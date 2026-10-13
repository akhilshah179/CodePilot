import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from './api.ts';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', cb);
    return () => mql.removeEventListener('change', cb);
  };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(REDUCED_MOTION).matches;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Fetch data for a component; re-runs when `deps` change and ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef
      .current()
      .then((data) => alive && setState({ data, loading: false }))
      .catch((error: unknown) => {
        if (!alive) return;
        const e = error instanceof ApiError ? error : new ApiError(0, { code: 'unknown', message: String((error as Error)?.message ?? error) });
        setState({ error: e, loading: false });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · CodePilot` : 'CodePilot — a living map of your codebase';
  }, [title]);
}
