import type { HttpCallFact } from './types.ts';

/** How client calls are named in the system map and request lifecycle, exactly as the code shows them. */

/** A readable name for an HTTP client string: `request() → fetch` → `fetch via request()`. */
export function clientLabel(client: string): string {
  const arrow = client.split('→').map((s) => s.trim());
  return arrow.length === 2 ? `${arrow[1]} via ${arrow[0]}` : client;
}

/** `Fetch POST /api/x`, `Axios GET /users`, `EventSource GET /stream`. */
export function transportLabel(h: HttpCallFact): string {
  const lib = h.client.includes('→') ? h.client.split('→')[1].trim() : h.client;
  const name = lib === 'fetch' || lib === '$fetch' || lib === 'ofetch' ? 'Fetch' : lib.charAt(0).toUpperCase() + lib.slice(1);
  return `${name} ${h.method && h.method !== 'ANY' ? h.method : ''} ${h.url ?? ''}`.replace(/\s+/g, ' ').trim();
}

export function protocolOf(h: HttpCallFact, fallback = 'REST'): string {
  return h.protocol ?? (h.url && /\/graphql\b/.test(h.url) ? 'GraphQL' : fallback);
}
