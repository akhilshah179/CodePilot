/*
 * Names and wording for main flows: actor + verb + object, from the code's own route, handler,
 * client-function and UI names. Generic filler is banned; text that matches a banned pattern is
 * replaced by a plainer, code-derived version rather than shown.
 */

export const BANNED: RegExp[] = [
  /client invokes .* endpoint/i,
  /traverses through verified handlers/i,
  /payload moves along verified edges/i,
  /provides essential business capability/i,
  /core application flow/i,
  /click ['“"]button['”"]/i,
  /submit ['“"]form['”"]/i,
  /\b(\w+)\s+\1\b/i,
];

export function isBanned(text: string): boolean {
  return BANNED.some((re) => re.test(text));
}

/** Remove a doubled word ("and and") and generic UI placeholders; never returns banned text. */
export function clean(text: string, fallback = ''): string {
  let t = text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1').replace(/\s+/g, ' ').trim();
  t = t.replace(/Click ['“"]button['”"]/i, 'Click').replace(/Submit ['“"]form['”"]/i, 'Submit');
  return isBanned(t) ? fallback : t;
}

const VERBS: Record<string, string> = {
  create: 'creates', add: 'adds', new: 'creates', post: 'creates', insert: 'adds', save: 'saves', store: 'stores',
  register: 'registers', signup: 'signs up', join: 'joins', invite: 'invites',
  login: 'signs in', signin: 'signs in', authenticate: 'signs in', logout: 'signs out', signout: 'signs out',
  delete: 'deletes', remove: 'removes', destroy: 'deletes', revoke: 'revokes', cancel: 'cancels',
  update: 'updates', edit: 'edits', patch: 'updates', set: 'sets', change: 'changes', rename: 'renames', toggle: 'toggles',
  get: 'loads', fetch: 'loads', load: 'loads', read: 'reads', view: 'views', show: 'shows', open: 'opens', list: 'lists', browse: 'browses', find: 'finds', search: 'searches', query: 'queries', filter: 'filters',
  send: 'sends', upload: 'uploads', download: 'downloads', import: 'imports', export: 'exports', share: 'shares', publish: 'publishes',
  analyze: 'analyzes', analyse: 'analyzes', run: 'runs', start: 'starts', stop: 'stops', process: 'processes', sync: 'syncs', refresh: 'refreshes', regenerate: 'regenerates', generate: 'generates', build: 'builds', render: 'renders', trace: 'traces',
  checkout: 'checks out', pay: 'pays', charge: 'charges', refund: 'refunds', transfer: 'transfers', book: 'books', order: 'orders', buy: 'buys', subscribe: 'subscribes to', tag: 'tags', connect: 'connects', disconnect: 'disconnects', verify: 'verifies', confirm: 'confirms', approve: 'approves', reject: 'rejects', reset: 'resets', stream: 'streams', watch: 'watches', handle: 'handles', notify: 'notifies', schedule: 'schedules', retry: 'retries', complete: 'completes',
};

/** Two-word verbs written as one identifier or with a space. */
const PHRASES: [RegExp, string][] = [
  [/^sign\s*in$/, 'signs in'],
  [/^sign\s*up$/, 'signs up'],
  [/^sign\s*out$/, 'signs out'],
  [/^log\s*in$/, 'signs in'],
  [/^log\s*out$/, 'signs out'],
  [/^check\s*out$/, 'checks out'],
];

const STOP = new Set(['api', 'handle', 'handler', 'on', 'do', 'the', 'a', 'an', 'to', 'of', 'for', 'by', 'route', 'endpoint', 'controller', 'action', 'page', 'index', 'async', 'v1', 'v2', 'v3', 'dev', 'id', 'with', 'from', 'and']);

export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:(){}[\]“”"'`]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

const singular = (w: string) => (/ies$/.test(w) ? w.replace(/ies$/, 'y') : /(ss|us|is)$/.test(w) ? w : /s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w);
const article = (w: string) => (/^[aeiou]/.test(w) ? 'an' : 'a');

/** "creates a note", "lists projects", "signs in" — from identifier-like text; null when no verb is visible. */
export function verbPhrase(source: string, opts: { plural?: boolean } = {}): string | null {
  const ws = words(source).filter((w) => !STOP.has(w));
  for (let i = 0; i < ws.length; i++) {
    const pair = `${ws[i]} ${ws[i + 1] ?? ''}`.trim();
    const phrase = PHRASES.find(([re]) => re.test(pair));
    const verb = phrase ? phrase[1] : VERBS[ws[i]];
    if (!verb) continue;
    const rest = ws.slice(i + (phrase ? 2 : 1)).filter((w) => !VERBS[w]).slice(0, 3);
    if (!rest.length) return verb;
    const obj = rest.join(' ');
    if (opts.plural || /lists|browses|searches|filters/.test(verb)) return `${verb} ${obj}`;
    const last = rest.at(-1)!;
    const sing = [...rest.slice(0, -1), singular(last)].join(' ');
    if (/^(signs|logs) (in|out)$/.test(verb)) return verb;
    return `${verb} ${article(sing)} ${sing}`;
  }
  return null;
}

/** A verb phrase from an HTTP method and a path when no name in the code says more. */
export function routePhrase(method: string, path: string): string {
  const segs = path.split('/').filter((s) => s && s !== 'api' && !/^v\d+$/.test(s));
  const statics = segs.filter((s) => !/^[:{[<*]|^\[/.test(s));
  const last = statics.at(-1) ?? 'home page';
  const object = words(last).join(' ') || 'resource';
  const byId = /^[:{[<]/.test(segs.at(-1) ?? '');
  if (/^(me|whoami|session|current-?user)$/i.test(last)) return 'loads the signed-in user';
  switch (method) {
    case 'GET':
    case 'HEAD':
      return byId ? `views ${article(singular(object))} ${singular(object)}` : /s$/.test(object) ? `lists ${object}` : `loads ${object}`;
    case 'POST':
      return verbPhrase(last) ?? `creates ${article(singular(object))} ${singular(object)}`;
    case 'PUT':
    case 'PATCH':
      return `updates ${article(singular(object))} ${singular(object)}`;
    case 'DELETE':
      return `deletes ${article(singular(object))} ${singular(object)}`;
    default:
      return `calls ${path}`;
  }
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
