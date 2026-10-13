import { FILE_NODE_TYPES } from '@codepilot/analyzer';
import { FINDING_CODES, LAYERS } from '@codepilot/analyzer/architecture';

/*
 * The collective fingerprint allowlist. A fingerprint is the ONLY thing a project contributes to
 * Collective Intelligence, and every field and every value in it is enumerated here: bucket labels,
 * catalogue categories, layer names, finding codes. Nothing free-form can pass validation, so no
 * path, name, identifier, snippet or exact count can enter the collective dataset.
 */

export const FINGERPRINT_VERSION = 1;

/** Logarithmic buckets for counts that could otherwise identify a repository. */
export const COUNT_BUCKETS = ['0', '1-9', '10-49', '50-99', '100-249', '250-499', '500-999', '1k-2.5k', '2.5k-5k', '5k-10k', '10k+'] as const;
export const LOC_BUCKETS = ['<1k', '1k-5k', '5k-20k', '20k-50k', '50k-100k', '100k-250k', '250k-1M', '1M+'] as const;
export const DENSITY_BUCKETS = ['<1', '1-2', '2-4', '4-8', '8+'] as const;
export const FAN_OUT_BUCKETS = ['0-2', '3-5', '6-10', '11-20', '21+'] as const;
export const FAN_IN_BUCKETS = ['0-5', '6-20', '21-50', '51-100', '101+'] as const;
export const CYCLE_BUCKETS = ['0', '1', '2-5', '6-20', '21+'] as const;
export const APP_BUCKETS = ['0', '1', '2', '3-5', '6+'] as const;
export const LAYER_COUNTS = ['0', '1', '2', '3', '4', '5', '6', '7'] as const;
export const SIZE_BANDS = ['small', 'medium', 'large'] as const;

export const PATTERNS = ['monolith', 'modular monolith', 'microservices', 'multi-service', 'serverless', 'event-driven', 'static frontend', 'undetermined'] as const;

/** Architecture-node categories from the technology catalogue (a fixed vocabulary, never product names). */
export const TOOL_CATEGORIES = [
  'frontend', 'framework', 'runtime', 'database', 'cache', 'search', 'storage', 'queue', 'worker', 'orm', 'auth', 'payments', 'email', 'messaging', 'ai',
  'observability', 'http-client', 'api', 'cloud', 'container', 'orchestration', 'iac', 'ci', 'hosting', 'proxy', 'realtime', 'analytics', 'service', 'application',
] as const;

/** Relationship kinds between categories, from the analyzer's fixed connection vocabulary. */
export const RELATION_KINDS = [
  'REST', 'HTTP', 'gRPC', 'GraphQL', 'WebSocket', 'SQL', 'query', 'cache read', 'cache write', 'pub/sub', 'publish', 'consume', 'enqueue', 'object storage', 'webhook',
  'OAuth', 'auth', 'API call', 'email', 'proxy', 'depends on', 'deploys', 'builds', 'tests', 'hosts', 'configures', 'uses',
] as const;

/** Structural elements an incident outcome may be attached to (never the element itself). */
export const OUTCOME_ELEMENTS = [...FILE_NODE_TYPES.map((t) => `file:${t}`), ...TOOL_CATEGORIES.map((c) => `category:${c}`)] as const;

export const FINDING_CODE_LIST = FINDING_CODES;
export const LAYER_LIST = LAYERS;

export interface Fingerprint {
  v: number;
  month: string;
  size: { files: (typeof COUNT_BUCKETS)[number]; loc: (typeof LOC_BUCKETS)[number]; band: (typeof SIZE_BANDS)[number] };
  nodesByType: Partial<Record<(typeof FILE_NODE_TYPES)[number], (typeof COUNT_BUCKETS)[number]>>;
  topology: {
    edges: (typeof COUNT_BUCKETS)[number];
    density: (typeof DENSITY_BUCKETS)[number];
    fanOutP90: (typeof FAN_OUT_BUCKETS)[number];
    fanInMax: (typeof FAN_IN_BUCKETS)[number];
    cycles: (typeof CYCLE_BUCKETS)[number];
  };
  architecture: {
    pattern: (typeof PATTERNS)[number];
    layers: (typeof LAYERS)[number][];
    layerCount: (typeof LAYER_COUNTS)[number];
    apps: (typeof APP_BUCKETS)[number];
    toolCategories: (typeof TOOL_CATEGORIES)[number][];
    /** `sourceCategory>targetCategory:relation`, e.g. `application>database:SQL`. */
    relations: string[];
  };
  /** Finding codes present (risks and strengths), never their titles or evidence. */
  risks: (typeof FINDING_CODES)[number][];
  strengths: (typeof FINDING_CODES)[number][];
}

/** Human-readable description of every field, served to the privacy explanation. */
export const SCHEMA_DOC = {
  version: FINGERPRINT_VERSION,
  fields: [
    { field: 'month', meaning: 'Month the snapshot was analyzed (YYYY-MM). No day or time.' },
    { field: 'size.files', meaning: 'Number of source files, as a range', values: COUNT_BUCKETS },
    { field: 'size.loc', meaning: 'Lines of code, as a range', values: LOC_BUCKETS },
    { field: 'size.band', meaning: 'small (< 100 files), medium (100–999), large (1,000+)', values: SIZE_BANDS },
    { field: 'nodesByType.<type>', meaning: 'Files of each classified type (route, page, component, service…), as ranges', values: COUNT_BUCKETS },
    { field: 'topology.edges', meaning: 'Number of resolved internal imports, as a range', values: COUNT_BUCKETS },
    { field: 'topology.density', meaning: 'Imports per file, as a range', values: DENSITY_BUCKETS },
    { field: 'topology.fanOutP90', meaning: '90th-percentile number of internal imports per file, as a range', values: FAN_OUT_BUCKETS },
    { field: 'topology.fanInMax', meaning: 'Most files depending on a single file, as a range', values: FAN_IN_BUCKETS },
    { field: 'topology.cycles', meaning: 'Number of circular import chains, as a range', values: CYCLE_BUCKETS },
    { field: 'architecture.pattern', meaning: 'Detected architecture pattern', values: PATTERNS },
    { field: 'architecture.layers', meaning: 'Architecture layers present', values: LAYERS },
    { field: 'architecture.layerCount', meaning: 'How many layers are present', values: LAYER_COUNTS },
    { field: 'architecture.apps', meaning: 'Runnable applications built from the repository, as a range', values: APP_BUCKETS },
    { field: 'architecture.toolCategories', meaning: 'Technology categories present (database, cache, queue…) — never product names', values: TOOL_CATEGORIES },
    { field: 'architecture.relations', meaning: 'Connections between categories, e.g. application>database:SQL', values: ['<category>><category>:<relation>'] },
    { field: 'risks', meaning: 'Structural risk codes detected', values: FINDING_CODES },
    { field: 'strengths', meaning: 'Resilience and practice codes detected', values: FINDING_CODES },
  ],
  never: [
    'source code or file contents',
    'file paths or file names',
    'repository, owner or organization names',
    'function, class, component or variable names',
    'comments, commit messages or commit hashes',
    'environment variables, secrets or credentials',
    'IP addresses, hostnames or URLs',
    'exact file, line, node or edge counts',
    'incident descriptions',
  ],
};

/* ------------------------------------------------------------------ validation */

export class FingerprintRejected extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`Fingerprint rejected at ${path}: ${reason}`);
  }
}

const oneOf = (path: string, v: unknown, allowed: readonly string[]) => {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new FingerprintRejected(path, `value is not in the allowlist`);
};
const exactKeys = (path: string, v: unknown, keys: readonly string[], optional = false) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FingerprintRejected(path, 'expected an object');
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new FingerprintRejected(`${path}.${k}`, 'field is not in the allowlist');
  if (!optional) for (const k of keys) if (!(k in v)) throw new FingerprintRejected(`${path}.${k}`, 'required field is missing');
};
const setOf = (path: string, v: unknown, allowed: readonly string[] | ((s: string) => boolean), max: number) => {
  if (!Array.isArray(v)) throw new FingerprintRejected(path, 'expected a list');
  if (v.length > max) throw new FingerprintRejected(path, 'too many values');
  const ok = typeof allowed === 'function' ? allowed : (s: string) => allowed.includes(s);
  for (const [i, x] of v.entries()) if (typeof x !== 'string' || !ok(x)) throw new FingerprintRejected(`${path}[${i}]`, 'value is not in the allowlist');
  if (new Set(v).size !== v.length) throw new FingerprintRejected(path, 'duplicate values');
  const sorted = [...v].sort();
  if (sorted.some((x, i) => x !== v[i])) throw new FingerprintRejected(path, 'values must be sorted (deterministic form)');
};

export function isRelation(s: string): boolean {
  const m = /^([a-z-]+)>([a-z-]+):(.+)$/.exec(s);
  return !!m && (TOOL_CATEGORIES as readonly string[]).includes(m[1]) && (TOOL_CATEGORIES as readonly string[]).includes(m[2]) && (RELATION_KINDS as readonly string[]).includes(m[3]);
}

/** Throws unless `fp` conforms exactly to the allowlist. Returns it typed. */
export function validateFingerprint(fp: unknown): Fingerprint {
  exactKeys('fingerprint', fp, ['v', 'month', 'size', 'nodesByType', 'topology', 'architecture', 'risks', 'strengths']);
  const f = fp as Record<string, unknown>;
  if (f.v !== FINGERPRINT_VERSION) throw new FingerprintRejected('v', 'unknown schema version');
  if (typeof f.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) throw new FingerprintRejected('month', 'expected YYYY-MM');

  exactKeys('size', f.size, ['files', 'loc', 'band']);
  const size = f.size as Record<string, unknown>;
  oneOf('size.files', size.files, COUNT_BUCKETS);
  oneOf('size.loc', size.loc, LOC_BUCKETS);
  oneOf('size.band', size.band, SIZE_BANDS);

  exactKeys('nodesByType', f.nodesByType, FILE_NODE_TYPES, true);
  for (const [k, v] of Object.entries(f.nodesByType as object)) oneOf(`nodesByType.${k}`, v, COUNT_BUCKETS);

  exactKeys('topology', f.topology, ['edges', 'density', 'fanOutP90', 'fanInMax', 'cycles']);
  const t = f.topology as Record<string, unknown>;
  oneOf('topology.edges', t.edges, COUNT_BUCKETS);
  oneOf('topology.density', t.density, DENSITY_BUCKETS);
  oneOf('topology.fanOutP90', t.fanOutP90, FAN_OUT_BUCKETS);
  oneOf('topology.fanInMax', t.fanInMax, FAN_IN_BUCKETS);
  oneOf('topology.cycles', t.cycles, CYCLE_BUCKETS);

  exactKeys('architecture', f.architecture, ['pattern', 'layers', 'layerCount', 'apps', 'toolCategories', 'relations']);
  const a = f.architecture as Record<string, unknown>;
  oneOf('architecture.pattern', a.pattern, PATTERNS);
  setOf('architecture.layers', a.layers, LAYERS, LAYERS.length);
  oneOf('architecture.layerCount', a.layerCount, LAYER_COUNTS);
  if (Number(a.layerCount) !== (a.layers as unknown[]).length) throw new FingerprintRejected('architecture.layerCount', 'does not match layers');
  oneOf('architecture.apps', a.apps, APP_BUCKETS);
  setOf('architecture.toolCategories', a.toolCategories, TOOL_CATEGORIES, TOOL_CATEGORIES.length);
  setOf('architecture.relations', a.relations, isRelation, 120);

  setOf('risks', f.risks, FINDING_CODES, FINDING_CODES.length);
  setOf('strengths', f.strengths, FINDING_CODES, FINDING_CODES.length);
  return fp as Fingerprint;
}
