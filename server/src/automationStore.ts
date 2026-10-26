import type { FastifyBaseLogger } from 'fastify';
import { AUTOMATION_SCHEMA_VERSION, buildAutomation, coverageFor, DEFAULT_LAYOUT, isBanned, layoutFlow, type AutomationResult, type AutoEdge, type AutoNode, type EntryRef, type MainFlow } from '@codepilot/analyzer/automation';
import type { ArchitectureStore } from './architectureStore.ts';
import { now, type Db } from './db.ts';
import { AppError } from './errors.ts';
import type { GraphContext } from './routes/projects.ts';

/*
 * Automation Engine storage. Main flows are computed from the analysis (architecture, facts,
 * graph), laid out once and stored per analysis with the engine's schema version; a stored result
 * with another version is regenerated on read. Swaps and renames are per project, so they survive
 * re-analysis while the flow (its capability key) still exists.
 */

interface RunRow {
  analysis_id: string;
  project_id: string;
  commit_sha: string | null;
  schema_version: number;
  status: AutomationResult['status'];
  project_type: AutomationResult['projectType'];
  meta_json: string;
  created_at: string;
}

interface RunMeta {
  projectTypeLabel: string;
  selected: string[];
  entries: EntryRef[];
  diagnostics: AutomationResult['diagnostics'];
}

type StoredFlow = MainFlow;

export interface Prefs {
  selected: string[];
  names: Record<string, string>;
}

const MAX_SHOWN = 4;

export class AutomationStore {
  constructor(
    private readonly db: Db,
    private readonly architectures: ArchitectureStore,
    private readonly log?: FastifyBaseLogger,
  ) {}

  /** The stored result for this analysis, computing it when missing or made by another engine version. */
  ensure(ctx: GraphContext): { meta: RunMeta; flows: StoredFlow[]; status: AutomationResult['status']; projectType: AutomationResult['projectType']; regenerated: boolean } {
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE analysis_id = ?').get(ctx.analysis.id) as unknown as RunRow | undefined;
    let regenerated = false;
    if (!row || row.schema_version !== AUTOMATION_SCHEMA_VERSION) {
      regenerated = !!row;
      this.compute(ctx);
    }
    const run = this.db.prepare('SELECT * FROM automation_runs WHERE analysis_id = ?').get(ctx.analysis.id) as unknown as RunRow;
    return { meta: JSON.parse(run.meta_json) as RunMeta, flows: this.loadFlows(ctx.analysis.id), status: run.status, projectType: run.project_type, regenerated };
  }

  /** Compute and store, stage by stage; a failure names its stage and is never swallowed. */
  compute(ctx: GraphContext) {
    let stage = 'architecture';
    try {
      const arch = this.architectures.get(ctx.project.id, ctx.analysis, ctx.index).architecture;
      stage = 'facts';
      const facts = this.architectures.loadFacts(ctx.analysis.id) ?? this.architectures.loadFacts(this.architectures.get(ctx.project.id, ctx.analysis, ctx.index).analysisId);
      if (!facts) throw new AppError('architecture_unavailable', 'This analysis has no extraction facts; re-analyze the repository to build its flows.', 409);
      stage = 'build';
      const result = buildAutomation({ arch, facts, graph: ctx.index.graph, projectName: ctx.project.repo });
      stage = 'store';
      this.save(ctx, result);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.log?.error({ err, analysisId: ctx.analysis.id, stage }, 'automation failed');
      throw new AppError('analysis_failed', `Building flows failed at the "${stage}" stage: ${(err as Error).message?.split('\n')[0] ?? 'unknown error'}. Re-analyze to try again; if it keeps failing, report analysis ${ctx.analysis.id}.`, 500);
    }
  }

  private save(ctx: GraphContext, r: AutomationResult) {
    const { db } = this;
    const a = ctx.analysis.id;
    const meta: RunMeta = { projectTypeLabel: r.projectTypeLabel, selected: r.selected, entries: (r as AutomationResult & { entries?: EntryRef[] }).entries ?? [], diagnostics: r.diagnostics };
    db.exec('BEGIN');
    try {
      for (const t of ['flow_edges', 'flow_nodes', 'flows', 'automation_runs']) db.prepare(`DELETE FROM ${t} WHERE analysis_id = ?`).run(a);
      db.prepare('INSERT INTO automation_runs (analysis_id, project_id, commit_sha, schema_version, status, project_type, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        a,
        ctx.project.id,
        ctx.analysis.commit_sha,
        AUTOMATION_SCHEMA_VERSION,
        r.status,
        r.projectType,
        JSON.stringify(meta),
        now(),
      );
      const flow = db.prepare('INSERT INTO flows (id, analysis_id, project_id, commit_sha, schema_version, flow_key, name, summary, cycle, confidence, coverage, pinned, rank, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)');
      const node = db.prepare('INSERT INTO flow_nodes (analysis_id, flow_id, id, type, label, lane, file, line, tools_json, x, y, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const edge = db.prepare('INSERT INTO flow_edges (analysis_id, flow_id, id, source, target, kind, label, evidence_json, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      r.flows.forEach((f, rank) => {
        const { nodes, edges, ...rest } = f;
        flow.run(f.id, a, ctx.project.id, ctx.analysis.commit_sha, AUTOMATION_SCHEMA_VERSION, f.key, f.name, f.purpose, f.cycle, f.confidence.percent, f.entries.shown.length + f.entries.folded.length, rank, JSON.stringify(rest));
        const layout = layoutFlow(nodes, edges, DEFAULT_LAYOUT);
        for (const n of nodes) {
          const { id, type, label, lane, file, line, tools, ...data } = n;
          const p = layout.nodes[id];
          node.run(a, f.id, id, type, label, lane, file, line ?? null, JSON.stringify(tools), p?.x ?? 0, p?.y ?? 0, JSON.stringify(data));
        }
        for (const e of edges) {
          const { id, source, target, kind, label, evidence, ...data } = e;
          edge.run(a, f.id, id, source, target, kind, label ?? null, JSON.stringify(evidence), JSON.stringify(data));
        }
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private loadFlows(analysisId: string): StoredFlow[] {
    const rows = this.db.prepare('SELECT id, data_json FROM flows WHERE analysis_id = ? ORDER BY rank').all(analysisId) as { id: string; data_json: string }[];
    const nodeRows = this.db.prepare('SELECT * FROM flow_nodes WHERE analysis_id = ?').all(analysisId) as unknown as { flow_id: string; id: string; type: AutoNode['type']; label: string; lane: AutoNode['lane']; file: string; line: number | null; tools_json: string; data_json: string }[];
    const edgeRows = this.db.prepare('SELECT * FROM flow_edges WHERE analysis_id = ?').all(analysisId) as unknown as { flow_id: string; id: string; source: string; target: string; kind: AutoEdge['kind']; label: string | null; evidence_json: string; data_json: string }[];
    return rows.map((r) => {
      const nodes: AutoNode[] = nodeRows
        .filter((n) => n.flow_id === r.id)
        .map((n) => ({ id: n.id, type: n.type, label: n.label, lane: n.lane, file: n.file, line: n.line ?? undefined, tools: JSON.parse(n.tools_json), ...JSON.parse(n.data_json) }))
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
      const edges: AutoEdge[] = edgeRows.filter((e) => e.flow_id === r.id).map((e) => ({ id: e.id, source: e.source, target: e.target, kind: e.kind, label: e.label ?? undefined, evidence: JSON.parse(e.evidence_json), ...JSON.parse(e.data_json) }));
      return { ...(JSON.parse(r.data_json) as Omit<StoredFlow, 'nodes' | 'edges'>), nodes, edges } as StoredFlow;
    });
  }

  prefs(projectId: string): Prefs {
    const r = this.db.prepare('SELECT selected_json, names_json FROM automation_prefs WHERE project_id = ?').get(projectId) as { selected_json: string; names_json: string } | undefined;
    return r ? { selected: JSON.parse(r.selected_json), names: JSON.parse(r.names_json) } : { selected: [], names: {} };
  }

  savePrefs(projectId: string, prefs: Prefs) {
    this.db
      .prepare('INSERT INTO automation_prefs (project_id, selected_json, names_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET selected_json = excluded.selected_json, names_json = excluded.names_json, updated_at = excluded.updated_at')
      .run(projectId, JSON.stringify(prefs.selected), JSON.stringify(prefs.names), now());
  }

  /** The flows to show, in slot order: the user's swaps where those flows still exist, then the defaults. */
  static selection(defaults: string[], available: StoredFlow[], prefs: Prefs): string[] {
    const exists = new Set(available.map((f) => f.key));
    const out: string[] = [];
    const wanted = prefs.selected.length ? prefs.selected : defaults;
    for (const k of wanted) if (exists.has(k) && !out.includes(k) && out.length < MAX_SHOWN) out.push(k);
    for (const k of defaults) if (out.length < Math.min(MAX_SHOWN, Math.max(defaults.length, wanted.length)) && exists.has(k) && !out.includes(k)) out.push(k);
    return out;
  }

  /** The response for the Automation tab. */
  view(ctx: GraphContext) {
    const { meta, flows, status, projectType, regenerated } = this.ensure(ctx);
    const prefs = this.prefs(ctx.project.id);
    const selected = AutomationStore.selection(meta.selected, flows, prefs);
    const named = (f: StoredFlow) => ({ ...f, name: prefs.names[f.key] ?? f.generatedName, renamed: !!prefs.names[f.key] });
    const coverage = coverageFor({ flows, entries: meta.entries } as unknown as AutomationResult, selected);
    const latest = this.db.prepare('SELECT status, error_code, error_message FROM analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(ctx.project.id) as { status: string; error_code: string | null; error_message: string | null } | undefined;
    return {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      regenerated,
      status,
      projectType,
      projectTypeLabel: meta.projectTypeLabel,
      project: { name: ctx.project.repo },
      snapshot: { analysisId: ctx.analysis.id, branch: ctx.analysis.branch, commitSha: ctx.analysis.commit_sha, finishedAt: ctx.analysis.finished_at },
      latestAnalysis: latest && latest.status === 'failed' ? { status: latest.status, error: { code: latest.error_code, message: latest.error_message } } : null,
      flows: selected.map((k) => flows.find((f) => f.key === k)!).map(named),
      candidates: flows.map((f) => ({ id: f.id, key: f.key, name: prefs.names[f.key] ?? f.generatedName, cycle: f.cycle, purpose: f.purpose, steps: f.nodes.filter((n) => n.type !== 'group').length, confidence: f.confidence, partial: f.partial, selected: selected.includes(f.key) })),
      coverage: { total: coverage.total, shown: coverage.shown.length, folded: coverage.folded.length, omitted: coverage.omitted.length },
      diagnostics: meta.diagnostics,
    };
  }

  coverage(ctx: GraphContext) {
    const { meta, flows } = this.ensure(ctx);
    const selected = AutomationStore.selection(meta.selected, flows, this.prefs(ctx.project.id));
    return coverageFor({ flows, entries: meta.entries } as unknown as AutomationResult, selected);
  }

  /** Swap the flow shown in a slot for another candidate. */
  replace(ctx: GraphContext, flowId: string, key: string) {
    const { meta, flows } = this.ensure(ctx);
    const prefs = this.prefs(ctx.project.id);
    const current = AutomationStore.selection(meta.selected, flows, prefs);
    const slot = current.findIndex((k) => flows.find((f) => f.key === k)?.id === flowId);
    if (slot < 0) throw new AppError('not_found', 'That flow is not shown.', 404);
    if (!flows.some((f) => f.key === key)) throw new AppError('not_found', 'No such flow in this analysis.', 404);
    const next = [...current];
    const existing = next.indexOf(key);
    if (existing >= 0) next[existing] = next[slot]; // swapping two shown flows keeps both
    next[slot] = key;
    this.savePrefs(ctx.project.id, { ...prefs, selected: next });
    return this.view(ctx);
  }

  rename(ctx: GraphContext, flowId: string, name: string | null) {
    const { flows } = this.ensure(ctx);
    const flow = flows.find((f) => f.id === flowId);
    if (!flow) throw new AppError('not_found', 'Flow not found.', 404);
    const prefs = this.prefs(ctx.project.id);
    const clean = name?.replace(/\s+/g, ' ').trim() ?? '';
    if (clean.length > 80) throw new AppError('bad_request', 'Names are at most 80 characters.', 400);
    if (clean && isBanned(clean)) throw new AppError('bad_request', 'That name is too generic; describe what the flow does.', 400);
    const names = { ...prefs.names };
    if (clean) names[flow.key] = clean;
    else delete names[flow.key];
    this.savePrefs(ctx.project.id, { ...prefs, names });
    return this.view(ctx);
  }
}
