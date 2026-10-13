import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { snapshot } from '../landing/snapshot.ts';
import { setStory, setTarget } from './story.ts';

const LivingScene = lazy(() => import('./LivingScene.tsx'));

/** WebGL available, and not a device that would struggle (≤ 2 cores or ≤ 2 GB reported memory). */
function canRender3D(): boolean {
  try {
    const c = document.createElement('canvas');
    if (!(c.getContext('webgl2') ?? c.getContext('webgl'))) return false;
  } catch {
    return false;
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) return false;
  if (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 2) return false;
  return true;
}

/**
 * Drives the story from scroll: sections marked `data-chapter` map the page position to a
 * continuous chapter value; anything between them (product, trust) hides the scene and stops
 * its render loop.
 */
export function useStoryScroll(stageRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const mid = window.innerHeight * 0.5;
      let target = -1;
      for (const el of document.querySelectorAll<HTMLElement>('[data-chapter]')) {
        const r = el.getBoundingClientRect();
        if (r.top <= mid && r.bottom > mid) {
          target = Number(el.dataset.chapter) - 0.5 + (mid - r.top) / r.height;
          break;
        }
      }
      const visible = target >= -0.5;
      if (visible) setTarget(Math.max(0, target));
      setStory({ visible });
      stageRef.current?.classList.toggle('is-hidden', !visible);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [stageRef]);
}

/** The fixed stage behind the story: the 3D scene, or a static drawing of the same graph. */
export function Stage({ stageRef, compact, reduced }: { stageRef: React.RefObject<HTMLDivElement | null>; compact: boolean; reduced: boolean }) {
  const [three] = useState(canRender3D);
  return (
    <div ref={stageRef} className="lx-stage" aria-hidden="true">
      <div className="lx-atmos" />
      {three ? (
        <Suspense fallback={<StaticGraph />}>
          <LivingScene key={compact ? 'compact' : 'full'} compact={compact} reduced={reduced} />
        </Suspense>
      ) : (
        <StaticGraph />
      )}
      <div className="lx-vignette" />
    </div>
  );
}

/** Fallback (no WebGL, low-power device, or while the scene loads): the real import graph, drawn once. */
function StaticGraph() {
  const { nodes, edges, box } = useMemo(() => {
    const xs = snapshot.nodes.map((n) => n.x);
    const ys = snapshot.nodes.map((n) => n.y);
    const pos = new Map(snapshot.nodes.map((n) => [n.id, n]));
    return {
      nodes: snapshot.nodes,
      edges: snapshot.edges.map((e) => [pos.get(e.source), pos.get(e.target)] as const).filter(([a, b]) => a && b),
      box: [Math.min(...xs) - 40, Math.min(...ys) - 40, Math.max(...xs) - Math.min(...xs) + 80, Math.max(...ys) - Math.min(...ys) + 80],
    };
  }, []);
  return (
    <svg className="lx-static" viewBox={box.join(' ')} preserveAspectRatio="xMidYMid meet">
      <g stroke="rgba(220,205,175,0.14)" strokeWidth={1}>
        {edges.map(([a, b], i) => (
          <line key={i} x1={a!.x} y1={a!.y} x2={b!.x} y2={b!.y} />
        ))}
      </g>
      {nodes.map((n) => (
        <circle key={n.id} cx={n.x} cy={n.y} r={n.id.startsWith('server/') ? 5 : 4} fill={n.id.startsWith('server/') ? '#ffcc80' : n.id.startsWith('web/') ? '#f2ede0' : '#bccdd1'} opacity={0.75} />
      ))}
    </svg>
  );
}
