import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository, type DependencyGraph } from '../src/index.ts';
import { computeLayout } from '../src/layout.ts';
import { EXPECTED_EDGES, FIXTURE, edgeKey as key } from './expected.ts';

let graph: DependencyGraph;

beforeAll(async () => {
  graph = await analyzeRepository(FIXTURE);
});

describe('fixture repository: dependency edges', () => {
  it('produces exactly the hand-verified edge set (no missing, no extra edges)', () => {
    const actual = graph.edges.map(key).sort();
    const expected = EXPECTED_EDGES.map(([source, target, kind, line, resolved]) => key({ source, target, kind, line, resolved })).sort();
    expect(actual).toEqual(expected);
  });

  it('traces every edge to a source line that contains its specifier', () => {
    for (const e of graph.edges) {
      expect(e.line).toBeGreaterThan(0);
      const lines = readFileSync(path.join(FIXTURE, e.source), 'utf8').split('\n');
      const text = lines[e.line - 1];
      expect(text, `${e.id}`).toContain(`'${e.specifier}'`);
    }
  });

  it('never fabricates edges: every endpoint is a real file, a declared external package, or an explicit unresolved marker', () => {
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
      if (e.resolved && !e.external) {
        // Resolved internal targets exist on disk.
        expect(() => readFileSync(path.join(FIXTURE, e.target))).not.toThrow();
        expect(e.resolution).toBeTruthy();
      }
      if (!e.resolved) {
        expect(e.target.startsWith('unresolved:')).toBe(true);
        expect(e.unresolved_reason).toBeTruthy();
      }
    }
  });

  it('records imported symbols as written', () => {
    const find = (s: string, t: string) => graph.edges.find((e) => e.source === s && e.target === t)!;
    expect(find('src/app.tsx', 'src/components/index.ts').symbols).toEqual(['Button', 'Card']);
    expect(find('src/app.tsx', 'ext:react').symbols).toEqual(['default']);
    expect(find('src/main.ts', 'src/styles.css').symbols).toEqual([]);
    expect(find('src/components/index.ts', 'src/components/Button.tsx').symbols).toEqual(['*']);
    expect(find('src/components/index.ts', 'src/components/Legacy.jsx').symbols).toEqual(['default']);
    expect(find('src/server.ts', 'src/routes/users.ts').symbols).toEqual(['router']);
    expect(find('src/main.ts', 'src/config/types.ts').typeOnly).toBe(true);
    expect(find('src/main.ts', 'src/app.tsx').typeOnly).toBe(false);
  });

  it('resolves static imports, re-exports, dynamic literal imports and CommonJS require', () => {
    const kinds = new Set(graph.edges.filter((e) => e.resolved).map((e) => e.kind));
    expect(kinds).toEqual(new Set(['static', 're-export', 'dynamic', 'require']));
  });

  it('resolves tsconfig path aliases through a solution-style tsconfig', () => {
    const e = graph.edges.find((x) => x.source === 'src/main.ts' && x.line === 4)!;
    expect(e.target).toBe('src/lib/format.ts');
    expect(e.resolution).toContain('tsconfig paths "~lib/*" (tsconfig.app.json)');
  });

  it('resolves extensions, index files and .js → .ts source mapping', () => {
    const via = (s: string, line: number) => graph.edges.find((x) => x.source === s && x.line === line)!.resolution;
    expect(via('src/main.ts', 1)).toContain('extension .tsx');
    expect(via('src/app.tsx', 2)).toContain('index file index.ts');
    expect(via('src/main.ts', 6)).toContain('index file index.tsx');
    expect(via('src/app.tsx', 3)).toContain('TypeScript source for .js');
  });

  it('resolves workspace packages via exports, and package.json imports', () => {
    const via = (s: string, line: number) => graph.edges.find((x) => x.source === s && x.line === line)!;
    expect(via('src/services/session.ts', 1).target).toBe('packages/shared/src/index.ts');
    expect(via('src/services/session.ts', 2).target).toBe('packages/shared/src/tokens.ts');
    expect(via('src/hooks/useSession.ts', 1).resolution).toContain('package.json imports "#internal/*"');
  });

  it('surfaces unresolved imports with a reason instead of guessing', () => {
    const unresolved = graph.edges.filter((e) => !e.resolved);
    expect(unresolved.map((e) => e.specifier).sort()).toEqual(['./does-not-exist', '@fixture/broken', '@fixture/shared/private']);
    const broken = unresolved.find((e) => e.specifier === '@fixture/broken')!;
    expect(broken.unresolved_reason).toContain('./dist/index.js');
    const priv = unresolved.find((e) => e.specifier === '@fixture/shared/private')!;
    expect(priv.unresolved_reason).toContain('does not export');
    // The file exists, but the package does not export it — no edge to it may be invented.
    expect(graph.edges.some((e) => e.target === 'packages/shared/src/private.ts')).toBe(false);
    expect(graph.summary.totals.unresolvedImports).toBe(3);
    expect(graph.nodes.filter((n) => n.type === 'unresolved')).toHaveLength(3);
  });

  it('does not turn external packages into source-file nodes', () => {
    const ext = graph.nodes.filter((n) => n.type === 'external').map((n) => n.id).sort();
    expect(ext).toEqual(['ext:express', 'ext:node:path', 'ext:react', 'ext:vite']);
    for (const n of graph.nodes.filter((x) => x.type === 'external')) expect(n.size).toBe(0);
  });

  it('reports computed dynamic imports as diagnostics without creating edges', () => {
    expect(graph.files['src/dynamic-computed.ts'].diagnostics).toEqual([
      expect.objectContaining({ line: 4, code: 'non-literal-dynamic-import' }),
    ]);
    expect(graph.edges.some((e) => e.source === 'src/dynamic-computed.ts')).toBe(false);
  });
});

describe('fixture repository: exports', () => {
  it('extracts exports with line numbers that match the source', () => {
    expect(graph.files['src/lib/format.ts'].exports).toEqual([
      { name: 'formatDate', kind: 'function', line: 1 },
      { name: 'cn', kind: 'variable', line: 5 },
    ]);
    expect(graph.files['src/components/index.ts'].exports).toEqual([
      { name: '*', kind: 're-export', line: 1, from: './Button' },
      { name: 'Card', kind: 're-export', line: 2, from: './Card' },
      { name: 'Legacy', kind: 're-export', line: 3, from: './Legacy.jsx' },
    ]);
    expect(graph.files['src/lib/legacy-helpers.cjs'].exports).toEqual([{ name: 'module.exports', kind: 'commonjs', line: 3 }]);
    expect(graph.files['src/pages/admin/index.tsx'].exports).toEqual([{ name: 'default', kind: 'default', line: 3 }]);
    expect(graph.files['src/config/types.ts'].exports).toEqual([{ name: 'Config', kind: 'interface', line: 1 }]);
  });
});

describe('fixture repository: graph analysis', () => {
  it('detects circular dependency chains with traceable hops', () => {
    expect(graph.summary.cycles.map((c) => c.members)).toEqual([
      ['src/components/Card.tsx', 'src/components/index.ts'],
      ['src/utils/a.ts', 'src/utils/b.ts'],
    ]);
    const first = graph.summary.cycles[0];
    expect(first.chain).toEqual([
      { source: 'src/components/Card.tsx', target: 'src/components/index.ts', line: 1 },
      { source: 'src/components/index.ts', target: 'src/components/Card.tsx', line: 2 },
    ]);
  });

  it('detects orphans', () => {
    expect(graph.summary.orphans).toEqual([
      { id: 'packages/broken/src/index.ts', hasDependencies: false },
      { id: 'packages/shared/src/private.ts', hasDependencies: false },
      { id: 'src/dynamic-computed.ts', hasDependencies: false },
      { id: 'src/isolated.ts', hasDependencies: false },
      { id: 'src/orphan.ts', hasDependencies: true },
      { id: 'src/widgets/Hello.vue', hasDependencies: true },
    ]);
  });

  it('detects entry points with evidence', () => {
    const byId = Object.fromEntries(graph.summary.entryPoints.map((e) => [e.id, e.reasons]));
    expect(Object.keys(byId).sort()).toEqual([
      'packages/shared/src/index.ts',
      'packages/shared/src/tokens.ts',
      'src/app.test.ts',
      'src/main.ts',
      'src/server.ts',
      'vite.config.ts',
    ]);
    expect(byId['src/main.ts']).toEqual(['"main" in package.json', '<script src> in index.html']);
    expect(byId['src/server.ts']).toEqual(['npm script "serve" in package.json']);
  });

  it('ranks most depended-on files by unique consumers', () => {
    expect(graph.summary.mostDependedOn[0]).toEqual({ id: 'src/lib/format.ts', count: 4 });
    expect(graph.summary.mostDependencies[0]).toEqual({ id: 'src/main.ts', count: 5 });
  });

  it('classifies nodes deterministically with evidence', () => {
    const t = (id: string) => graph.nodes.find((n) => n.id === id)!;
    expect(t('src/components/Button.tsx').type).toBe('component');
    expect(t('src/pages/admin/index.tsx').type).toBe('page');
    expect(t('src/routes/users.ts').type).toBe('route');
    expect(t('src/services/session.ts').type).toBe('service');
    expect(t('src/lib/format.ts').type).toBe('utility');
    expect(t('vite.config.ts').type).toBe('config');
    expect(t('package.json').type).toBe('config');
    for (const n of graph.nodes) expect(n.classification_evidence.length).toBeGreaterThan(0);
  });

  it('is deterministic across runs', async () => {
    const again = await analyzeRepository(FIXTURE);
    expect({ ...again, generatedAt: '' }).toEqual({ ...graph, generatedAt: '' });
    const ids = graph.nodes.map((n) => ({ id: n.id, type: n.type, directory: n.directory }));
    expect(computeLayout(ids, graph.edges, 'force')).toEqual(computeLayout(ids, graph.edges, 'force'));
  });
});

describe('security: exclusions and secrets', () => {
  let dir: string;
  let secured: DependencyGraph;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codepilot-fixture-'));
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(path.join(dir, '.env'), 'API_TOKEN=supersecretvalue123\n');
    writeFileSync(path.join(dir, '.env.production'), 'DB_PASSWORD=hunter2hunter2\n');
    mkdirSync(path.join(dir, 'certs'));
    writeFileSync(path.join(dir, 'certs/server.key'), '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n');
    writeFileSync(path.join(dir, 'src/embedded-key.ts'), "export const pem = `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`;\n");
    writeFileSync(path.join(dir, 'src/aws.ts'), "export const awsKeyId = 'AKIAIOSFODNN7EXAMPLE';\n");
    writeFileSync(path.join(dir, 'src/schema.generated.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(dir, 'src/codegen.ts'), '// @generated by protoc\nexport const y = 2;\n');
    mkdirSync(path.join(dir, 'dist'));
    writeFileSync(path.join(dir, 'dist/bundle.js'), "import './secret';\n");
    mkdirSync(path.join(dir, 'node_modules/react'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/react/index.js'), 'module.exports = {};\n');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
    secured = await analyzeRepository(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('never includes .env files, key files, excluded directories, lockfiles or generated files as nodes', () => {
    const ids = new Set(secured.nodes.map((n) => n.id));
    for (const p of ['.env', '.env.production', 'certs/server.key', 'src/embedded-key.ts', 'dist/bundle.js', 'node_modules/react/index.js', 'package-lock.json', 'src/schema.generated.ts', 'src/codegen.ts']) {
      expect(ids.has(p), p).toBe(false);
    }
    expect(secured.scan.excluded['secret-file']).toBe(3);
    expect(secured.scan.excluded['secret-content']).toBe(1);
    expect(secured.scan.excluded.generated).toBe(2);
    expect(secured.scan.excludedDirectories).toEqual(['dist', 'node_modules']);
  });

  it('flags files containing credential-shaped values without storing the value', () => {
    const aws = secured.nodes.find((n) => n.id === 'src/aws.ts')!;
    expect(aws.flags?.secretsDetected).toBe(1);
    const serialized = JSON.stringify(secured);
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'supersecretvalue123', 'hunter2hunter2', 'MIIEvQ', 'BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps the dependency edge set unchanged by excluded content', () => {
    const base = graph.edges.map(key).sort();
    const withExtras = secured.edges.map(key).sort();
    expect(withExtras).toEqual(base);
  });
});
