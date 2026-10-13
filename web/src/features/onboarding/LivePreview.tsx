import { shapePath } from '@codepilot/analyzer/shapes';
import { useEffect, useRef } from 'react';
import type { NodeType } from '../../lib/api.ts';

export interface PartialData {
  nodes: { id: string; type: string }[];
  edges: { source: string; target: string; resolved: boolean; external: boolean }[];
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Live view of the partial graph streamed during analysis. Nodes are placed on a phyllotaxis
 * spiral in the order the analyzer classified them; every edge drawn has already been
 * resolved by the backend. It is a progress view, not the final layout.
 */
export function LivePreview({ data, label }: { data: PartialData; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const canvas = ref.current;
      if (!canvas) return;
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const files = data.nodes.filter((n) => n.type !== 'external' && n.type !== 'unresolved');
      const count = Math.max(1, files.length);
      const spacing = Math.min(9, (Math.min(width, height) * 0.46) / Math.sqrt(count));
      const pos = new Map<string, [number, number]>();
      files.forEach((n, i) => {
        const r = spacing * Math.sqrt(i + 0.5);
        const a = i * GOLDEN;
        pos.set(n.id, [width / 2 + Math.cos(a) * r, height / 2 + Math.sin(a) * r]);
      });
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = 'rgba(255, 92, 92, 0.28)';
      ctx.beginPath();
      for (const e of data.edges) {
        if (!e.resolved || e.external) continue;
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) continue;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      const size = Math.max(1.6, Math.min(3.5, spacing * 0.42));
      ctx.fillStyle = '#c9cdc2';
      for (const n of files) {
        const p = pos.get(n.id)!;
        ctx.fill(new Path2D(shapePath(n.type as NodeType, p[0], p[1], size)));
      }
    });
    return () => cancelAnimationFrame(frame.current);
  }, [data]);

  return <canvas ref={ref} className="live-preview" role="img" aria-label={label} />;
}
