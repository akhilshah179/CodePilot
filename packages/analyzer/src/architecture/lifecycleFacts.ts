import { escapeRegExp, snippet } from './text.ts';
import type { HttpCallFact, MiddlewareFact, ResponseFact, RouteFact, SourceLanguage, UiTriggerFact } from './types.ts';

/*
 * Facts for the request lifecycle: what triggers a client call in the UI and what the UI does with
 * the result, which middleware a request passes through, and what a route handler returns. All of
 * it is pattern-based on real lines; anything that does not match stays unknown rather than
 * guessed.
 */

/** The subset of a scanned file these passes read. */
export interface LifecycleFile {
  input: { path: string; lang: SourceLanguage; js?: { imports: { specifier: string; symbols: string[]; line: number }[] } };
  code: string[];
  raw: string[];
  internalBindings: { target: string; line: number; symbols: Map<string, string>; namespace?: string }[];
}

type Defs = (f: LifecycleFile) => { name: string; line: number; end: number }[];

const stripStrings = (s: string) => s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
const indentOf = (s: string) => /^\s*/.exec(s)![0].length;

// --- Middleware ------------------------------------------------------------------------------------------

const PURPOSE: [RegExp, MiddlewareFact['purpose']][] = [
  [/csrf|xsrf|helmet|cross-origin|same-origin|origin\b|content-security|security|secure headers|x-frame|nosniff|frame-ancestors/i, 'security'],
  [/auth|jwt|passport|guard|clerk|permission|login|bearer|api.?key/i, 'auth'],
  [/\bcors\b/i, 'cors'],
  [/compress|gzip|brotli/i, 'compression'],
  [/session|cookie/i, 'session'],
  [/\blog|morgan|pino|winston|tracing|telemetry/i, 'logging'],
  [/rate.?limit|throttl/i, 'rate-limit'],
  [/body.?parser|\.json\b|urlencoded|multer|multipart|formbody/i, 'parsing'],
];

function purposeOf(...texts: (string | undefined)[]): MiddlewareFact['purpose'] {
  const t = texts.filter(Boolean).join(' ');
  for (const [re, p] of PURPOSE) if (re.test(t)) return p;
  return 'other';
}

/** A comment directly inside (next line) or above a line: the code's own description. */
function commentNear(raw: string[], line: number): string | undefined {
  const pick = (s?: string) => {
    const m = /^\s*(?:\/\/+|#|\*)\s*(.{3,160}?)\s*$/.exec(s ?? '');
    return m && !/^[-=*/#]+$/.test(m[1]) ? m[1] : undefined;
  };
  return pick(raw[line]) ?? pick(raw[line - 2]);
}

const REQUEST_HOOKS = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onResponse', 'onError', 'onTimeout']);
const KNOWN_PLUGIN = /^@fastify\/|^fastify-|cors|helmet|compress|rate-?limit|cookie|session|jwt|auth|multipart|formbody|csrf/i;

export function scanMiddleware(st: LifecycleFile, out: MiddlewareFact[]) {
  const { code, raw } = st;
  const file = st.input.path;
  const push = (i: number, m: Omit<MiddlewareFact, 'file' | 'line' | 'snippet' | 'note' | 'purpose'> & { purpose?: MiddlewareFact['purpose'] }) => {
    const note = commentNear(raw, i + 1);
    // The first lines of a hook's body say what it does (e.g. it sets Content-Security-Policy).
    out.push({ file, line: i + 1, snippet: snippet(raw[i]), note, ...m, purpose: m.purpose ?? purposeOf(m.name, note, code.slice(i, i + 8).join(' ')) });
  };
  if (st.input.lang === 'js') {
    // Local names bound to external packages (for `app.register(cookie)` / `app.use(cors())`).
    const pkgOf = new Map<string, string>();
    for (const imp of st.input.js?.imports ?? []) {
      if (imp.specifier.startsWith('.') || imp.specifier.startsWith('/')) continue;
      const text = raw.slice(imp.line - 1, imp.line + 4).join(' ');
      const def = /import\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (def) pkgOf.set(def[1], imp.specifier);
      const named = /\{([^}]*)\}/.exec(text);
      if (named) for (const part of named[1].split(',')) {
        const local = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (local) pkgOf.set(local, imp.specifier);
      }
      const req = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/.exec(text);
      if (req) pkgOf.set(req[1], imp.specifier);
    }
    code.forEach((line, i) => {
      let m = /\b[\w$]+\.addHook\s*\(\s*["'](\w+)["']/.exec(line);
      if (m && REQUEST_HOOKS.has(m[1])) {
        push(i, { name: `${m[1]} hook`, kind: 'hook', phase: m[1], framework: 'fastify' });
        return;
      }
      m = /\b[\w$]+\.register\s*\(\s*([A-Za-z_$][\w$]*)/.exec(line);
      // Static-file servers, docs and env loaders register routes or config, not request middleware.
      if (m && pkgOf.has(m[1]) && KNOWN_PLUGIN.test(pkgOf.get(m[1])!) && !/static|swagger|env|sensible|autoload|websocket/.test(pkgOf.get(m[1])!)) {
        push(i, { name: pkgOf.get(m[1])!, kind: 'plugin', framework: 'fastify', purpose: purposeOf(pkgOf.get(m[1])) });
        return;
      }
      m = /\b(?:app|server|api|router|[\w$]*Router|[\w$]*App)\.use\s*\(\s*(.+)$/.exec(line);
      if (m) {
        const arg = m[1].trim();
        // `app.use('/api', router)` mounts routes; only path-less or middleware-call arguments are middleware.
        if (/^["'`]/.test(arg) && !/,\s*[\w$.]+\s*\(/.test(arg)) return;
        const head = /^(?:["'`][^"'`]*["'`]\s*,\s*)?([A-Za-z_$][\w$.]*)/.exec(arg)?.[1];
        if (!head || /router|routes?$/i.test(head)) return;
        const pkg = pkgOf.get(head.split('.')[0]);
        push(i, { name: pkg && !head.includes('.') ? pkg : head, kind: 'use', framework: 'express', purpose: purposeOf(head, pkg) });
        return;
      }
      m = /@UseGuards\s*\(\s*([^)]*)\)/.exec(line);
      if (m) push(i, { name: m[1].trim() || 'guard', kind: 'guard', framework: 'nestjs', purpose: 'auth' });
    });
  } else if (st.input.lang === 'python') {
    let inDjangoList = false;
    code.forEach((line, i) => {
      let m = /\.add_middleware\s*\(\s*([\w.]+)/.exec(line);
      if (m) return push(i, { name: m[1], kind: 'use', framework: 'starlette' });
      if (/@\w+\.middleware\s*\(\s*["']http["']/.test(line)) {
        const def = code.slice(i + 1, i + 4).map((l) => /^\s*(?:async\s+)?def\s+(\w+)/.exec(l)?.[1]).find(Boolean);
        return push(i, { name: def ?? 'http middleware', kind: 'hook', framework: 'fastapi' });
      }
      m = /@\w+\.(before_request|after_request)\b/.exec(line);
      if (m) {
        const def = code.slice(i + 1, i + 4).map((l) => /^\s*def\s+(\w+)/.exec(l)?.[1]).find(Boolean);
        return push(i, { name: def ?? m[1], kind: 'hook', phase: m[1], framework: 'flask' });
      }
      m = /(?:FastAPI|APIRouter)\s*\(.*dependencies\s*=\s*\[\s*Depends\(\s*([\w.]+)/.exec(line);
      if (m) return push(i, { name: m[1], kind: 'dependency', framework: 'fastapi' });
      if (/^\s*MIDDLEWARE\s*=\s*\[/.test(line)) {
        inDjangoList = true;
        return;
      }
      if (inDjangoList) {
        if (/^\s*\]/.test(line)) {
          inDjangoList = false;
          return;
        }
        const s = /["']([\w.]+)["']/.exec(raw[i]);
        if (s) push(i, { name: s[1].split('.').pop()!, kind: 'setting', framework: 'django', purpose: purposeOf(s[1]) });
      }
    });
  } else if (st.input.lang === 'go') {
    code.forEach((line, i) => {
      const m = /\b\w+\.Use\s*\(\s*([\w.]+)/.exec(line);
      if (m) push(i, { name: m[1], kind: 'use', framework: 'go' });
    });
  }
}

// --- Route responses ---------------------------------------------------------------------------------------

/** Top-level keys of an object literal starting at `{` on `lines[0]`, as `{ a, b, c }`. */
function objectShape(lines: string[]): string | undefined {
  const text = lines.join('\n').slice(lines[0].indexOf('{'));
  const keys: string[] = [];
  let depth = 0;
  let seg = '';
  let quote = '';
  const flush = () => {
    const m = /^\s*(?:\.\.\.\s*([A-Za-z_$][\w$.]*)|(["'`])([\w$ -]+)\2\s*:|([A-Za-z_$][\w$-]*)\s*(?::|$))/.exec(seg);
    if (m) keys.push(m[1] ? `…${m[1]}` : (m[3] ?? m[4]));
    seg = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (depth === 1) seg += ch;
      if (ch === '\\') {
        if (depth === 1) seg += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      if (depth === 1) seg += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) {
        flush();
        break;
      }
    }
    if (depth === 1 && ch === ',') flush();
    else if (depth >= 1) seg += ch;
  }
  if (!keys.length) return /^\{\s*\}/.test(text) ? '{}' : undefined;
  return `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`;
}

/** `await createOrder(body.total));` → `createOrder(…)`; `rows` → `rows`. */
function exprShape(e: string): string {
  let s = e.trim().replace(/^await\s+/, '');
  const open = s.indexOf('(');
  if (open >= 0) s = `${s.slice(0, open)}(…)`;
  return s.replace(/[;\s]+$/, '').slice(0, 48);
}

export function scanResponse(st: LifecycleFile, r: RouteFact): ResponseFact | undefined {
  if (r.kind === 'page') return undefined;
  const { code, raw } = st;
  const start = r.line - 1;
  const end = Math.min(code.length, r.bodyEnd ?? r.line + 60, r.line + 160);
  const candidates: (ResponseFact & { indent: number })[] = [];
  const add = (i: number, kind: ResponseFact['kind'], shape?: string) => candidates.push({ line: i + 1, kind, shape, snippet: snippet(raw[i]), indent: indentOf(code[i]) });
  if (st.input.lang === 'python') {
    for (let i = start; i < Math.min(start + 4, code.length); i++) {
      const m = /response_model\s*=\s*([\w.[\]]+)/.exec(code[i]);
      if (m) return { line: i + 1, kind: 'json', shape: m[1], snippet: snippet(raw[i]) };
    }
  }
  // Expression-bodied handlers: `app.get('/x', (req) => handlers.x(req))`.
  const expr = /=>\s*(?!\{)(?:await\s+)?([A-Za-z_$][\w$.]*\s*\(.*\))\s*\)\s*;?\s*$/.exec(code[start] ?? '');
  if (expr && st.input.lang === 'js') return { line: r.line, kind: 'json', shape: exprShape(expr[1]), snippet: snippet(raw[start]) };
  for (let i = start; i < end; i++) {
    const line = code[i];
    let m: RegExpExecArray | null;
    if (/\b(?:reply|res)\.redirect\s*\(|\breturn\s+(?:redirect|RedirectResponse|NextResponse\.redirect)\s*\(/.test(line)) add(i, 'redirect', /redirect\w*\s*\(\s*([^,)]+)/i.exec(line)?.[1]?.trim().slice(0, 48));
    else if (/text\/event-stream|\breply\.raw\.write|\breply\.hijack\(|\bStreamingResponse\s*\(|\bEventSourceResponse\s*\(|\bres\.write\s*\(/.test(line)) add(i, 'stream');
    else if ((m = /\b(?:res|reply|response)(?:\.code\(\d+\)|\.status\(\d+\))?\.(json|send)\s*\(\s*(.*)$/.exec(line)) && !/^\s*\)?\s*;?\s*$/.test(m[2])) add(i, 'json', m[2].trim().startsWith('{') ? objectShape(code.slice(i, i + 14).map((l, k) => (k === 0 ? l.slice(l.indexOf(m![2])) : l))) : exprShape(m[2].replace(/\)\s*;?\s*$/, '')));
    else if ((m = /\breturn\s+(?:NextResponse|Response)\.json\s*\(\s*(.*)$/.exec(line))) add(i, 'json', m[1].trim().startsWith('{') ? objectShape(code.slice(i, i + 14).map((l, k) => (k === 0 ? l.slice(l.indexOf(m![1])) : l))) : exprShape(m[1]));
    else if (/\breturn\s+(?:render|render_template)\s*\(/.test(line)) add(i, 'render');
    else if (/\breturn\s+(?:jsonify)\s*\(/.test(line)) add(i, 'json', objectShape([line.slice(line.indexOf('jsonify'))]) ?? undefined);
    else if (/\breturn\s+\{/.test(line)) add(i, 'json', objectShape(code.slice(i, i + 14).map((l, k) => (k === 0 ? l.slice(l.indexOf('{')) : l))));
    else if ((m = /\breturn\s+(?:await\s+)?([A-Za-z_$][\w$.]*(?:\([^;]*\))?)\s*;?\s*$/.exec(line)) && !/^(?:null|undefined|None|True|False|true|false|reply|res|next)$/.test(m[1])) add(i, 'json', exprShape(m[1]));
  }
  if (!candidates.length) return undefined;
  // The outermost return is the handler's own; nested ones belong to callbacks inside it.
  const minIndent = Math.min(...candidates.map((c) => c.indent));
  const { indent: _indent, ...best } = candidates.find((c) => c.indent === minIndent)!;
  void _indent;
  return best;
}

// --- Client functions ------------------------------------------------------------------------------------------

/**
 * Name the client function each HTTP call is written in (`devSignIn` in `export const api = {…}`)
 * and the declared response type (`request<Me>(…)`), so UI call sites can be found.
 */
export function annotateClientFunctions(files: Map<string, LifecycleFile>, calls: HttpCallFact[], defs: Defs) {
  const defsCache = new Map<string, ReturnType<Defs>>();
  for (const h of calls) {
    const st = files.get(h.file);
    if (!st || st.input.lang !== 'js') continue;
    const i = h.line - 1;
    const line = st.code[i] ?? '';
    const t = /\b[A-Za-z_$][\w$]*\s*<\s*((?:[^<>()]|<[^<>]*>)+?)\s*>\s*\(/.exec(line);
    if (t) h.responseType = t[1].replace(/\s+/g, ' ').slice(0, 60);
    let fn = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:<[^>]*>\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/.exec(line)?.[1];
    if (!fn) {
      // A method or property defined a few lines above, less indented than the call.
      const ind = indentOf(line);
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const l = st.code[j];
        if (!l.trim()) continue;
        if (indentOf(l) >= ind) continue;
        fn = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?(?:function\s*)?\(|\([^)]*\)\s*(?::\s*[^{]+)?\{)/.exec(l)?.[1];
        break;
      }
    }
    if (!defsCache.has(h.file)) defsCache.set(h.file, defs(st));
    const enclosing = defsCache.get(h.file)!.find((d) => d.line <= h.line && d.end >= h.line);
    if (fn && ['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function'].includes(fn)) fn = undefined;
    if (fn && enclosing && enclosing.name !== fn && enclosing.name !== 'default') h.owner = enclosing.name;
    // Only small wrappers count as client functions: a call buried in a long function (a route
    // registrar, a class) is not something UI code calls by name.
    // A component (PascalCase) that fetches is not a client function; its call site is handled directly.
    h.fn = fn ?? (enclosing && enclosing.name !== 'default' && !/^[A-Z]/.test(enclosing.name) && enclosing.end - enclosing.line <= 25 ? enclosing.name : undefined);
  }
}

// --- UI triggers ---------------------------------------------------------------------------------------------------

const EVENT_KIND: Record<string, UiTriggerFact['trigger']['kind']> = { Click: 'click', Submit: 'submit', Change: 'change', Input: 'change', Select: 'change', KeyDown: 'key', KeyUp: 'key', KeyPress: 'key' };
const eventKind = (name: string): UiTriggerFact['trigger']['kind'] => EVENT_KIND[name] ?? (/Click|Press|Tap/.test(name) ? 'click' : /Submit/.test(name) ? 'submit' : 'call');

/** Brace depth between `from` (line, col) and `to` (line, col): > 0 means `to` is inside a block opened after `from`. */
function depthBetween(code: string[], fromLine: number, fromCol: number, toLine: number, toCol: number): number {
  let depth = 0;
  for (let i = fromLine; i <= toLine; i++) {
    let text = stripStrings(code[i]);
    if (i === toLine) text = text.slice(0, i === fromLine ? toCol : toCol);
    if (i === fromLine) text = text.slice(fromCol);
    for (const ch of text) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
    }
  }
  return depth;
}

/** Last line of the block that opens at or after `line` (brace matching, bounded). */
function blockEnd(code: string[], line: number, limit = 80): number {
  let depth = 0;
  let opened = false;
  for (let i = line; i < Math.min(code.length, line + limit); i++) {
    for (const ch of stripStrings(code[i])) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) return i;
      }
    }
  }
  return Math.min(code.length - 1, line + limit);
}

/** Visible text of the element whose handler ends at `after`: a JSX text line, `>Text<`, or a ternary's idle label. */
function elementLabel(code: string[], raw: string[], triggerLine: number, handlerEnd: number): string | undefined {
  for (let i = handlerEnd; i < Math.min(code.length, handlerEnd + 10); i++) {
    // On the trigger's own line, only look after the handler attribute.
    const r = i === triggerLine ? raw[i].slice(raw[i].search(/\bon[A-Z]\w*\s*=/)) : raw[i];
    let m = /\?\s*(["'])([^"']{2,60})\1\s*:\s*(["'])([^"']{2,60})\3/.exec(r);
    if (m) return m[4];
    m = />\s*([A-Za-z][^<>{}]{1,60}?)\s*</.exec(r);
    if (m) return m[1].trim();
    const text = /^\s*([A-Z][^<>{}=;()]{1,60}?)\s*$/.exec(code[i]);
    if (text && !/^(?:return|const|let|if|else|export|import)\b/.test(text[1])) return text[1].trim();
    if (/<\//.test(code[i])) break;
  }
  for (let i = triggerLine; i >= Math.max(0, triggerLine - 6); i--) {
    const m = /\b(?:aria-label|title|label)\s*=\s*(?:\{\s*)?["'`]([^"'`]{2,60})["'`]/.exec(raw[i]);
    if (m) return m[1];
    if (/<[A-Za-z]/.test(code[i])) break;
  }
  return undefined;
}

function afterEffects(code: string[], raw: string[], from: number, to: number): UiTriggerFact['after'] {
  const out: UiTriggerFact['after'] = [];
  const seen = new Set<string>();
  const add = (kind: UiTriggerFact['after'][number]['kind'], i: number, detail: string) => {
    const key = `${kind}:${detail}`;
    if (seen.has(key) || out.length >= 4) return;
    seen.add(key);
    out.push({ kind, line: i + 1, detail, snippet: snippet(raw[i]) });
  };
  for (let i = from; i <= Math.min(to, from + 16, code.length - 1); i++) {
    const line = code[i];
    let m = /\b(navigate|router\.(?:push|replace)|history\.push|redirect|goto)\s*\(\s*([^)]*)\)/.exec(line);
    if (m) add('navigate', i, `${m[1]}(${m[2].trim().slice(0, 40)})`);
    if (/\bwindow\.location(?:\.href)?\s*=|\blocation\.assign\s*\(/.test(line)) add('navigate', i, 'window.location');
    const sets = line.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g);
    for (const s of sets) add('state', i, s[1]);
    m = /\b(reload|refetch|mutate|invalidateQueries|revalidate\w*|refresh)\s*\(/.exec(line);
    if (m) add('reload', i, `${m[1]}()`);
    if (/\b(?:toast|notify|alert)\s*[.(]/.test(line)) add('notify', i, 'notification');
  }
  return out;
}

/**
 * Follow client functions to the UI code that calls them: the event (click, submit, load), the
 * named handler, the component, the button text, and what happens after the response.
 */
export function scanUiTriggers(files: Map<string, LifecycleFile>, calls: HttpCallFact[], out: UiTriggerFact[], defs: Defs) {
  // Client functions by file: owner object (or function) name → client call.
  const byFile = new Map<string, { owner?: string; fn: string; call: HttpCallFact }[]>();
  // A call's target must be written in the code: a path on this app, an absolute URL, or an env-configured URL.
  const targeted = (h: HttpCallFact) => !!(h.url?.startsWith('/') || h.host || h.envVar);
  for (const h of calls) {
    if (!h.fn || !targeted(h)) continue;
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push({ owner: h.owner, fn: h.fn, call: h });
  }
  // Calls written directly in a component (`new EventSource(…)` inside a useEffect) are their own call site.
  const direct = new Map<string, HttpCallFact[]>();
  for (const h of calls) {
    if (h.fn || !targeted(h)) continue;
    if (!direct.has(h.file)) direct.set(h.file, []);
    direct.get(h.file)!.push(h);
  }
  if (!byFile.size && !direct.size) return;
  const seen = new Set<string>();
  const perCallee = new Map<string, number>();
  for (const st of files.values()) {
    if (st.input.lang !== 'js') continue;
    // Names visible here for each client function: same file, or imported from the client's file.
    const patterns: { re: RegExp; callee: string; call: HttpCallFact; line?: number }[] = [];
    for (const h of direct.get(st.input.path) ?? []) {
      const name = h.protocol === 'SSE' ? 'EventSource' : h.protocol === 'WebSocket' ? 'WebSocket' : h.client.split('→')[0].trim().replace(/\(\)$/, '');
      patterns.push({ re: new RegExp(`(?:new\\s+)?${escapeRegExp(name)}\\s*\\(`), callee: name, call: h, line: h.line });
    }
    for (const [file, fns] of byFile) {
      const ib = file === st.input.path ? null : st.internalBindings.find((b) => b.target === file);
      if (file !== st.input.path && !ib) continue;
      for (const f of fns) {
        const head = f.owner ?? f.fn;
        const local = ib ? (ib.symbols.get(head) ?? (ib.namespace ? `${ib.namespace}.${head}` : undefined)) : head;
        if (!local) continue;
        const callee = f.owner ? `${local}.${f.fn}` : local;
        patterns.push({ re: new RegExp(`(?<![\\w$.])${escapeRegExp(callee)}\\s*\\(`), callee: f.owner ? `${f.owner}.${f.fn}` : f.fn, call: f.call });
      }
    }
    if (!patterns.length) continue;
    const fileDefs = defs(st);
    const { code, raw } = st;
    code.forEach((line, i) => {
      for (const p of patterns) {
        if (p.line !== undefined && p.line !== i + 1) continue;
        const m = p.re.exec(line);
        if (!m) continue;
        // The client function's own definition line is not a call site.
        if (p.line === undefined && st.input.path === p.call.file && i + 1 === p.call.line) continue;
        const col = m.index;
        const encl = fileDefs.find((d) => d.line <= i + 1 && d.end >= i + 1);
        const component = encl && /^[A-Z]/.test(encl.name) ? encl.name : undefined;
        let trigger: UiTriggerFact['trigger'] | undefined;
        let handler: UiTriggerFact['handler'];
        let blockStart = i;
        const floor = encl ? encl.line - 1 : Math.max(0, i - 40);
        for (let j = i; j >= floor && !trigger; j--) {
          const l = code[j];
          const ev = /\bon([A-Z]\w*)\s*=\s*\{/.exec(l);
          if (ev && depthBetween(code, j, ev.index, i, j === i ? col : col) > 0) {
            trigger = { kind: eventKind(ev[1]), line: j + 1, snippet: snippet(raw[j]) };
            blockStart = j;
            break;
          }
          const hook = /\b(useEffect|useLayoutEffect|useAsync|useQuery|useSWR|useMemo|onMount|useLoaderData)\s*\(/.exec(l);
          if (hook && depthBetween(code, j, hook.index, i, col) > 0) {
            trigger = { kind: 'load', line: j + 1, snippet: snippet(raw[j]) };
            blockStart = j;
            break;
          }
          const fnDef = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\s*\(\s*)?(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(l);
          if (fnDef && j !== (encl ? encl.line - 1 : -1) && depthBetween(code, j, fnDef.index, i, col) > 0) {
            const name = fnDef[1] ?? fnDef[2];
            handler = { name, line: j + 1 };
            blockStart = j;
            // Where the handler is wired to an event.
            const wire = new RegExp(`\\bon([A-Z]\\w*)\\s*=\\s*\\{\\s*(?:\\(\\)\\s*=>\\s*)?(?:[\\w$.]+\\()?${escapeRegExp(name)}\\b`);
            const w = code.findIndex((x) => wire.test(x));
            if (w >= 0) trigger = { kind: eventKind(wire.exec(code[w])![1]), line: w + 1, snippet: snippet(raw[w]) };
            else trigger = { kind: 'call', line: j + 1, snippet: snippet(raw[j]) };
            break;
          }
        }
        trigger ??= { kind: 'call', line: i + 1, snippet: snippet(raw[i]) };
        // Outside a component with no event or hook, this is server or library code calling a client, not a UI trigger.
        if (!component && (trigger.kind === 'call' || p.line !== undefined)) continue;
        const key = `${p.callee}|${st.input.path}|${trigger.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const count = perCallee.get(p.callee) ?? 0;
        if (count >= 4) continue;
        perCallee.set(p.callee, count + 1);
        const end = blockEnd(code, blockStart);
        let label: string | undefined;
        if (trigger.kind === 'click' || trigger.kind === 'submit') {
          const tl = trigger.line - 1;
          // `onClick={pay}`: the label is on the same line or just after; an inline handler's label follows its block.
          label = elementLabel(code, raw, tl, /^=\s*\{\s*[\w$.]*\s*\}/.test(stripStrings(code[tl]).slice(stripStrings(code[tl]).indexOf('={'))) ? tl : blockEnd(code, tl) + 1);
        }
        // On load, the result lands in the hook's variable; lines after it are unrelated code.
        const after = trigger.kind === 'load' ? afterEffects(code, raw, i, i) : afterEffects(code, raw, i, end);
        if (trigger.kind === 'load') {
          const v = /(?:const|let)\s+(?:\{\s*([^}]*)\}|([A-Za-z_$][\w$]*))\s*=\s*use\w+\s*\(/.exec(code[trigger.line - 1]);
          if (v) after.unshift({ kind: 'state', line: trigger.line, detail: (v[2] ?? v[1].split(',')[0]).trim(), snippet: snippet(raw[trigger.line - 1]) });
        }
        out.push({ file: st.input.path, line: i + 1, callee: p.callee, target: { file: p.call.file, line: p.call.line }, trigger, handler, component, label, after, snippet: snippet(raw[i]) });
      }
    });
  }
}
