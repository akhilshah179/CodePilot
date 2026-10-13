import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { validateFingerprint, type Fingerprint } from './schema.ts';

/*
 * The collective dataset lives in its own database file, apart from users, projects and analyses.
 * Rows carry only a keyed pseudonym (an HMAC the collective data cannot be reversed from), a month
 * and allowlisted structural values. Tables are WITHOUT ROWID and keyed by those HMACs, so not even
 * insertion order links a row back to when a project was analyzed.
 */

const MIGRATIONS = [
  `
  CREATE TABLE collective_fingerprints (
    id TEXT PRIMARY KEY,
    contributor TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    month TEXT NOT NULL,
    data_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    current INTEGER NOT NULL DEFAULT 1
  ) WITHOUT ROWID;
  CREATE INDEX collective_fingerprints_contributor ON collective_fingerprints(contributor);
  CREATE TABLE pattern_outcomes (
    id TEXT PRIMARY KEY,
    contributor TEXT NOT NULL,
    element TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('incident')),
    month TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  ) WITHOUT ROWID;
  CREATE INDEX pattern_outcomes_contributor ON pattern_outcomes(contributor);
  CREATE TABLE aggregate_statistics (
    key TEXT PRIMARY KEY,
    population TEXT NOT NULL,
    metric TEXT NOT NULL,
    n INTEGER NOT NULL,
    counts_json TEXT NOT NULL,
    computed_month TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE discovered_patterns (
    id TEXT PRIMARY KEY,
    antecedent_json TEXT NOT NULL,
    consequent TEXT NOT NULL,
    population TEXT NOT NULL,
    n INTEGER NOT NULL,
    support INTEGER NOT NULL,
    antecedent_support INTEGER NOT NULL,
    confidence REAL NOT NULL,
    baseline REAL NOT NULL,
    lift REAL NOT NULL,
    chi2 REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'rejected')),
    claim TEXT NOT NULL DEFAULT 'correlation' CHECK (claim IN ('correlation', 'causal')),
    review_note TEXT,
    reviewed_month TEXT,
    discovered_month TEXT NOT NULL,
    current INTEGER NOT NULL DEFAULT 1
  ) WITHOUT ROWID;
  `,
];

export interface StoredFingerprint {
  id: string;
  contributor: string;
  month: string;
  data: Fingerprint;
  active: boolean;
  current: boolean;
}

export interface AggregateRow {
  population: string;
  metric: string;
  n: number;
  counts: Record<string, number>;
  computedMonth: string;
}

export interface DiscoveredPattern {
  id: string;
  antecedent: string[];
  consequent: string;
  population: string;
  n: number;
  support: number;
  antecedentSupport: number;
  confidence: number;
  baseline: number;
  lift: number;
  chi2: number;
  status: 'pending_review' | 'approved' | 'rejected';
  claim: 'correlation' | 'causal';
  reviewNote: string | null;
  reviewedMonth: string | null;
  discoveredMonth: string;
  current: boolean;
}

export class CollectiveStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string, file = 'collective.sqlite') {
    this.db = new DatabaseSync(file === ':memory:' ? ':memory:' : path.join(dataDir, file));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.db.exec(MIGRATIONS[version]);
      version++;
      this.db.prepare('UPDATE schema_version SET version = ?').run(version);
    }
  }

  close() {
    this.db.close();
  }

  /**
   * Store the fingerprint of one snapshot. It becomes the contributor's current fingerprint; earlier
   * snapshots stay as history but no longer count. Re-storing the same snapshot replaces only it.
   */
  putFingerprint(id: string, contributor: string, fp: Fingerprint) {
    const data = validateFingerprint(fp);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE collective_fingerprints SET current = 0 WHERE contributor = ? AND id <> ?').run(contributor, id);
      this.db
        .prepare(
          `INSERT INTO collective_fingerprints (id, contributor, schema_version, month, data_json, active, current) VALUES (?, ?, ?, ?, ?, 1, 1)
           ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, month = excluded.month, data_json = excluded.data_json, active = 1, current = 1`,
        )
        .run(id, contributor, data.v, data.month, JSON.stringify(data));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Revocation: every fingerprint and outcome of the contributor stops counting. */
  deactivate(contributor: string): { fingerprints: number; outcomes: number } {
    const f = this.db.prepare('UPDATE collective_fingerprints SET active = 0 WHERE contributor = ? AND active = 1').run(contributor);
    const o = this.db.prepare('UPDATE pattern_outcomes SET active = 0 WHERE contributor = ? AND active = 1').run(contributor);
    return { fingerprints: Number(f.changes), outcomes: Number(o.changes) };
  }

  /** The contributor's own rows — callers pass only the pseudonym of the project they have access to. */
  ownFingerprints(contributor: string): StoredFingerprint[] {
    const rows = this.db.prepare('SELECT * FROM collective_fingerprints WHERE contributor = ? ORDER BY current DESC, month DESC').all(contributor) as unknown as FpRow[];
    return rows.map(toStored);
  }

  ownOutcomes(contributor: string): { element: string; month: string; active: boolean }[] {
    return (this.db.prepare('SELECT element, month, active FROM pattern_outcomes WHERE contributor = ? ORDER BY month DESC, element').all(contributor) as { element: string; month: string; active: number }[]).map((r) => ({ ...r, active: !!r.active }));
  }

  /** Fingerprints that count: active (consent not revoked) and current (latest snapshot of each contributor). */
  population(): StoredFingerprint[] {
    return (this.db.prepare('SELECT * FROM collective_fingerprints WHERE active = 1 AND current = 1').all() as unknown as FpRow[]).map(toStored);
  }

  activeOutcomes(): { contributor: string; element: string }[] {
    return this.db.prepare('SELECT DISTINCT contributor, element FROM pattern_outcomes WHERE active = 1').all() as { contributor: string; element: string }[];
  }

  putOutcome(id: string, contributor: string, element: string, month: string) {
    this.db.prepare("INSERT INTO pattern_outcomes (id, contributor, element, outcome, month, active) VALUES (?, ?, ?, 'incident', ?, 1) ON CONFLICT(id) DO UPDATE SET active = 1").run(id, contributor, element, month);
  }

  replaceAggregates(rows: AggregateRow[]) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM aggregate_statistics');
      const ins = this.db.prepare('INSERT INTO aggregate_statistics (key, population, metric, n, counts_json, computed_month) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(`${r.population}|${r.metric}`, r.population, r.metric, r.n, JSON.stringify(r.counts), r.computedMonth);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  aggregate(population: string, metric: string): AggregateRow | null {
    const r = this.db.prepare('SELECT * FROM aggregate_statistics WHERE key = ?').get(`${population}|${metric}`) as { population: string; metric: string; n: number; counts_json: string; computed_month: string } | undefined;
    return r ? { population: r.population, metric: r.metric, n: r.n, counts: JSON.parse(r.counts_json), computedMonth: r.computed_month } : null;
  }

  populationSize(population: string): number {
    return this.aggregate(population, 'n')?.n ?? 0;
  }

  /** New rules start pending review; a rule seen again keeps its review decision and gets fresh statistics. */
  upsertPatterns(found: Omit<DiscoveredPattern, 'status' | 'claim' | 'reviewNote' | 'reviewedMonth' | 'current'>[]) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('UPDATE discovered_patterns SET current = 0');
      const up = this.db.prepare(
        `INSERT INTO discovered_patterns (id, antecedent_json, consequent, population, n, support, antecedent_support, confidence, baseline, lift, chi2, status, discovered_month, current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, 1)
         ON CONFLICT(id) DO UPDATE SET n = excluded.n, support = excluded.support, antecedent_support = excluded.antecedent_support, confidence = excluded.confidence,
           baseline = excluded.baseline, lift = excluded.lift, chi2 = excluded.chi2, current = 1`,
      );
      for (const p of found) up.run(p.id, JSON.stringify(p.antecedent), p.consequent, p.population, p.n, p.support, p.antecedentSupport, p.confidence, p.baseline, p.lift, p.chi2, p.discoveredMonth);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  patterns(filter: { status?: DiscoveredPattern['status']; currentOnly?: boolean } = {}): DiscoveredPattern[] {
    const where = [filter.status ? 'status = ?' : null, filter.currentOnly ? 'current = 1' : null].filter(Boolean).join(' AND ');
    const rows = this.db.prepare(`SELECT * FROM discovered_patterns${where ? ` WHERE ${where}` : ''} ORDER BY lift DESC, id`).all(...(filter.status ? [filter.status] : [])) as unknown as PatternRow[];
    return rows.map(toPattern);
  }

  review(id: string, decision: 'approved' | 'rejected', claim: 'correlation' | 'causal', note: string | null, month: string): DiscoveredPattern | null {
    this.db.prepare('UPDATE discovered_patterns SET status = ?, claim = ?, review_note = ?, reviewed_month = ? WHERE id = ?').run(decision, claim, note, month, id);
    const r = this.db.prepare('SELECT * FROM discovered_patterns WHERE id = ?').get(id) as PatternRow | undefined;
    return r ? toPattern(r) : null;
  }
}

interface FpRow {
  id: string;
  contributor: string;
  month: string;
  data_json: string;
  active: number;
  current: number;
}
const toStored = (r: FpRow): StoredFingerprint => ({ id: r.id, contributor: r.contributor, month: r.month, data: JSON.parse(r.data_json), active: !!r.active, current: !!r.current });

interface PatternRow {
  id: string;
  antecedent_json: string;
  consequent: string;
  population: string;
  n: number;
  support: number;
  antecedent_support: number;
  confidence: number;
  baseline: number;
  lift: number;
  chi2: number;
  status: DiscoveredPattern['status'];
  claim: DiscoveredPattern['claim'];
  review_note: string | null;
  reviewed_month: string | null;
  discovered_month: string;
  current: number;
}
const toPattern = (r: PatternRow): DiscoveredPattern => ({
  id: r.id,
  antecedent: JSON.parse(r.antecedent_json),
  consequent: r.consequent,
  population: r.population,
  n: r.n,
  support: r.support,
  antecedentSupport: r.antecedent_support,
  confidence: r.confidence,
  baseline: r.baseline,
  lift: r.lift,
  chi2: r.chi2,
  status: r.status,
  claim: r.claim,
  reviewNote: r.review_note,
  reviewedMonth: r.reviewed_month,
  discoveredMonth: r.discovered_month,
  current: !!r.current,
});
