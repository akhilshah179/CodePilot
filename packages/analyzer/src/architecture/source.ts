import { credentialLines } from '../secrets.ts';
import type { ExportEntry } from '../types.ts';
import { CATALOG, CATALOG_BY_ID, toolForScheme, toolsForModule, type CatalogEntry } from './catalog.ts';
import { annotateClientFunctions, scanMiddleware, scanResponse, scanUiTriggers, type LifecycleFile } from './lifecycleFacts.ts';
import { dirOf, escapeRegExp, joinPath, parseUrlish, snippet, stripComments, type CommentStyle } from './text.ts';
import type {
  CallFact,
  ClientFact,
  ConfigFact,
  DefinitionFact,
  EnvRefFact,
  HttpCallFact,
  HttpMethod,
  InternalImportFact,
  MiddlewareFact,
  ModuleImportFact,
  MountFact,
  OpKind,
  ResponseFact,
  RouteFact,
  SecretFact,
  SourceLanguage,
  SymbolFact,
  SymbolRef,
  UiTriggerFact,
} from './types.ts';

/**
 * Source-level evidence: imports, clients, operations, routes, outbound calls, env vars and
 * declarations. Everything is pattern-based on comment-stripped lines, so each fact maps to one
 * real line; operations are only recorded on identifiers that are provably bound to a client
 * (constructed in the file, or imported from the module that constructs it).
 */

export interface JsParseInfo {
  imports: { specifier: string; symbols: string[]; line: number }[];
  directives: { value: string; line: number }[];
  exportedHttpMethods: string[];
  exports: ExportEntry[];
}

export interface SourceInput {
  path: string;
  lang: SourceLanguage;
  text: string;
  js?: JsParseInfo;
}

export interface ConfigInput {
  path: string;
  text: string;
}

export interface JsInternalEdge {
  source: string;
  target: string;
  line: number;
  specifier: string;
  symbols: string[];
}

export interface SourceScanInput {
  sources: SourceInput[];
  configs: ConfigInput[];
  repoFiles: Set<string>;
  jsEdges: JsInternalEdge[];
  goModules: { dir: string; module: string }[];
  /** Catalog ids declared in any manifest. */
  declared: Set<string>;
}

export interface SourceScanOutput {
  imports: ModuleImportFact[];
  internalImports: InternalImportFact[];
  symbols: SymbolFact[];
  clients: ClientFact[];
  calls: CallFact[];
  routes: RouteFact[];
  mounts: MountFact[];
  httpCalls: HttpCallFact[];
  uiTriggers: UiTriggerFact[];
  middleware: MiddlewareFact[];
  envRefs: EnvRefFact[];
  definitions: DefinitionFact[];
  configs: ConfigFact[];
  secrets: SecretFact[];
}

export function sourceLanguage(language: string): SourceLanguage | undefined {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
    case 'vue':
    case 'svelte':
    case 'astro':
      return 'js';
    case 'python':
      return 'python';
    case 'go':
      return 'go';
    case 'java':
    case 'kotlin':
      return 'java';
    case 'ruby':
      return 'ruby';
    case 'php':
      return 'php';
    case 'rust':
      return 'rust';
    case 'csharp':
      return 'csharp';
    default:
      return undefined;
  }
}

const STYLE: Record<SourceLanguage, CommentStyle> = { js: 'c', python: 'python', go: 'c', java: 'c', ruby: 'hash', php: 'c', rust: 'c', csharp: 'c' };

interface Binding {
  tool: string;
  kind: 'module' | 'client';
  /** A function that returns a client; only its call results are clients. */
  factory?: boolean;
  /** File the client was constructed in, when imported. */
  via?: string;
  /** Literal argument of the client (queue name, base URL). */
  arg?: string;
}

interface FileState {
  input: SourceInput;
  code: string[];
  raw: string[];
  /** Catalog ids imported by this file, with the first import line. */
  tools: Map<string, number>;
  bindings: Map<string, Binding>;
  /** Local name bound to each symbol imported from an internal file (per target file). */
  internalBindings: { target: string; line: number; symbols: Map<string, string>; namespace?: string }[];
  /** `const NAME = 'literal'` in this file. */
  constants: Map<string, string>;
  defaultExport?: string;
}

// --- Argument helpers -------------------------------------------------------------------------------------------

/** Text of the first argument after `(` at `open` (same line), with nesting respected. */
function firstArg(line: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return line.slice(open + 1, i).trim();
      depth--;
    } else if (c === ',' && depth === 0) return line.slice(open + 1, i).trim();
  }
  return line.slice(open + 1).trim();
}

const ENV_IN_EXPR = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|import\.meta\.env\.([A-Z_][A-Z0-9_]*)|os\.environ(?:\.get)?\s*[[(]\s*["']([A-Z_][A-Z0-9_]*)["']|os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']|os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"|ENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|settings\.([A-Z_][A-Z0-9_]*)|config\.([A-Z_][A-Z0-9_]*)/;

function envInExpr(expr: string): string | undefined {
  const m = ENV_IN_EXPR.exec(expr);
  return m ? m.slice(1).find(Boolean) : undefined;
}

/**
 * Template placeholders (`${…}`, Python `{…}`, nested braces allowed) → `:param` when they fill a
 * whole path segment; placeholders glued to text (a query-string builder like `${q(opts)}`) are dropped.
 */
function templatePath(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const dollar = body[i] === '$' && body[i + 1] === '{';
    if (!dollar && body[i] !== '{') {
      out += body[i];
      continue;
    }
    let depth = 0;
    let j = dollar ? i + 1 : i;
    for (; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}' && --depth === 0) break;
    }
    const segmentStart = out === '' || out.endsWith('/');
    const segmentEnd = j + 1 >= body.length || body[j + 1] === '/' || body[j + 1] === '?';
    if (segmentStart && (segmentEnd || /^[\w-]/.test(body[j + 1] ?? ''))) out += ':param';
    i = j;
  }
  return out;
}

/** Interpret a call argument as a URL: literal, template with placeholders, or env-driven. */
function urlFromArg(arg: string): { url?: string; host?: string; envVar?: string } {
  const a = arg.trim();
  let m = /^(?:f|r|b)?(["'])(.*?)\1/.exec(a);
  if (m && !a.slice(m[0].length).trim().startsWith('+') && !a.startsWith('f')) return withHost(m[2]);
  m = /^(`)(.*?)`/.exec(a) ?? /^f(["'])(.*?)\1/.exec(a);
  if (m) {
    const body = m[2];
    const lead = /^(\$\{(?:[^{}]|\{[^{}]*\})*\}|\{[^}]*\})/.exec(body);
    if (lead) {
      return { envVar: envInExpr(lead[1]), url: templatePath(body.slice(lead[1].length)) || undefined };
    }
    return withHost(templatePath(body));
  }
  const env = envInExpr(a);
  const tail = /\+\s*(["'`])(\/[^"'`]*)\1/.exec(a);
  return { envVar: env, url: tail ? tail[2] : undefined };
}

function withHost(url: string): { url: string; host?: string } {
  const u = parseUrlish(url);
  return u?.host && /^https?|wss?$/.test(u.scheme) ? { url, host: u.host } : { url };
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const asMethod = (m: string | undefined): HttpMethod => {
  const u = (m ?? '').toUpperCase();
  return (METHODS.has(u) ? u : 'ANY') as HttpMethod;
};

/** Guard-like identifiers in code (string literals and the handler's own name are ignored). */
function hasAuthHint(line: string): boolean {
  const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\b(?:async\s+)?def\s+\w+|\bfunction\s+\w+/g, '');
  return AUTH_HINT.test(code);
}

const AUTH_HINT = /\b(?:auth\w*|authenticate\w*|authorize\w*|requireAuth|require_auth|requireUser|isAuthenticated|is_authenticated|ensureAuth\w*|login_required|jwt_required|verify_?[Tt]oken|verifyJwt|current_user|get_current_\w+|getCurrentUser|getServerSession|currentUser|withAuth|protect(?:ed)?|UseGuards|AuthGuard|PreAuthorize|Secured|requires_auth|permission_required|IsAuthenticated|protectedProcedure|clerkMiddleware|getAuth)\b/;

// --- Import parsing ------------------------------------------------------------------------------------------------------

interface ParsedImport {
  module: string;
  line: number;
  /** Relative import depth for Python (`from ..x import y` → 2). */
  level: number;
  /** imported symbol → local binding */
  named: Map<string, string>;
  /** Binding of the whole module (default import, `import x`, namespace). */
  whole?: string;
  snippet: string;
}

function jsImportBindings(raw: string[], line: number, specifier: string): { whole?: string; named: Map<string, string> } {
  const named = new Map<string, string>();
  let text = '';
  for (let i = line - 1; i < Math.min(raw.length, line + 25); i++) {
    text += ' ' + raw[i];
    if (raw[i].includes(specifier)) break;
  }
  let whole: string | undefined;
  const imp = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)?\s*,?\s*(?:\*\s+as\s+([A-Za-z_$][\w$]*))?\s*(?:\{([^}]*)\})?\s*from/.exec(text);
  if (imp) {
    whole = imp[2] ?? imp[1];
    if (imp[1] && imp[1] !== 'type') named.set('default', imp[1]);
    for (const part of (imp[3] ?? '').split(',')) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (m) named.set(m[1], m[2] ?? m[1]);
    }
  }
  const req = /(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*=\s*(?:await\s+)?(?:require|import)\s*\(/.exec(text);
  if (req) {
    if (req[1]) whole = req[1];
    for (const part of (req[2] ?? '').split(',')) {
      const m = /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/.exec(part);
      if (m) named.set(m[1], m[2] ?? m[1]);
    }
  }
  return { whole, named };
}

function pythonImports(code: string[], raw: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    let m = /^\s*import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const p = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (p) out.push({ module: p[1], line: i + 1, level: 0, named: new Map(), whole: p[2] ?? p[1].split('.')[0], snippet: snippet(raw[i]) });
      }
      continue;
    }
    m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (!m) continue;
    let list = m[3];
    let j = i;
    if (list.includes('(') && !list.includes(')')) {
      while (++j < code.length && !code[j].includes(')')) list += ' ' + code[j];
      if (j < code.length) list += ' ' + code[j];
    }
    const named = new Map<string, string>();
    for (const part of list.replace(/[()\\]/g, ' ').split(',')) {
      const p = /^\s*(\w+|\*)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (p) named.set(p[1], p[2] ?? p[1]);
    }
    out.push({ module: m[2], line: i + 1, level: m[1].length, named, snippet: snippet(raw[i]) });
    i = Math.max(i, j);
  }
  return out;
}

function goImports(code: string[], raw: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  let block = false;
  const pkgName = (path: string) => {
    const segs = path.split('/');
    let last = segs[segs.length - 1];
    if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2];
    return last.replace(/^go-/, '').replace(/[-.]go$/, '').replace(/[^\w]/g, '');
  };
  code.forEach((line, i) => {
    if (/^\s*import\s*\(\s*$/.test(line)) {
      block = true;
      return;
    }
    if (block && /^\s*\)/.test(line)) {
      block = false;
      return;
    }
    const m = block ? /^\s*([\w.]+\s+)?"([^"]+)"/.exec(line) : /^\s*import\s+([\w.]+\s+)?"([^"]+)"/.exec(line);
    if (m) out.push({ module: m[2], line: i + 1, level: 0, named: new Map(), whole: m[1]?.trim() || pkgName(m[2]), snippet: snippet(raw[i]) });
  });
  return out;
}

function otherImports(lang: SourceLanguage, code: string[], raw: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  code.forEach((line, i) => {
    let m: RegExpExecArray | null = null;
    if (lang === 'java') m = /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/.exec(line);
    else if (lang === 'ruby') m = /^\s*require\s+["']([\w/.-]+)["']/.exec(line);
    else if (lang === 'php') m = /^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/.exec(line);
    else if (lang === 'rust') m = /^\s*(?:pub\s+)?use\s+([\w:]+)|^\s*extern\s+crate\s+(\w+)/.exec(line);
    else if (lang === 'csharp') m = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
    if (m) {
      const module = (m[1] ?? m[2]).replace(/^\\/, '');
      out.push({ module, line: i + 1, level: 0, named: new Map(), whole: module.split(/[.:\\/]+/).pop(), snippet: snippet(raw[i]) });
    }
  });
  return out;
}

// --- Main -------------------------------------------------------------------------------------------------------------------

export function scanSources(input: SourceScanInput): SourceScanOutput {
  const out: SourceScanOutput = { imports: [], internalImports: [], symbols: [], clients: [], calls: [], routes: [], mounts: [], httpCalls: [], uiTriggers: [], middleware: [], envRefs: [], definitions: [], configs: [], secrets: [] };
  const states = new Map<string, FileState>();
  const pyFiles = new Set([...input.repoFiles].filter((f) => f.endsWith('.py')));

  // ---- Pass A: per-file facts that need no cross-file knowledge ----------------------------------------------------
  for (const src of input.sources) {
    const raw = src.text.split('\n');
    const code = stripComments(src.text, STYLE[src.lang], src.lang === 'php');
    const st: FileState = { input: src, code, raw, tools: new Map(), bindings: new Map(), internalBindings: [], constants: new Map() };
    states.set(src.path, st);

    // Imports
    let parsed: ParsedImport[] = [];
    if (src.lang === 'js' && src.js) {
      for (const imp of src.js.imports) {
        if (imp.specifier.startsWith('.') || imp.specifier.startsWith('/')) continue;
        const b = jsImportBindings(raw, imp.line, imp.specifier);
        parsed.push({ module: imp.specifier, line: imp.line, level: 0, named: b.named, whole: b.whole, snippet: snippet(raw[imp.line - 1]) });
      }
    } else if (src.lang === 'python') parsed = pythonImports(code, raw);
    else if (src.lang === 'go') parsed = goImports(code, raw);
    else parsed = otherImports(src.lang, code, raw);

    for (const imp of parsed) {
      if (imp.level > 0) continue;
      const tools = toolsForModule(src.lang, imp.module);
      if (!tools.length) continue;
      const bindings = [...new Set([...(imp.whole ? [imp.whole] : []), ...imp.named.values()])];
      out.imports.push({ file: src.path, line: imp.line, lang: src.lang, module: imp.module, bindings, snippet: imp.snippet });
      for (const t of tools) {
        if (!st.tools.has(t.id)) st.tools.set(t.id, imp.line);
        if (t.moduleOps && imp.whole) st.bindings.set(imp.whole, { tool: t.id, kind: 'module' });
      }
    }

    // Internal imports (Python / Go / Ruby); JS comes from the resolved dependency graph.
    if (src.lang === 'python') {
      for (const imp of parsed) {
        const hits = resolvePython(src.path, imp, pyFiles);
        for (const h of hits) {
          out.internalImports.push({ source: src.path, target: h.target, line: imp.line, symbols: h.symbols });
          const symbols = new Map<string, string>();
          for (const s of h.symbols) symbols.set(s, imp.named.get(s) ?? s);
          st.internalBindings.push({ target: h.target, line: imp.line, symbols, namespace: h.namespace });
        }
      }
    } else if (src.lang === 'go') {
      for (const imp of parsed) {
        for (const target of resolveGo(imp.module, input.goModules, input.repoFiles)) {
          if (target === src.path) continue;
          out.internalImports.push({ source: src.path, target, line: imp.line, symbols: [] });
          st.internalBindings.push({ target, line: imp.line, symbols: new Map(), namespace: imp.whole });
        }
      }
    } else if (src.lang === 'ruby') {
      code.forEach((line, i) => {
        const m = /^\s*require_relative\s+["']([\w/.-]+)["']/.exec(line);
        if (!m) return;
        const target = joinPath(dirOf(src.path), m[1].endsWith('.rb') ? m[1] : m[1] + '.rb');
        if (target && input.repoFiles.has(target)) out.internalImports.push({ source: src.path, target, line: i + 1, symbols: [] });
      });
    }

    // Constants and default export (to resolve queue names / default-exported clients)
    code.forEach((line) => {
      const c = /^\s*(?:export\s+)?(?:const|let|var|final\s+\w+|static\s+final\s+\w+)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*["'`]([\w:./-]+)["'`]\s*;?\s*$/.exec(line);
      if (c) st.constants.set(c[1], c[2]);
      const d = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(line);
      if (d) st.defaultExport = d[1];
    });

    // Clients of imported tools (and tools that need no import binding: fetch is handled separately)
    for (const toolId of st.tools.keys()) {
      const tool = CATALOG_BY_ID.get(toolId)!;
      for (const pattern of tool.clients ?? []) {
        if (pattern.langs && !pattern.langs.includes(src.lang)) continue;
        code.forEach((line, i) => {
          const m = pattern.re.exec(line);
          if (!m?.groups?.name) return;
          const name = m.groups.name;
          if (st.bindings.get(name)?.kind === 'client') return;
          const arg = m.groups.arg ?? baseUrlArg(line) ?? undefined;
          st.bindings.set(name, { tool: toolId, kind: 'client', arg });
          out.clients.push({ file: src.path, line: i + 1, tool: toolId, name, snippet: snippet(raw[i]), arg });
        });
      }
    }

    scanEnv(st, out);
    scanRoutes(st, out, input.declared);
    scanMiddleware(st, out.middleware);
    scanDefinitions(st, out);
    scanConfigLines(src.path, code, raw, out, st.tools);
    for (const line of credentialLines(src.text)) out.secrets.push({ file: src.path, line, kind: 'credential-pattern' });
  }

  for (const cfg of input.configs) {
    const code = stripComments(cfg.text, /\.(ya?ml|properties|toml|cfg|ini|conf|env)$/i.test(cfg.path) ? 'hash' : /\.prisma$/.test(cfg.path) ? 'c' : 'none');
    const raw = cfg.text.split('\n');
    scanConfigLines(cfg.path, code, raw, out, new Map());
    if (cfg.path.endsWith('.prisma')) scanPrisma(cfg.path, code, raw, out);
    for (const line of credentialLines(cfg.text)) out.secrets.push({ file: cfg.path, line, kind: 'credential-pattern' });
  }

  // ---- Pass B: clients imported from other files, then operations ------------------------------------------------------
  for (const e of input.jsEdges) {
    const st = states.get(e.source);
    const target = states.get(e.target);
    if (!st || !target) continue;
    const b = jsImportBindings(st.raw, e.line, e.specifier);
    const symbols = new Map<string, string>();
    for (const s of e.symbols) {
      if (s === '*') continue;
      symbols.set(s, b.named.get(s) ?? (s === 'default' ? (b.named.get('default') ?? b.whole ?? s) : s));
    }
    st.internalBindings.push({ target: e.target, line: e.line, symbols, namespace: e.symbols.includes('*') ? b.whole : undefined });
  }

  deriveBindings(states);

  // Propagate client bindings along imports (twice, so barrel re-exports work).
  const exported = (st: FileState, symbol: string): Binding | undefined => {
    if (symbol === 'default' && st.defaultExport) return st.bindings.get(st.defaultExport);
    const b = st.bindings.get(symbol);
    return b?.kind === 'client' ? b : undefined;
  };
  for (let round = 0; round < 3; round++) {
    for (const st of states.values()) {
      for (const ib of st.internalBindings) {
        const target = states.get(ib.target);
        if (!target) continue;
        for (const [symbol, local] of ib.symbols) {
          const b = exported(target, symbol);
          if (b && !st.bindings.has(local)) st.bindings.set(local, { ...b, via: b.via ?? ib.target });
        }
        if (ib.namespace) {
          for (const [name, b] of target.bindings) {
            if (b.kind === 'client' && !name.includes('.') && !st.bindings.has(`${ib.namespace}.${name}`)) st.bindings.set(`${ib.namespace}.${name}`, { ...b, via: b.via ?? ib.target });
          }
        }
      }
    }
  }

  // Factories: a top-level function that returns a client (`def get_redis(): … return g.redis`) yields that client.
  for (let round = 0; round < 2; round++) {
    for (const st of states.values()) {
      const clients = [...st.bindings].filter(([, b]) => b.kind === 'client');
      if (!clients.length) continue;
      for (const def of topLevelDefs(st)) {
        if (st.bindings.has(def.name)) continue;
        for (let i = def.line - 1; i < def.end; i++) {
          const m = /\breturn\s+(?:await\s+)?([A-Za-z_$][\w$.]*)\s*;?\s*$/.exec(st.code[i]);
          const b = m ? st.bindings.get(m[1]) : undefined;
          if (b?.kind === 'client') {
            st.bindings.set(def.name, { ...b, kind: 'client', factory: true });
            break;
          }
        }
      }
    }
    for (const st of states.values()) {
      for (const ib of st.internalBindings) {
        const target = states.get(ib.target);
        if (!target) continue;
        for (const [symbol, local] of ib.symbols) {
          const b = target.bindings.get(symbol);
          if (b?.factory && !st.bindings.has(local)) st.bindings.set(local, { ...b, via: b.via ?? ib.target });
        }
      }
    }
  }

  deriveBindings(states);

  // Operations on bound identifiers.
  for (const st of states.values()) scanOperations(st, out, input.declared);
  scanFetchWrappers(states, out);

  // Celery tasks (need task names from all files) and consumers derived from operations.
  scanCeleryTasks(states, out);
  for (const c of out.calls) {
    if (c.op !== 'consume') continue;
    // `consumer.run()` next to `consumer.subscribe({ topic })` is the same consumer.
    if (!c.arg && out.calls.some((o) => o !== c && o.op === 'consume' && o.tool === c.tool && o.file === c.file && o.arg)) continue;
    const tool = CATALOG_BY_ID.get(c.tool);
    out.definitions.push({ file: c.file, line: c.line, kind: tool?.id === 'kafka' ? 'topic-consumer' : 'queue-consumer', tool: c.tool, name: c.arg, snippet: c.snippet });
  }

  applyMounts(states, out);
  scanSymbols(states, out);
  // Request lifecycle: what each handler returns, which client function each call is written in,
  // and the UI code that triggers those functions.
  for (const r of out.routes) {
    const st = states.get(r.file);
    if (st) r.response = scanResponse(st, r);
  }
  resolveUrlHelpers(states, out);
  const defs = (f: LifecycleFile) => topLevelDefs(f as FileState);
  annotateClientFunctions(states, out.httpCalls, defs);
  scanUiTriggers(states, out.httpCalls, out.uiTriggers, defs);
  return out;
}

/**
 * Streams opened with a URL helper (`new EventSource(api.streamUrl(id))`): take the URL from the
 * helper's definition when it returns a literal or template in the importing file's reach.
 */
function resolveUrlHelpers(states: Map<string, FileState>, out: SourceScanOutput) {
  for (const h of out.httpCalls) {
    if (h.url || !h.protocol || h.protocol === 'REST') continue;
    const st = states.get(h.file);
    if (!st) continue;
    const m = /new\s+(?:EventSource|WebSocket)\s*\(\s*(?:[\w$]+\.)?([\w$]+)\s*\(/.exec(st.code[h.line - 1] ?? '');
    if (!m) continue;
    const def = new RegExp(`(?<![\\w$.])${escapeRegExp(m[1])}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*(?::\\s*\\w+\\s*)?=>\\s*(\`[^\`]*\`|'[^']*'|"[^"]*")`);
    const candidates = [st, ...st.internalBindings.map((b) => states.get(b.target)).filter((x): x is FileState => !!x)];
    for (const c of candidates) {
      const i = c.code.findIndex((l) => def.test(l));
      if (i < 0) continue;
      const u = urlFromArg(def.exec(c.code[i])![1]);
      if (u.url) {
        h.url = u.url.replace(/\?.*$/, '');
        h.envVar ??= u.envVar;
      }
      break;
    }
  }
}

/** Top-level definitions of a JS/TS or Python file: name and line range (decorators included). */
function topLevelDefs(st: FileState): { name: string; line: number; end: number; isDefault?: boolean }[] {
  const { code } = st;
  const lang = st.input.lang;
  if (lang !== 'js' && lang !== 'python') return [];
  const starts: { line: number; name?: string; isDefault?: boolean }[] = [];
  let depth = 0;
  let pendingDecorator: number | null = null;
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    const atTop = depth === 0 && /^\S/.test(line) && !/^[)\]}.?:+\-*/|&,]/.test(line);
    if (atTop) {
      let name: string | undefined;
      let isDefault = false;
      let m: RegExpExecArray | null;
      if (lang === 'python') {
        if (/^@/.test(line)) {
          pendingDecorator ??= i;
        } else if ((m = /^(?:async\s+)?def\s+(\w+)|^class\s+(\w+)|^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(line))) {
          name = m[1] ?? m[2] ?? m[3];
        }
      } else if ((m = /^(?:export\s+)?(default\s+)?(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)?|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|^export\s+(default)\b/.exec(line))) {
        name = m[2] ?? m[3] ?? m[5] ?? (m[1] || m[4] || m[6] ? 'default' : undefined);
        isDefault = !!(m[1] || m[4] || m[6]);
      }
      if (!/^@/.test(line)) {
        starts.push({ line: (pendingDecorator ?? i) + 1, name, isDefault });
        pendingDecorator = null;
      }
    }
    for (const ch of line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  const defs: { name: string; line: number; end: number; isDefault?: boolean }[] = [];
  starts.forEach((s, k) => {
    if (!s.name) return;
    let end = (starts[k + 1]?.line ?? code.length + 1) - 1;
    while (end > s.line && !code[end - 1]?.trim()) end--;
    defs.push({ name: s.name, line: s.line, end, isDefault: s.isDefault });
  });
  return defs;
}

/** Project code referenced between `start` and `end` (1-based, inclusive) in a file. */
function bodyRefs(st: FileState, start: number, end: number, localDefs: { name: string; line: number }[], self?: string): SymbolRef[] {
  const targets = new Map<string, { file: string; symbol?: string; namespace: boolean }>();
  for (const ib of st.internalBindings) {
    for (const [symbol, local] of ib.symbols) if (!targets.has(local)) targets.set(local, { file: ib.target, symbol: symbol === 'default' ? 'default' : symbol, namespace: false });
    if (ib.namespace && !targets.has(ib.namespace)) targets.set(ib.namespace, { file: ib.target, namespace: true });
  }
  for (const d of localDefs) if (d.name !== self && !targets.has(d.name)) targets.set(d.name, { file: st.input.path, symbol: d.name, namespace: false });
  if (!targets.size) return [];
  const names = [...targets.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(?<![\\w$.])(${names.join('|')})(?![\\w$])(?:\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g');
  const out = new Map<string, SymbolRef>();
  for (let i = start - 1; i < Math.min(end, st.code.length); i++) {
    const line = st.code[i];
    if (/^\s*(?:import\b|from\s+\S+\s+import\b)/.test(line)) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const t = targets.get(m[1]);
      if (!t) continue;
      const symbol = t.namespace ? m[2] : t.symbol;
      const key = `${t.file}#${symbol ?? ''}`;
      if (!out.has(key)) out.set(key, { file: t.file, symbol, line: i + 1 });
    }
  }
  return [...out.values()];
}

/** Last line (1-based) of the call whose opening parenthesis is the first on `line`. */
function callEnd(code: string[], line: number): number {
  let depth = 0;
  let opened = false;
  for (let i = line - 1; i < code.length && i < line + 400; i++) {
    const text = code[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const ch of text) {
      if (ch === '(') {
        depth++;
        opened = true;
      } else if (ch === ')') {
        depth--;
        if (opened && depth === 0) return i + 1;
      }
    }
  }
  return line;
}

/** Definitions with their references, and handler scopes for routes. */
function scanSymbols(states: Map<string, FileState>, out: SourceScanOutput) {
  const defsByFile = new Map<string, ReturnType<typeof topLevelDefs>>();
  for (const st of states.values()) {
    const defs = topLevelDefs(st);
    if (!defs.length) continue;
    defsByFile.set(st.input.path, defs);
    for (const d of defs) {
      const refs = bodyRefs(st, d.line, d.end, defs, d.name);
      out.symbols.push({ file: st.input.path, name: d.name, line: d.line, end: d.end, refs });
      if (d.isDefault && d.name !== 'default') out.symbols.push({ file: st.input.path, name: 'default', line: d.line, end: d.end, refs });
    }
    if (st.defaultExport && !defs.some((d) => d.name === 'default')) {
      const target = defs.find((d) => d.name === st.defaultExport);
      if (target) out.symbols.push({ file: st.input.path, name: 'default', line: target.line, end: target.end, refs: bodyRefs(st, target.line, target.end, defs, target.name) });
    }
  }
  // Routes: the handler body runs to the enclosing definition's end, or to the next route.
  const byFile = new Map<string, RouteFact[]>();
  for (const r of out.routes) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }
  for (const [file, routes] of byFile) {
    const st = states.get(file);
    if (!st) continue;
    const defs = defsByFile.get(file) ?? [];
    const lines = [...new Set(routes.map((r) => r.line))].sort((a, b) => a - b);
    for (const r of routes) {
      if (r.kind === 'page') {
        // A page renders its default-export component.
        const component = defs.find((d) => d.isDefault);
        if (component) {
          r.bodyStart = component.line;
          r.bodyEnd = component.end;
          r.refs = bodyRefs(st, component.line, component.end, defs, component.name);
        }
        continue;
      }
      // Router calls (`app.get('/x', handler)`): the handler is the call expression itself.
      if (r.source === 'router-call') {
        r.bodyEnd = callEnd(st.code, r.line);
        r.refs = bodyRefs(st, r.line, r.bodyEnd, defs);
        continue;
      }
      const enclosing = defs.find((d) => d.line <= r.line && d.end >= r.line);
      const next = lines.find((l) => l > r.line);
      if (r.source === 'file-convention' && r.kind !== 'action' && !enclosing) r.bodyEnd = st.code.length;
      else r.bodyEnd = enclosing && (!next || enclosing.end < next) ? enclosing.end : next ? next - 1 : st.code.length;
      r.refs = bodyRefs(st, r.line, r.bodyEnd, defs, enclosing?.name);
    }
  }
}

/** Bindings derived inside a file: `db = SessionLocal()`, `redis = get_redis()`, `with SessionLocal() as db`, `export const db = prisma`. */
function deriveBindings(states: Map<string, FileState>) {
  for (const st of states.values()) {
    const clients = [...st.bindings].filter(([, b]) => b.kind === 'client');
    for (const [name, b] of clients) {
      const n = escapeRegExp(name);
      const re = new RegExp(`(?:^|[\\s(,])(?<name>[A-Za-z_][\\w.]*)\\s*(?::\\s*[\\w.\\[\\]]+\\s*)?(?::=|=)\\s*(?:await\\s+)?${n}(?:\\.(?:acquire|connect|session|begin|cursor|getConnection|get_connection|pipeline|multi|duplicate))?\\s*\\(|with\\s+${n}(?:\\.(?:acquire|connect|begin|session|cursor|pipeline))?\\s*\\([^)]*\\)\\s+as\\s+(?<name2>[A-Za-z_]\\w*)|^\\s*(?:export\\s+)?(?:const|let|var)\\s+(?<name3>[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*${n}\\s*;?\\s*$`);
      st.code.forEach((line) => {
        const m = re.exec(line);
        const bound = m?.groups?.name ?? m?.groups?.name2 ?? m?.groups?.name3;
        if (bound && bound !== name && !st.bindings.has(bound)) st.bindings.set(bound, { ...b, factory: false });
      });
    }
  }
}

/**
 * HTTP wrappers: a top-level function that passes its first parameter to fetch()
 * (`function request(path) { … fetch(path, …) }`). Calls to it with a literal path are HTTP calls
 * to that path — the wrapper's body is the evidence that the argument reaches fetch.
 */
function scanFetchWrappers(states: Map<string, FileState>, out: SourceScanOutput) {
  const wrappers = new Map<string, Set<string>>(); // file → wrapper names
  const wrapperMethod = new Map<string, string>(); // file#name → method the wrapper always uses
  for (const st of states.values()) {
    if (st.input.lang !== 'js') continue;
    for (const def of topLevelDefs(st)) {
      const head = st.code[def.line - 1] ?? '';
      const m = /function\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)|=\s*(?:async\s*)?(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*(?::[^=]+)?=>/.exec(head);
      const param = m?.[1] ?? m?.[2];
      if (!param) continue;
      const p = escapeRegExp(param);
      const passes = new RegExp(`(?<![\\w$.])fetch\\s*\\(\\s*(?:${p}\\b|[\\w$.]+\\s*\\+\\s*${p}\\b|\`[^\`]*\\$\\{\\s*${p}\\s*\\}[^\`]*\`)`);
      for (let i = def.line - 1; i < def.end; i++) {
        if (passes.test(st.code[i])) {
          if (!wrappers.has(st.input.path)) wrappers.set(st.input.path, new Set());
          wrappers.get(st.input.path)!.add(def.name);
          const fixed = st.code.slice(def.line - 1, def.end).map((l) => /method\s*:\s*["'`](\w+)["'`]/.exec(l)?.[1]).find(Boolean);
          if (fixed) wrapperMethod.set(`${st.input.path}#${def.name}`, fixed);
          break;
        }
      }
    }
  }
  if (!wrappers.size) return;
  /** HTTP method of a request-options argument: a literal, or a helper like `json(body)` that sets one. */
  const methodOfArg = (st: FileState, rest: string): string | undefined => {
    const lit = /method\s*:\s*["'`](\w+)["'`]/.exec(rest)?.[1];
    if (lit) return lit;
    const helper = /^\s*,\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest)?.[1];
    if (!helper) return undefined;
    const i = st.code.findIndex((l) => new RegExp(`(?:const|let|function)\\s+${escapeRegExp(helper)}\\b`).test(l));
    return i < 0 ? undefined : st.code.slice(i, i + 4).map((l) => /method\s*:\s*["'`](\w+)["'`]/.exec(l)?.[1]).find(Boolean);
  };
  for (const st of states.values()) {
    if (st.input.lang !== 'js') continue;
    const visible = new Map<string, string>([...(wrappers.get(st.input.path) ?? [])].map((n) => [n, st.input.path]));
    for (const ib of st.internalBindings) {
      const names = wrappers.get(ib.target);
      if (!names) continue;
      for (const [symbol, local] of ib.symbols) if (names.has(symbol)) visible.set(local, ib.target);
    }
    for (const [name, from] of visible) {
      const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*(?:<[^()]*?>)?\\s*\\(`, 'g');
      st.code.forEach((line, i) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          const open = m.index + m[0].length - 1;
          const arg = firstArg(line, open);
          if (!/^["'`]/.test(arg)) continue;
          const u = urlFromArg(arg);
          if (!u.url && !u.envVar) continue;
          // After the URL: request options (method literal or helper), or nothing — fetch's default is GET.
          const rest = line.slice(line.indexOf(arg, open) + arg.length);
          const noInit = /^\s*\)/.test(rest);
          const method = methodOfArg(st, rest) ?? wrapperMethod.get(`${from}#${name}`) ?? (noInit ? 'GET' : undefined);
          out.httpCalls.push({ file: st.input.path, line: i + 1, client: `${name}() → fetch`, method: method ? asMethod(method) : undefined, url: u.url, host: u.host, envVar: u.envVar, snippet: snippet(st.raw[i]) });
        }
      });
    }
  }
}

function baseUrlArg(line: string): string | undefined {
  return /baseURL\s*:\s*["'`]([^"'`]+)["'`]/.exec(line)?.[1] ?? /base_url\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
}

// --- Import resolution --------------------------------------------------------------------------------------------------------

function resolvePython(from: string, imp: ParsedImport, pyFiles: Set<string>): { target: string; symbols: string[]; namespace?: string }[] {
  const asFile = (base: string): string | null => {
    if (pyFiles.has(base + '.py')) return base + '.py';
    if (pyFiles.has(base + '/__init__.py')) return base + '/__init__.py';
    return null;
  };
  const bases: string[] = [];
  if (imp.level > 0) {
    let dir = dirOf(from);
    for (let k = 1; k < imp.level; k++) dir = dirOf(dir);
    bases.push(dir);
  } else {
    let dir = dirOf(from);
    for (;;) {
      bases.push(dir);
      if (!dir) break;
      dir = dirOf(dir);
    }
  }
  const modPath = imp.module.replace(/\./g, '/');
  for (const b of bases) {
    const base = [b, modPath].filter(Boolean).join('/');
    if (imp.named.size) {
      // `from pkg import sub` may import submodules; otherwise names come from pkg itself.
      const out: { target: string; symbols: string[]; namespace?: string }[] = [];
      const pkg = modPath ? asFile(base) : null;
      const rest: string[] = [];
      for (const [name, local] of imp.named) {
        const sub = name !== '*' ? asFile(`${base ? base + '/' : ''}${name}`) : null;
        if (sub && sub !== from) out.push({ target: sub, symbols: [], namespace: local });
        else rest.push(name);
      }
      if (pkg && rest.length && pkg !== from) out.push({ target: pkg, symbols: rest.filter((n) => n !== '*') });
      if (out.length) return out;
    } else {
      const hit = asFile(base);
      if (hit && hit !== from) return [{ target: hit, symbols: [], namespace: imp.whole }];
    }
  }
  return [];
}

function resolveGo(path: string, modules: { dir: string; module: string }[], files: Set<string>): string[] {
  const mod = modules.find((m) => path === m.module || path.startsWith(m.module + '/'));
  if (!mod) return [];
  const dir = [mod.dir, path.slice(mod.module.length + 1)].filter(Boolean).join('/');
  return [...files].filter((f) => dirOf(f) === dir && f.endsWith('.go') && !f.endsWith('_test.go')).sort();
}

// --- Env vars ------------------------------------------------------------------------------------------------------------------

const ENV_PATTERNS: Record<SourceLanguage, RegExp[]> = {
  js: [/process\.env\.([A-Z_][A-Z0-9_]*)/g, /process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g, /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g, /Deno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, /Bun\.env\.([A-Z_][A-Z0-9_]*)/g],
  python: [/os\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g, /os\.environ\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, /os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, /env\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, /config\(\s*["']([A-Z_][A-Z0-9_]*)["']/g],
  go: [/os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g],
  java: [/System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g, /\$\{([A-Z_][A-Z0-9_]*)(?::[^}]*)?\}/g],
  ruby: [/ENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g, /ENV\.fetch\(\s*["']([A-Z_][A-Z0-9_]*)["']/g],
  php: [/(?:env|getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g, /\$_ENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g],
  rust: [/env::var\(\s*"([A-Z_][A-Z0-9_]*)"/g, /env!\(\s*"([A-Z_][A-Z0-9_]*)"/g],
  csharp: [/Environment\.GetEnvironmentVariable\(\s*"([A-Z_][A-Z0-9_]*)"/g],
};

function scanEnv(st: FileState, out: SourceScanOutput) {
  const pats = ENV_PATTERNS[st.input.lang];
  st.code.forEach((line, i) => {
    if (!/env|ENV|getenv|Getenv|config\(/.test(line)) return;
    const seen = new Set<string>();
    for (const re of pats) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        out.envRefs.push({ file: st.input.path, line: i + 1, name: m[1] });
      }
    }
  });
}

// --- Routes --------------------------------------------------------------------------------------------------------------------------

function nextPathFromDir(segments: string[]): string {
  const parts = segments
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@') && s !== '')
    .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '*').replace(/^\[(\w+)\]$/, ':$1'));
  return '/' + parts.join('/');
}

function scanRoutes(st: FileState, out: SourceScanOutput, declared: Set<string>) {
  const { path, lang, js } = st.input;
  const { code, raw } = st;
  const push = (r: Omit<RouteFact, 'file' | 'snippet'> & { snippet?: string }) => out.routes.push({ file: path, snippet: r.snippet ?? snippet(raw[r.line - 1]), ...r });
  const authInFile = () => {
    for (let i = 0; i < code.length; i++) if (/\(/.test(code[i]) && !/^\s*import\b/.test(code[i]) && hasAuthHint(code[i])) return { line: i + 1, snippet: snippet(raw[i]) };
    return undefined;
  };

  if (lang === 'js') {
    // Next.js App Router, SvelteKit, Nuxt file conventions.
    const next = /(?:^|\/)app\/(.*\/)?(route|page)\.(?:[mc]?[jt]sx?|mdx)$/.exec(path);
    if (next && declared.has('nextjs')) {
      const segs = (next[1] ?? '').split('/');
      const routePath = nextPathFromDir(segs);
      if (next[2] === 'route') {
        const methods = js?.exportedHttpMethods.length ? [...new Set(js.exportedHttpMethods)] : [];
        const auth = authInFile();
        if (!methods.length) push({ line: 1, kind: 'api', method: 'ANY', path: routePath, framework: 'nextjs', source: 'file-convention', auth });
        for (const m of methods) {
          const ex = js?.exports.find((e) => e.name === m);
          push({ line: ex?.line ?? 1, kind: 'api', method: asMethod(m), path: routePath, framework: 'nextjs', source: 'file-convention', handler: m, auth });
        }
      } else {
        push({ line: 1, kind: 'page', method: 'GET', path: routePath, framework: 'nextjs', source: 'file-convention', snippet: path });
      }
    }
    const pagesApi = /(?:^|\/)pages\/api\/(.+)\.[mc]?[jt]sx?$/.exec(path);
    if (pagesApi && declared.has('nextjs')) {
      push({ line: 1, kind: 'api', method: 'ANY', path: '/api/' + pagesApi[1].replace(/\/?index$/, '').replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1'), framework: 'nextjs', source: 'file-convention', auth: authInFile(), snippet: path });
    } else {
      const pagesUi = /(?:^|\/)pages\/(?!_)(.+)\.(?:tsx|jsx|js|ts)$/.exec(path);
      if (pagesUi && declared.has('nextjs') && !path.includes('/api/') && !/\.(test|spec|stories)\./.test(path)) {
        push({ line: 1, kind: 'page', method: 'GET', path: '/' + pagesUi[1].replace(/\/?index$/, '').replace(/\[(\w+)\]/g, ':$1'), framework: 'nextjs', source: 'file-convention', snippet: path });
      }
    }
    const svelte = /(?:^|\/)src\/routes\/(.*\/)?\+server\.[jt]s$/.exec(path);
    if (svelte && declared.has('sveltekit')) {
      const routePath = nextPathFromDir((svelte[1] ?? '').split('/'));
      for (const m of js?.exportedHttpMethods ?? []) push({ line: js?.exports.find((e) => e.name === m)?.line ?? 1, kind: 'api', method: asMethod(m), path: routePath, framework: 'sveltekit', source: 'file-convention', handler: m });
    }
    const nuxt = /(?:^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete))?\.[jt]s$/.exec(path);
    if (nuxt && declared.has('nuxt')) {
      const p = (nuxt[1] === 'api' ? '/api/' : '/') + nuxt[2].replace(/\/?index$/, '').replace(/\[(\w+)\]/g, ':$1');
      push({ line: 1, kind: 'api', method: asMethod(nuxt[3]), path: p, framework: 'nuxt', source: 'file-convention', snippet: path });
    }
    // Server actions: exported functions of a 'use server' module.
    if (js?.directives.some((d) => d.value === 'use server')) {
      for (const ex of js.exports) {
        if (ex.kind !== 'function' && ex.kind !== 'variable' && ex.kind !== 'named') continue;
        push({ line: ex.line, kind: 'action', method: 'POST', path: `action:${ex.name}`, framework: 'nextjs', source: 'file-convention', handler: ex.name, auth: authInFile() });
      }
    }

    // Router calls: express/koa/hono/fastify/elysia style.
    const routers = new Set<string>();
    const routerTools = ['express', 'fastify', 'koa', 'hono', 'elysia'].filter((t) => st.tools.has(t));
    code.forEach((line) => {
      const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:express\.Router|Router|express|new\s+Hono|Hono|Fastify|fastify|new\s+Koa|new\s+Router|new\s+Elysia|createRouter|new\s+KoaRouter)\s*(?:<[^>]*>)?\s*\(/.exec(line);
      if (m) routers.add(m[1]);
    });
    if (routerTools.length || routers.size) {
      for (const n of ['app', 'router', 'server', 'api', 'fastify', 'routes', 'r']) if (routerTools.length) routers.add(n);
      // Type arguments are allowed: `app.get<{ Params: { id: string } }>('/x', …)`.
      const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|options|head)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*(["'`])((?:\/|\*)[^"'`]*)\3(.*)$/;
      code.forEach((line, i) => {
        const m = re.exec(line);
        if (!m || !routers.has(m[1])) return;
        const rest = m[5];
        const auth = hasAuthHint(rest) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined;
        push({ line: i + 1, kind: 'api', method: asMethod(m[2] === 'all' ? 'ANY' : m[2]), path: m[4], framework: routerTools[0] ?? 'express', source: 'router-call', auth });
      });
      code.forEach((line, i) => {
        const m = /\broute\s*\(\s*\{[^}]*method\s*:\s*["'](\w+)["'][^}]*url\s*:\s*["']([^"']+)["']/.exec(line);
        if (m) push({ line: i + 1, kind: 'api', method: asMethod(m[1]), path: m[2], framework: 'fastify', source: 'router-call' });
      });
      // Mounts: app.use('/prefix', importedRouter)
      code.forEach((line, i) => {
        const m = /(?<![\w$.])([A-Za-z_$][\w$]*)\.(?:use|route|register)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*([A-Za-z_$][\w$.]*)/.exec(line);
        if (m && routers.has(m[1])) out.mounts.push({ file: path, line: i + 1, prefix: m[2], target: m[3] });
      });
    }
    // NestJS controllers.
    if (st.tools.has('nestjs') || /@Controller\s*\(/.test(st.input.text)) {
      let prefix = '';
      code.forEach((line, i) => {
        const c = /@Controller\s*\(\s*(?:["']([^"']*)["'])?/.exec(line);
        if (c) prefix = c[1] ? '/' + c[1].replace(/^\/|\/$/g, '') : '';
        const m = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*(?:["']([^"']*)["'])?\s*\)/.exec(line);
        if (!m) return;
        const sub = m[2] ? '/' + m[2].replace(/^\//, '') : '';
        const window = code.slice(Math.max(0, i - 4), i + 3).join(' ');
        const auth = hasAuthHint(window) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined;
        push({ line: i + 1, kind: 'api', method: asMethod(m[1] === 'All' ? 'ANY' : m[1]), path: (prefix + sub) || '/', framework: 'nestjs', source: 'decorator', auth });
      });
    }
    // tRPC procedures.
    if (st.tools.has('trpc')) {
      code.forEach((line, i) => {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(\w*[pP]rocedure)\b/.exec(line);
        if (m) push({ line: i + 1, kind: 'api', method: 'POST', path: `trpc:${m[1]}`, framework: 'trpc', source: 'router-call', auth: /protected|auth/i.test(m[2]) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined });
      });
    }
    return;
  }

  if (lang === 'python') {
    const routers = new Map<string, string>(); // binding → prefix
    code.forEach((line) => {
      const m = /^\s*([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*(FastAPI|APIRouter|Flask|Blueprint|Sanic|Quart)\s*\((.*)$/.exec(line);
      if (m) routers.set(m[1], /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(m[3])?.[1] ?? '');
    });
    if (routers.size) {
      code.forEach((line, i) => {
        const m = /^\s*@([A-Za-z_]\w*)\.(get|post|put|patch|delete|options|head|api_route|route|websocket)\s*\(\s*["']([^"']*)["'](.*)$/.exec(line);
        if (!m || !routers.has(m[1])) return;
        let method: HttpMethod = asMethod(m[2]);
        if (m[2] === 'route' || m[2] === 'api_route') {
          const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(m[4]);
          method = methods ? asMethod(/["'](\w+)["']/.exec(methods[1])?.[1]) : m[2] === 'route' ? 'GET' : 'ANY';
        }
        let handler: string | undefined;
        let sigEnd = i;
        for (let j = i + 1; j < Math.min(code.length, i + 8); j++) {
          const d = /^\s*(?:async\s+)?def\s+(\w+)/.exec(code[j]);
          if (d) {
            handler = d[1];
            sigEnd = j;
            while (sigEnd < code.length - 1 && !/\)\s*(?:->[^:]*)?:\s*$/.test(code[sigEnd]) && sigEnd < j + 12) sigEnd++;
            break;
          }
        }
        let auth: RouteFact['auth'];
        let firstDecorator = i;
        while (firstDecorator > 0 && /^\s*@/.test(code[firstDecorator - 1])) firstDecorator--;
        for (let j = firstDecorator; j <= sigEnd; j++) {
          if (hasAuthHint(code[j])) {
            auth = { line: j + 1, snippet: snippet(raw[j]) };
            break;
          }
        }
        const prefix = routers.get(m[1]) ?? '';
        push({ line: i + 1, kind: 'api', method, path: joinRoute(prefix, m[3]), framework: st.tools.has('fastapi') ? 'fastapi' : st.tools.has('flask') ? 'flask' : 'python', source: 'decorator', handler, auth });
      });
      code.forEach((line, i) => {
        const inc = /([A-Za-z_]\w*)\.(?:include_router|register_blueprint)\s*\(\s*([\w.]+?)(?:\.(?:router|bp|blueprint))?\s*(?:,(.*))?\)?\s*$/.exec(line);
        if (!inc || !routers.has(inc[1])) return;
        const literal = /(?:prefix|url_prefix)\s*=\s*["']([^"']*)["']/.exec(inc[3] ?? '')?.[1];
        const expr = literal === undefined ? /(?:prefix|url_prefix)\s*=\s*([\w.]+)/.exec(inc[3] ?? '')?.[1] : undefined;
        out.mounts.push({ file: path, line: i + 1, prefix: literal ?? (expr ? `\u0000${expr}` : ''), target: inc[2] });
      });
    }
    if (/(?:^|\/)urls\.py$/.test(path)) {
      code.forEach((line, i) => {
        const m = /\b(?:re_)?path\s*\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/.exec(line);
        if (m && m[2] !== 'include') push({ line: i + 1, kind: 'api', method: 'ANY', path: '/' + m[1].replace(/^\^|\$$/g, ''), framework: 'django', source: 'config', handler: m[2] });
      });
    }
    return;
  }

  if (lang === 'go') {
    code.forEach((line, i) => {
      const m = /\b([A-Za-z_]\w*)\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|Group)\s*\(\s*"([^"]*)"/.exec(line);
      if (!m || m[2] === 'Group') return;
      let routePath = m[3];
      let method: HttpMethod = asMethod(m[2]);
      const pm = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/.*)$/.exec(routePath);
      if (pm) {
        method = pm[1] as HttpMethod;
        routePath = pm[2];
      }
      if (!routePath.startsWith('/')) return;
      push({ line: i + 1, kind: 'api', method, path: routePath, framework: ['gin', 'echo', 'fiber', 'chi', 'gorilla-mux'].find((t) => st.tools.has(t)) ?? 'net/http', source: 'router-call', auth: hasAuthHint(line.slice(m.index + m[0].length)) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined });
    });
    return;
  }

  if (lang === 'java') {
    let prefix = '';
    code.forEach((line, i) => {
      const cls = /@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"/.exec(line);
      const next = code.slice(i + 1, i + 4).join(' ');
      if (cls && /\bclass\b/.test(next)) {
        prefix = cls[1];
        return;
      }
      const m = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b(?:\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)")?/.exec(line);
      if (!m) return;
      const window = code.slice(Math.max(0, i - 3), i + 2).join(' ');
      push({ line: i + 1, kind: 'api', method: asMethod(m[1] === 'Request' ? 'ANY' : m[1]), path: joinRoute(prefix, m[2] ?? ''), framework: 'spring-boot', source: 'decorator', auth: hasAuthHint(window) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined });
    });
    return;
  }

  if (lang === 'ruby') {
    const routesFile = /(?:^|\/)config\/routes\.rb$/.test(path);
    code.forEach((line, i) => {
      const m = /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/.exec(line);
      if (m && (routesFile || /\bdo\s*(\|.*\|)?\s*$/.test(line))) push({ line: i + 1, kind: 'api', method: asMethod(m[1]), path: m[2].startsWith('/') ? m[2] : '/' + m[2], framework: routesFile ? 'rails' : 'sinatra', source: routesFile ? 'config' : 'router-call' });
      const r = routesFile ? /^\s*resources?\s+:(\w+)/.exec(line) : null;
      if (r) push({ line: i + 1, kind: 'api', method: 'ANY', path: '/' + r[1], framework: 'rails', source: 'config' });
    });
    return;
  }

  if (lang === 'php') {
    code.forEach((line, i) => {
      const m = /Route::(get|post|put|patch|delete|any)\s*\(\s*["']([^"']+)["']/.exec(line);
      if (m) push({ line: i + 1, kind: 'api', method: asMethod(m[1]), path: m[2].startsWith('/') ? m[2] : '/' + m[2], framework: 'laravel', source: 'router-call', auth: /middleware\s*\(\s*["']auth/.test(line) ? { line: i + 1, snippet: snippet(raw[i]) } : undefined });
    });
    return;
  }

  if (lang === 'rust') {
    code.forEach((line, i) => {
      const a = /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\s*\(/.exec(line);
      if (a) push({ line: i + 1, kind: 'api', method: asMethod(a[2]), path: a[1], framework: 'axum', source: 'router-call' });
      const b = /#\[(get|post|put|delete|patch)\s*\(\s*"([^"]+)"/.exec(line);
      if (b) push({ line: i + 1, kind: 'api', method: asMethod(b[1]), path: b[2], framework: 'actix', source: 'decorator' });
    });
    return;
  }

  if (lang === 'csharp') {
    code.forEach((line, i) => {
      const m = /\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/.exec(line) ?? /\[Http(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/.exec(line);
      if (m) push({ line: i + 1, kind: 'api', method: asMethod(m[1]), path: m[2].startsWith('/') ? m[2] : '/' + m[2], framework: 'aspnet', source: 'router-call' });
    });
  }
}

function joinRoute(prefix: string, p: string): string {
  const a = prefix.replace(/\/+$/, '');
  const b = p ? (p.startsWith('/') ? p : '/' + p) : '';
  return (a + b) || '/';
}

// --- Definitions ----------------------------------------------------------------------------------------------------------------------

const DEFINITIONS: { lang: SourceLanguage; re: RegExp; kind: DefinitionFact['kind']; tool?: string; needs?: string }[] = [
  { lang: 'js', re: /\bexpress\s*\(\s*\)/, kind: 'http-app', tool: 'express', needs: 'express' },
  { lang: 'js', re: /new\s+Hono\s*(?:<[^>]*>)?\s*\(/, kind: 'http-app', tool: 'hono', needs: 'hono' },
  { lang: 'js', re: /\b(?:Fastify|fastify)\s*\(\s*(?:\{|\))/, kind: 'http-app', tool: 'fastify', needs: 'fastify' },
  { lang: 'js', re: /new\s+Koa\s*\(/, kind: 'http-app', tool: 'koa', needs: 'koa' },
  { lang: 'js', re: /NestFactory\.create\s*\(/, kind: 'http-app', tool: 'nestjs', needs: 'nestjs' },
  { lang: 'js', re: /new\s+Elysia\s*\(/, kind: 'http-app', tool: 'elysia', needs: 'elysia' },
  { lang: 'js', re: /\bhttps?\.createServer\s*\(|Bun\.serve\s*\(/, kind: 'http-app' },
  { lang: 'js', re: /new\s+ApolloServer\s*\(|createYoga\s*\(|graphqlHTTP\s*\(/, kind: 'graphql-server', tool: 'graphql' },
  { lang: 'js', re: /new\s+grpc\.Server\s*\(/, kind: 'grpc-server', tool: 'grpc' },
  { lang: 'js', re: /new\s+WebSocketServer\s*\(|new\s+(?:SocketIOServer|Server)\s*\([^)]*(?:cors|httpServer|server)|\bio\.on\s*\(\s*["']connection["']/, kind: 'websocket-server' },
  { lang: 'js', re: /\bcron\.schedule\s*\(|@Cron\s*\(|new\s+CronJob\s*\(/, kind: 'scheduler' },
  { lang: 'js', re: /stripe\.webhooks\.constructEvent(?:Async)?\s*\(/, kind: 'webhook-handler', tool: 'stripe' },
  { lang: 'js', re: /new\s+Webhook\s*\([^)]*\)\s*;?\s*$|\.verify\s*\(\s*\w+\s*,\s*\{\s*["']svix-id["']/, kind: 'webhook-handler' },
  { lang: 'js', re: /new\s+Worker\s*(?:<[^>]*>)?\s*\(/, kind: 'queue-consumer', tool: 'bullmq', needs: 'bullmq' },
  { lang: 'python', re: /\bFastAPI\s*\(/, kind: 'http-app', tool: 'fastapi', needs: 'fastapi' },
  { lang: 'python', re: /\bFlask\s*\(\s*__name__/, kind: 'http-app', tool: 'flask', needs: 'flask' },
  { lang: 'python', re: /get_(?:wsgi|asgi)_application\s*\(/, kind: 'http-app', tool: 'django', needs: 'django' },
  { lang: 'python', re: /\bStarlette\s*\(/, kind: 'http-app', tool: 'starlette', needs: 'starlette' },
  { lang: 'python', re: /\bCelery\s*\(/, kind: 'worker-app', tool: 'celery', needs: 'celery' },
  { lang: 'python', re: /beat_schedule|crontab\s*\(/, kind: 'scheduler', tool: 'celery', needs: 'celery' },
  { lang: 'python', re: /\.add_job\s*\(|BackgroundScheduler\s*\(|AsyncIOScheduler\s*\(/, kind: 'scheduler' },
  { lang: 'python', re: /@dramatiq\.actor/, kind: 'task', tool: 'dramatiq', needs: 'dramatiq' },
  { lang: 'python', re: /stripe\.Webhook\.construct_event\s*\(/, kind: 'webhook-handler', tool: 'stripe' },
  { lang: 'python', re: /strawberry\.Schema\s*\(|graphene\.Schema\s*\(|GraphQLRouter\s*\(/, kind: 'graphql-server', tool: 'graphql' },
  { lang: 'python', re: /grpc\.(?:aio\.)?server\s*\(/, kind: 'grpc-server', tool: 'grpc' },
  { lang: 'python', re: /@\w+\.websocket\s*\(|websockets\.serve\s*\(/, kind: 'websocket-server' },
  { lang: 'go', re: /http\.ListenAndServe(?:TLS)?\s*\(/, kind: 'http-app' },
  { lang: 'go', re: /gin\.(?:Default|New)\s*\(\s*\)/, kind: 'http-app', tool: 'gin' },
  { lang: 'go', re: /echo\.New\s*\(\s*\)/, kind: 'http-app', tool: 'echo' },
  { lang: 'go', re: /fiber\.New\s*\(/, kind: 'http-app', tool: 'fiber' },
  { lang: 'go', re: /chi\.NewRouter\s*\(\s*\)/, kind: 'http-app', tool: 'chi' },
  { lang: 'go', re: /grpc\.NewServer\s*\(/, kind: 'grpc-server', tool: 'grpc' },
  { lang: 'java', re: /SpringApplication\.run\s*\(/, kind: 'http-app', tool: 'spring-boot' },
  { lang: 'java', re: /@KafkaListener\s*\(/, kind: 'topic-consumer', tool: 'kafka' },
  { lang: 'java', re: /@RabbitListener\s*\(/, kind: 'queue-consumer', tool: 'rabbitmq' },
  { lang: 'java', re: /@Scheduled\s*\(/, kind: 'scheduler' },
  { lang: 'ruby', re: /include\s+Sidekiq::(?:Worker|Job)/, kind: 'queue-consumer', tool: 'sidekiq' },
  { lang: 'ruby', re: /<\s*Sinatra::Base/, kind: 'http-app', tool: 'sinatra' },
  { lang: 'rust', re: /HttpServer::new\s*\(|axum::serve\s*\(|axum::Server::bind/, kind: 'http-app' },
  { lang: 'csharp', re: /WebApplication\.CreateBuilder\s*\(/, kind: 'http-app', tool: 'aspnet' },
];

function scanDefinitions(st: FileState, out: SourceScanOutput) {
  const { lang, path } = st.input;
  for (const def of DEFINITIONS) {
    if (def.lang !== lang) continue;
    if (def.needs && !st.tools.has(def.needs)) continue;
    st.code.forEach((line, i) => {
      const m = def.re.exec(line);
      if (!m) return;
      let name: string | undefined;
      if (def.kind === 'queue-consumer' && def.tool === 'bullmq') {
        const arg = firstArg(line, line.indexOf('(', m.index));
        name = /^["'`]([\w:.-]+)["'`]$/.exec(arg)?.[1] ?? st.constants.get(arg);
      }
      if (def.kind === 'worker-app' && def.tool === 'celery') name = /Celery\s*\(\s*["']([\w.-]+)["']/.exec(line)?.[1];
      out.definitions.push({ file: path, line: i + 1, kind: def.kind, tool: def.tool, name, snippet: snippet(st.raw[i]) });
    });
  }
  if (lang === 'js' && /(?:^|\/)(?:src\/)?middleware\.[jt]s$/.test(path) && /^(?:src\/)?middleware\.[jt]s$/.test(path)) {
    const i = st.code.findIndex((l) => /export\s+(?:default\s+)?(?:async\s+)?function|export\s+(?:default|const\s+middleware)|matcher\s*:/.test(l));
    out.definitions.push({ file: path, line: i >= 0 ? i + 1 : 1, kind: 'auth-middleware', tool: 'nextjs-middleware', snippet: snippet(st.raw[i >= 0 ? i : 0]) });
  }
  st.code.forEach((line, i) => {
    if (/\b(?:app|server)\.use\s*\(\s*(?:[\w.]*\b(?:authenticate|requireAuth|authMiddleware|auth|passport\.(?:initialize|session)|jwt|clerkMiddleware|verifyToken)\b)/.test(line)) {
      out.definitions.push({ file: path, line: i + 1, kind: 'auth-middleware', snippet: snippet(st.raw[i]) });
    }
  });
}

// --- Configuration lines ---------------------------------------------------------------------------------------------------------------

const URL_LITERAL = /["'`]?((?:postgres(?:ql)?(?:\+\w+)?|mysql(?:\+\w+)?|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|kafka|nats|memcached|neo4j|bolt|clickhouse|cassandra|sqlite(?:\+\w+)?):\/\/[^"'`\s,)]*)/;
const DIALECTS: Record<string, string> = {
  postgres: 'postgresql', postgresql: 'postgresql', pg: 'postgresql', 'postgresql_psycopg2': 'postgresql', cockroachdb: 'postgresql',
  mysql: 'mysql', mysql2: 'mysql', mariadb: 'mysql', trilogy: 'mysql', singlestore: 'mysql',
  sqlite: 'sqlite', sqlite3: 'sqlite', 'better-sqlite3': 'sqlite', 'better-sqlite': 'sqlite', turso: 'sqlite', libsql: 'sqlite', d1: 'sqlite',
  mongodb: 'mongodb', mssql: '', sqlserver: '', oracle: '', oracledb: '',
};

function scanConfigLines(path: string, code: string[], raw: string[], out: SourceScanOutput, tools: Map<string, number>) {
  const lowerPath = path.toLowerCase();
  code.forEach((line, i) => {
    if (!line.trim()) return;
    const at = { file: path, line: i + 1, snippet: snippet(raw[i]) };
    const url = URL_LITERAL.exec(line);
    const isBroker = /broker/i.test(line);
    const isBackend = /result_backend|backend\s*=|CELERY_RESULT_BACKEND/i.test(line);
    const via = /create_(?:async_)?engine|SQLALCHEMY/i.test(line) ? 'sqlalchemy' : /Celery\s*\(|broker|CELERY/i.test(line) ? 'celery' : /mongoose\.connect/.test(line) ? 'mongoose' : undefined;
    if (url) {
      const u = parseUrlish(url[1]);
      const tool = u ? toolForScheme(u.scheme) : undefined;
      if (tool) out.configs.push({ ...at, kind: isBroker ? 'broker' : isBackend ? 'result-backend' : 'url', tool: tool.id, via, host: u?.host });
    } else if ((isBroker || isBackend) && /Celery\s*\(|broker_url|CELERY_BROKER_URL|result_backend|CELERY_RESULT_BACKEND|conf\.update/i.test(line)) {
      const env = envInExpr(line);
      if (env) out.configs.push({ ...at, kind: isBroker ? 'broker' : 'result-backend', tool: '', via: 'celery', envVar: env });
    }
    if (/mongoose\.connect\s*\(/.test(line) && tools.has('mongoose')) out.configs.push({ ...at, kind: 'datasource', tool: 'mongodb', via: 'mongoose' });
    let m: RegExpExecArray | null;
    if ((m = /["']ENGINE["']\s*:\s*["']django\.db\.backends\.(\w+)["']/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'django-orm' });
    if ((m = /["']BACKEND["']\s*:\s*["'](django_redis\.cache\.RedisCache|django\.core\.cache\.backends\.redis\.RedisCache|django\.core\.cache\.backends\.memcached\.\w+)["']/.exec(line))) {
      out.configs.push({ ...at, kind: 'cache-backend', tool: m[1].includes('memcached') ? 'memcached' : 'redis', via: 'django' });
    }
    if (/drizzle\.config\.[cm]?[jt]s$/.test(lowerPath) && (m = /\b(?:dialect|driver)\s*:\s*["'`]([\w-]+)["'`]/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'drizzle' });
    if ((tools.has('knex') || /knexfile/.test(lowerPath)) && (m = /\bclient\s*:\s*["'`]([\w-]+)["'`]/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'knex' });
    if (tools.has('typeorm') && (m = /\btype\s*:\s*["'`]([\w-]+)["'`]/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'typeorm' });
    if (tools.has('sequelize') && (m = /\bdialect\s*:\s*["'`]([\w-]+)["'`]/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'sequelize' });
    if ((m = /spring\.datasource\.url\s*[=:]\s*jdbc:(\w+):|^\s*url\s*:\s*jdbc:(\w+):/.exec(line)) && DIALECTS[m[1] ?? m[2]]) out.configs.push({ ...at, kind: 'datasource', tool: DIALECTS[m[1] ?? m[2]], via: 'hibernate' });
    if (/spring\.(?:data\.)?redis\.(?:host|url)|^\s*redis\s*:\s*$/.test(line) && /application[-\w]*\.(?:properties|ya?ml)$/.test(lowerPath)) out.configs.push({ ...at, kind: 'url', tool: 'redis', via: 'spring-boot' });
    if (/spring\.kafka\.bootstrap-servers/.test(line)) out.configs.push({ ...at, kind: 'url', tool: 'kafka', via: 'spring-boot' });
    if (/spring\.rabbitmq\.host/.test(line)) out.configs.push({ ...at, kind: 'url', tool: 'rabbitmq', via: 'spring-boot' });
    if (/(?:^|\/)config\/database\.yml$/.test(lowerPath) && (m = /^\s*adapter\s*:\s*(\w+)/.exec(line)) && DIALECTS[m[1]]) out.configs.push({ ...at, kind: 'dialect', tool: DIALECTS[m[1]], via: 'active-record' });
    if (/(?:^|\/)config\/cable\.yml$/.test(lowerPath) && /^\s*adapter\s*:\s*redis/.test(line)) out.configs.push({ ...at, kind: 'url', tool: 'redis', via: 'rails' });
  });
}

function scanPrisma(path: string, code: string[], raw: string[], out: SourceScanOutput) {
  let inDatasource = false;
  code.forEach((line, i) => {
    if (/^\s*datasource\s+\w+\s*\{/.test(line)) inDatasource = true;
    else if (inDatasource && /^\s*\}/.test(line)) inDatasource = false;
    const m = inDatasource ? /^\s*provider\s*=\s*"(\w+)"/.exec(line) : null;
    if (m && DIALECTS[m[1]] !== undefined && DIALECTS[m[1]]) {
      const urlLine = code.findIndex((l, j) => j > i - 5 && j < i + 5 && /^\s*url\s*=\s*env\(\s*"(\w+)"/.test(l));
      out.configs.push({
        file: path,
        line: i + 1,
        kind: 'datasource',
        tool: DIALECTS[m[1]],
        via: 'prisma',
        envVar: urlLine >= 0 ? /env\(\s*"(\w+)"/.exec(code[urlLine])?.[1] : undefined,
        snippet: snippet(raw[i]),
      });
    }
  });
}

// --- Operations ----------------------------------------------------------------------------------------------------------------------

interface CompiledOps {
  re: RegExp;
  patterns: { test: RegExp; op: OpKind }[];
}
const opCache = new Map<string, CompiledOps | null>();

function compiledOps(tool: CatalogEntry, name: string): CompiledOps | null {
  const key = `${tool.id}\0${name}`;
  if (opCache.has(key)) return opCache.get(key)!;
  if (!tool.ops?.length) {
    opCache.set(key, null);
    return null;
  }
  const methods = tool.ops.map((o) => o.methods).join('|');
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}((?:\\??\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])*?)\\??\\.(${methods})\\s*\\(`, 'g');
  const compiled = { re, patterns: tool.ops.map((o) => ({ test: new RegExp(`^(?:${o.methods})$`), op: o.op })) };
  if (opCache.size > 5000) opCache.clear();
  opCache.set(key, compiled);
  return compiled;
}

function opArg(tool: string, op: OpKind, line: string, open: number, binding: Binding | undefined, st: FileState): string | undefined {
  const arg = firstArg(line, open);
  if (op === 'cache-write') {
    const ttl = /\b(?:ex|px|exat|pxat|EX|PX|timeout|ttl|expire|expiration|expiresIn)\s*[=:]|["'](?:EX|PX)["']|\bsetex\b|\bpsetex\b|\bexpire/i.test(line.slice(open));
    return ttl ? 'ttl' : undefined;
  }
  if (op === 'enqueue') return binding?.arg;
  if (op === 'publish' || op === 'consume') {
    const topic = /topics?\s*:\s*\[?\s*["'`]([\w.:-]+)["'`]/.exec(line.slice(open)) ?? /routing_key\s*=\s*["']([\w.:-]+)["']/.exec(line) ?? /queue\s*=\s*["']([\w.:-]+)["']/.exec(line);
    if (topic) return topic[1];
    const lit = /^\[?\s*["'`]([\w.:-]+)["'`]/.exec(arg);
    if (lit) return lit[1];
    if (st.constants.has(arg)) return st.constants.get(arg);
    return binding?.arg;
  }
  if (tool === 'kafka') return undefined;
  return undefined;
}

function scanOperations(st: FileState, out: SourceScanOutput, declared: Set<string>) {
  const { path, lang } = st.input;
  const push = (i: number, tool: string, op: OpKind, callee: string, via?: string, arg?: string) =>
    out.calls.push({ file: path, line: i + 1, tool, op, callee, via, snippet: snippet(st.raw[i]), arg });

  // Longest names first so `self.redis` wins over `redis`.
  const bindings = [...st.bindings].filter(([, b]) => !b.factory).sort((a, b) => b[0].length - a[0].length);
  st.code.forEach((line, i) => {
    if (!line.includes('(')) return;
    const claimed: [number, number][] = [];
    for (const [name, b] of bindings) {
      if (!line.includes(name)) continue;
      const tool = CATALOG_BY_ID.get(b.tool);
      if (!tool) continue;
      const ops = compiledOps(tool, name);
      if (!ops) continue;
      ops.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ops.re.exec(line))) {
        const start = m.index;
        if (claimed.some(([s, e]) => start >= s && start < e)) continue;
        claimed.push([start, start + m[0].length]);
        const method = m[2];
        const op = ops.patterns.find((p) => p.test.test(method))?.op;
        if (!op) continue;
        const open = start + m[0].length - 1;
        const callee = `${name}${m[1]}.${method}`;
        if (op === 'http') {
          const u = urlFromArg(firstArg(line, open));
          const base = b.arg && u.url?.startsWith('/') ? b.arg.replace(/\/$/, '') + u.url : u.url;
          const httpMethod = /^(get|post|put|patch|delete|head|options)$/i.test(method) ? asMethod(method) : undefined;
          out.httpCalls.push({ file: path, line: i + 1, client: tool.name, method: httpMethod, url: base, host: base ? withHost(base).host : undefined, envVar: u.envVar, snippet: snippet(st.raw[i]) });
        }
        push(i, b.tool, op, callee, b.via, opArg(b.tool, op, line, open, b, st));
      }
    }
  });

  // Receiver-less operations (Django ORM, AWS SDK commands, `sql` tagged templates…).
  for (const tool of CATALOG) {
    if (!tool.rawOps) continue;
    for (const raw of tool.rawOps) {
      if (raw.langs && !raw.langs.includes(lang)) continue;
      if (raw.scope === 'file' && !st.tools.has(tool.id)) continue;
      if (raw.scope === 'repo' && !declared.has(tool.id) && !st.tools.has(tool.id)) continue;
      st.code.forEach((line, i) => {
        const m = raw.re.exec(line);
        if (m) push(i, tool.id, raw.op, m[0].split('(')[0].replace(/^new\s+/, 'new ').trim());
      });
    }
  }

  // fetch() and friends: global HTTP clients with no import.
  if (lang === 'js') {
    const re = /(?<![\w$.])(fetch|\$fetch|ofetch|useFetch|useSWR)\s*\(/g;
    st.code.forEach((line, i) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const open = m.index + m[0].length - 1;
        const arg = firstArg(line, open);
        if (!arg) continue;
        const u = urlFromArg(arg);
        const method = /method\s*:\s*["'`](\w+)["'`]/.exec(line.slice(open))?.[1] ?? /method\s*:\s*["'`](\w+)["'`]/.exec(st.code.slice(i + 1, i + 5).join(' '))?.[1];
        out.httpCalls.push({ file: path, line: i + 1, client: m[1], method: method ? asMethod(method) : m[1] === 'useSWR' ? 'GET' : undefined, url: u.url, host: u.host, envVar: u.envVar, snippet: snippet(st.raw[i]), protocol: u.url && /\/graphql\b/.test(u.url) ? 'GraphQL' : undefined });
      }
    });
    // Streaming transports: EventSource is Server-Sent Events; WebSocket is its own protocol.
    st.code.forEach((line, i) => {
      const m = /(?<![\w$.])new\s+(EventSource|WebSocket)\s*\(/.exec(line);
      if (!m) return;
      const open = m.index + m[0].length - 1;
      let arg = firstArg(line, open);
      // `new EventSource(url)` with `const url = \`…\`` just above.
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          const def = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(arg)}\\s*=\\s*(.+?);?\\s*$`).exec(st.code[j]);
          if (def) {
            arg = def[1];
            break;
          }
        }
      }
      const u = urlFromArg(arg);
      out.httpCalls.push({ file: path, line: i + 1, client: m[1], method: 'GET', url: u.url, host: u.host, envVar: u.envVar, snippet: snippet(st.raw[i]), protocol: m[1] === 'EventSource' ? 'SSE' : 'WebSocket' });
    });
    // `client.post({ url: '/api/v1/items/' })` — request objects in generated or hand-written API clients.
    st.code.forEach((line, i) => {
      const u = /^\s*(?:url|path)\s*:\s*(["'`])(\/[^"'`]*)\1\s*,?\s*$/.exec(line);
      if (!u) return;
      for (let j = i; j >= Math.max(0, i - 8); j--) {
        const call = /\.(get|post|put|patch|delete|request)\s*(?:<[^>]*>)?\s*\(\s*\{?\s*$/.exec(st.code[j]) ?? /\.(get|post|put|patch|delete|request)\s*(?:<[^>]*>)?\s*\(\s*\{/.exec(st.code[j]);
        if (!call) continue;
        const method = call[1] === 'request' ? /method\s*:\s*["'`](\w+)["'`]/.exec(st.code.slice(j, i + 6).join(' '))?.[1] : call[1];
        out.httpCalls.push({ file: path, line: i + 1, client: 'API client', method: method ? asMethod(method) : undefined, url: u[2].replace(/\{[^}]*\}/g, ':param'), snippet: snippet(st.raw[i]) });
        break;
      }
    });
  } else if (lang === 'go') {
    st.code.forEach((line, i) => {
      const m = /\bhttp\.(Get|Post|Head|NewRequest(?:WithContext)?)\s*\(/.exec(line);
      if (!m) return;
      const open = m.index + m[0].length - 1;
      let arg = firstArg(line, open);
      if (m[1].startsWith('NewRequest')) {
        const parts = line.slice(open + 1).split(',').map((s) => s.trim());
        arg = parts[m[1] === 'NewRequestWithContext' ? 2 : 1] ?? '';
      }
      const u = urlFromArg(arg);
      out.httpCalls.push({ file: path, line: i + 1, client: 'net/http', method: m[1] === 'Get' ? 'GET' : m[1] === 'Post' ? 'POST' : undefined, url: u.url, host: u.host, envVar: u.envVar, snippet: snippet(st.raw[i]) });
    });
  }
}

function scanCeleryTasks(states: Map<string, FileState>, out: SourceScanOutput) {
  const tasksByFile = new Map<string, Set<string>>();
  for (const st of states.values()) {
    if (st.input.lang !== 'python') continue;
    const celeryApps = [...st.bindings].filter(([, b]) => b.tool === 'celery' && b.kind === 'client').map(([n]) => n);
    const decorator = new RegExp(`^\\s*@(?:(?:${celeryApps.map(escapeRegExp).join('|') || '(?!)'})\\.task|(?:celery\\.)?shared_task|app\\.task|celery_app\\.task|celery\\.task)\\b`);
    if (!celeryApps.length && !st.tools.has('celery')) continue;
    st.code.forEach((line, i) => {
      if (!decorator.test(line)) return;
      const explicit = /name\s*=\s*["']([\w.:-]+)["']/.exec(line)?.[1];
      for (let j = i + 1; j < Math.min(st.code.length, i + 6); j++) {
        const d = /^\s*(?:async\s+)?def\s+(\w+)/.exec(st.code[j]);
        if (!d) continue;
        if (!tasksByFile.has(st.input.path)) tasksByFile.set(st.input.path, new Set());
        tasksByFile.get(st.input.path)!.add(d[1]);
        out.definitions.push({ file: st.input.path, line: j + 1, kind: 'task', tool: 'celery', name: explicit ?? d[1], snippet: snippet(st.raw[j]) });
        break;
      }
    });
  }
  if (!tasksByFile.size) return;
  for (const st of states.values()) {
    if (st.input.lang !== 'python') continue;
    const visible = new Set<string>(tasksByFile.get(st.input.path) ?? []);
    for (const ib of st.internalBindings) {
      const tasks = tasksByFile.get(ib.target);
      if (!tasks) continue;
      for (const [symbol, local] of ib.symbols) if (tasks.has(symbol)) visible.add(local);
      if (ib.namespace) for (const t of tasks) visible.add(`${ib.namespace}.${t}`);
    }
    st.code.forEach((line, i) => {
      for (const t of visible) {
        const re = new RegExp(`(?<![\\w.])${escapeRegExp(t)}\\.(delay|apply_async|s|si|signature)\\s*\\(`);
        const m = re.exec(line);
        if (m) out.calls.push({ file: st.input.path, line: i + 1, tool: 'celery', op: 'enqueue', callee: `${t}.${m[1]}`, snippet: snippet(st.raw[i]), arg: t.split('.').pop() });
      }
      const send = /\.send_task\s*\(\s*["']([\w.:-]+)["']/.exec(line);
      if (send) out.calls.push({ file: st.input.path, line: i + 1, tool: 'celery', op: 'enqueue', callee: 'send_task', snippet: snippet(st.raw[i]), arg: send[1].split('.').pop() });
    });
  }
}

/**
 * Apply router mount prefixes (`app.use('/api', router)`, `include_router(r, prefix=…)`) to the
 * routes declared in mounted files, composing nested mounts (app → api router → items router).
 */
function applyMounts(states: Map<string, FileState>, out: SourceScanOutput) {
  if (!out.mounts.length) return;
  // Prefixes given as constants (`prefix=settings.API_V1_STR`) resolve through the files the mounting file imports.
  for (const mount of out.mounts) {
    if (!mount.prefix.startsWith('\u0000')) continue;
    const name = mount.prefix.slice(1).split('.').pop()!;
    const st = states.get(mount.file);
    const candidates = st ? [st, ...st.internalBindings.map((b) => states.get(b.target)).filter((x): x is FileState => !!x)] : [];
    const value = candidates.map((c) => c.constants.get(name)).find((v) => v !== undefined && v.startsWith('/'));
    mount.prefix = value ?? '';
  }
  const parents = new Map<string, { from: string; prefix: string }>();
  for (const mount of out.mounts) {
    const st = states.get(mount.file);
    if (!st) continue;
    const root = mount.target.split('.')[0];
    const ib = st.internalBindings.find((b) => b.namespace === root || [...b.symbols.values()].includes(root));
    if (!ib || ib.target === mount.file) continue;
    mount.target = ib.target;
    if (!parents.has(ib.target)) parents.set(ib.target, { from: mount.file, prefix: mount.prefix });
  }
  const effective = (file: string, seen = new Set<string>()): string => {
    const p = parents.get(file);
    if (!p || seen.has(file)) return '';
    seen.add(file);
    return joinRoute(effective(p.from, seen), p.prefix).replace(/^\/$/, '');
  };
  for (const r of out.routes) {
    if (r.source === 'file-convention' || r.framework === 'nestjs' || r.framework === 'django') continue;
    const prefix = effective(r.file);
    if (prefix && !r.path.startsWith(prefix + '/') && r.path !== prefix) r.path = joinRoute(prefix, r.path === '/' ? '' : r.path);
  }
}
