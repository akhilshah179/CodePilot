import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository, type DependencyGraph } from '../src/index.ts';
import { computeLayout, LAYOUTS } from '../src/layout.ts';

const FILES = 1200;
const IMPORTS_PER_FILE = 5;
const DIRS = ['components', 'services', 'utils', 'pages', 'routes', 'lib'];

const fileName = (i: number) => `src/${DIRS[i % DIRS.length]}/m${i}.ts`;
const targetsOf = (i: number) => {
  const out: number[] = [];
  for (let k = 1; out.length < IMPORTS_PER_FILE; k++) {
    const t = (i * 7 + k * 13) % FILES;
    if (t !== i && !out.includes(t)) out.push(t);
  }
  return out;
};

describe('scale: 1,200 files / 6,000 imports', () => {
  let dir: string;
  let graph: DependencyGraph;
  let analyzeMs = 0;
  const expected = new Set<string>();

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'codepilot-scale-'));
    for (const d of DIRS) mkdirSync(path.join(dir, 'src', d), { recursive: true });
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    for (let i = 0; i < FILES; i++) {
      const lines = targetsOf(i).map((t, k) => {
        const target = fileName(t);
        const rel = path.posix.relative(path.posix.dirname(fileName(i)), target).replace(/\.ts$/, '');
        const spec = rel.startsWith('.') ? rel : './' + rel;
        const alias = '@/' + target.slice(4, -3);
        const kind = ['static', 're-export', 'dynamic', 'require', 'static'][k];
        expected.add(`${fileName(i)}>${target}>${kind}>${k + 1}`);
        switch (kind) {
          case 're-export':
            return `export { v${t} } from '${spec}';`;
          case 'dynamic':
            return `const lazy${t} = () => import('${spec}');`;
          case 'require':
            return `const r${t} = require('${spec}');`;
          default:
            return k === 0 ? `import { v${t} } from '${alias}';` : `import * as n${t} from '${spec}';`;
        }
      });
      writeFileSync(path.join(dir, fileName(i)), lines.join('\n') + `\nexport const v${i} = ${i};\n`);
    }
    const t0 = performance.now();
    graph = await analyzeRepository(dir);
    analyzeMs = performance.now() - t0;
  }, 120_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts every generated import exactly once, all resolved', () => {
    expect(graph.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved')).toHaveLength(FILES + 1);
    expect(graph.edges).toHaveLength(FILES * IMPORTS_PER_FILE);
    const actual = new Set(graph.edges.map((e) => `${e.source}>${e.target}>${e.kind}>${e.line}`));
    expect(actual).toEqual(expected);
    expect(graph.edges.every((e) => e.resolved)).toBe(true);
  });

  it('analyzes in a reasonable time', () => {
    expect(analyzeMs).toBeLessThan(30_000);
  });

  it('computes every layout for 1,200 nodes / 6,000 edges quickly and deterministically', () => {
    const nodes = graph.nodes.map((n) => ({ id: n.id, type: n.type, directory: n.directory }));
    for (const layout of LAYOUTS) {
      const t0 = performance.now();
      const a = computeLayout(nodes, graph.edges, layout);
      const ms = performance.now() - t0;
      expect(ms, layout).toBeLessThan(15_000);
      expect(Object.keys(a)).toHaveLength(nodes.length);
      for (const [x, y] of Object.values(a)) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
    expect(computeLayout(nodes, graph.edges, 'type')).toEqual(computeLayout(nodes, graph.edges, 'type'));
  });
});
