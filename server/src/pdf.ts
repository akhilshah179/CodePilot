import { deflateSync } from 'node:zlib';

/**
 * Minimal single-page PDF writer: text in the standard Helvetica fonts plus one RGB image.
 * Enough for an architecture one-pager without pulling in a PDF library.
 */

export interface PdfText {
  x: number;
  y: number;
  size: number;
  text: string;
  bold?: boolean;
  /** Gray level 0 (black) – 1 (white) or an [r, g, b] triple in 0–1. */
  color?: number | [number, number, number];
}

export interface PdfImage {
  /** Raw RGBA pixels. */
  rgba: Uint8Array;
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfPage {
  width: number;
  height: number;
  background?: [number, number, number];
  texts: PdfText[];
  image?: PdfImage;
  lines?: { x1: number; y1: number; x2: number; y2: number; color: [number, number, number] }[];
}

const WIN_ANSI: Record<string, string> = { '…': '...', '→': '->', '←': '<-', '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '‹': '<', '›': '>', '·': '·', '•': '·' };

/** PDF string literal in Latin-1, escaping delimiters; characters outside Latin-1 become '?'. */
function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = WIN_ANSI[ch] ?? ch;
    for (const cc of c) {
      const code = cc.charCodeAt(0);
      if (cc === '\\' || cc === '(' || cc === ')') out += '\\' + cc;
      else if (code < 32) out += ' ';
      else if (code > 255) out += '?';
      else out += cc;
    }
  }
  return `(${out})`;
}

const color = (c: PdfText['color'], op: 'rg' | 'RG') => (Array.isArray(c) ? `${c.map((v) => v.toFixed(3)).join(' ')} ${op}` : `${(c ?? 0).toFixed(3)} ${(c ?? 0).toFixed(3)} ${(c ?? 0).toFixed(3)} ${op}`);

/** Approximate Helvetica advance width (em) used for wrapping. */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) w += /[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-Z]/.test(ch) ? 0.66 : ch === ' ' ? 0.28 : 0.53;
  return w * size * (bold ? 1.05 : 1);
}

/** Greedy word wrap to a width in points. */
export function wrap(text: string, width: number, size: number, bold = false): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size, bold) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function writePdf(page: PdfPage): Buffer {
  const objects: (string | Buffer)[] = [];
  const add = (o: string | Buffer) => objects.push(o) && objects.length;

  const ops: string[] = [];
  if (page.background) ops.push(`${color(page.background, 'rg')} 0 0 ${page.width} ${page.height} re f`);
  for (const l of page.lines ?? []) ops.push(`${color(l.color, 'RG')} 0.6 w ${l.x1} ${l.y1} m ${l.x2} ${l.y2} l S`);
  if (page.image) ops.push(`q ${page.image.w.toFixed(2)} 0 0 ${page.image.h.toFixed(2)} ${page.image.x.toFixed(2)} ${page.image.y.toFixed(2)} cm /Im1 Do Q`);
  for (const t of page.texts) ops.push(`BT /${t.bold ? 'F2' : 'F1'} ${t.size} Tf ${color(t.color, 'rg')} ${t.x.toFixed(2)} ${t.y.toFixed(2)} Td ${pdfString(t.text)} Tj ET`);
  const content = Buffer.from(ops.join('\n'), 'latin1');

  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  void catalog;
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${page.image ? ' /XObject << /Im1 7 0 R >>' : ''} >> /Contents 4 0 R >>`);
  add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]));
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  if (page.image) {
    const { rgba, width, height } = page.image;
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const data = deflateSync(rgb);
    add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]));
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(offset);
    const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n')]);
    chunks.push(body);
    offset += body.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
