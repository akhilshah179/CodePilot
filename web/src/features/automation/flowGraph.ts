import { FLOW_STAGES } from '@codepilot/analyzer/architecture/types';
import type { Flow, FlowStage, FlowStep } from '../../lib/api.ts';

/*
 * The Automation canvas model: flows merged into one graph of repository entities, laid out in
 * stage columns (user → frontend → transport → backend → services → tools → data → external →
 * response). A node is one real entity — a component, a route, a middleware registration, a
 * function, a technology — and an edge is one traced transition between consecutive steps.
 * Shared entities (the same middleware, the same database) appear once, used by many flows.
 */

export const STAGE_LABELS: Record<FlowStage, string> = {
  user: 'User',
  frontend: 'Frontend',
  transport: 'Transport',
  backend: 'Backend',
  services: 'Services',
  tools: 'Tools',
  data: 'Data',
  external: 'External',
  response: 'Response',
};

export interface FGNode {
  key: string;
  stage: FlowStage;
  label: string;
  kind: FlowStep['kind'];
  file: string;
  line?: number;
  tool?: string;
  flows: Set<string>;
  x: number;
  y: number;
}

export interface FGEdge {
  key: string;
  from: string;
  to: string;
  flows: Set<string>;
  /** Background work: does not block the response. */
  async: boolean;
  /** The response path back to the client. */
  back: boolean;
  label?: string;
}

export interface FlowGraph {
  nodes: FGNode[];
  edges: FGEdge[];
  /** Node key of each step, per flow: flowId → keys in step order. */
  path: Map<string, string[]>;
  /** Edge key between consecutive steps, per flow: flowId → keys (index i = edge into step i). */
  pathEdges: Map<string, (string | null)[]>;
  width: number;
  height: number;
  columns: { stage: FlowStage; x: number }[];
}

export const COL_W = 262;
export const CARD_W = 188;
export const CARD_H = 58;
const ROW_H = 78;
const TOP = 46;

/** One entity per technology; otherwise per stage, label and file (the line may differ between call sites). */
export function entityKey(s: FlowStep): string {
  const stage = s.stage ?? 'backend';
  if (s.tool && (s.kind === 'data' || s.kind === 'cache' || s.kind === 'queue' || s.kind === 'external')) return `tool|${s.tool}`;
  if (s.kind === 'unknown') return `unknown|${s.file}|${s.line ?? ''}`;
  return `${stage}|${s.label ?? s.node}|${s.file}`;
}

function entityLabel(s: FlowStep, techName: (id: string) => string | undefined): string {
  if (s.tool && (s.kind === 'data' || s.kind === 'cache' || s.kind === 'queue' || s.kind === 'external')) return techName(s.tool) ?? s.label ?? s.tool;
  return s.label ?? s.node;
}

export function buildFlowGraph(flows: Flow[], opts?: { hideGlobalMiddleware?: boolean }): FlowGraph {
  const techNames = new Map<string, string>();
  for (const f of flows) for (const t of f.index?.technologies ?? []) techNames.set(t.id, t.name);
  const nodes = new Map<string, FGNode>();
  const edges = new Map<string, FGEdge>();
  const path = new Map<string, string[]>();
  const pathEdges = new Map<string, (string | null)[]>();
  const order: string[] = [];

  for (const rawF of flows) {
    const fSteps = opts?.hideGlobalMiddleware
      ? rawF.steps.filter((s) => !s.isGlobalMiddleware)
      : rawF.steps;
    const steps = fSteps.length > 0 ? fSteps : rawF.steps;
    const keys = steps.map(entityKey);
    path.set(rawF.id, keys);
    const ek: (string | null)[] = [null];
    steps.forEach((s, i) => {
      const key = keys[i];
      let n = nodes.get(key);
      if (!n) {
        n = { key, stage: s.stage ?? 'backend', label: entityLabel(s, (id) => techNames.get(id)), kind: s.kind, file: s.file, line: s.line, tool: s.tool, flows: new Set(), x: 0, y: 0 };
        nodes.set(key, n);
        order.push(key);
      }
      n.flows.add(rawF.id);
      if (i === 0) return;
      // The first background step hangs off the enqueue, not off the response before it.
      let from = i - 1;
      if (s.parentStepIndex !== undefined && s.parentStepIndex >= 0 && s.parentStepIndex < keys.length) {
        from = s.parentStepIndex;
      } else {
        const asyncStart = s.branch === 'async' && steps[i - 1].branch !== 'async';
        if (asyncStart) for (let k = i - 1; k >= 0; k--) if (steps[k].kind === 'queue') {
          from = k;
          break;
        }
      }
      const a = keys[from];
      if (a === key) {
        ek.push(null);
        return;
      }
      const prev = steps[from];
      const eKey = `${a}->${key}`;
      let e = edges.get(eKey);
      if (!e) {
        e = { key: eKey, from: a, to: key, flows: new Set(), async: s.branch === 'async', back: prev.kind === 'response' || s.kind === 'resolve', label: prev.kind === 'response' ? prev.transport : s.kind === 'route' ? s.transport : undefined };
        edges.set(eKey, e);
      }
      e.flows.add(rawF.id);
      ek.push(eKey);
    });
    pathEdges.set(rawF.id, ek);
  }

  // Columns by stage; rows by first appearance, so a flow reads top to bottom.
  const stages = FLOW_STAGES.filter((st) => [...nodes.values()].some((n) => n.stage === st));
  const columns = stages.map((stage, i) => ({ stage, x: 24 + i * COL_W }));
  const colX = new Map(columns.map((c) => [c.stage, c.x]));
  const rows = new Map<FlowStage, number>();
  for (const key of order) {
    const n = nodes.get(key)!;
    const r = rows.get(n.stage) ?? 0;
    rows.set(n.stage, r + 1);
    n.x = colX.get(n.stage)!;
    n.y = TOP + r * ROW_H;
  }
  const maxRows = Math.max(1, ...rows.values());
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    path,
    pathEdges,
    width: 24 + stages.length * COL_W,
    height: TOP + maxRows * ROW_H + 20,
    columns,
  };
}

/** Geometry of an edge: a cubic from the side facing the target; response edges run right to left. */
export function edgeGeometry(a: FGNode, b: FGNode): { d: string; pts: [number, number][]; mid: [number, number] } {
  const forward = b.x > a.x || (b.x === a.x && b.y > a.y);
  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  if (b.x === a.x) {
    // Same column: straight down (or up) between cards.
    x1 = a.x + CARD_W / 2;
    x2 = b.x + CARD_W / 2;
    y1 = forward ? a.y + CARD_H : a.y;
    y2 = forward ? b.y : b.y + CARD_H;
  } else {
    x1 = forward ? a.x + CARD_W : a.x;
    x2 = forward ? b.x : b.x + CARD_W;
    y1 = a.y + CARD_H / 2;
    y2 = b.y + CARD_H / 2;
  }
  const dx = b.x === a.x ? 0 : Math.max(40, Math.abs(x2 - x1) * 0.4) * (forward ? 1 : -1);
  const dy = b.x === a.x ? (y2 - y1) * 0.4 : 0;
  const c1: [number, number] = [x1 + dx, y1 + dy];
  const c2: [number, number] = [x2 - dx, y2 - dy];
  const d = `M${x1} ${y1} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x2} ${y2}`;
  // Sampled points for the packet animation.
  const pts: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const u = 1 - t;
    pts.push([u * u * u * x1 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * x2, u * u * u * y1 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * y2]);
  }
  return { d, pts, mid: pts[6] };
}

/** Flows matching a query across everything they touch. */
export function flowMatches(f: Flow, q: string): boolean {
  if (!q) return true;
  const i = f.index;
  const hay = [
    f.name ?? '',
    f.title,
    f.domain ?? '',
    f.journeyTitle ?? '',
    f.flowType ?? '',
    ...(i?.routes ?? []),
    ...(i?.components ?? []),
    ...(i?.functions ?? []),
    ...(i?.files ?? []),
    ...(i?.technologies.map((t) => `${t.name} ${t.category}`) ?? []),
    ...(i?.categories ?? []),
    ...f.steps.map((s) => s.label ?? ''),
    f.importance?.level ?? '',
    ...(f.importance?.reasons ?? []),
    f.capabilityId ?? '',
    f.whyBelongsToCapability ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Change of a flow between two snapshots, by id and step signature. */
export type FlowChange = 'new' | 'changed' | 'same';
export function flowChanges(current: Flow[], previous: Flow[] | null): { byId: Map<string, FlowChange>; removed: Flow[] } {
  const byId = new Map<string, FlowChange>();
  if (!previous) return { byId, removed: [] };
  const sig = (f: Flow) => f.steps.map((s) => `${s.kind}|${s.label}|${s.file}`).join('>');
  const prev = new Map(previous.map((f) => [f.id, f]));
  for (const f of current) {
    const p = prev.get(f.id);
    byId.set(f.id, !p ? 'new' : sig(p) === sig(f) ? 'same' : 'changed');
  }
  const ids = new Set(current.map((f) => f.id));
  return { byId, removed: previous.filter((f) => !ids.has(f.id)) };
}
