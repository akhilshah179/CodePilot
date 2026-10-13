import { CATEGORY_ICONS, LAYER_ACCENTS, LAYER_TINTS } from './icons.ts';
import { layoutDiagram, MAX_FILES, NODE_W } from './layout.ts';
import { edgeStyle, RELATION_LABELS, relationOf } from './relations.ts';
import { CONFIDENCE_LABELS, LAYER_LABELS, type ArchNode, type Architecture, type Overlay } from './types.ts';

/**
 * Static renderings of a detected architecture for export: SVG (also rasterized to PNG/PDF by
 * the server) and Mermaid. Both draw only what the architecture contains.
 */

const C = {
  bg: '#0B0D0A',
  raised: '#10130F',
  line: '#20241D',
  lineStrong: '#2E3429',
  text: '#ECEEE6',
  text2: '#B4B9AB',
  text3: '#8B9183',
  accent: '#FFB020',
  async: '#B48CFF',
  edge: '#9AA092',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clipStart = (s: string, n: number) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);

export interface ArchSvgOptions {
  title: string;
  subtitle?: string;
  overlay?: Overlay;
}

export function versionText(n: ArchNode): string {
  if (!n.version) return '';
  const v = n.version.value.startsWith('v') || !/^\d/.test(n.version.value) ? n.version.value : `v${n.version.value}`;
  return n.version.package ? `${n.version.package} ${v}` : v;
}

export function renderArchitectureSvg(arch: Architecture, opts: ArchSvgOptions): string {
  const overlay = opts.overlay ?? 'dataflow';
  const d = layoutDiagram(arch, overlay);
  const header = 76;
  const legendH = 64;
  const width = d.width + 48;
  const height = header + d.height + legendH + 24;
  const ox = 24;
  const oy = header;
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(arch.edges.map((e) => [e.id, e]));
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="IBM Plex Sans, Helvetica, Arial, sans-serif">`);
  p.push(`<rect width="100%" height="100%" fill="${C.bg}"/>`);
  p.push(`<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.edge}"/></marker><marker id="aha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.async}"/></marker></defs>`);
  p.push(`<text x="24" y="36" fill="${C.text}" font-size="20" font-weight="600" font-family="Space Grotesk, IBM Plex Sans, Helvetica, sans-serif">${esc(opts.title)}</text>`);
  if (opts.subtitle) p.push(`<text x="24" y="58" fill="${C.text3}" font-size="12" font-family="IBM Plex Mono, Menlo, monospace">${esc(opts.subtitle)}</text>`);
  p.push(`<line x1="0" x2="${width}" y1="${header - 12.5}" y2="${header - 12.5}" stroke="${C.line}"/>`);

  // Lanes
  for (const lane of d.lanes) {
    p.push(`<rect x="${ox}" y="${oy + lane.y}" width="${d.width}" height="${lane.h - 8}" fill="${LAYER_TINTS[lane.layer]}" stroke="${C.line}"/>`);
    p.push(`<rect x="${ox}" y="${oy + lane.y}" width="3" height="${lane.h - 8}" fill="${LAYER_ACCENTS[lane.layer]}" opacity="0.6"/>`);
    p.push(`<text x="${ox + 14}" y="${oy + lane.y + 22}" fill="${C.text2}" font-size="12" font-weight="500" font-family="IBM Plex Mono, Menlo, monospace">${esc(lane.label)}</text>`);
  }

  // Edges: colour by relationship, dash by confidence, arrows show the direction of the call.
  const colors = [...new Set(d.edges.map((e) => edgeStyle(edgeById.get(e.id)!).color))];
  p.push(`<defs>${colors.map((c, i) => `<marker id="ar${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('')}</defs>`);
  for (const e of d.edges) {
    const s = edgeStyle(edgeById.get(e.id)!);
    p.push(`<path d="${e.d}" transform="translate(${ox} ${oy})" fill="none" stroke="${s.color}" stroke-opacity="${s.opacity}" stroke-width="${s.width}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} marker-end="url(#ar${colors.indexOf(s.color)})"/>`);
  }
  for (const e of d.edges) {
    const edge = edgeById.get(e.id)!;
    const s = edgeStyle(edge);
    const label = edge.labels.slice(0, 2).join(' · ');
    const w = label.length * 6.2 + 14;
    const [mx, my] = [e.mid[0] + ox, e.mid[1] + oy];
    p.push(`<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18" rx="9" fill="${C.bg}" stroke="${C.lineStrong}"/>`);
    p.push(`<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" fill="${s.color}" font-size="10.5" font-family="IBM Plex Mono, Menlo, monospace">${esc(label)}</text>`);
  }

  // Nodes
  for (const dn of d.nodes) {
    const n = byId.get(dn.id)!;
    const x = dn.x + ox;
    const y = dn.y + oy;
    const dash = n.confidence === 'confirmed' ? '' : n.confidence === 'strong' ? ' stroke-dasharray="5 3"' : ' stroke-dasharray="1.5 3"';
    p.push(`<rect x="${x}" y="${y}" width="${dn.w}" height="${dn.h}" rx="4" fill="${C.raised}" stroke="${C.lineStrong}"${dash}/>`);
    p.push(`<path d="${CATEGORY_ICONS[n.category]}" transform="translate(${x + 12} ${y + 12}) scale(0.75)" fill="none" stroke="${LAYER_ACCENTS[n.layer]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
    const version = versionText(n);
    p.push(`<text x="${x + 38}" y="${y + 26}" fill="${C.text}" font-size="14" font-weight="600" font-family="Space Grotesk, IBM Plex Sans, Helvetica, sans-serif">${esc(clip(n.name, version ? 20 : 26))}</text>`);
    if (version) p.push(`<text x="${x + dn.w - 12}" y="${y + 26}" text-anchor="end" fill="${C.text3}" font-size="10.5" font-family="IBM Plex Mono, Menlo, monospace">${esc(clip(version, 14))}</text>`);
    p.push(`<text x="${x + 12}" y="${y + 46}" fill="${C.text2}" font-size="11.5">${esc(clip(n.role || '—', 38))}</text>`);
    p.push(`<text x="${x + 12}" y="${y + 64}" fill="${C.text3}" font-size="10.5" font-family="IBM Plex Mono, Menlo, monospace">${esc(`${n.category} · ${CONFIDENCE_LABELS[n.confidence].toLowerCase()}`)}</text>`);
    let cy = y + 74;
    if (n.app?.chips.length) {
      let cx = x + 12;
      for (const chipId of n.app.chips.slice(0, 5)) {
        const chip = byId.get(chipId);
        if (!chip) continue;
        const w = Math.min(96, chip.name.length * 6 + 12);
        if (cx + w > x + dn.w - 10) break;
        p.push(`<rect x="${cx}" y="${cy + 2}" width="${w}" height="18" rx="3" fill="none" stroke="${C.lineStrong}"/>`);
        p.push(`<text x="${cx + 6}" y="${cy + 15}" fill="${C.text2}" font-size="10" font-family="IBM Plex Mono, Menlo, monospace">${esc(clip(chip.name, 14))}</text>`);
        cx += w + 6;
      }
      cy += 26;
    }
    if (n.files.length) {
      p.push(`<line x1="${x + 10}" x2="${x + dn.w - 10}" y1="${cy + 0.5}" y2="${cy + 0.5}" stroke="${C.line}"/>`);
      p.push(`<text x="${x + 12}" y="${cy + 15}" fill="${C.text3}" font-size="9.5" font-family="IBM Plex Mono, Menlo, monospace">WHERE USED</text>`);
      n.files.slice(0, MAX_FILES).forEach((f, i) => {
        const label = `${clipStart(f.path, 30)}${f.lines[0] ? `:${f.lines[0]}` : ''}`;
        p.push(`<text x="${x + 12}" y="${cy + 33 + i * 18}" fill="${C.text2}" font-size="10.5" font-family="IBM Plex Mono, Menlo, monospace">${esc(label)}</text>`);
      });
      if (n.files.length > MAX_FILES) p.push(`<text x="${x + 12}" y="${cy + 33 + MAX_FILES * 18}" fill="${C.text3}" font-size="10" font-family="IBM Plex Mono, Menlo, monospace">+${n.files.length - MAX_FILES} more</text>`);
    }
  }

  // Legend
  const ly = oy + d.height + 20;
  p.push(`<line x1="0" x2="${width}" y1="${ly - 8.5}" y2="${ly - 8.5}" stroke="${C.line}"/>`);
  const rels = [...new Set(arch.edges.filter((e) => e.overlays.includes(overlay)).map((e) => relationOf(e.labels)))];
  rels.forEach((r, i) => {
    const s = edgeStyle({ labels: arch.edges.find((e) => relationOf(e.labels) === r)!.labels, confidence: 'confirmed' });
    const x = 24 + (i % 6) * 200;
    const y = ly + 16 + Math.floor(i / 6) * 0;
    p.push(`<path d="M${x} ${y}h26" stroke="${s.color}" stroke-width="1.6"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`);
    p.push(`<text x="${x + 34}" y="${y + 4}" fill="${C.text3}" font-size="11">${esc(RELATION_LABELS[r])}</text>`);
  });
  p.push(`<text x="24" y="${ly + 44}" fill="${C.text3}" font-size="10.5" font-family="IBM Plex Mono, Menlo, monospace">${esc(`${overlay} overlay · arrows: caller → callee · dashed: strong inference · dotted: possible · evidence: JSON export`)}</text>`);
  p.push('</svg>');
  void NODE_W;
  return p.join('\n');
}

/** Mermaid flowchart with one subgraph per layer. Libraries are listed inside their app's label. */
export function renderArchitectureMermaid(arch: Architecture, overlay: Overlay = 'dataflow'): string {
  const ids = new Map<string, string>();
  const idFor = (id: string) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size + 1}`);
    return ids.get(id)!;
  };
  const q = (s: string) => s.replace(/"/g, '#quot;').replace(/[<>]/g, '');
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const lines = ['flowchart TB'];
  for (const layer of arch.layers) {
    const members = arch.nodes.filter((n) => n.layer === layer && n.display === 'node');
    if (!members.length) continue;
    lines.push(`  subgraph ${layer}["${LAYER_LABELS[layer]}"]`);
    for (const n of members) {
      const chips = (n.app?.chips ?? []).map((c) => byId.get(c)?.name).filter(Boolean);
      const version = versionText(n);
      const label = [`<b>${q(n.name)}</b>${version ? ` ${q(version)}` : ''}`, q(n.role), chips.length ? q(chips.join(', ')) : '', n.confidence !== 'confirmed' ? `<i>${CONFIDENCE_LABELS[n.confidence]}</i>` : ''].filter(Boolean).join('<br/>');
      const shape = n.category === 'database' || n.category === 'cache' ? ['[(', ')]'] : n.kind === 'app' ? ['[', ']'] : ['(', ')'];
      lines.push(`    ${idFor(n.id)}${shape[0]}"${label}"${shape[1]}`);
    }
    lines.push('  end');
  }
  for (const e of arch.edges) {
    if (!e.overlays.includes(overlay)) continue;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s.display !== 'node' || t.display !== 'node') continue;
    const arrow = e.async || e.confidence !== 'confirmed' ? '-.->' : '-->';
    lines.push(`  ${idFor(e.source)} ${arrow}|"${q(e.labels.join(' · '))}"| ${idFor(e.target)}`);
  }
  return lines.join('\n') + '\n';
}
