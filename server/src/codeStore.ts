import type { FastifyBaseLogger } from 'fastify';
import { ANALYZABLE_LANGUAGES, outlineOf, SCAN_POLICY, STORE_EXCLUSION_TEXT, walkRepositoryFiles, type RepoEntry, type StoreExclusion } from '@codepilot/analyzer';
import { sha256 } from './crypto.ts';
import { now, type Db } from './db.ts';
import { AppError } from './errors.ts';
import { nodeDetails, type GraphStore } from './graphStore.ts';
import type { AnalysisRow } from './routes/projects.ts';

/*
 * The Code tab's storage. Each analysis snapshot keeps the files as they were imported, with
 * detected secrets already masked — raw values are never written here, so no endpoint can return
 * them. Contents are deduplicated by hash across snapshots; every entry that was not stored is
 * kept with its reason so the explorer can show it.
 */

export interface CodeSnapshotRow {
  analysis_id: string;
  project_id: string;
  commit_sha: string | null;
  status: 'storing' | 'ready' | 'empty' | 'failed';
  stored: number;
  not_stored: number;
  bytes: number;
  truncated: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

interface FileRow {
  path: string;
  stored: number;
  is_dir: number;
  reason: StoreExclusion | null;
  size: number | null;
  language: string | null;
  lines: number | null;
  blob_hash: string | null;
  masked_lines: string | null;
}

export interface CodeRef {
  analysis: AnalysisRow;
  snapshot: CodeSnapshotRow | undefined;
}

const BATCH = 200;
const MAX_FILES = SCAN_POLICY.limits.maxFiles;
export const SEARCH_LIMITS = { query: 200, perFile: 50, matches: 1000, files: 300, budgetMs: 4000, snippet: 240 };

/** A repository path as stored: relative, POSIX, no `.`/`..` segments, no NUL or backslash. */
export function validPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 1024) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..');
}

export class CodeStore {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Store a snapshot's files from a checked-out tree. Never throws: failures are recorded on the snapshot. */
  async store(input: { analysisId: string; projectId: string; root: string; ignore?: string[]; commitSha?: string; signal?: AbortSignal }): Promise<void> {
    const { db } = this;
    db.prepare("INSERT OR REPLACE INTO code_snapshots (analysis_id, project_id, commit_sha, status, created_at) VALUES (?, ?, ?, 'storing', ?)").run(input.analysisId, input.projectId, input.commitSha ?? null, now());
    const insBlob = db.prepare('INSERT OR IGNORE INTO code_blobs (hash, content) VALUES (?, ?)');
    const insFile = db.prepare('INSERT OR REPLACE INTO code_files (analysis_id, path, stored, is_dir, reason, size, language, lines, blob_hash, masked_lines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const counts = db.prepare('UPDATE code_snapshots SET stored = ?, not_stored = ?, bytes = ? WHERE analysis_id = ?');
    let stored = 0;
    let notStored = 0;
    let bytes = 0;
    let truncated = false;
    let batch: RepoEntry[] = [];
    const flush = () => {
      if (!batch.length) return;
      db.exec('BEGIN');
      try {
        for (const e of batch) {
          if (e.kind === 'file') {
            const hash = sha256(e.content);
            insBlob.run(hash, e.content);
            insFile.run(input.analysisId, e.path, 1, 0, null, e.size, e.language, e.lines, hash, e.maskedLines.length ? JSON.stringify(e.maskedLines) : null);
            stored++;
            bytes += e.size;
          } else {
            insFile.run(input.analysisId, e.path, 0, e.directory ? 1 : 0, e.reason, e.size ?? null, null, null, null, null);
            notStored++;
          }
        }
        counts.run(stored, notStored, bytes, input.analysisId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      batch = [];
    };
    try {
      for await (const e of walkRepositoryFiles(input.root, { ignore: input.ignore, signal: input.signal })) {
        if (e.kind === 'file' && stored + batch.filter((b) => b.kind === 'file').length >= MAX_FILES) {
          truncated = true;
          break;
        }
        batch.push(e);
        if (batch.length >= BATCH) flush();
      }
      flush();
      // A clone always has .git; a repository with nothing else in it is empty.
      const onlyGit = stored === 0 && (db.prepare("SELECT COUNT(*) AS n FROM code_files WHERE analysis_id = ? AND path <> '.git'").get(input.analysisId) as { n: number }).n === 0;
      db.prepare('UPDATE code_snapshots SET status = ?, truncated = ?, finished_at = ? WHERE analysis_id = ?').run(onlyGit ? 'empty' : 'ready', truncated ? 1 : 0, now(), input.analysisId);
    } catch (err) {
      const aborted = input.signal?.aborted;
      if (!aborted) this.log.warn({ err, analysisId: input.analysisId }, 'storing files for the Code tab failed');
      db.prepare("UPDATE code_snapshots SET status = 'failed', error_message = ?, finished_at = ? WHERE analysis_id = ?").run(
        aborted ? 'The import was cancelled before all files were stored.' : 'Storing the repository’s files failed. Retry the import.',
        now(),
        input.analysisId,
      );
    }
    this.collectGarbage();
  }

  /** Contents no snapshot refers to any more (deleted analyses) are removed. */
  collectGarbage() {
    this.db.prepare('DELETE FROM code_blobs WHERE NOT EXISTS (SELECT 1 FROM code_files f WHERE f.blob_hash = code_blobs.hash)').run();
  }

  /**
   * Which snapshot to show: an explicit analysis, else the newest analysis of a commit, else the
   * newest analysis with stored files (or the newest analysis, when none has any).
   */
  resolve(projectId: string, q: { analysisId?: string; commit?: string }): CodeRef {
    const { db } = this;
    let analysis: AnalysisRow | undefined;
    if (q.analysisId) {
      analysis = db.prepare('SELECT * FROM analyses WHERE id = ? AND project_id = ?').get(q.analysisId, projectId) as AnalysisRow | undefined;
      if (!analysis) throw new AppError('not_found', 'This snapshot does not exist.', 404);
    } else if (q.commit) {
      analysis = (db
        .prepare('SELECT a.* FROM analyses a JOIN code_snapshots c ON c.analysis_id = a.id WHERE a.project_id = ? AND a.commit_sha = ? ORDER BY a.created_at DESC LIMIT 1')
        .get(projectId, q.commit) ?? db.prepare('SELECT * FROM analyses WHERE project_id = ? AND commit_sha = ? ORDER BY created_at DESC LIMIT 1').get(projectId, q.commit)) as AnalysisRow | undefined;
    }
    analysis ??= (db
      .prepare("SELECT a.* FROM analyses a JOIN code_snapshots c ON c.analysis_id = a.id WHERE a.project_id = ? AND c.status <> 'failed' ORDER BY a.created_at DESC LIMIT 1")
      .get(projectId) ?? db.prepare('SELECT * FROM analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId)) as AnalysisRow | undefined;
    if (!analysis) throw new AppError('not_found', 'This project has not been imported yet.', 404);
    const snapshot = db.prepare('SELECT * FROM code_snapshots WHERE analysis_id = ?').get(analysis.id) as CodeSnapshotRow | undefined;
    return { analysis, snapshot };
  }

  /** The explorer listing and the snapshot's state. */
  tree(projectId: string, ref: CodeRef) {
    const { analysis, snapshot } = ref;
    const latest = this.db.prepare('SELECT * FROM analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as (AnalysisRow & { failed_stage: string | null }) | undefined;
    const own = analysis as AnalysisRow & { failed_stage?: string | null };
    // The newest import failed before any file was stored: say where.
    const failedImport = (a: (AnalysisRow & { failed_stage?: string | null }) | undefined) =>
      a && a.status === 'failed' && a.error_code !== 'repo_empty' && !this.db.prepare("SELECT 1 FROM code_snapshots WHERE analysis_id = ? AND status <> 'failed'").get(a.id)
        ? { analysisId: a.id, stage: a.failed_stage ?? 'cloning', code: a.error_code, message: a.error_message }
        : null;
    const failure = failedImport(own) ?? (latest && latest.id !== analysis.id ? failedImport(latest) : null);
    const rows = snapshot ? (this.db.prepare('SELECT path, stored, is_dir, reason, size, language, lines, masked_lines FROM code_files WHERE analysis_id = ? ORDER BY path').all(analysis.id) as unknown as FileRow[]) : [];
    const byReason: Partial<Record<StoreExclusion, number>> = {};
    let dirs = 0;
    for (const r of rows) {
      if (r.stored) continue;
      byReason[r.reason!] = (byReason[r.reason!] ?? 0) + 1;
      if (r.is_dir) dirs++;
    }
    const stored = rows.filter((r) => r.stored).length;
    const state =
      own.error_code === 'repo_empty' || snapshot?.status === 'empty'
        ? 'empty'
        : snapshot?.status === 'ready'
          ? 'ready'
          : snapshot?.status === 'storing'
            ? 'storing'
            : snapshot?.status === 'failed' || failedImport(own)
              ? 'failed'
              : own.status === 'queued' || own.status === 'running'
                ? 'pending'
                : 'not-stored';
    return {
      state,
      snapshot: { analysisId: analysis.id, branch: analysis.branch, commitSha: analysis.commit_sha, createdAt: analysis.created_at, analysisStatus: analysis.status, analysisStage: analysis.stage, storedAt: snapshot?.finished_at ?? null },
      counts: { stored, notStored: rows.length - stored, notStoredDirectories: dirs, notStoredFiles: rows.length - stored - dirs, byReason, bytes: snapshot?.bytes ?? 0 },
      truncated: !!snapshot?.truncated,
      storeError: snapshot?.status === 'failed' ? snapshot.error_message : null,
      failure,
      reasons: STORE_EXCLUSION_TEXT,
      entries: rows.map((r) =>
        r.stored
          ? { p: r.path, s: r.size ?? 0, l: r.language ?? 'text', n: r.lines ?? 0, ...(r.masked_lines ? { m: (JSON.parse(r.masked_lines) as number[]).length } : {}) }
          : { p: r.is_dir ? `${r.path}/` : r.path, r: r.reason!, ...(r.is_dir ? { d: 1 } : {}), ...(r.size != null ? { s: r.size } : {}) },
      ),
    };
  }

  private row(ref: CodeRef, path: string): FileRow {
    if (!ref.snapshot) throw new AppError('not_found', 'Files for this snapshot were not stored.', 404);
    const row = this.db.prepare('SELECT * FROM code_files WHERE analysis_id = ? AND path = ?').get(ref.analysis.id, path.replace(/\/$/, '')) as FileRow | undefined;
    if (!row) throw new AppError('not_found', 'This file is not in this snapshot.', 404);
    return row;
  }

  private content(row: FileRow): string {
    const blob = this.db.prepare('SELECT content FROM code_blobs WHERE hash = ?').get(row.blob_hash) as { content: string } | undefined;
    if (!blob) throw new AppError('not_found', 'The stored contents of this file are unavailable. Re-analyze to store them again.', 404);
    return blob.content;
  }

  file(ref: CodeRef, path: string) {
    const row = this.row(ref, path);
    if (!row.stored) return { path: row.path, stored: false as const, directory: !!row.is_dir, reason: row.reason, reasonText: STORE_EXCLUSION_TEXT[row.reason!], size: row.size };
    return {
      path: row.path,
      stored: true as const,
      language: row.language ?? 'text',
      size: row.size ?? 0,
      lines: row.lines ?? 0,
      maskedLines: row.masked_lines ? (JSON.parse(row.masked_lines) as number[]) : [],
      content: this.content(row),
      analysisId: ref.analysis.id,
    };
  }

  outline(ref: CodeRef, path: string) {
    const row = this.row(ref, path);
    if (!row.stored) return { path: row.path, supported: false, symbols: [], language: null };
    return { path: row.path, language: row.language, ...outlineOf(this.content(row), row.language ?? 'text') };
  }

  /** Files importing this one and what it imports, from the snapshot's dependency graph. */
  relations(ref: CodeRef, path: string, graphs: GraphStore) {
    const row = this.row(ref, path);
    const importsAnalyzed = ANALYZABLE_LANGUAGES.has(row.language ?? '');
    if (ref.analysis.status !== 'complete') return { status: 'pending' as const, importsAnalyzed, importers: [], imports: [] };
    const index = graphs.load(ref.analysis.id);
    const d = index ? nodeDetails(index, row.path) : null;
    if (!d) return { status: index ? ('ready' as const) : ('unavailable' as const), importsAnalyzed, importers: [], imports: [] };
    return {
      status: 'ready' as const,
      importsAnalyzed,
      importers: d.consumers
        .map((c) => ({ path: c.source, line: c.line, specifier: c.specifier, symbols: c.symbols, typeOnly: c.typeOnly }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)),
      imports: d.imports.map((i) => ({
        specifier: i.specifier,
        line: i.line,
        symbols: i.symbols,
        typeOnly: i.typeOnly,
        resolved: i.resolved,
        external: i.external,
        target: i.resolved && !i.external ? i.targetPath : null,
        packageName: i.external ? i.targetPath.replace(/^ext:/, '') : null,
        reason: i.resolved ? null : (i.unresolvedReason ?? 'Could not be resolved'),
      })),
    };
  }

  /** Literal search over the snapshot's stored (masked) contents, grouped by file. */
  search(ref: CodeRef, q: { query: string; caseSensitive: boolean; wholeWord: boolean }) {
    if (!ref.snapshot) throw new AppError('not_found', 'Files for this snapshot were not stored.', 404);
    // A literal pattern (the query is escaped), so positions are always in the original text.
    const re = new RegExp(q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), q.caseSensitive ? 'g' : 'gi');
    const started = Date.now();
    const results: { path: string; total: number; matches: { line: number; col: number; len: number; text: string; offset: number }[] }[] = [];
    let matches = 0;
    let filesSearched = 0;
    let truncated = false;
    const page = this.db.prepare(
      'SELECT f.path, b.content FROM code_files f JOIN code_blobs b ON b.hash = f.blob_hash WHERE f.analysis_id = ? AND f.stored = 1 AND f.path > ? ORDER BY f.path LIMIT 200',
    );
    const word = (c: string | undefined) => !!c && /[\w$]/.test(c);
    let after = '';
    outer: for (;;) {
      const rows = page.all(ref.analysis.id, after) as { path: string; content: string }[];
      if (!rows.length) break;
      for (const { path, content } of rows) {
        after = path;
        filesSearched++;
        if (Date.now() - started > SEARCH_LIMITS.budgetMs) {
          truncated = true;
          break outer;
        }
        re.lastIndex = 0;
        let m = re.exec(content);
        if (!m) continue;
        const file = { path, total: 0, matches: [] as (typeof results)[number]['matches'] };
        let line = 1;
        let lineStart = 0;
        let scanned = 0;
        while (m) {
          const at = m.index;
          const len = m[0].length;
          if (!q.wholeWord || (!word(content[at - 1]) && !word(content[at + len]))) {
            for (let i = content.indexOf('\n', scanned); i >= 0 && i < at; i = content.indexOf('\n', i + 1)) {
              line++;
              lineStart = i + 1;
              scanned = i + 1;
            }
            file.total++;
            if (file.matches.length < SEARCH_LIMITS.perFile && matches < SEARCH_LIMITS.matches) {
              let end = content.indexOf('\n', at);
              if (end < 0) end = content.length;
              const col = at - lineStart;
              // Long lines are cut to a window around the match; `offset` says where it starts.
              const offset = end - lineStart > SEARCH_LIMITS.snippet ? Math.max(0, col - 80) : 0;
              const text = content.slice(lineStart + offset, Math.min(end, lineStart + offset + SEARCH_LIMITS.snippet)).replace(/\r$/, '');
              file.matches.push({ line, col: col - offset, len, text, offset });
              matches++;
            }
          }
          m = re.exec(content);
        }
        if (file.total) results.push(file);
        if (results.length >= SEARCH_LIMITS.files || matches >= SEARCH_LIMITS.matches) {
          truncated = true;
          break outer;
        }
      }
    }
    return { query: q.query, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, results, filesSearched, filesMatched: results.length, matches, truncated, limits: SEARCH_LIMITS };
  }
}
