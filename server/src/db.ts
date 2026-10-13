import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    login TEXT,
    token_enc TEXT,
    scopes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_user_id)
  );
  CREATE INDEX accounts_user ON accounts(user_id);
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    intent TEXT NOT NULL,
    user_id TEXT,
    nonce TEXT,
    next TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    full_name TEXT NOT NULL,
    is_private INTEGER NOT NULL DEFAULT 0,
    default_branch TEXT,
    branch TEXT NOT NULL,
    html_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX projects_user_repo ON projects(user_id, full_name);
  CREATE TABLE analyses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    files_scanned INTEGER NOT NULL DEFAULT 0,
    nodes_classified INTEGER NOT NULL DEFAULT 0,
    edges_found INTEGER NOT NULL DEFAULT 0,
    commit_sha TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX analyses_project ON analyses(project_id, created_at);
  CREATE TABLE graphs (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    graph_json TEXT NOT NULL
  );
  CREATE TABLE layouts (
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    layout TEXT NOT NULL,
    positions_json TEXT NOT NULL,
    PRIMARY KEY (analysis_id, layout)
  );
  `,
  // 2: architecture detection (cached per commit and detector version) and read-only share links.
  `
  CREATE TABLE architecture_facts (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    extractor_version INTEGER NOT NULL,
    facts_json TEXT NOT NULL
  );
  CREATE TABLE architectures (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL,
    commit_sha TEXT,
    detector_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    layers_json TEXT,
    summary_json TEXT,
    blast_json TEXT,
    generated_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, cache_key, detector_version)
  );
  CREATE TABLE evidence (
    architecture_id TEXT NOT NULL REFERENCES architectures(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    snippet TEXT,
    detail TEXT NOT NULL,
    PRIMARY KEY (architecture_id, id)
  );
  CREATE TABLE architecture_tools (
    architecture_id TEXT NOT NULL REFERENCES architectures(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    category TEXT NOT NULL,
    layer TEXT NOT NULL,
    confidence TEXT NOT NULL,
    role TEXT,
    ord INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (architecture_id, id)
  );
  CREATE TABLE architecture_edges (
    architecture_id TEXT NOT NULL REFERENCES architectures(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    confidence TEXT NOT NULL,
    is_async INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (architecture_id, id)
  );
  CREATE TABLE architecture_flows (
    architecture_id TEXT NOT NULL REFERENCES architectures(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    confidence TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (architecture_id, id)
  );
  CREATE TABLE architecture_flow_steps (
    architecture_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    mode TEXT NOT NULL,
    explanation TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    edge_id TEXT,
    latency_ms REAL,
    PRIMARY KEY (architecture_id, flow_id, step),
    FOREIGN KEY (architecture_id, flow_id) REFERENCES architecture_flows(architecture_id, id) ON DELETE CASCADE
  );
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX shares_project ON shares(project_id);
  `,
  // Request lifecycle: lane, step kind, labels and branches for each flow step.
  `
  ALTER TABLE architecture_flow_steps ADD COLUMN data_json TEXT;
  `,
  // Collective Intelligence: consent (off unless a row says otherwise), its audit log, and incident
  // tags. These identify the project and stay here; the collective dataset is a separate database.
  `
  CREATE TABLE collective_consent (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE consent_log (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
    schema_version INTEGER NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX consent_log_project ON consent_log(project_id, created_at);
  CREATE TABLE incident_tags (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL,
    node_id TEXT NOT NULL,
    element TEXT NOT NULL,
    occurred_month TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT,
    contributed INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX incident_tags_project ON incident_tags(project_id, created_at);
  `,
  // 6: Automation Engine v3 flow customizations (renames, replacements per project).
  `
  CREATE TABLE main_flow_customizations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    flow_id TEXT NOT NULL,
    replacement_flow_id TEXT,
    custom_name TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, flow_id)
  );
  `,
  // 7: Automation Engine v4 data model (flows, flow_nodes, flow_edges)
  `
  CREATE TABLE flows_v4 (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    coverage INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    pinned_by_user INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
  );
  CREATE INDEX flows_v4_project ON flows_v4(project_id);

  CREATE TABLE flow_nodes_v4 (
    id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    snippet_ref TEXT,
    tools_json TEXT NOT NULL,
    lane TEXT NOT NULL,
    PRIMARY KEY (project_id, flow_id, id),
    FOREIGN KEY (project_id, flow_id) REFERENCES flows_v4(project_id, id) ON DELETE CASCADE
  );

  CREATE TABLE flow_edges_v4 (
    id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    evidence_json TEXT,
    PRIMARY KEY (project_id, flow_id, id),
    FOREIGN KEY (project_id, flow_id) REFERENCES flows_v4(project_id, id) ON DELETE CASCADE
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(dataDir: string, file = 'codepilot.sqlite'): Db {
  const db = new DatabaseSync(file === ':memory:' ? ':memory:' : path.join(dataDir, file));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export const now = () => new Date().toISOString();
