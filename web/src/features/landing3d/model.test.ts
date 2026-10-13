import { describe, expect, it } from 'vitest';
import { snapshot } from '../landing/snapshot.ts';
import { buildModel, bucketOf, CHAPTERS, chapterBlend, presence } from './model.ts';

describe('landing scene model', () => {
  const m = buildModel({ compact: false });
  const ids = new Set(m.nodes.map((n) => n.id));

  it('contains only entities from the analysis snapshot', () => {
    expect(ids.size).toBe(m.nodes.length);
    const files = m.nodes.filter((n) => n.kind === 'file').map((n) => n.id).sort();
    expect(files).toEqual(snapshot.nodes.map((n) => n.id).sort());
    expect(m.nodes.filter((n) => n.kind === 'symbol')).toHaveLength(snapshot.symbols.length);
    for (const s of snapshot.symbols) expect(ids.has(`sym:${s.file}#${s.name}`)).toBe(true);
    expect(m.nodes.filter((n) => n.kind === 'package').map((n) => n.id.slice(4))).toEqual(snapshot.packages.map((p) => p.name));
    expect(m.nodes.filter((n) => n.kind === 'tech').map((n) => n.id)).toEqual(snapshot.technologies.map((t) => t.id));
    // Besides those: the repository, its GitHub source, two applications and the workspace package.
    expect(m.nodes.filter((n) => ['core', 'github', 'app'].includes(n.kind)).map((n) => n.id)).toEqual(['core', 'github', 'app:web', 'app:server', 'pkg-ws:analyzer']);
  });

  it('draws every import once, and every architecture connection with the labels the code shows', () => {
    const imports = m.edges.filter((e) => e.kind === 'import').map((e) => `${m.nodes[e.a].id}>${m.nodes[e.b].id}`);
    expect(imports.sort()).toEqual(snapshot.edges.map((e) => `${e.source}>${e.target}`).sort());
    for (const e of snapshot.architecture.edges) {
      const drawn = m.edges.find((x) => x.kind === 'arch' && m.nodes[x.a].id === e.source && m.nodes[x.b].id === e.target);
      expect(drawn?.label).toBe(e.labels.join(' · '));
    }
    // The workspace edges are counted from real imports into packages/analyzer.
    const intoAnalyzer = snapshot.edges.filter((e) => e.source.startsWith('server/') && e.target.startsWith('packages/')).length;
    expect(m.edges.find((x) => x.kind === 'arch' && m.nodes[x.b].id === 'pkg-ws:analyzer' && m.nodes[x.a].id === 'app:server')?.label).toBe(`imports · ${intoAnalyzer}`);
    for (const e of m.edges) expect(e.a !== e.b && e.a < m.nodes.length && e.b < m.nodes.length).toBe(true);
  });

  it('connects technologies only to files that import them or appear in their evidence', () => {
    for (const [i, t] of snapshot.technologies.entries()) {
      const allowed = new Set([...(snapshot.packages.find((p) => p.name === t.name.toLowerCase())?.files ?? []), ...t.files.map((f) => f.path), ...t.usedBy.map((u) => `app:${u}`), ...t.connections.map((c) => `app:${c.name}`)]);
      for (const e of m.techs[i].edges) {
        const other = m.edges[e].a === m.techs[i].node ? m.edges[e].b : m.edges[e].a;
        expect(allowed.has(m.nodes[other].id)).toBe(true);
      }
    }
  });

  it('traces the files of the real flow, in step order', () => {
    expect(m.trace?.nodes.map((n) => m.nodes[n].id)).toEqual(snapshot.traceFlow?.steps.map((s) => s.file));
  });

  it('has a complete, finite layout for every chapter, and never draws label anchors', () => {
    expect(m.layouts).toHaveLength(CHAPTERS.length);
    for (let c = 0; c < CHAPTERS.length; c++) {
      expect(m.layouts[c]).toHaveLength(m.nodes.length * 3);
      expect([...m.layouts[c]].every(Number.isFinite)).toBe(true);
      m.nodes.forEach((n, i) => n.kind === 'anchor' && expect(m.alphas[c][i]).toBe(0));
    }
  });

  it('is deterministic, and leaves symbols and packages out on phones', () => {
    const again = buildModel({ compact: false });
    expect([...again.layouts[2]]).toEqual([...m.layouts[2]]);
    const compact = buildModel({ compact: true });
    expect(compact.nodes.some((n) => n.kind === 'symbol' || n.kind === 'package')).toBe(false);
    expect(compact.nodes.filter((n) => n.kind === 'file')).toHaveLength(snapshot.nodes.length);
  });

  it('holds on each chapter and morphs in between', () => {
    expect(chapterBlend(3)).toEqual({ i0: 3, i1: 4, f: 0 });
    expect(chapterBlend(3.1).f).toBe(0);
    expect(chapterBlend(3.5).f).toBeCloseTo(0.5);
    expect(chapterBlend(3.9).f).toBe(1);
    expect(chapterBlend(99)).toEqual({ i0: 6, i1: 7, f: 1 });
    expect(presence(4, 4)).toBe(1);
    expect(presence(5, 4)).toBe(0);
    expect(bucketOf('web/src/features/landing/snapshot.ts')).toBe('web/src/features/landing');
    expect(bucketOf('server/src/routes/projects.ts')).toBe('server/src/routes');
  });
});
