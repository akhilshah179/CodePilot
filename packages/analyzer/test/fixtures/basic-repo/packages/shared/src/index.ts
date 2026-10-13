export function api(path: string, ...rest: unknown[]) {
  return fetch(path, { body: JSON.stringify(rest) });
}
