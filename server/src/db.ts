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
  // Automation Engine: main flows per analysis and engine schema version, with stored layout.
  `
  CREATE TABLE automation_runs (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT,
    schema_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    project_type TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX automation_runs_commit ON automation_runs(project_id, commit_sha, schema_version);
  CREATE TABLE flows (
    id TEXT NOT NULL,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT,
    schema_version INTEGER NOT NULL,
    flow_key TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    cycle TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    coverage INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    rank INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (analysis_id, id)
  );
  CREATE TABLE flow_nodes (
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    flow_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    lane TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    tools_json TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (analysis_id, flow_id, id)
  );
  CREATE TABLE flow_edges (
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    flow_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    evidence_json TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (analysis_id, flow_id, id)
  );
  CREATE TABLE automation_prefs (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    selected_json TEXT NOT NULL DEFAULT '[]',
    names_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  `,
  // Code tab: the files of each snapshot as imported (secrets masked), deduplicated by content,
  // with every entry that was not stored and why; and the stage an analysis failed at.
  `
  CREATE TABLE code_snapshots (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT,
    status TEXT NOT NULL,
    stored INTEGER NOT NULL DEFAULT 0,
    not_stored INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX code_snapshots_project ON code_snapshots(project_id, created_at);
  CREATE TABLE code_blobs (
    hash TEXT PRIMARY KEY,
    content TEXT NOT NULL
  );
  CREATE TABLE code_files (
    analysis_id TEXT NOT NULL REFERENCES code_snapshots(analysis_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    stored INTEGER NOT NULL,
    is_dir INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    size INTEGER,
    language TEXT,
    lines INTEGER,
    blob_hash TEXT,
    masked_lines TEXT,
    PRIMARY KEY (analysis_id, path)
  );
  CREATE INDEX code_files_blob ON code_files(blob_hash);
  ALTER TABLE analyses ADD COLUMN failed_stage TEXT;
  `,
  // 6: Workspace RBAC: project_members mapping with role checks (owner, admin, member, viewer).
  `
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX project_members_user ON project_members(user_id);
  INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at)
  SELECT id, user_id, 'owner', created_at FROM projects WHERE user_id IS NOT NULL;
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
