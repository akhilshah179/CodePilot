import { PerformanceMonitor } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { buildModel, CH, chapterBlend, presence, type EdgeKind, type SceneModel } from './model.ts';
import { onWake, setStory, story, useStory } from './story.ts';

/*
 * The living codebase. One canvas, fixed behind the story; the same real nodes morph between
 * chapter layouts as the page scrolls. Everything per-frame is written straight into typed
 * arrays — React renders this component once.
 */

interface Props {
  compact: boolean;
  reduced: boolean;
}

const POINT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float s = aSize * uScale / max(0.1, -mv.z);
    gl_PointSize = s;
    vColor = aColor;
    vAlpha = aAlpha * smoothstep(0.5, 2.5, s);
  }
`;
const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.34, 0.14, d);
    float halo = pow(1.0 - d, 2.4) * 0.5;
    vec3 col = vColor * (halo + core) + vec3(core * 0.25);
    gl_FragColor = vec4(col, (halo + core) * vAlpha);
  }
`;
const LINE_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;
const LINE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(vColor, vAlpha); }
`;

const EDGE_COLOR: Record<EdgeKind, [number, number, number]> = {
  import: [0.86, 0.8, 0.68],
  symbol: [0.55, 0.55, 0.5],
  package: [0.45, 0.52, 0.62],
  tech: [1, 0.69, 0.13],
  arch: [0, 0.82, 1],
  ingest: [0, 0.82, 1],
  evidence: [1, 0.69, 0.13],
};

/** Camera per chapter: position, look-at, and view offset as a fraction of the viewport (x < 0 moves the scene right, y > 0 moves it up). */
type Shot = { pos: [number, number, number]; look: [number, number, number]; off: [number, number] };
const SHOTS: Shot[] = [
  { pos: [0, 0.6, 28], look: [0, -0.6, 0], off: [-0.19, 0.04] },
  { pos: [-1.5, 0.4, 23], look: [-1.8, 0, 0], off: [-0.18, 0] },
  { pos: [2, 3, 27], look: [-0.4, -0.6, 0], off: [0.19, 0] },
  { pos: [1.2, 11, 23], look: [1.4, -0.6, 0], off: [-0.14, 0] },
  { pos: [-0.5, 8.5, 17], look: [0.4, 0.6, 0], off: [0.2, 0] },
  { pos: [0, 3.2, 21], look: [0, 0, 0], off: [-0.19, 0] },
  { pos: [0, 1, 15], look: [0, 0, 0], off: [0.2, 0] },
  { pos: [0, 0, 17], look: [0, 0, 0], off: [0, 0.2] },
]
/** Phones: farther away, centred, and lifted into the top part of the screen above the story card. */
const SHOTS_COMPACT: Shot[] = SHOTS.map((s, i) => ({
  pos: [s.pos[0] * 0.6, s.pos[1] * 1.1, s.pos[2] * (i === CH.hero || i === CH.converge ? 1.75 : 2)],
  look: s.look,
  off: [0, i === CH.hero ? 0.12 : 0.2],
}));

export default function LivingScene({ compact, reduced }: Props) {
  const model = useMemo(() => buildModel({ compact }), [compact]);
  const visible = useStory((s) => s.visible);
  const [dpr, setDpr] = useState(compact ? 1.25 : 1.75);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tipRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <Canvas
        className="lx-canvas"
        dpr={dpr}
        frameloop={!visible ? 'never' : reduced ? 'demand' : 'always'}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ fov: 40, near: 0.1, far: 120, position: [0, 1.2, 25] }}
        aria-hidden="true"
      >
        <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(compact ? 1.5 : 2)} flipflops={3} onFallback={() => setDpr(1)} />
        <System model={model} compact={compact} reduced={reduced} labelRefs={labelRefs} tipRef={tipRef} />
      </Canvas>
      <div className="lx-labels" aria-hidden="true">
        {model.labels.map((l, i) => (
          <div key={i} ref={(el) => void (labelRefs.current[i] = el)} className={`lx-label tone-${l.tone ?? 'plain'}`}>
            <span>{l.text}</span>
            {l.sub && <small>{l.sub}</small>}
          </div>
        ))}
      </div>
      <Tooltip model={model} tipRef={tipRef} />
    </>
  );
}

function Tooltip({ model, tipRef }: { model: SceneModel; tipRef: React.RefObject<HTMLDivElement | null> }) {
  const hover = useStory((s) => s.hover);
  const n = hover >= 0 ? model.nodes[hover] : null;
  return (
    <div ref={tipRef} className={`lx-tip${n ? ' is-on' : ''}`} aria-hidden="true">
      {n && (
        <>
          <span className="lx-tip-kind">{n.kind === 'app' ? 'application' : n.kind}</span>
          <strong>{n.label}</strong>
          <span className="lx-tip-detail">{n.detail}</span>
          {model.neighbors[hover].length > 0 && (
            <span className="lx-tip-meta">
              {new Set(model.neighbors[hover]).size} connection{new Set(model.neighbors[hover]).size === 1 ? '' : 's'} highlighted
            </span>
          )}
        </>
      )}
    </div>
  );
}

function System({ model, compact, reduced, labelRefs, tipRef }: Props & { model: SceneModel; labelRefs: React.RefObject<(HTMLDivElement | null)[]>; tipRef: React.RefObject<HTMLDivElement | null> }) {
  const { camera, size, invalidate } = useThree();
  const N = model.nodes.length;
  const E = model.edges.length;
  const P = compact ? 36 : 110;

  const built = useMemo(() => {
    // Nodes
    const cur = new Float32Array(N * 3);
    const alpha = new Float32Array(N);
    const sizeMul = new Float32Array(N);
    const pGeo = new THREE.BufferGeometry();
    const pPos = new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const pCol = new THREE.BufferAttribute(new Float32Array(model.nodes.flatMap((n) => n.color)), 3);
    const pSize = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
    const pAlpha = new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage);
    pGeo.setAttribute('position', pPos);
    pGeo.setAttribute('aColor', pCol);
    pGeo.setAttribute('aSize', pSize);
    pGeo.setAttribute('aAlpha', pAlpha);
    const pMat = new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, uniforms: { uScale: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;

    // Edges
    const lGeo = new THREE.BufferGeometry();
    const lPos = new THREE.BufferAttribute(new Float32Array(E * 6), 3).setUsage(THREE.DynamicDrawUsage);
    const lCol = new THREE.BufferAttribute(new Float32Array(model.edges.flatMap((e) => [...EDGE_COLOR[e.kind], ...EDGE_COLOR[e.kind]])), 3);
    const lAlpha = new THREE.BufferAttribute(new Float32Array(E * 2), 1).setUsage(THREE.DynamicDrawUsage);
    lGeo.setAttribute('position', lPos);
    lGeo.setAttribute('aColor', lCol);
    lGeo.setAttribute('aAlpha', lAlpha);
    const lMat = new THREE.ShaderMaterial({ vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lines = new THREE.LineSegments(lGeo, lMat);
    lines.frustumCulled = false;

    // Packets (+1: the traced request)
    const kGeo = new THREE.BufferGeometry();
    const kPos = new THREE.BufferAttribute(new Float32Array((P + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const kCol = new THREE.BufferAttribute(new Float32Array((P + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const kSize = new THREE.BufferAttribute(new Float32Array(P + 1).fill(0.34), 1);
    const kAlpha = new THREE.BufferAttribute(new Float32Array(P + 1), 1).setUsage(THREE.DynamicDrawUsage);
    kSize.setX(P, 0.95);
    kGeo.setAttribute('position', kPos);
    kGeo.setAttribute('aColor', kCol);
    kGeo.setAttribute('aSize', kSize);
    kGeo.setAttribute('aAlpha', kAlpha);
    const packets = new THREE.Points(kGeo, pMat);
    packets.frustumCulled = false;
    const pk = Array.from({ length: P }, (_, i) => ({ e: -1, t: (i * 0.618) % 1, speed: 0.35 + ((i * 0.37) % 0.4) }));

    // Traced request path
    const tr = model.trace?.nodes ?? [];
    const hops: [number, number][] = [];
    for (let i = 1; i < tr.length; i++) if (tr[i] !== tr[i - 1]) hops.push([tr[i - 1], tr[i]]);
    const tGeo = new THREE.BufferGeometry();
    const tPos = new THREE.BufferAttribute(new Float32Array(Math.max(1, hops.length) * 6), 3).setUsage(THREE.DynamicDrawUsage);
    const tCol = new THREE.BufferAttribute(new Float32Array(Math.max(1, hops.length) * 6).map((_, i) => [1, 0.69, 0.13][i % 3]), 3);
    const tAlpha = new THREE.BufferAttribute(new Float32Array(Math.max(1, hops.length) * 2), 1).setUsage(THREE.DynamicDrawUsage);
    tGeo.setAttribute('position', tPos);
    tGeo.setAttribute('aColor', tCol);
    tGeo.setAttribute('aAlpha', tAlpha);
    const tracePath = new THREE.LineSegments(tGeo, lMat);
    tracePath.frustumCulled = false;

    // Layer rings
    const ringMat = new THREE.LineBasicMaterial({ color: new THREE.Color(1, 0.69, 0.13), transparent: true, opacity: 0, depthWrite: false });
    const rings = model.rings.map((r) => {
      const pts = Array.from({ length: 97 }, (_, i) => {
        const a = (i / 96) * Math.PI * 2;
        return new THREE.Vector3(r.x + Math.cos(a) * r.r, r.y, r.z + Math.sin(a) * r.r * 0.8);
      });
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
    });

    return { cur, alpha, sizeMul, points, pPos, pSize, pAlpha, lines, lPos, lAlpha, packets, kPos, kCol, kAlpha, pk, hops, tracePath, tPos, tAlpha, rings, ringMat, pMat, lMat, pGeo, lGeo, kGeo, tGeo };
  }, [model, N, E, P]);

  useEffect(
    () => () => {
      for (const g of [built.pGeo, built.lGeo, built.kGeo, built.tGeo, ...built.rings.map((r) => r.geometry)]) g.dispose();
      for (const m of [built.pMat, built.lMat, built.ringMat]) m.dispose();
    },
    [built],
  );

  // Render on demand (reduced motion): any scroll, hover or selection change requests a frame.
  useEffect(() => onWake(() => invalidate()), [invalidate]);

  // Pointer → story (hover is resolved in the frame loop by projecting nodes).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      story.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      story.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      const t = e.target as Element | null;
      story.pointer.inside = e.pointerType === 'mouse' && !t?.closest('a, button, input, select, .lx-card, .lx-hero-copy, .lx-nav, .lx-hud, .lx-final-copy');
      if (reduced) invalidate();
    };
    const leave = () => {
      story.pointer.inside = false;
      setStory({ hover: -1 });
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', leave);
    };
  }, [reduced, invalidate]);

  const group = useRef<THREE.Group>(null);
  const live = useRef({ v: 0, angle: 0, trace: 0, started: false, cam: new THREE.Vector3(0, 1.2, 25), look: new THREE.Vector3(), off: [-0.2, 0] as [number, number], time: 0 });
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), camDir: new THREE.Vector3() }), []);
  const shots = compact ? SHOTS_COMPACT : SHOTS;

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const L = live.current;
    const b = built;
    L.time += dt;
    const snap = reduced || !L.started;

    // Chapter position: smoothed scroll, or the nearest chapter with reduced motion.
    L.v = reduced ? Math.round(story.target) : L.v + (story.target - L.v) * (1 - Math.exp(-dt * 4));
    const v = L.v;
    const { i0, i1, f } = chapterBlend(v);
    const near = Math.round(v);
    if (near !== story.chapter) setStory({ chapter: near });
    const wHero = presence(v, CH.hero);
    const wTrace = presence(v, CH.trace);
    const wExplain = presence(v, CH.explain);
    const wMap = Math.max(presence(v, CH.map), wTrace);

    // Camera
    const s0 = shots[i0];
    const s1 = shots[i1];
    const px = reduced || compact ? 0 : story.pointer.x;
    const py = reduced || compact ? 0 : story.pointer.y;
    tmp.v.set(s0.pos[0] + (s1.pos[0] - s0.pos[0]) * f + px * 1.4, s0.pos[1] + (s1.pos[1] - s0.pos[1]) * f + py * 0.9, s0.pos[2] + (s1.pos[2] - s0.pos[2]) * f);
    tmp.w.set(s0.look[0] + (s1.look[0] - s0.look[0]) * f, s0.look[1] + (s1.look[1] - s0.look[1]) * f, s0.look[2] + (s1.look[2] - s0.look[2]) * f);
    const kc = snap ? 1 : 1 - Math.exp(-dt * 3);
    L.cam.lerp(tmp.v, kc);
    L.look.lerp(tmp.w, kc);
    L.off[0] += (s0.off[0] + (s1.off[0] - s0.off[0]) * f - L.off[0]) * kc;
    L.off[1] += (s0.off[1] + (s1.off[1] - s0.off[1]) * f - L.off[1]) * kc;
    camera.position.copy(L.cam);
    camera.lookAt(L.look);
    const cam = camera as THREE.PerspectiveCamera;
    const W = size.width;
    const H = size.height;
    cam.setViewOffset(W, H, L.off[0] * W, L.off[1] * H, W, H);
    cam.updateMatrixWorld();
    b.pMat.uniforms.uScale.value = ((H * state.viewport.dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360))) * (compact ? 0.6 : 0.52);

    // Slow rotation on the hero and the final view; elsewhere the layout faces the reader.
    const g = group.current!;
    const spin = Math.max(wHero, presence(v, CH.converge));
    if (!reduced && spin > 0.5) L.angle += dt * 0.05;
    else {
      const home = Math.round(L.angle / (Math.PI * 2)) * Math.PI * 2;
      L.angle += (home - L.angle) * (snap ? 1 : 1 - Math.exp(-dt * 2));
    }
    g.rotation.y = L.angle;
    g.rotation.x = reduced ? 0 : py * 0.04 * wHero;
    g.updateMatrixWorld();

    // Hover: the node nearest the pointer, among the ones that are visible.
    const hoverable = !compact && story.pointer.inside && v < CH.converge - 0.5 && Math.abs(v - Math.round(v)) < 0.3;
    let hover = -1;
    if (hoverable) {
      let best = 22 * 22;
      for (let i = 0; i < N; i++) {
        const k = model.nodes[i].kind;
        if (k === 'anchor' || k === 'github' || b.alpha[i] < 0.25) continue;
        tmp.v.fromArray(b.cur, i * 3).applyMatrix4(g.matrixWorld).project(camera);
        if (tmp.v.z > 1) continue;
        const dx = ((tmp.v.x - story.pointer.x) * W) / 2;
        const dy = ((tmp.v.y - story.pointer.y) * H) / 2;
        const d = dx * dx + dy * dy - (k === 'symbol' ? 60 : 0);
        if (d < best) {
          best = d;
          hover = i;
        }
      }
    }
    if (hover !== story.hover) setStory({ hover });
    const hoverSet = hover >= 0 ? new Set([hover, ...model.neighbors[hover]]) : null;

    // Explain: the selected technology and what it connects to.
    const sel = model.techs[story.tech];
    const selSet = sel ? new Set([sel.node, ...sel.edges.flatMap((e) => [model.edges[e].a, model.edges[e].b])]) : null;
    const selEdges = new Set(sel?.edges ?? []);
    const traceSet = new Set(model.trace?.nodes ?? []);

    // Nodes
    const LA = model.layouts[i0];
    const LB = model.layouts[i1];
    const AA = model.alphas[i0];
    const AB = model.alphas[i1];
    const SA = model.sizes[i0];
    const SB = model.sizes[i1];
    const kp = snap ? 1 : 1 - Math.exp(-dt * 2.6);
    const ka = snap ? 1 : 1 - Math.exp(-dt * 6);
    const breathe = reduced ? 0 : 0.06;
    const pos = b.pPos.array as Float32Array;
    const al = b.pAlpha.array as Float32Array;
    const sz = b.pSize.array as Float32Array;
    tmp.camDir.copy(camera.position).sub(L.look).normalize();
    for (let i = 0; i < N; i++) {
      const n = model.nodes[i];
      let ta = AA[i] + (AB[i] - AA[i]) * f;
      let ts = SA[i] + (SB[i] - SA[i]) * f;
      if (hoverSet) {
        if (i === hover) ts *= 1.6;
        if (hoverSet.has(i)) ta = Math.max(ta, 0.95);
        else ta *= 0.14;
      }
      if (selSet && wExplain > 0) {
        if (selSet.has(i)) ta = ta + (Math.max(ta, 0.95) - ta) * wExplain;
        else ta *= 1 - 0.6 * wExplain;
        if (i === sel.node) ts *= 1 + 0.5 * wExplain;
      }
      if (wTrace > 0 && traceSet.has(i)) ta = Math.max(ta, wTrace);
      for (let k = 0; k < 3; k++) {
        const target = LA[i * 3 + k] + (LB[i * 3 + k] - LA[i * 3 + k]) * f;
        b.cur[i * 3 + k] += (target - b.cur[i * 3 + k]) * kp;
      }
      // A slow, per-node drift keeps the system alive without moving it anywhere.
      const ph = i * 1.7;
      pos[i * 3] = b.cur[i * 3] + Math.sin(L.time * 0.35 + ph) * breathe;
      pos[i * 3 + 1] = b.cur[i * 3 + 1] + Math.cos(L.time * 0.3 + ph * 1.3) * breathe;
      pos[i * 3 + 2] = b.cur[i * 3 + 2];
      // Near the cursor (hero), nodes lean toward the viewer and brighten.
      if (wHero > 0 && story.pointer.inside && !compact && !reduced && (n.kind === 'file' || n.kind === 'symbol')) {
        tmp.v.fromArray(pos, i * 3).applyMatrix4(g.matrixWorld).project(camera);
        const dx = ((tmp.v.x - story.pointer.x) * W) / 2;
        const dy = ((tmp.v.y - story.pointer.y) * H) / 2;
        const infl = Math.exp(-(dx * dx + dy * dy) / (150 * 150)) * wHero;
        if (infl > 0.01) {
          pos[i * 3 + 2] += infl * 1.2;
          ta = Math.min(1, ta + infl * 0.5);
        }
      }
      b.alpha[i] += (ta - b.alpha[i]) * ka;
      b.sizeMul[i] += (ts - b.sizeMul[i]) * ka;
      al[i] = b.alpha[i];
      sz[i] = n.size * b.sizeMul[i];
    }
    b.pPos.needsUpdate = true;
    b.pAlpha.needsUpdate = true;
    b.pSize.needsUpdate = true;

    // Edges
    const EA = model.edgeAlpha[i0];
    const EB = model.edgeAlpha[i1];
    const lp = b.lPos.array as Float32Array;
    const la = b.lAlpha.array as Float32Array;
    for (let e = 0; e < E; e++) {
      const { a, b: c, kind } = model.edges[e];
      lp[e * 6] = pos[a * 3];
      lp[e * 6 + 1] = pos[a * 3 + 1];
      lp[e * 6 + 2] = pos[a * 3 + 2];
      lp[e * 6 + 3] = pos[c * 3];
      lp[e * 6 + 4] = pos[c * 3 + 1];
      lp[e * 6 + 5] = pos[c * 3 + 2];
      let ea = (EA[kind] + (EB[kind] - EA[kind]) * f) * Math.pow(Math.min(1, Math.min(al[a], al[c]) * 1.15), 1.5);
      if (hoverSet && kind !== 'ingest') ea = a === hover || c === hover ? 0.75 : ea * 0.15;
      if (wExplain > 0 && kind === 'tech') ea = selEdges.has(e) ? ea + (0.6 - ea) * wExplain : ea * (1 - 0.8 * wExplain);
      la[e * 2] = ea;
      la[e * 2 + 1] = kind === 'ingest' ? ea * 0.4 : ea;
    }
    b.lPos.needsUpdate = true;
    b.lAlpha.needsUpdate = true;

    // Ambient packets along the edges this chapter is about.
    const kpos = b.kPos.array as Float32Array;
    const kcol = b.kCol.array as Float32Array;
    const kal = b.kAlpha.array as Float32Array;
    const list = near === CH.explain && sel ? sel.edges : model.packetEdges[near];
    for (let p = 0; p < P; p++) {
      const pk = b.pk[p];
      pk.t += dt * pk.speed * (near === CH.map ? 0.7 : 1);
      if (pk.e < 0 || pk.t >= 1) {
        pk.t = pk.e < 0 ? pk.t : 0;
        pk.e = list.length ? list[Math.floor(((p * 7919 + Math.floor(L.time * 13)) % 10007) / 10007 * list.length)] : -1;
      }
      if (pk.e < 0 || reduced) {
        kal[p] = 0;
        continue;
      }
      const ed = model.edges[pk.e];
      const t = pk.t;
      for (let k = 0; k < 3; k++) kpos[p * 3 + k] = pos[ed.a * 3 + k] + (pos[ed.b * 3 + k] - pos[ed.a * 3 + k]) * t;
      const col = EDGE_COLOR[ed.kind === 'import' || ed.kind === 'symbol' ? 'arch' : ed.kind];
      kcol.set(col, p * 3);
      const vis = Math.min(1, la[pk.e * 2] * 4) * Math.sin(Math.PI * t);
      kal[p] = (hoverSet && !(ed.a === hover || ed.b === hover) ? 0.15 : 0.9) * vis;
    }

    // The traced request: one packet hopping through the files of a real flow.
    const tr = model.trace?.nodes ?? [];
    const tpos = b.tPos.array as Float32Array;
    const tal = b.tAlpha.array as Float32Array;
    if (tr.length > 1) {
      if (!reduced && wTrace > 0.3) L.trace += dt * 0.85;
      const steps = tr.length;
      const cycle = L.trace % (steps + 1.5);
      const k = Math.min(steps - 1, Math.floor(cycle));
      const frac = Math.min(1, (cycle - k) * 1.6);
      const ease = frac * frac * (3 - 2 * frac);
      if (wTrace > 0.3 && !reduced && k !== story.traceStep) setStory({ traceStep: k });
      const a = tr[k];
      const c = tr[Math.min(steps - 1, k + 1)];
      for (let q = 0; q < 3; q++) kpos[P * 3 + q] = pos[a * 3 + q] + (pos[c * 3 + q] - pos[a * 3 + q]) * (k + 1 < steps ? ease : 0);
      kcol.set([1, 0.78, 0.35], P * 3);
      kal[P] = reduced ? 0 : wTrace;
      // Hops lit as the request passes them (all lit when motion is reduced).
      const passed = new Set<string>();
      for (let i = 1; i <= k; i++) passed.add(`${tr[i - 1]}>${tr[i]}`);
      b.hops.forEach(([x, y], h) => {
        for (let q = 0; q < 3; q++) {
          tpos[h * 6 + q] = pos[x * 3 + q];
          tpos[h * 6 + 3 + q] = pos[y * 3 + q];
        }
        const on = reduced || passed.has(`${x}>${y}`);
        tal[h * 2] = tal[h * 2 + 1] = wTrace * (on ? 0.95 : 0.22);
      });
      b.tPos.needsUpdate = true;
      b.tAlpha.needsUpdate = true;
    }
    b.kPos.needsUpdate = true;
    b.kCol.needsUpdate = true;
    b.kAlpha.needsUpdate = true;

    b.ringMat.opacity = 0.28 * wMap;

    // Labels: projected to the screen, shown in their chapters.
    const els = labelRefs.current;
    model.labels.forEach((l, i) => {
      const el = els[i];
      if (!el) return;
      let w = 0;
      for (const c of l.chapters) w = Math.max(w, presence(v, c));
      if (compact && l.tone === 'faint') w = 0;
      if (hoverSet && !hoverSet.has(l.node)) w *= 0.3;
      if (wExplain > 0 && model.nodes[l.node].kind === 'tech' && l.node !== sel?.node) w *= 1 - 0.5 * wExplain;
      if (w < 0.02) {
        if (el.style.opacity !== '0') el.style.opacity = '0';
        return;
      }
      tmp.v.fromArray(pos, l.node * 3).applyMatrix4(g.matrixWorld).project(camera);
      if (tmp.v.z > 1) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = String(Math.min(1, w * 1.4));
      el.style.transform = `translate3d(${((tmp.v.x + 1) / 2) * W}px, ${((1 - tmp.v.y) / 2) * H}px, 0)`;
    });

    // Tooltip follows the hovered node.
    const tip = tipRef.current;
    if (tip && hover >= 0) {
      tmp.v.fromArray(pos, hover * 3).applyMatrix4(g.matrixWorld).project(camera);
      tip.style.transform = `translate3d(${((tmp.v.x + 1) / 2) * W}px, ${((1 - tmp.v.y) / 2) * H}px, 0)`;
    }

    L.started = true;
  });

  return (
    <group ref={group}>
      <primitive object={built.lines} />
      <primitive object={built.tracePath} />
      {built.rings.map((r, i) => (
        <primitive key={i} object={r} />
      ))}
      <primitive object={built.points} />
      <primitive object={built.packets} />
    </group>
  );
}
