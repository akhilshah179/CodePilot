import { snapshot } from '../landing/snapshot.ts';

/*
 * The landing page's "living codebase": CodePilot's analysis of its own repository, as a 3D
 * scene. Every node is a real file, exported symbol, package, technology or application from the
 * snapshot; every edge is a real import, export, package import, technology use or architecture
 * connection. Each story chapter has its own layout of the same nodes, and the scene morphs
 * between them as the page scrolls.
 */

export const CHAPTERS = ['hero', 'discover', 'understand', 'map', 'trace', 'explain', 'verify', 'converge'] as const;
export type Chapter = (typeof CHAPTERS)[number];
export const CH = Object.fromEntries(CHAPTERS.map((c, i) => [c, i])) as Record<Chapter, number>;

export type NodeKind = 'core' | 'github' | 'app' | 'file' | 'symbol' | 'package' | 'tech' | 'anchor';
export type Area = 'web' | 'server' | 'analyzer' | 'external' | 'core';
export type EdgeKind = 'import' | 'symbol' | 'package' | 'tech' | 'arch' | 'ingest' | 'evidence';

export interface SNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Tooltip detail: what this is, from the analysis. */
  detail: string;
  area: Area;
  bucket?: string;
  size: number;
  color: [number, number, number];
}

export interface SEdge {
  a: number;
  b: number;
  kind: EdgeKind;
  label?: string;
}

export interface SLabel {
  node: number;
  text: string;
  sub?: string;
  /** Chapters in which the label is shown. */
  chapters: number[];
  tone?: 'accent' | 'path' | 'data' | 'plain' | 'faint';
}

export interface SceneModel {
  nodes: SNode[];
  edges: SEdge[];
  /** Per chapter: xyz per node. */
  layouts: Float32Array[];
  /** Per chapter: opacity per node. */
  alphas: Float32Array[];
  /** Per chapter: size multiplier per node. */
  sizes: Float32Array[];
  /** Per chapter and edge kind: opacity. */
  edgeAlpha: Record<EdgeKind, number>[];
  neighbors: number[][];
  labels: SLabel[];
  /** Edges ambient packets travel on, per chapter. */
  packetEdges: number[][];
  trace: { nodes: number[]; steps: NonNullable<typeof snapshot.traceFlow>['steps'] } | null;
  /** Technologies, with the edges to the files (or application) that use them. */
  techs: { node: number; id: string; edges: number[] }[];
  /** Layer rings for the map and trace chapters. */
  rings: { y: number; x: number; z: number; r: number; label: string }[];
}

/* ------------------------------------------------------------------ helpers */

/** Deterministic 0..1 from a string (FNV-1a). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Point i of n on a unit sphere (Fibonacci lattice). */
function fib(i: number, n: number): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const t = i * 2.399963229728653;
  return [Math.cos(t) * r, y, Math.sin(t) * r];
}

/** Point i of n on a unit disc (sunflower). */
function disc(i: number, n: number): [number, number] {
  const r = Math.sqrt((i + 0.5) / n);
  const t = i * 2.399963229728653;
  return [Math.cos(t) * r, Math.sin(t) * r];
}

export function areaOf(path: string): Area {
  if (path.startsWith('web/')) return 'web';
  if (path.startsWith('server/')) return 'server';
  if (path.startsWith('packages/')) return 'analyzer';
  return 'external';
}

/** Directory group a file belongs to: `web/src/pages`, `web/src/features/landing`, `packages/analyzer/src/architecture`… */
export function bucketOf(path: string): string {
  const dir = path.split('/').slice(0, -1);
  const depth = dir[0] === 'packages' || dir[2] === 'features' ? 4 : 3;
  return dir.slice(0, depth).join('/');
}

export function bucketLabel(bucket: string): string {
  const parts = bucket.split('/');
  const area = parts[0] === 'packages' ? 'analyzer' : parts[0];
  const last = parts.at(-1)!;
  return last === 'src' ? `${area}` : `${area} · ${last}`;
}

const AREA_LABEL: Record<Area, string> = { web: 'web', server: 'server', analyzer: 'packages/analyzer', external: 'external', core: 'codepilot' };

const C = {
  core: [1, 0.69, 0.13] as [number, number, number],
  web: [0.95, 0.93, 0.88] as [number, number, number],
  server: [1, 0.8, 0.5] as [number, number, number],
  analyzer: [0.74, 0.8, 0.82] as [number, number, number],
  symbol: [0.6, 0.6, 0.55] as [number, number, number],
  package: [0.55, 0.6, 0.66] as [number, number, number],
  tech: [1, 0.72, 0.2] as [number, number, number],
  data: [0, 0.82, 1] as [number, number, number],
};

/* ------------------------------------------------------------------ model */

export function buildModel({ compact }: { compact: boolean }): SceneModel {
  const nodes: SNode[] = [];
  const index = new Map<string, number>();
  const add = (n: SNode) => {
    index.set(n.id, nodes.length);
    nodes.push(n);
    return nodes.length - 1;
  };

  const core = add({ id: 'core', kind: 'core', label: 'codepilot', detail: `This repository: ${snapshot.totals.files} source files, ${snapshot.totals.edges} imports`, area: 'core', size: 2.4, color: C.core });
  const github = add({ id: 'github', kind: 'github', label: 'GitHub', detail: 'Repository source — one branch, shallow-cloned', area: 'external', size: 1.3, color: C.web });

  // Files, in a stable order (area, then path).
  const AREA_ORDER: Area[] = ['web', 'server', 'analyzer'];
  const files = [...snapshot.nodes].sort((a, b) => AREA_ORDER.indexOf(areaOf(a.id)) - AREA_ORDER.indexOf(areaOf(b.id)) || a.id.localeCompare(b.id));
  const degree = new Map<string, { out: number; in: number }>();
  for (const e of snapshot.edges) {
    degree.set(e.source, { out: (degree.get(e.source)?.out ?? 0) + 1, in: degree.get(e.source)?.in ?? 0 });
    degree.set(e.target, { out: degree.get(e.target)?.out ?? 0, in: (degree.get(e.target)?.in ?? 0) + 1 });
  }
  for (const f of files) {
    const area = areaOf(f.id);
    const d = degree.get(f.id) ?? { out: 0, in: 0 };
    add({
      id: f.id,
      kind: 'file',
      label: f.id.slice(f.id.lastIndexOf('/') + 1),
      detail: `${f.id} · imports ${d.out} · imported by ${d.in}`,
      area,
      bucket: bucketOf(f.id),
      size: 0.5 + Math.min(0.9, Math.log2(1 + d.in) * 0.16),
      color: C[area as 'web' | 'server' | 'analyzer'],
    });
  }
  const symbols = compact ? [] : snapshot.symbols;
  for (const s of symbols) {
    add({ id: `sym:${s.file}#${s.name}`, kind: 'symbol', label: s.name, detail: `export ${s.kind} ${s.name} — ${s.file}:${s.line}`, area: areaOf(s.file), bucket: bucketOf(s.file), size: 0.2, color: C.symbol });
  }
  const packages = compact ? [] : snapshot.packages;
  for (const p of packages) {
    add({ id: `pkg:${p.name}`, kind: 'package', label: p.name, detail: `${p.name} · imported by ${p.files.length} file${p.files.length === 1 ? '' : 's'}`, area: 'external', size: 0.3 + Math.min(0.5, p.files.length * 0.02), color: C.package });
  }
  const techs = snapshot.technologies.map((t) => ({
    node: add({ id: t.id, kind: 'tech', label: t.name, detail: t.role, area: t.usedBy.includes('web') ? 'web' : t.usedBy.includes('server') ? 'server' : 'external', size: 1.05, color: C.tech }),
    id: t.id,
  }));
  const apps = {
    web: add({ id: 'app:web', kind: 'app', label: 'web', detail: 'Application: web (React, Vite)', area: 'web', size: 0.9, color: C.data }),
    server: add({ id: 'app:server', kind: 'app', label: 'server', detail: 'Application: server (Fastify)', area: 'server', size: 0.9, color: C.data }),
    analyzer: add({ id: 'pkg-ws:analyzer', kind: 'app', label: 'packages/analyzer', detail: 'Workspace package used by server and web', area: 'analyzer', size: 0.7, color: C.data }),
  };

  // Label anchors: invisible nodes that only carry a position per chapter.
  const anchor = (id: string) => add({ id: `anchor:${id}`, kind: 'anchor', label: id, detail: '', area: 'core', size: 0, color: C.web });
  const buckets = [...new Set(files.map((f) => bucketOf(f.id)))];
  const bucketAnchor = new Map(buckets.map((b) => [b, anchor(`bucket:${b}`)]));
  const areaAnchor = { web: anchor('area:web'), server: anchor('area:server'), analyzer: anchor('area:analyzer') };
  const beamAnchor = { webServer: anchor('beam:web-server'), serverSql: anchor('beam:server-sql'), serverExt: anchor('beam:server-ext'), serverAnalyzer: anchor('beam:server-analyzer') };

  /* ------------------------------------------------------------ edges */
  const edges: SEdge[] = [];
  const edge = (a: number | undefined, b: number | undefined, kind: EdgeKind, label?: string) => {
    if (a === undefined || b === undefined || a === b) return -1;
    edges.push({ a, b, kind, label });
    return edges.length - 1;
  };
  const importEdges = snapshot.edges.map((e) => edge(index.get(e.source), index.get(e.target), 'import')).filter((i) => i >= 0);
  for (const s of symbols) edge(index.get(s.file), index.get(`sym:${s.file}#${s.name}`), 'symbol');
  for (const p of packages) for (const f of p.files) edge(index.get(f), index.get(`pkg:${p.name}`), 'package');
  const ingestEdges: number[] = [];
  for (const f of files) {
    ingestEdges.push(edge(github, index.get(f.id), 'ingest'));
    ingestEdges.push(edge(index.get(f.id), core, 'ingest'));
  }
  // A technology connects to the files that show it is used (its import sites and evidence files), else to its application.
  const techEdges = new Map<number, number[]>();
  for (const [i, t] of snapshot.technologies.entries()) {
    const n = techs[i].node;
    const pkg = snapshot.packages.find((p) => p.name === t.name.toLowerCase());
    const users = new Set([...(pkg?.files ?? []), ...t.files.map((f) => f.path)].filter((p) => index.has(p)));
    const list: number[] = [];
    for (const u of users) list.push(edge(n, index.get(u), 'tech'));
    if (!list.length) for (const app of t.usedBy) list.push(edge(n, index.get(`app:${app}`), 'tech'));
    if (!list.length && t.connections[0]) list.push(edge(index.get(`app:${t.connections[0].name}`), n, 'tech'));
    techEdges.set(n, list.filter((x) => x >= 0));
  }
  const techList = techs.map((t) => ({ ...t, edges: techEdges.get(t.node) ?? [] }));
  // Architecture connections, as detected (labels from the code: REST, SQL…).
  const archEdges: number[] = [];
  for (const e of snapshot.architecture.edges) archEdges.push(edge(index.get(e.source), index.get(e.target), 'arch', e.labels.join(' · ')));
  // Workspace imports into the analyzer package, counted from the real import edges.
  const crossServer = snapshot.edges.filter((e) => areaOf(e.source) === 'server' && areaOf(e.target) === 'analyzer').length;
  const crossWeb = snapshot.edges.filter((e) => areaOf(e.source) === 'web' && areaOf(e.target) === 'analyzer').length;
  if (crossServer) archEdges.push(edge(apps.server, apps.analyzer, 'arch', `imports · ${crossServer}`));
  if (crossWeb) archEdges.push(edge(apps.web, apps.analyzer, 'arch', `type imports · ${crossWeb}`));

  // The traced request: from the evidence chain of the web → server connection.
  const restEv = snapshot.architecture.edges.find((e) => e.source === 'app:web' && e.target === 'app:server')?.evidence.map((id) => snapshot.architecture.evidence[id]) ?? [];
  const evFrom = restEv[0] ? index.get(restEv[0].file) : undefined;
  const evTo = restEv[1] ? index.get(restEv[1].file) : undefined;
  const evidenceEdge = edge(evFrom, evTo, 'evidence', restEv[0]?.detail);

  const neighbors: number[][] = nodes.map(() => []);
  for (const e of edges) {
    if (e.kind === 'ingest') continue;
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }

  /* ------------------------------------------------------------ layouts */
  const N = nodes.length;
  const layouts = CHAPTERS.map(() => new Float32Array(N * 3));
  const alphas = CHAPTERS.map(() => new Float32Array(N));
  const sizes = CHAPTERS.map(() => new Float32Array(N).fill(1));
  const set = (ch: number, i: number, p: ArrayLike<number>, alpha = 1, size = 1) => {
    layouts[ch][i * 3] = p[0];
    layouts[ch][i * 3 + 1] = p[1];
    layouts[ch][i * 3 + 2] = p[2];
    alphas[ch][i] = alpha;
    sizes[ch][i] = size;
  };
  const get = (ch: number, i: number): [number, number, number] => [layouts[ch][i * 3], layouts[ch][i * 3 + 1], layouts[ch][i * 3 + 2]];
  const fileIdx = files.map((f) => index.get(f.id)!);
  const symbolsOf = new Map<number, number[]>();
  for (const s of symbols) {
    const f = index.get(s.file)!;
    if (!symbolsOf.has(f)) symbolsOf.set(f, []);
    symbolsOf.get(f)!.push(index.get(`sym:${s.file}#${s.name}`)!);
  }
  const placeSymbols = (ch: number, alpha: number, radius = 0.5) => {
    for (const [f, list] of symbolsOf) {
      const [x, y, z] = get(ch, f);
      list.forEach((s, k) => {
        const [dx, dy, dz] = fib(k, list.length);
        const r = radius * (0.8 + 0.4 * hash01(nodes[s].id));
        set(ch, s, [x + dx * r, y + dy * r, z + dz * r], alpha);
      });
    }
  };
  const collapseSymbols = (ch: number) => {
    for (const [f, list] of symbolsOf) for (const s of list) set(ch, s, get(ch, f), 0);
  };
  const ringPackages = (ch: number, radius: number, y: number, alpha: number) =>
    packages.forEach((p, k) => {
      const t = (k / Math.max(1, packages.length)) * Math.PI * 2 + 0.3;
      set(ch, index.get(`pkg:${p.name}`)!, [Math.cos(t) * radius, y + Math.sin(t * 3) * 0.6, Math.sin(t) * radius], alpha);
    });
  const centroid = (ch: number, list: number[]): [number, number, number] => {
    const c: [number, number, number] = [0, 0, 0];
    for (const i of list) for (let k = 0; k < 3; k++) c[k] += layouts[ch][i * 3 + k] / Math.max(1, list.length);
    return c;
  };
  const byArea = (a: Area) => fileIdx.filter((i) => nodes[i].area === a);
  const AREA_Z: Record<string, number> = { web: 2.2, server: -0.4, analyzer: -2.6 };

  // 0 · hero: the force layout of the real import graph, given depth by application.
  {
    const xs = snapshot.nodes.map((n) => n.x);
    const ys = snapshot.nodes.map((n) => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
    const pos = new Map(snapshot.nodes.map((n) => [n.id, n]));
    for (const i of fileIdx) {
      const p = pos.get(nodes[i].id)!;
      set(CH.hero, i, [((p.x - cx) / span) * 15, (-(p.y - cy) / span) * 11, AREA_Z[nodes[i].area] + (hash01(nodes[i].id, 1) - 0.5) * 3]);
    }
    placeSymbols(CH.hero, 0.75, 0.55);
    ringPackages(CH.hero, 11, 0, 0.5);
    set(CH.hero, core, [0, 0, 0], 1);
    set(CH.hero, github, [-16, 0, 0], 0);
    for (const a of ['web', 'server', 'analyzer'] as const) {
      const c = centroid(CH.hero, byArea(a));
      set(CH.hero, apps[a], c, 0);
      set(CH.hero, areaAnchor[a], [c[0], c[1] + 3.2, c[2]], 0);
    }
    techs.forEach(({ node }, k) => {
      const app = nodes[node].area === 'external' ? 'server' : (nodes[node].area as 'web' | 'server');
      const c = centroid(CH.hero, byArea(app));
      const t = (k / techs.length) * Math.PI * 2;
      set(CH.hero, node, [c[0] * 1.3 + Math.cos(t) * 2.2, c[1] * 1.15 + Math.sin(t) * 1.8, c[2] + 2.5], 1);
    });
  }

  // 1 · discover: GitHub → the repository's files, as a file tree by application → CodePilot.
  {
    const cols: Record<string, { x: number; w: number }> = { web: { x: -6.2, w: 4 }, server: { x: -1.2, w: 2 }, analyzer: { x: 1.8, w: 3 } };
    for (const a of ['web', 'server', 'analyzer'] as const) {
      const list = byArea(a);
      const { x, w } = cols[a];
      const rows = Math.ceil(list.length / w);
      list.forEach((i, k) => set(CH.discover, i, [x + (k % w) * 0.62, 3.6 - Math.floor(k / w) * (7.6 / Math.max(rows, 15)), 0], 0.95, 0.8));
      set(CH.discover, areaAnchor[a], [x + ((w - 1) * 0.62) / 2, 4.6, 0], 0);
      set(CH.discover, apps[a], [x + ((w - 1) * 0.62) / 2, 0, -0.5], 0);
    }
    collapseSymbols(CH.discover);
    packages.forEach((p, k) => set(CH.discover, index.get(`pkg:${p.name}`)!, [-6.2 + (k % 12) * 0.95, -4.8 - Math.floor(k / 12) * 0.6, 0], 0.4, 0.8));
    set(CH.discover, github, [-12.5, 0, 0], 1, 1.2);
    set(CH.discover, core, [8.5, 0, 0], 1, 1.1);
    for (const { node } of techs) set(CH.discover, node, [8.5, 0, 0], 0);
  }

  // 2 · understand: files grouped by directory, around the three applications.
  {
    const centers: Record<string, [number, number, number]> = { web: [-4.6, 1.6, 0], server: [3.8, 2.6, -1], analyzer: [-0.2, -3.6, 0.8] };
    for (const a of ['web', 'server', 'analyzer'] as const) {
      const bs = buckets.filter((b) => areaOf(b + '/x') === a);
      const R = a === 'server' ? 1.8 : 2.9;
      bs.forEach((b, k) => {
        const [dx, dy, dz] = fib(k, bs.length);
        const c: [number, number, number] = bs.length === 1 ? centers[a] : [centers[a][0] + dx * R, centers[a][1] + dy * R * 0.85, centers[a][2] + dz * R];
        const members = fileIdx.filter((i) => nodes[i].bucket === b);
        const r = 0.32 * Math.sqrt(members.length) + 0.2;
        members.forEach((i, m) => {
          const [ex, ey, ez] = fib(m, members.length);
          set(CH.understand, i, members.length === 1 ? c : [c[0] + ex * r, c[1] + ey * r, c[2] + ez * r]);
        });
        set(CH.understand, bucketAnchor.get(b)!, [c[0], c[1] + r + 0.45, c[2]], 0);
      });
      set(CH.understand, apps[a], centers[a], 0.5);
      set(CH.understand, areaAnchor[a], [centers[a][0], centers[a][1] + R + 1.5, centers[a][2]], 0);
    }
    placeSymbols(CH.understand, 0.55, 0.32);
    ringPackages(CH.understand, 11.5, 0, 0.3);
    set(CH.understand, core, [0, 0.4, 0], 0.7, 0.6);
    set(CH.understand, github, [-16, 0, 0], 0);
    techs.forEach(({ node }) => {
      const a = nodes[node].area === 'external' ? 'server' : (nodes[node].area as 'web' | 'server');
      const k = techs.filter((t) => (nodes[t.node].area === 'external' ? 'server' : nodes[t.node].area) === a).findIndex((t) => t.node === node);
      set(CH.understand, node, [centers[a][0] + (a === 'web' ? -4.2 : 3.6), centers[a][1] + 1.6 - k * 1.6, centers[a][2] + 1], 0.9);
    });
  }

  // 3 · map: the architecture as stacked layers — frontend, backend, analysis engine and data, external.
  const rings: SceneModel['rings'] = [];
  {
    const planes: Record<'web' | 'server' | 'analyzer', { c: [number, number, number]; r: number; label: string }> = {
      web: { c: [0, 4.6, 0], r: 4.6, label: 'FRONTEND · web' },
      server: { c: [0, 0.2, 0], r: 2.8, label: 'BACKEND · server' },
      analyzer: { c: [-4.4, -4.2, 0], r: 3.6, label: 'ANALYSIS ENGINE · packages/analyzer' },
    };
    for (const a of ['web', 'server', 'analyzer'] as const) {
      const list = byArea(a);
      const { c, r } = planes[a];
      list.forEach((i, k) => {
        const [dx, dz] = disc(k, list.length);
        set(CH.map, i, [c[0] + dx * r, c[1] + (hash01(nodes[i].id, 2) - 0.5) * 0.25, c[2] + dz * r * 0.8]);
      });
      set(CH.map, apps[a], c, 1, 1.2);
      set(CH.map, areaAnchor[a], [c[0] - r - 0.4, c[1] + 0.2, c[2]], 0);
      rings.push({ x: c[0], y: c[1] - 0.15, z: c[2], r: r + 0.5, label: planes[a].label });
    }
    collapseSymbols(CH.map);
    ringPackages(CH.map, 12, -1, 0.12);
    const dataPos: [number, number, number] = [4.6, -4.2, 0];
    const extPos: [number, number, number] = [8.4, 0.4, 0];
    rings.push({ x: dataPos[0], y: dataPos[1] - 0.15, z: 0, r: 1.6, label: 'DATA' });
    rings.push({ x: extPos[0], y: extPos[1] - 0.15, z: 0, r: 1.5, label: 'EXTERNAL' });
    for (const { node, id } of techs) {
      const t = snapshot.technologies.find((x) => x.id === id)!;
      const p: [number, number, number] =
        t.category === 'database'
          ? dataPos
          : t.category === 'service'
            ? extPos
            : t.usedBy.includes('web')
              ? [planes.web.c[0] + planes.web.r + 1.4, planes.web.c[1] + (t.category === 'frontend' ? 0.8 : -0.8), 0]
              : [planes.server.c[0] + planes.server.r + 1.4, planes.server.c[1], 0];
      set(CH.map, node, p, 1, 1.1);
    }
    set(CH.map, core, [0, 8.5, 0], 0, 0.5);
    set(CH.map, github, [-16, 4, 0], 0);
    const mid = (a: number, b: number): [number, number, number] => {
      const p = get(CH.map, a);
      const q = get(CH.map, b);
      return [(p[0] + q[0]) / 2 + 0.25, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    };
    const sql = techs.find((t) => snapshot.technologies.find((x) => x.id === t.id)?.category === 'database');
    const ext = techs.find((t) => snapshot.technologies.find((x) => x.id === t.id)?.category === 'service');
    set(CH.map, beamAnchor.webServer, mid(apps.web, apps.server), 0);
    set(CH.map, beamAnchor.serverAnalyzer, mid(apps.server, apps.analyzer), 0);
    if (sql) set(CH.map, beamAnchor.serverSql, mid(apps.server, sql.node), 0);
    if (ext) set(CH.map, beamAnchor.serverExt, mid(apps.server, ext.node), 0);
  }

  // 4 · trace: the map, with the traced request's files brought forward.
  const flow = snapshot.traceFlow;
  const traceNodes = flow ? flow.steps.map((s) => index.get(s.file) ?? apps[areaOf(s.file) as 'web' | 'server' | 'analyzer'] ?? core) : [];
  {
    layouts[CH.trace].set(layouts[CH.map]);
    alphas[CH.trace].set(alphas[CH.map]);
    const onPath = new Set(traceNodes);
    for (let i = 0; i < N; i++) {
      if (nodes[i].kind === 'anchor') continue;
      if (onPath.has(i)) {
        const p = get(CH.map, i);
        set(CH.trace, i, [p[0], p[1] + 0.5, p[2] + 1.2], 1, 1.8);
      } else alphas[CH.trace][i] *= nodes[i].kind === 'app' || nodes[i].kind === 'tech' ? 0.6 : 0.3;
    }
  }

  // 5 · explain: the system compacted at the centre; technologies on an orbit, packages beyond.
  {
    for (const i of fileIdx) {
      const p = get(CH.hero, i);
      set(CH.explain, i, [p[0] * 0.36, p[1] * 0.4, p[2] * 0.5], 0.85);
    }
    collapseSymbols(CH.explain);
    for (const a of ['web', 'server', 'analyzer'] as const) set(CH.explain, apps[a], centroid(CH.explain, byArea(a)), 0.6);
    techs.forEach(({ node }, k) => {
      const t = (k / techs.length) * Math.PI * 2 - Math.PI / 2;
      set(CH.explain, node, [Math.cos(t) * 6.4, Math.sin(t) * 4.6, Math.sin(t * 2) * 1.2], 1, 1.25);
    });
    ringPackages(CH.explain, 9.6, 0, 0.55);
    set(CH.explain, core, [0, 0, 0], 0.8, 0.7);
    set(CH.explain, github, [-16, 0, 0], 0);
  }

  // 6 · verify: one connection, down to the file and line — the call site and the route it reaches.
  {
    for (let i = 0; i < N; i++) {
      const p = get(CH.hero, i);
      set(CH.verify, i, [p[0] * 1.8, p[1] * 1.8, p[2] - 22], nodes[i].kind === 'anchor' ? 0 : 0.1);
    }
    if (evFrom !== undefined && evTo !== undefined) {
      set(CH.verify, evFrom, [-3.4, 0, 0], 1, 2.2);
      set(CH.verify, evTo, [3.4, 0, 0], 1, 2.2);
      for (const [center, sign] of [
        [evFrom, -1],
        [evTo, 1],
      ] as const) {
        const near = [...new Set(neighbors[center])].filter((j) => nodes[j].kind === 'file' && j !== evFrom && j !== evTo).slice(0, 14);
        near.forEach((j, k) => {
          const t = ((k + 0.5) / near.length - 0.5) * Math.PI * 0.9;
          set(CH.verify, j, [sign * (3.4 + Math.cos(t) * 3.8), Math.sin(t) * 3.6, -1.2], 0.6);
        });
        (symbolsOf.get(center) ?? []).slice(0, 6).forEach((s, k) => set(CH.verify, s, [sign * 3.4 + sign * 0.9, 1.4 - k * 0.5, 0.4], 0.9, 1.6));
      }
    }
    set(CH.verify, core, [0, 0, -22], 0.3);
  }

  // 7 · converge: the whole system drawn into one.
  {
    // Spread every kind over the whole sphere: lattice slots in a stable, hashed order.
    const order = nodes.map((n, i) => ({ i, h: hash01(n.id, 7) })).sort((a, b) => a.h - b.h);
    const slot = new Array<number>(N);
    order.forEach(({ i }, k) => (slot[i] = k));
    for (let i = 0; i < N; i++) {
      const [x, y, z] = fib(slot[i], N);
      const r = nodes[i].kind === 'symbol' ? 2.7 : nodes[i].kind === 'package' || nodes[i].kind === 'tech' ? 3.2 : 2.1;
      set(CH.converge, i, [x * r, y * r, z * r], nodes[i].kind === 'anchor' || nodes[i].kind === 'github' ? 0 : 0.8);
    }
    set(CH.converge, core, [0, 0, 0], 1, 1.5);
  }

  // Anchors and the GitHub source are never drawn as dots.
  for (let ch = 0; ch < CHAPTERS.length; ch++)
    for (let i = 0; i < N; i++) if (nodes[i].kind === 'anchor') alphas[ch][i] = 0;

  /* ------------------------------------------------------------ edge visibility per chapter */
  const E = (o: Partial<Record<EdgeKind, number>>): Record<EdgeKind, number> => ({ import: 0, symbol: 0, package: 0, tech: 0, arch: 0, ingest: 0, evidence: 0, ...o });
  const edgeAlpha = [
    E({ import: 0.22, symbol: 0.12, package: 0.05, tech: 0.18 }),
    E({ ingest: 0.07 }),
    E({ import: 0.3, symbol: 0.12, tech: 0.15 }),
    E({ import: 0.08, arch: 0.95 }),
    E({ import: 0.04, arch: 0.35 }),
    E({ import: 0.06, tech: 0.32, package: 0.08 }),
    E({ import: 0.35, evidence: 1, symbol: 0.5 }),
    E({ import: 0.1, symbol: 0.05 }),
  ];

  const allTech = [...techEdges.values()].flat();
  const evidenceNeighborhood = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'import' && (e.a === evFrom || e.b === evFrom || e.a === evTo || e.b === evTo)).map(({ i }) => i);
  const packetEdges = [importEdges, ingestEdges, importEdges, [...archEdges, ...archEdges, ...archEdges, ...importEdges.slice(0, 60)], archEdges, allTech, evidenceEdge >= 0 ? [evidenceEdge, evidenceEdge, ...evidenceNeighborhood] : evidenceNeighborhood, importEdges];

  /* ------------------------------------------------------------ labels */
  const labels: SLabel[] = [];
  labels.push({ node: core, text: 'codepilot', sub: `${snapshot.totals.files} files`, chapters: [CH.hero, CH.converge], tone: 'accent' });
  labels.push({ node: github, text: 'GitHub', sub: 'one branch · shallow clone', chapters: [CH.discover] });
  labels.push({ node: core, text: 'CodePilot', sub: 'parse · resolve · extract', chapters: [CH.discover], tone: 'accent' });
  for (const a of ['web', 'server', 'analyzer'] as const) {
    labels.push({ node: areaAnchor[a], text: `${AREA_LABEL[a]}/`, sub: `${byArea(a).length} files`, chapters: [CH.discover] });
    labels.push({ node: areaAnchor[a], text: AREA_LABEL[a], sub: `${byArea(a).length} files`, chapters: [CH.understand], tone: 'accent' });
  }
  if (!compact)
    for (const b of buckets) {
      const count = fileIdx.filter((i) => nodes[i].bucket === b).length;
      if (count >= 4) labels.push({ node: bucketAnchor.get(b)!, text: bucketLabel(b), sub: String(count), chapters: [CH.understand], tone: 'faint' });
    }
  for (const { node } of techs) labels.push({ node, text: nodes[node].label, chapters: [CH.hero, CH.map, CH.explain], tone: 'accent' });
  const beamLabel = (anchorNode: number, from: string, to: string) => {
    const e = edges.find((x) => x.kind === 'arch' && nodes[x.a].id === from && nodes[x.b].id === to);
    if (e?.label) labels.push({ node: anchorNode, text: e.label, chapters: [CH.map], tone: 'data' });
  };
  beamLabel(beamAnchor.webServer, 'app:web', 'app:server');
  beamLabel(beamAnchor.serverAnalyzer, 'app:server', 'pkg-ws:analyzer');
  const sqlT = snapshot.technologies.find((t) => t.category === 'database');
  const extT = snapshot.technologies.find((t) => t.category === 'service');
  if (sqlT) beamLabel(beamAnchor.serverSql, 'app:server', sqlT.id);
  if (extT) beamLabel(beamAnchor.serverExt, 'app:server', extT.id);
  for (const n of [...new Set(traceNodes)]) if (nodes[n].kind === 'file') labels.push({ node: n, text: nodes[n].label, chapters: [CH.trace], tone: 'path' });
  if (evFrom !== undefined && evTo !== undefined && restEv[0] && restEv[1]) {
    labels.push({ node: evFrom, text: `${restEv[0].file}:${restEv[0].line}`, sub: 'call site', chapters: [CH.verify], tone: 'path' });
    labels.push({ node: evTo, text: `${restEv[1].file}:${restEv[1].line}`, sub: 'route', chapters: [CH.verify], tone: 'path' });
  }
  if (!compact) for (const p of packages.slice(0, 10)) labels.push({ node: index.get(`pkg:${p.name}`)!, text: p.name, chapters: [CH.explain], tone: 'faint' });

  return {
    nodes,
    edges,
    layouts,
    alphas,
    sizes,
    edgeAlpha,
    neighbors,
    labels,
    packetEdges,
    trace: flow ? { nodes: traceNodes, steps: flow.steps } : null,
    techs: techList,
    rings,
  };
}

/** Ease between chapters: hold on each chapter, morph in between. */
export function chapterBlend(v: number): { i0: number; i1: number; f: number } {
  const max = CHAPTERS.length - 1;
  const c = Math.max(0, Math.min(max, v));
  const i0 = Math.min(max - 1, Math.floor(c));
  const raw = c - i0;
  const t = Math.max(0, Math.min(1, (raw - 0.2) / 0.6));
  return { i0, i1: i0 + 1, f: t * t * (3 - 2 * t) };
}

/** How present chapter `ch` is at scroll value `v` (1 on the chapter, 0 one chapter away). */
export function presence(v: number, ch: number): number {
  return Math.max(0, 1 - Math.abs(v - ch) * 1.6);
}
