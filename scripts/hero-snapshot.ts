/**
 * Generates the landing page's graph data by running the real analyzer on this repository.
 * Everything on the landing page (hero graph, feature demos) is derived from this output.
 *
 *   npm run hero:snapshot
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeRepositoryWithFacts } from '../packages/analyzer/src/index.ts';
import { detectArchitecture } from '../packages/analyzer/src/architecture/detect.ts';
import { computeLayout } from '../packages/analyzer/src/layout.ts';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'web/src/features/landing/heroGraph.json');
const IGNORE = ['legacy', 'packages/analyzer/test/fixtures', 'scripts', '.data', '.claude', 'graphify-out'];
const TECH = ['react', 'react-router', 'vite', 'fastify', 'typescript', 'd3-force', 'd3-zoom', '@resvg/resvg-js', 'vitest'];

const { graph, facts } = await analyzeRepositoryWithFacts(root, { ignore: IGNORE, repository: { name: 'codepilot' } });
const arch = detectArchitecture({ facts, graph });

// Hero shows parsed source files and the imports between them (no config files or packages).
const keep = new Set(graph.nodes.filter((n) => n.analyzed && n.type !== 'config').map((n) => n.id));
const edges = graph.edges.filter((e) => e.resolved && !e.external && keep.has(e.source) && keep.has(e.target));
const nodes = graph.nodes.filter((n) => keep.has(n.id));
const positions = computeLayout(nodes.map((n) => ({ id: n.id, type: n.type, directory: n.directory })), edges, 'force');

// Longest import chain (by BFS depth) starting at an entry point — a real path through the code.
const out = new Map<string, { target: string; line: number }[]>();
for (const e of edges) {
  if (!out.has(e.source)) out.set(e.source, []);
  out.get(e.source)!.push({ target: e.target, line: e.line });
}
let chain: { id: string; line?: number }[] = [];
for (const entry of graph.summary.entryPoints.filter((e) => keep.has(e.id))) {
  const prev = new Map<string, { from: string; line: number }>();
  const seen = new Set([entry.id]);
  let frontier = [entry.id];
  let last = entry.id;
  while (frontier.length) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const { target, line } of (out.get(v) ?? []).sort((a, b) => (a.target < b.target ? -1 : 1))) {
        if (seen.has(target)) continue;
        seen.add(target);
        prev.set(target, { from: v, line });
        next.push(target);
        last = target;
      }
    }
    frontier = next;
  }
  const pathIds: { id: string; line?: number }[] = [{ id: last }];
  for (let cur = last; prev.has(cur); cur = prev.get(cur)!.from) pathIds.unshift({ id: prev.get(cur)!.from, line: prev.get(cur)!.line });
  if (pathIds.length > chain.length) chain = pathIds;
}
// `line` on hop i is the import line in chain[i] that pulls in chain[i + 1].
chain = chain.slice(0, 6);

const tech: { name: string; version: string; file: string; line: number }[] = [];
for (const n of graph.nodes.filter((x) => x.path.endsWith('package.json'))) {
  const text = readFileSync(path.join(root, n.path), 'utf8');
  const lines = text.split('\n');
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!TECH.includes(name) || tech.some((t) => t.name === name)) continue;
    const line = lines.findIndex((l) => l.includes(`"${name}":`)) + 1;
    tech.push({ name, version, file: n.path, line });
  }
}
tech.sort((a, b) => TECH.indexOf(a.name) - TECH.indexOf(b.name));

const hub = graph.summary.mostDependedOn.find((h) => keep.has(h.id))?.id ?? nodes[0].id;
const doc = {
  id: hub,
  exports: graph.files[hub]?.exports.slice(0, 8) ?? [],
  consumers: graph.edges.filter((e) => e.target === hub).map((e) => ({ id: e.source, line: e.line })),
  dependencies: graph.edges.filter((e) => e.source === hub && e.resolved).map((e) => ({ id: e.target, line: e.line })),
};

// Exported symbols of each file (functions, components, types…), for the hero's symbol-level nodes.
const symbols = nodes.flatMap((n) =>
  (graph.files[n.id]?.exports ?? [])
    .filter((x) => x.name !== 'default')
    .slice(0, 8)
    .map((x) => ({ file: n.id, name: x.name, kind: x.kind, line: x.line })),
);

// External packages imported by source files, by number of importing files.
const pkgFiles = new Map<string, Set<string>>();
for (const e of graph.edges) {
  if (!e.external || !keep.has(e.source)) continue;
  const name = e.target.replace(/^ext:/, '');
  if (!pkgFiles.has(name)) pkgFiles.set(name, new Set());
  pkgFiles.get(name)!.add(e.source);
}
const packages = [...pkgFiles]
  .map(([name, files]) => ({ name, files: [...files].sort() }))
  .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name))
  .slice(0, 24);

// Technology intelligence for catalogued technologies: what the code shows each one does here.
const evidenceOf = (id: string) => {
  const e = arch.evidence[id];
  return e ? { kind: e.kind, file: e.file, line: e.line, snippet: e.snippet, detail: e.detail } : null;
};
const technologies = arch.technologies
  .filter((t) => t.kind !== 'library')
  .map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    version: t.version,
    confidence: t.why.confidence,
    general: t.general,
    role: t.role.text,
    why: t.why.text,
    usedBy: t.usedBy,
    files: t.files.slice(0, 4).map((f) => ({ path: f.path, line: f.lines[0] })),
    connections: t.connections.slice(0, 4).map((c) => ({ direction: c.direction, name: c.name, labels: c.labels })),
    routes: t.routes.length,
    flows: t.flows.length,
    evidence: [...new Set([...t.why.evidence, ...t.role.evidence, ...t.evidence])].slice(0, 3).map(evidenceOf).filter(Boolean),
  }));

// The flow the story traces: a user action fully traced (no unknown hop), crossing the most stages.
const traced = arch.flows
  .filter((f) => !f.steps.some((st) => st.kind === 'unknown'))
  .sort(
    (a, b) =>
      (b.action ? 1 : 0) - (a.action ? 1 : 0) ||
      new Set(b.steps.map((st) => st.stage)).size - new Set(a.steps.map((st) => st.stage)).size ||
      b.steps.length - a.steps.length ||
      a.title.localeCompare(b.title),
  )[0];
const traceFlow = traced
  ? {
      id: traced.id,
      name: traced.name ?? traced.title,
      title: traced.title,
      steps: traced.steps.map((st) => ({ stage: st.stage, kind: st.kind, label: st.label ?? st.node, file: st.file, line: st.line, fn: st.fn, transport: st.transport, branch: st.branch, explanation: st.explanation })),
    }
  : null;

let commit: string | null = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  commit = null;
}

const snapshot = {
  generatedAt: graph.generatedAt,
  commit,
  totals: { files: nodes.length, edges: edges.length, externalPackages: graph.summary.totals.externalPackages },
  nodes: nodes.map((n) => ({ id: n.id, type: n.type, directory: n.directory, x: positions[n.id][0], y: positions[n.id][1] })),
  edges: edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, line: e.line, typeOnly: e.typeOnly })),
  hubs: graph.summary.mostDependedOn.filter((h) => keep.has(h.id)).slice(0, 5).map((h) => h.id),
  chain,
  tech,
  doc,
  frameworks: graph.frameworks,
  symbols,
  packages,
  technologies,
  traceFlow,
  // The detected architecture of this repository, for the landing page's architecture and flow demos.
  architecture: {
    layers: arch.layers,
    nodes: arch.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, category: n.category, layer: n.layer, display: n.display, role: n.role, confidence: n.confidence, version: n.version?.value, files: n.files.slice(0, 3).map((f) => ({ path: f.path, line: f.lines[0] })), chips: n.app?.chips ?? [] })),
    edges: arch.edges.filter((e) => e.overlays.includes('dataflow')).map((e) => ({ id: e.id, source: e.source, target: e.target, labels: e.labels, confidence: e.confidence, evidence: e.evidence.slice(0, 2) })),
    // A real user action, preferring the one that crosses the most lanes (frontend → backend → external).
    flow:
      [...arch.flows].sort(
        (a, b) =>
          (b.action && b.action.kind === 'click' ? 1 : 0) - (a.action && a.action.kind === 'click' ? 1 : 0) ||
          (b.lanes?.length ?? 0) - (a.lanes?.length ?? 0) ||
          new Set(b.steps.map((st) => st.node)).size - new Set(a.steps.map((st) => st.node)).size ||
          b.steps.length - a.steps.length,
      )[0] ?? null,
    evidence: Object.fromEntries(
      [...new Set([...arch.edges.flatMap((e) => e.evidence.slice(0, 2)), ...arch.flows.flatMap((f) => f.steps.flatMap((st) => st.evidence))])].map((id) => [id, arch.evidence[id]]).filter(([, v]) => v),
    ),
    pattern: arch.summary.patterns[0]?.name ?? null,
    stats: {
      routes: facts.routes.filter((r) => r.kind === 'api').length,
      apps: arch.nodes.filter((n) => n.kind === 'app').length,
      tools: arch.nodes.filter((n) => n.kind === 'tool').length,
      hosts: arch.nodes.filter((n) => n.kind === 'host').length,
      edges: arch.edges.length,
      flows: arch.flows.length,
      evidence: Object.keys(arch.evidence).length,
    },
  },
};

writeFileSync(OUT, JSON.stringify(snapshot) + '\n');
console.log(`hero snapshot: ${snapshot.totals.files} files, ${snapshot.totals.edges} edges → ${path.relative(root, OUT)}`);
