import { Resvg } from '@resvg/resvg-js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONFIDENCE_LABELS, OVERLAYS, type Architecture, type Evidence, type Overlay } from '@codepilot/analyzer/architecture';
import { renderArchitectureMermaid, renderArchitectureSvg } from '@codepilot/analyzer/architecture/render';
import type { ArchitectureStore } from '../architectureStore.ts';
import { AppError } from '../errors.ts';
import { textWidth, wrap, writePdf, type PdfText } from '../pdf.ts';
import type { GraphContext, ProjectsApi } from './projects.ts';

type ArchQuery = { analysisId?: string; format?: string; overlay?: string };

export interface ArchitectureHandlers {
  overview(ctx: GraphContext): unknown;
  tool(ctx: GraphContext, toolId: string): unknown;
  flows(ctx: GraphContext): unknown;
  summary(ctx: GraphContext): unknown;
  intelligence(ctx: GraphContext): unknown;
  exportArchitecture(ctx: GraphContext, q: ArchQuery, reply: FastifyReply): Promise<unknown>;
  regenerate(ctx: GraphContext): unknown;
}

const pick = (arch: Architecture, ids: Iterable<string>): Record<string, Evidence> => {
  const out: Record<string, Evidence> = {};
  for (const id of ids) if (arch.evidence[id]) out[id] = arch.evidence[id];
  return out;
};

export function architectureHandlers(projects: ProjectsApi, store: ArchitectureStore): ArchitectureHandlers {
  const load = (ctx: GraphContext, regenerate = false) => store.get(ctx.project.id, ctx.analysis, ctx.index, { regenerate });

  const overview = (ctx: GraphContext, regenerate = false) => {
    const rec = load(ctx, regenerate);
    const a = rec.architecture;
    return {
      ...projects.graphMeta(ctx.project, ctx.analysis),
      architecture: {
        id: rec.id,
        generatedAt: a.generatedAt,
        detectorVersion: a.version,
        commitSha: rec.commitSha,
        reused: rec.reused,
        layers: a.layers,
        nodes: a.nodes,
        edges: a.edges,
        evidence: a.evidence,
        patterns: a.summary.patterns,
        totals: a.summary.totals,
        system: a.system,
        flows: a.flows.map((f) => ({ id: f.id, title: f.title, trigger: f.trigger, variant: f.variant, confidence: f.confidence, steps: f.steps.length, action: f.action, lanes: f.lanes })),
      },
    };
  };

  return {
    overview: (ctx) => overview(ctx),
    regenerate: (ctx) => overview(ctx, true),

    tool(ctx, toolId) {
      const a = load(ctx).architecture;
      const node = a.nodes.find((n) => n.id === toolId);
      if (!node) throw new AppError('not_found', 'This technology is not part of the detected architecture.', 404);
      const byId = new Map(a.nodes.map((n) => [n.id, n]));
      const connections = a.edges
        .filter((e) => e.source === toolId || e.target === toolId)
        .map((e) => {
          const otherId = e.source === toolId ? e.target : e.source;
          const other = byId.get(otherId);
          return { edge: e, direction: e.source === toolId ? 'out' : 'in', other: other ? { id: other.id, name: other.name, kind: other.kind, layer: other.layer, category: other.category } : { id: otherId, name: otherId } };
        });
      const blast = a.blast[toolId] ?? { nodes: [], files: [], routes: [] };
      const ids = new Set([...node.evidence, ...node.badges.flatMap((b) => b.evidence), ...connections.flatMap((c) => c.edge.evidence)]);
      return {
        node,
        chips: (node.app?.chips ?? []).map((id) => byId.get(id)).filter(Boolean),
        hosts: (node.hosts ?? []).map((id) => byId.get(id)).filter(Boolean),
        connections,
        blast: { ...blast, nodes: blast.nodes.map((b) => ({ ...b, name: byId.get(b.id)?.name ?? b.id, layer: byId.get(b.id)?.layer })) },
        flows: a.flows.filter((f) => f.steps.some((s) => s.node === toolId)).map((f) => ({ id: f.id, title: f.title })),
        evidence: pick(a, ids),
        confidenceLabel: CONFIDENCE_LABELS[node.confidence],
      };
    },

    flows(ctx) {
      const a = load(ctx).architecture;
      return { flows: a.flows, evidence: pick(a, a.flows.flatMap((f) => f.steps.flatMap((s) => s.evidence))) };
    },

    /** Technology explanations for exactly this analysis snapshot (commit), with every cited line. */
    intelligence(ctx) {
      const rec = load(ctx);
      const a = rec.architecture;
      const ids = a.technologies.flatMap((t) => [...t.evidence, ...t.role.evidence, ...t.why.evidence, ...t.connections.flatMap((c) => c.evidence)]);
      return {
        ...projects.graphMeta(ctx.project, ctx.analysis),
        snapshot: { architectureId: rec.id, commitSha: rec.commitSha, generatedAt: a.generatedAt, detectorVersion: a.version, analysisId: ctx.analysis.id },
        technologies: a.technologies,
        evidence: pick(a, ids),
      };
    },

    summary(ctx) {
      const a = load(ctx).architecture;
      const s = a.summary;
      return { ...projects.graphMeta(ctx.project, ctx.analysis), summary: s, evidence: pick(a, [...s.patterns, ...s.strengths, ...s.risks].flatMap((f) => f.evidence)) };
    },

    async exportArchitecture(ctx, q, reply) {
      const rec = load(ctx);
      const a = rec.architecture;
      const format = q.format ?? 'json';
      const overlay: Overlay = OVERLAYS.includes(q.overlay as Overlay) ? (q.overlay as Overlay) : 'dataflow';
      const { project, analysis } = ctx;
      const base = `${project.full_name.replace('/', '-')}-${(analysis.commit_sha ?? analysis.id).slice(0, 7)}-architecture`;
      const title = project.user_id === null ? 'CodePilot (sample project)' : project.full_name;
      const subtitle = `${analysis.branch}${analysis.commit_sha ? ' @ ' + analysis.commit_sha.slice(0, 7) : ''} · ${a.summary.totals.apps} applications · ${a.summary.totals.tools} technologies · ${a.edges.length} connections · ${overlay}`;
      if (format === 'json') {
        reply.header('Content-Disposition', `attachment; filename="${base}.json"`);
        return {
          ...a,
          repository: { fullName: project.full_name, url: project.html_url, branch: analysis.branch, commitSha: analysis.commit_sha, analyzedAt: analysis.finished_at },
          generator: { name: 'CodePilot', detectorVersion: a.version, generatedAt: a.generatedAt },
        };
      }
      if (format === 'mermaid') {
        reply.header('Content-Disposition', `attachment; filename="${base}.mmd"`);
        return reply.type('text/plain; charset=utf-8').send(renderArchitectureMermaid(a, overlay));
      }
      const svg = renderArchitectureSvg(a, { title, subtitle, overlay });
      if (format === 'svg') {
        reply.header('Content-Disposition', `attachment; filename="${base}.svg"`);
        return reply.type('image/svg+xml').send(svg);
      }
      if (format === 'png') {
        const [w] = [/width="(\d+)"/].map((re) => Number(re.exec(svg)?.[1] ?? 1000));
        const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: Math.min(2, 8000 / w) }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render().asPng();
        reply.header('Content-Disposition', `attachment; filename="${base}.png"`);
        return reply.type('image/png').send(png);
      }
      if (format === 'pdf') {
        reply.header('Content-Disposition', `attachment; filename="${base}.pdf"`);
        return reply.type('application/pdf').send(onePager(a, svg, title, subtitle));
      }
      throw new AppError('bad_request', 'format must be json, svg, png, pdf or mermaid.', 400);
    },
  };
}

/** A4 landscape: summary column on the left, the diagram on the right. */
function onePager(a: Architecture, svg: string, title: string, subtitle: string): Buffer {
  const W = 842;
  const H = 595;
  const M = 30;
  const colW = 250;
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: 1500 }, background: '#0B0D0A', font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } }).render();
  const texts: PdfText[] = [];
  const white = 0.93;
  const muted: [number, number, number] = [0.6, 0.62, 0.57];
  const accent: [number, number, number] = [1, 0.69, 0.13];
  let y = H - M - 10;
  texts.push({ x: M, y, size: 15, bold: true, text: title, color: white });
  y -= 15;
  for (const line of wrap(subtitle, colW, 7.5)) {
    texts.push({ x: M, y, size: 7.5, text: line, color: muted });
    y -= 10;
  }
  const section = (label: string) => {
    y -= 10;
    texts.push({ x: M, y, size: 8, bold: true, text: label.toUpperCase(), color: accent });
    y -= 11;
  };
  const para = (text: string, size = 8, color: PdfText['color'] = white, indent = 0) => {
    for (const line of wrap(text, colW - indent, size)) {
      if (y < M + 10) return;
      texts.push({ x: M + indent, y, size, text: line, color });
      y -= size + 2.5;
    }
  };
  section('Pattern');
  for (const p of a.summary.patterns) para(`${p.name} (${CONFIDENCE_LABELS[p.confidence].toLowerCase()}): ${p.reason}`);
  if (!a.summary.patterns.length) para('No architecture pattern is supported by the evidence.', 8, muted);
  section('Risks');
  for (const r of a.summary.risks.slice(0, 6)) {
    const ev = r.evidence.map((id) => a.evidence[id]).filter(Boolean)[0];
    para(`${r.title}${ev ? ` — ${ev.file}${ev.line ? ':' + ev.line : ''}` : ''}`, 8, white);
  }
  if (!a.summary.risks.length) para('No evidence-backed risks were found.', 8, muted);
  section('Strengths');
  for (const s of a.summary.strengths.slice(0, 5)) para(s.title, 8);
  if (!a.summary.strengths.length) para('None reported.', 8, muted);
  section('Technologies');
  para(
    a.nodes
      .filter((n) => n.kind === 'tool')
      .map((n) => `${n.name}${n.version ? ' ' + n.version.value : ''}`)
      .join(', ') || '—',
    7.5,
    muted,
  );
  texts.push({ x: M, y: M - 12, size: 6.5, text: 'Generated by CodePilot from repository evidence. See the JSON export for file and line references.', color: muted });
  void textWidth;
  const areaX = M + colW + 16;
  const areaW = W - areaX - M;
  const areaH = H - 2 * M;
  const scale = Math.min(areaW / img.width, areaH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  return writePdf({
    width: W,
    height: H,
    background: [0.043, 0.051, 0.039],
    lines: [{ x1: M + colW + 8, y1: M, x2: M + colW + 8, y2: H - M, color: [0.13, 0.14, 0.11] }],
    texts,
    image: { rgba: img.pixels, width: img.width, height: img.height, x: areaX, y: H - M - h, w, h },
  });
}

import { getClientKey, type RateLimiter } from '../rateLimit.ts';

export function registerArchitectureRoutes(app: FastifyInstance, projects: ProjectsApi, store: ArchitectureStore, rateLimiter?: RateLimiter): ArchitectureHandlers {
  const h = architectureHandlers(projects, store);
  type Req = FastifyRequest<{ Params: { id: string }; Querystring: ArchQuery }>;
  const ctx = (r: Req) => projects.completedGraph(r, r.params.id);
  app.get('/api/projects/:id/architecture', async (r: Req) => h.overview(ctx(r)));
  app.get('/api/projects/:id/architecture/tools/:toolId', async (r: FastifyRequest<{ Params: { id: string; toolId: string }; Querystring: ArchQuery }>) =>
    h.tool(projects.completedGraph(r, r.params.id), r.params.toolId),
  );
  app.get('/api/projects/:id/architecture/flows', async (r: Req) => h.flows(ctx(r)));
  app.get('/api/projects/:id/architecture/summary', async (r: Req) => h.summary(ctx(r)));
  app.get('/api/projects/:id/architecture/intelligence', async (r: Req) => h.intelligence(ctx(r)));
  app.get('/api/projects/:id/architecture/export', async (r: Req, reply: FastifyReply) => {
    if (rateLimiter) {
      rateLimiter.check(`export:${getClientKey(r)}`, { max: 20, windowMs: 60_000 }, reply);
    }
    return h.exportArchitecture(ctx(r), r.query, reply);
  });
  app.post('/api/projects/:id/architecture/regenerate', async (r: Req, reply: FastifyReply) => {
    if (rateLimiter) {
      rateLimiter.check(`regen:${getClientKey(r)}`, { max: 10, windowMs: 60_000 }, reply);
    }
    return h.regenerate(projects.completedGraph(r, r.params.id, 'analysis:trigger'));
  });
  return h;
}
