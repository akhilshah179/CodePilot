import type { ToolCategory } from './types.ts';

/**
 * Monoline category glyphs on a 24×24 grid, drawn with `stroke` only (no fills), so the same
 * path data renders in the web page and in exported SVG/PNG/PDF. These are generic category
 * marks, not vendor logos.
 */
export const CATEGORY_ICONS: Record<ToolCategory, string> = {
  frontend: 'M3 5h18v11H3zM8 20h8M12 16v4',
  framework: 'M8 5L3 12l5 7M16 5l5 7-5 7',
  runtime: 'M4 6h16v12H4zM8 10l3 2-3 2M13 14h3',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  cache: 'M13 2L4 14h7l-1 8 9-12h-7z',
  search: 'M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.5 15.5L21 21',
  storage: 'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10',
  queue: 'M4 6h16M4 12h16M4 18h16M17 3l3 3-3 3',
  worker: 'M12 8a4 4 0 110 8 4 4 0 010-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  orm: 'M3 4h18v16H3zM3 9h18M3 14h18M9 9v11',
  auth: 'M8 11V7a4 4 0 118 0v4M5 11h14v10H5zM12 15v2',
  payments: 'M2 6h20v12H2zM2 10h20M6 15h4',
  email: 'M3 5h18v14H3zM3 6l9 7 9-7',
  messaging: 'M4 4h16v12H9l-5 4z',
  ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  observability: 'M2 12h4l3-8 4 16 3-8h6',
  'http-client': 'M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4',
  api: 'M8 4H6a2 2 0 00-2 2v4l-2 2 2 2v4a2 2 0 002 2h2M16 4h2a2 2 0 012 2v4l2 2-2 2v4a2 2 0 01-2 2h-2',
  cloud: 'M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z',
  container: 'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
  orchestration: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  iac: 'M12 2l10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5',
  ci: 'M20 12a8 8 0 01-14.9 4M4 12a8 8 0 0114.9-4M19 3v5h-5M5 21v-5h5',
  hosting: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  proxy: 'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z',
  realtime: 'M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0M2 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0',
  analytics: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  service: 'M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z',
  application: 'M12 2l9 5v10l-9 5-9-5V7z',
};

export const LAYER_TINTS: Record<string, string> = {
  clients: 'rgba(76, 154, 255, 0.045)',
  edge: 'rgba(255, 176, 32, 0.045)',
  application: 'rgba(201, 205, 194, 0.035)',
  data: 'rgba(255, 92, 92, 0.045)',
  async: 'rgba(180, 140, 255, 0.05)',
  external: 'rgba(95, 207, 160, 0.045)',
  delivery: 'rgba(139, 145, 131, 0.05)',
};

export const LAYER_ACCENTS: Record<string, string> = {
  clients: '#4c9aff',
  edge: '#ffb020',
  application: '#c9cdc2',
  data: '#ff5c5c',
  async: '#b48cff',
  external: '#5fcfa0',
  delivery: '#8b9183',
};
