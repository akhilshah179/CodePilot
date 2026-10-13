import { useSyncExternalStore } from 'react';

/*
 * Shared state between the page (scroll, selections) and the 3D scene. The scene reads it every
 * frame without React re-renders; DOM overlays subscribe to the few discrete values they show.
 */

export interface StoryState {
  /** Continuous chapter position from scroll: 0 = hero … 7 = converge. */
  target: number;
  /** Whether the scene is on screen (story sections or the final CTA). */
  visible: boolean;
  /** Pointer in normalized device coordinates, and whether it is over the page. */
  pointer: { x: number; y: number; inside: boolean };
  /** Hovered node (index into the scene model), or -1. */
  hover: number;
  /** Selected technology (index into model.techs) in the Explain chapter. */
  tech: number;
  /** Current step of the traced request, driven by the scene. */
  traceStep: number;
  /** Discrete chapter for overlays. */
  chapter: number;
}

export const story: StoryState = { target: 0, visible: true, pointer: { x: 0, y: 0, inside: false }, hover: -1, tech: 0, traceStep: 0, chapter: 0 };

const listeners = new Set<() => void>();
const wakers = new Set<() => void>();

/** Called on any change the scene must render (used to request frames when rendering on demand). */
export function onWake(fn: () => void) {
  wakers.add(fn);
  return () => {
    wakers.delete(fn);
  };
}
export function wake() {
  for (const w of wakers) w();
}

export function setTarget(v: number) {
  if (story.target === v) return;
  story.target = v;
  wake();
}
let version = 0;

/** Set discrete values and notify subscribers (only when something changed). */
export function setStory(patch: Partial<Pick<StoryState, 'hover' | 'tech' | 'traceStep' | 'chapter' | 'visible'>>) {
  let changed = false;
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, never][]) {
    if (story[k] !== v) {
      (story as unknown as Record<string, unknown>)[k] = v;
      changed = true;
    }
  }
  if (!changed) return;
  version++;
  for (const l of listeners) l();
  wake();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStory<T>(select: (s: StoryState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(story),
    () => select(story),
  );
}

export const storyVersion = () => version;
