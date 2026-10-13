import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { analyzeRepositoryWithFacts, type AnalysisProgress, type PartialGraph } from '@codepilot/analyzer';
import type { ArchitectureStore } from '../architectureStore.ts';
import type { AuthStore } from '../auth/store.ts';
import type { Config } from '../config.ts';
import { randomId } from '../crypto.ts';
import { now, type Db } from '../db.ts';
import { AppError, type ErrorAction } from '../errors.ts';
import { cloneRepository, headCommit } from '../git.ts';
import { GitHubClient } from '../github.ts';
import type { GraphStore } from '../graphStore.ts';

export const STAGES = ['queued', 'cloning', 'scanning', 'parsing', 'resolving', 'building', 'complete'] as const;
export type Stage = (typeof STAGES)[number] | 'failed';

export type AnalysisSource =
  | { kind: 'github'; userId: string; owner: string; repo: string; branch: string }
  | { kind: 'local'; root: string; ignore: string[]; name: string; branch: string };

export interface LiveCounters {
  filesScanned: number;
  nodesClassified: number;
  edgesFound: number;
  clone?: { phase: string; percent: number };
}

export interface AnalysisError {
  code: string;
  message: string;
  action?: ErrorAction;
}

export type AnalysisEvent =
  | { type: 'stage'; stage: Stage }
  | { type: 'progress'; counters: LiveCounters }
  | { type: 'partial'; nodes: { id: string; type: string }[]; edges: { source: string; target: string; resolved: boolean; external: boolean }[] }
  | { type: 'complete'; analysisId: string; projectId: string }
  | { type: 'error'; error: AnalysisError };

export interface AnalysisSnapshot {
  analysisId: string;
  projectId: string;
  stage: Stage;
  counters: LiveCounters;
  partial: { nodes: { id: string; type: string }[]; edges: { source: string; target: string; resolved: boolean; external: boolean }[] };
  error?: AnalysisError;
}

interface Live extends AnalysisSnapshot {
  listeners: Set<(e: AnalysisEvent) => void>;
  source: AnalysisSource;
  abort: AbortController;
  lastProgressEmit: number;
  pendingProgress?: ReturnType<typeof setTimeout>;
  lastDbWrite: number;
}

/** Partial graph data kept for late subscribers; enough to draw a live preview. */
const PARTIAL_CAP = { nodes: 4000, edges: 12000 };
const PROGRESS_INTERVAL_MS = 100;

export class AnalysisRunner {
  /** Called once an analysis has completed and its architecture was detected (failures are logged, never fail the analysis). */
  onComplete?: (projectId: string, analysisId: string) => void;
  private readonly live = new Map<string, Live>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly auth: AuthStore,
    private readonly graphs: GraphStore,
    private readonly log: FastifyBaseLogger,
    private readonly architectures?: ArchitectureStore,
  ) {}

  /** Analyses left running by a previous process can never finish; mark them failed with a clear next step. */
  recoverInterrupted() {
    this.db
      .prepare("UPDATE analyses SET status = 'failed', stage = 'failed', error_code = 'interrupted', error_message = ?, finished_at = ? WHERE status IN ('queued', 'running')")
      .run('Analysis was interrupted by a server restart. Start it again.', now());
  }

  start(projectId: string, source: AnalysisSource): string {
    const analysisId = randomId();
    this.db
      .prepare("INSERT INTO analyses (id, project_id, branch, status, stage, created_at) VALUES (?, ?, ?, 'queued', 'queued', ?)")
      .run(analysisId, projectId, source.branch, now());
    this.live.set(analysisId, {
      analysisId,
      projectId,
      stage: 'queued',
      counters: { filesScanned: 0, nodesClassified: 0, edgesFound: 0 },
      partial: { nodes: [], edges: [] },
      listeners: new Set(),
      source,
      abort: new AbortController(),
      lastProgressEmit: 0,
      lastDbWrite: 0,
    });
    this.queue.push(analysisId);
    this.pump();
    return analysisId;
  }

  /** Current state for an in-flight analysis, or undefined if it is not running in this process. */
  snapshot(analysisId: string): AnalysisSnapshot | undefined {
    const l = this.live.get(analysisId);
    if (!l) return undefined;
    return { analysisId: l.analysisId, projectId: l.projectId, stage: l.stage, counters: { ...l.counters }, partial: l.partial, error: l.error };
  }

  subscribe(analysisId: string, listener: (e: AnalysisEvent) => void): () => void {
    const l = this.live.get(analysisId);
    if (!l) return () => {};
    l.listeners.add(listener);
    return () => l.listeners.delete(listener);
  }

  async shutdown() {
    for (const l of this.live.values()) l.abort.abort();
  }

  private pump() {
    while (this.running < this.config.analysisConcurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      this.run(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private emit(l: Live, e: AnalysisEvent) {
    for (const fn of l.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.log.warn({ err }, 'analysis listener failed');
      }
    }
  }

  private setStage(l: Live, stage: Stage) {
    if (l.stage === stage) return;
    l.stage = stage;
    this.db.prepare('UPDATE analyses SET stage = ? WHERE id = ?').run(stage, l.analysisId);
    this.flushProgress(l);
    this.emit(l, { type: 'stage', stage });
  }

  private flushProgress(l: Live) {
    if (l.pendingProgress) clearTimeout(l.pendingProgress);
    l.pendingProgress = undefined;
    l.lastProgressEmit = Date.now();
    this.emit(l, { type: 'progress', counters: { ...l.counters } });
    if (Date.now() - l.lastDbWrite > 1000) {
      l.lastDbWrite = Date.now();
      this.db
        .prepare('UPDATE analyses SET files_scanned = ?, nodes_classified = ?, edges_found = ? WHERE id = ?')
        .run(l.counters.filesScanned, l.counters.nodesClassified, l.counters.edgesFound, l.analysisId);
    }
  }

  /** Coalesce frequent progress callbacks into at most one event per interval. */
  private progress(l: Live) {
    const wait = PROGRESS_INTERVAL_MS - (Date.now() - l.lastProgressEmit);
    if (wait <= 0) this.flushProgress(l);
    else if (!l.pendingProgress) l.pendingProgress = setTimeout(() => this.flushProgress(l), wait);
  }

  private onPartial(l: Live, p: PartialGraph) {
    const nodes = p.nodes.map((n) => ({ id: n.id, type: n.type }));
    const edges = p.edges.map((e) => ({ source: e.source, target: e.target, resolved: e.resolved, external: e.external }));
    if (l.partial.nodes.length < PARTIAL_CAP.nodes) l.partial.nodes.push(...nodes.slice(0, PARTIAL_CAP.nodes - l.partial.nodes.length));
    if (l.partial.edges.length < PARTIAL_CAP.edges) l.partial.edges.push(...edges.slice(0, PARTIAL_CAP.edges - l.partial.edges.length));
    this.emit(l, { type: 'partial', nodes, edges });
  }

  private async run(analysisId: string) {
    const l = this.live.get(analysisId)!;
    const src = l.source;
    let workdir: string | undefined;
    this.db.prepare("UPDATE analyses SET status = 'running', started_at = ? WHERE id = ?").run(now(), analysisId);
    try {
      let root: string;
      let commitSha: string | undefined;
      let repository: { owner?: string; name?: string; branch: string; commitSha?: string };
      let ignore: string[] | undefined;

      if (src.kind === 'github') {
        this.setStage(l, 'cloning');
        const token = this.auth.githubToken(src.userId);
        const meta = await new GitHubClient(this.config.github.apiUrl, token).repo(src.owner, src.repo);
        if (meta.sizeKb / 1024 > this.config.maxRepoSizeMb) {
          throw new AppError('repo_too_large', `${meta.fullName} is ${Math.round(meta.sizeKb / 1024)} MB, above this server's ${this.config.maxRepoSizeMb} MB limit.`, 413);
        }
        workdir = await mkdtemp(path.join(tmpdir(), 'codepilot-clone-'));
        root = path.join(workdir, 'repo');
        await cloneRepository({
          url: `${this.config.github.webUrl}/${src.owner}/${src.repo}.git`,
          branch: src.branch,
          dest: root,
          token,
          timeoutMs: this.config.cloneTimeoutMs,
          signal: l.abort.signal,
          onProgress: (p) => {
            l.counters.clone = p;
            this.progress(l);
          },
        });
        commitSha = await headCommit(root);
        repository = { owner: src.owner, name: src.repo, branch: src.branch, commitSha };
      } else {
        root = src.root;
        ignore = src.ignore;
        repository = { name: src.name, branch: src.branch };
      }

      const { graph, facts } = await analyzeRepositoryWithFacts(root, {
        repository,
        ignore,
        signal: l.abort.signal,
        onProgress: (p: AnalysisProgress) => {
          l.counters.filesScanned = p.filesScanned;
          l.counters.nodesClassified = p.nodesClassified;
          l.counters.edgesFound = p.edgesFound;
          this.setStage(l, p.stage);
          this.progress(l);
        },
        onPartial: (p) => this.onPartial(l, p),
      });

      this.setStage(l, 'building');
      this.graphs.save(analysisId, graph);
      this.graphs.positions(analysisId, 'force');
      this.architectures?.saveFacts(analysisId, facts);

      l.counters.nodesClassified = graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved').length;
      l.counters.edgesFound = graph.edges.length;
      this.db
        .prepare("UPDATE analyses SET status = 'complete', stage = 'complete', commit_sha = ?, files_scanned = ?, nodes_classified = ?, edges_found = ?, finished_at = ? WHERE id = ?")
        .run(commitSha ?? null, l.counters.filesScanned, l.counters.nodesClassified, l.counters.edgesFound, now(), analysisId);
      this.flushProgress(l);
      // Detect the architecture now (cached per commit); a failure here never fails the analysis.
      if (this.architectures) {
        try {
          const index = this.graphs.load(analysisId);
          if (index) this.architectures.get(l.projectId, { id: analysisId, commit_sha: commitSha ?? null, branch: src.branch }, index);
        } catch (err) {
          this.log.warn({ err, analysisId }, 'architecture detection after analysis failed; it will be retried on request');
        }
      }
      try {
        this.onComplete?.(l.projectId, analysisId);
      } catch (err) {
        this.log.warn({ err, analysisId }, 'post-analysis hook failed');
      }
      l.stage = 'complete';
      this.emit(l, { type: 'stage', stage: 'complete' });
      this.emit(l, { type: 'complete', analysisId, projectId: l.projectId });
    } catch (err) {
      const error: AnalysisError =
        err instanceof AppError
          ? err.toJSON()
          : err instanceof Error && /more than [\d,]+ files/.test(err.message)
            ? { code: 'repo_too_large', message: err.message }
            : { code: 'analysis_failed', message: `Analysis failed unexpectedly. Try again; if it keeps failing, report analysis ${analysisId}.` };
      if (!(err instanceof AppError)) this.log.error({ err, analysisId }, 'analysis failed');
      l.error = error;
      l.stage = 'failed';
      this.db
        .prepare("UPDATE analyses SET status = 'failed', stage = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?")
        .run(error.code, error.message, now(), analysisId);
      this.emit(l, { type: 'error', error });
    } finally {
      if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
      if (l.pendingProgress) clearTimeout(l.pendingProgress);
      // Keep the terminal state briefly for late subscribers, then release memory.
      setTimeout(() => this.live.delete(analysisId), 60_000).unref();
    }
  }
}
