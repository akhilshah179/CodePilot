import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createReveal, REVEAL } from '../graph/renderer.ts';
import { GraphModel } from '../graph/model.ts';
import { prefersReducedMotion, usePrefersReducedMotion } from './hooks.ts';

function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('prefers-reduced-motion') ? matches : false;
    },
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  })) as unknown as typeof window.matchMedia;
  return {
    set(v: boolean) {
      matches = v;
      listeners.forEach((l) => l());
    },
  };
}

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

describe('reduced motion', () => {
  it('reads and follows the prefers-reduced-motion media query', () => {
    const mq = mockMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    act(() => mq.set(false));
    expect(result.current).toBe(false);
  });

  it('sweeps nodes in clockwise order from 12 o’clock within the sweep duration', () => {
    const node = (id: string, x: number, y: number) => ({ id, path: id, type: 'other' as const, language: 'ts', size: 0, classification_evidence: [], directory: '.', analyzed: true, x, y });
    const model = new GraphModel([node('top', 0, -10), node('right', 10, 0), node('bottom', 0, 10), node('left', -10, 0)], []);
    const reveal = createReveal(model, 0);
    const at = (id: string) => reveal.nodeAt[model.index.get(id)!];
    expect(at('top')).toBeLessThan(at('right'));
    expect(at('right')).toBeLessThan(at('bottom'));
    expect(at('bottom')).toBeLessThan(at('left'));
    expect(at('left')).toBeLessThanOrEqual(REVEAL.sweepMs);
  });
});
