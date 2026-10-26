import type { FastifyBaseLogger } from 'fastify';
import { ARCH_DETECTOR_VERSION, ARCH_EXTRACTOR_VERSION, detectArchitecture, type Architecture, type ArchitectureFacts, type ArchNode, type Evidence, type Flow } from '@codepilot/analyzer/architecture';
import { randomId } from './crypto.ts';
import { now, type Db } from './db.ts';
import { AppError } from './errors.ts';
import type { GraphIndex } from './graphStore.ts';

export interface ArchitectureRecord {
  id: string;
  analysisId: string;
  commitSha: string | null;
  cacheKey: string;
  /** True when the result was computed for an earlier analysis of the same commit. */
  reused: boolean;
  architecture: Architecture;
}

interface ArchRow {
  id: string;
  analysis_id: string;
  commit_sha: string | null;
  cache_key: string;
  status: string;
  error_message: string | null;
  layers_json: string | null;
  summary_json: string | null;
  blast_json: string | null;
  generated_at: string | null;
}

/**
 * Stores extraction facts per analysis and detected architectures per (project, commit,
 * detector version). An unchanged commit is never re-detected; a newer detector version or an
 * explicit regenerate recomputes from the stored facts without re-cloning.
 */
export class ArchitectureStore {
  private readonly cache = new Map<string, Architecture>();
  /** Called after an architecture is newly computed (first use, regenerate, newer detector version). */
  onComputed?: (projectId: string, analysisId: string) => void;

  constructor(
    private readonly db: Db,
    private readonly log?: FastifyBaseLogger,
  ) {}

  saveFacts(analysisId: string, facts: ArchitectureFacts) {
    this.db.prepare('INSERT OR REPLACE INTO architecture_facts (analysis_id, extractor_version, facts_json) VALUES (?, ?, ?)').run(analysisId, facts.version, JSON.stringify(facts));
  }

  loadFacts(analysisId: string): ArchitectureFacts | null {
    const row = this.db.prepare('SELECT extractor_version, facts_json FROM architecture_facts WHERE analysis_id = ?').get(analysisId) as { extractor_version: number; facts_json: string } | undefined;
    if (!row || row.extractor_version !== ARCH_EXTRACTOR_VERSION) return null;
    return JSON.parse(row.facts_json) as ArchitectureFacts;
  }

  static cacheKey(analysisId: string, commitSha: string | null): string {
    return commitSha ? `commit:${commitSha}` : `analysis:${analysisId}`;
  }

  /** The architecture for a completed analysis, computing (and storing) it on first use. */
  get(projectId: string, analysis: { id: string; commit_sha: string | null; branch: string }, index: GraphIndex, opts: { regenerate?: boolean } = {}): ArchitectureRecord {
    const key = ArchitectureStore.cacheKey(analysis.id, analysis.commit_sha);
    if (opts.regenerate) {
      const old = this.db.prepare('SELECT id FROM architectures WHERE project_id = ? AND cache_key = ? AND detector_version = ?').get(projectId, key, ARCH_DETECTOR_VERSION) as { id: string } | undefined;
      if (old) {
        this.db.prepare('DELETE FROM architectures WHERE id = ?').run(old.id);
        this.cache.delete(old.id);
      }
    }
    const row = this.db.prepare("SELECT * FROM architectures WHERE project_id = ? AND cache_key = ? AND detector_version = ? AND status = 'complete'").get(projectId, key, ARCH_DETECTOR_VERSION) as ArchRow | undefined;
    if (row) return { id: row.id, analysisId: row.analysis_id, commitSha: row.commit_sha, cacheKey: key, reused: row.analysis_id !== analysis.id, architecture: this.load(row) };

    // Facts from this analysis, or from another analysis of the same commit.
    let facts = this.loadFacts(analysis.id);
    if (!facts && analysis.commit_sha) {
      const other = this.db
        .prepare("SELECT a.id FROM analyses a JOIN architecture_facts f ON f.analysis_id = a.id WHERE a.project_id = ? AND a.commit_sha = ? AND a.status = 'complete' ORDER BY a.created_at DESC LIMIT 1")
        .get(projectId, analysis.commit_sha) as { id: string } | undefined;
      if (other) facts = this.loadFacts(other.id);
    }
    if (!facts) {
      throw new AppError('architecture_unavailable', 'This analysis was made before architecture detection existed (or with an older extractor). Re-analyze the repository to detect its architecture.', 409);
    }

    let architecture: Architecture;
    try {
      architecture = detectArchitecture({ facts, graph: index.graph, repository: { commitSha: analysis.commit_sha ?? undefined, branch: analysis.branch, name: index.graph.repository.name } });
    } catch (err) {
      this.log?.error({ err, analysisId: analysis.id }, 'architecture detection failed');
      throw new AppError('analysis_failed', `Architecture detection failed for this analysis. Try regenerating; if it keeps failing, report analysis ${analysis.id}.`, 500);
    }
    const id = this.save(projectId, analysis.id, key, analysis.commit_sha, architecture);
    try {
      this.onComputed?.(projectId, analysis.id);
    } catch (err) {
      this.log?.warn({ err, analysisId: analysis.id }, 'architecture hook failed');
    }
    return { id, analysisId: analysis.id, commitSha: analysis.commit_sha, cacheKey: key, reused: false, architecture };
  }

  private save(projectId: string, analysisId: string, key: string, commitSha: string | null, arch: Architecture): string {
    const id = randomId(12);
    const { db } = this;
    db.exec('BEGIN');
    try {
      db.prepare(
        'INSERT INTO architectures (id, project_id, analysis_id, cache_key, commit_sha, detector_version, status, layers_json, summary_json, blast_json, generated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, projectId, analysisId, key, commitSha, arch.version, 'complete', JSON.stringify({ layers: arch.layers, repository: arch.repository, system: arch.system, technologies: arch.technologies }), JSON.stringify(arch.summary), JSON.stringify(arch.blast), arch.generatedAt, now());
      const ev = db.prepare('INSERT INTO evidence (architecture_id, id, kind, file, line, snippet, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of Object.values(arch.evidence)) ev.run(id, e.id, e.kind, e.file, e.line ?? null, e.snippet ?? null, e.detail);
      const tool = db.prepare('INSERT INTO architecture_tools (architecture_id, id, kind, name, version, category, layer, confidence, role, ord, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      arch.nodes.forEach((n, i) => {
        const { id: nid, kind, name, category, layer, confidence, role, ...rest } = n;
        tool.run(id, nid, kind, name, n.version?.value ?? null, category, layer, confidence, role, i, JSON.stringify(rest));
      });
      const edge = db.prepare('INSERT INTO architecture_edges (architecture_id, id, source, target, labels_json, confidence, is_async, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of arch.edges) edge.run(id, e.id, e.source, e.target, JSON.stringify(e.labels), e.confidence, e.async ? 1 : 0, JSON.stringify({ overlays: e.overlays, evidence: e.evidence, reason: e.reason }));
      const flow = db.prepare('INSERT INTO architecture_flows (architecture_id, id, title, trigger_kind, confidence, truncated, ord, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const step = db.prepare('INSERT INTO architecture_flow_steps (architecture_id, flow_id, step, node_id, file, line, mode, explanation, evidence_json, edge_id, latency_ms, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      arch.flows.forEach((f, i) => {
        flow.run(id, f.id, f.title, f.trigger.kind, f.confidence, f.truncated ? 1 : 0, i, JSON.stringify({ trigger: f.trigger, variant: f.variant, notes: f.notes, action: f.action, lanes: f.lanes, name: f.name, index: f.index }));
        for (const s of f.steps) {
          const extra = { lane: s.lane, kind: s.kind, label: s.label, transport: s.transport, branch: s.branch, tool: s.tool, stage: s.stage, fn: s.fn, input: s.input, output: s.output, confidence: s.confidence };
          step.run(id, f.id, s.step, s.node, s.file, s.line ?? null, s.mode, s.explanation, JSON.stringify(s.evidence), s.edge ?? null, s.latencyMs ?? null, JSON.stringify(extra));
        }
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.remember(id, arch);
    return id;
  }

  private load(row: ArchRow): Architecture {
    const hit = this.cache.get(row.id);
    if (hit) return hit;
    const { db } = this;
    const meta = JSON.parse(row.layers_json ?? '{}') as { layers: Architecture['layers']; repository: Architecture['repository']; system?: Architecture['system']; technologies?: Architecture['technologies'] };
    const evidence: Record<string, Evidence> = {};
    for (const e of db.prepare('SELECT * FROM evidence WHERE architecture_id = ? ORDER BY id').all(row.id) as unknown as { id: string; kind: Evidence['kind']; file: string; line: number | null; snippet: string | null; detail: string }[]) {
      evidence[e.id] = { id: e.id, kind: e.kind, file: e.file, line: e.line ?? undefined, snippet: e.snippet ?? undefined, detail: e.detail };
    }
    const nodes = (db.prepare('SELECT * FROM architecture_tools WHERE architecture_id = ? ORDER BY ord').all(row.id) as unknown as { id: string; kind: ArchNode['kind']; name: string; category: ArchNode['category']; layer: ArchNode['layer']; confidence: ArchNode['confidence']; role: string; data_json: string }[]).map(
      (t) => ({ id: t.id, kind: t.kind, name: t.name, category: t.category, layer: t.layer, confidence: t.confidence, role: t.role, ...JSON.parse(t.data_json) }) as ArchNode,
    );
    const edges = (db.prepare('SELECT * FROM architecture_edges WHERE architecture_id = ? ORDER BY id').all(row.id) as unknown as { id: string; source: string; target: string; labels_json: string; confidence: ArchNode['confidence']; is_async: number; data_json: string }[]).map((e) => {
      const data = JSON.parse(e.data_json) as { overlays: Architecture['edges'][number]['overlays']; evidence: string[]; reason: string };
      return { id: e.id, source: e.source, target: e.target, labels: JSON.parse(e.labels_json), confidence: e.confidence, async: !!e.is_async, ...data };
    });
    const stepsByFlow = new Map<string, Flow['steps']>();
    for (const s of db.prepare('SELECT * FROM architecture_flow_steps WHERE architecture_id = ? ORDER BY flow_id, step').all(row.id) as unknown as { flow_id: string; step: number; node_id: string; file: string; line: number | null; mode: Flow['steps'][number]['mode']; explanation: string; evidence_json: string; edge_id: string | null; latency_ms: number | null; data_json: string | null }[]) {
      if (!stepsByFlow.has(s.flow_id)) stepsByFlow.set(s.flow_id, []);
      const extra = s.data_json ? (JSON.parse(s.data_json) as Partial<Flow['steps'][number]>) : {};
      stepsByFlow.get(s.flow_id)!.push({ step: s.step, node: s.node_id, file: s.file, line: s.line ?? undefined, mode: s.mode, explanation: s.explanation, evidence: JSON.parse(s.evidence_json), edge: s.edge_id ?? undefined, latencyMs: s.latency_ms ?? undefined, ...extra });
    }
    const flows = (db.prepare('SELECT * FROM architecture_flows WHERE architecture_id = ? ORDER BY ord').all(row.id) as unknown as { id: string; title: string; confidence: Flow['confidence']; truncated: number; data_json: string }[]).map((f) => {
      const data = JSON.parse(f.data_json) as { trigger: Flow['trigger']; variant?: Flow['variant']; notes: string[]; action?: Flow['action']; lanes?: Flow['lanes']; name?: string; index?: Flow['index'] };
      return { id: f.id, title: f.title, confidence: f.confidence, truncated: !!f.truncated, steps: stepsByFlow.get(f.id) ?? [], ...data } as Flow;
    });
    const arch: Architecture = {
      version: ARCH_DETECTOR_VERSION,
      generatedAt: row.generated_at ?? '',
      repository: meta.repository ?? {},
      layers: meta.layers ?? [],
      nodes,
      edges,
      flows,
      evidence,
      summary: JSON.parse(row.summary_json ?? '{}'),
      blast: JSON.parse(row.blast_json ?? '{}'),
      system: meta.system ?? { layers: [], nodes: [], links: [], groups: [] },
      technologies: meta.technologies ?? [],
    };
    this.remember(row.id, arch);
    return arch;
  }

  private remember(id: string, arch: Architecture) {
    this.cache.set(id, arch);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }
}
