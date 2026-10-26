/*
 * Symbol outline for the Code tab: functions, classes, methods and types with the line they are
 * declared on. Pattern-based and line-oriented, per language family; a language without patterns
 * reports `supported: false` instead of an empty (misleading) outline.
 */

export type OutlineKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'struct' | 'trait' | 'module' | 'component' | 'heading';

export interface OutlineSymbol {
  name: string;
  kind: OutlineKind;
  /** 1-based declaration line. */
  line: number;
  /** Nesting: 0 for top level, 1 for a member of a class, … */
  depth: number;
}

export interface Outline {
  supported: boolean;
  symbols: OutlineSymbol[];
}

const JS_FAMILY = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro', 'mdx']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'typeof', 'await', 'super', 'constructor', 'sizeof', 'elif', 'when', 'match', 'using', 'lock', 'foreach', 'fixed']);

/** Remove string literals and line comments so braces inside them are not counted. */
function stripLine(line: string, lineComment: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (line.startsWith(lineComment, i)) break;
    out += c;
  }
  return out;
}

/**
 * Brace-scoped languages. Symbols are recorded at the top level and directly inside a class-like
 * body; locals inside function bodies are not part of the outline. A declaration opens a scope once
 * its `{` is seen (signatures may span lines) and closes when the depth returns.
 */
function braceOutline(text: string, match: (line: string, inClass: boolean) => { name: string; kind: OutlineKind; scope: boolean } | null, lineComment = '//'): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const scopes: { depth: number; isClass: boolean; opened: boolean; since: number }[] = [];
  let depth = 0;
  let paren = 0;
  let inBlockComment = false;
  const lines = text.split('\n');
  const closeFinished = () => {
    while (scopes.length) {
      const t = scopes[scopes.length - 1];
      if ((t.opened && depth <= t.depth) || (!t.opened && depth < t.depth)) scopes.pop();
      else break;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const start = line.indexOf('/*');
    if (start >= 0 && line.indexOf('*/', start + 2) < 0) {
      line = line.slice(0, start);
      inBlockComment = true;
    }
    // A declaration whose body never opened (a one-line arrow, an abstract method) is dropped.
    while (scopes.length && !scopes[scopes.length - 1].opened && i - scopes[scopes.length - 1].since > 6) scopes.pop();
    const top = scopes[scopes.length - 1];
    const inClass = !!top && top.opened && top.isClass && depth === top.depth + 1;
    const allowed = !top || inClass;
    const m = allowed ? match(line, inClass) : null;
    if (m && !CONTROL.has(m.name)) {
      out.push({ name: m.name, kind: m.kind, line: i + 1, depth: scopes.length });
      if (m.scope) scopes.push({ depth, isClass: m.kind === 'class' || m.kind === 'interface' || m.kind === 'struct' || m.kind === 'trait' || m.kind === 'enum' || m.kind === 'module', opened: false, since: i });
    }
    const code = stripLine(line, lineComment);
    for (const c of code) {
      if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      else if (c === '{') {
        depth++;
        // A brace inside a parameter list (a destructured or typed parameter) is not the body.
        if (!paren) for (const s of scopes) if (!s.opened && depth === s.depth + 1) s.opened = true;
      } else if (c === '}') {
        depth = Math.max(0, depth - 1);
        closeFinished();
      }
    }
    const last = scopes[scopes.length - 1];
    if (last && !last.opened && depth === last.depth && /;\s*$/.test(code)) scopes.pop();
  }
  return out;
}

const JS_PREFIX = String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?`;
const JS = {
  fn: new RegExp(JS_PREFIX + String.raw`(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)`),
  cls: new RegExp(JS_PREFIX + String.raw`class\s+([A-Za-z_$][\w$]*)`),
  iface: new RegExp(JS_PREFIX + String.raw`interface\s+([A-Za-z_$][\w$]*)`),
  type: new RegExp(JS_PREFIX + String.raw`type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=`),
  enm: new RegExp(JS_PREFIX + String.raw`(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)`),
  arrow: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:memo|forwardRef)\()/,
  method: /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/,
  field: /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>/,
};

function jsOutline(text: string): OutlineSymbol[] {
  return braceOutline(text, (line, inClass) => {
    let m: RegExpExecArray | null;
    if ((m = JS.cls.exec(line))) return { name: m[1], kind: 'class', scope: true };
    if ((m = JS.iface.exec(line))) return { name: m[1], kind: 'interface', scope: true };
    if ((m = JS.enm.exec(line))) return { name: m[1], kind: 'enum', scope: false };
    if ((m = JS.type.exec(line))) return { name: m[1], kind: 'type', scope: false };
    if ((m = JS.fn.exec(line))) return { name: m[1], kind: /^[A-Z]/.test(m[1]) ? 'component' : 'function', scope: true };
    if ((m = JS.arrow.exec(line))) return { name: m[1], kind: /^[A-Z]/.test(m[1]) ? 'component' : 'function', scope: true };
    if (inClass && ((m = JS.field.exec(line)) || (m = JS.method.exec(line)))) return { name: m[1], kind: 'method', scope: true };
    return null;
  });
}

function pythonOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const stack: { indent: number }[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!m) return;
    const indent = m[1].replace(/\t/g, '    ').length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentIsClass = stack.length > 0 && (stack[stack.length - 1] as { indent: number; cls?: boolean }).cls;
    out.push({ name: m[3], kind: m[2] === 'class' ? 'class' : parentIsClass ? 'method' : 'function', line: i + 1, depth: stack.length });
    stack.push({ indent, cls: m[2] === 'class' } as { indent: number });
  });
  return out;
}

function goOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  text.split('\n').forEach((line, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^func\s+\(([^)]*)\)\s*([A-Za-z_]\w*)/.exec(line))) {
      const recv = /\*?\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(m[1])?.[1];
      out.push({ name: recv ? `${recv}.${m[2]}` : m[2], kind: 'method', line: i + 1, depth: 0 });
    } else if ((m = /^func\s+([A-Za-z_]\w*)/.exec(line))) out.push({ name: m[1], kind: 'function', line: i + 1, depth: 0 });
    else if ((m = /^(?:type\s+|\t)([A-Z_a-z]\w*)\s+(?:\[[^\]]*\]\s*)?(struct|interface)\b/.exec(line))) out.push({ name: m[1], kind: m[2] === 'struct' ? 'struct' : 'interface', line: i + 1, depth: 0 });
    else if ((m = /^type\s+([A-Za-z_]\w*)\s+/.exec(line))) out.push({ name: m[1], kind: 'type', line: i + 1, depth: 0 });
  });
  return out;
}

function rustOutline(text: string): OutlineSymbol[] {
  const vis = String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?`;
  const fn = new RegExp(vis + String.raw`(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)`);
  const item = new RegExp(vis + String.raw`(struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)`);
  const impl = /^\s*impl(?:<[^>]*>)?\s+(?:([\w:<>, ]+?)\s+for\s+)?([\w:]+)/;
  const KIND: Record<string, OutlineKind> = { struct: 'struct', enum: 'enum', trait: 'trait', mod: 'module', type: 'type' };
  return braceOutline(text, (line, inClass) => {
    let m: RegExpExecArray | null;
    if ((m = impl.exec(line))) return { name: m[1] ? `${m[1].trim()} for ${m[2]}` : m[2], kind: 'module', scope: true };
    if ((m = item.exec(line))) return { name: m[2], kind: KIND[m[1]], scope: m[1] !== 'type' };
    if ((m = fn.exec(line))) return { name: m[1], kind: inClass ? 'method' : 'function', scope: true };
    return null;
  });
}

/** Java, Kotlin, C#, Swift, PHP, Scala, Dart and C/C++: classes plus declared functions. */
function curlyOutline(text: string, language: string): OutlineSymbol[] {
  const cls = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|export|inline|value|enum|annotation|fileprivate)\s+)*(class|interface|enum|record|struct|object|trait|protocol|extension|namespace)\s+([A-Za-z_]\w*)/;
  const keywordFn = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|open|suspend|inline|operator|async|mutating|fileprivate|class)\s+)*(?:fun|func|function|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/;
  const modifierFn = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|sealed|extern|unsafe|new)\s+)+(?:[\w<>[\],.?]+\s+)+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^;]*$/;
  const cFn = /^(?:[A-Za-z_][\w:<>,*&\s]*?[\s*&])([A-Za-z_][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/;
  const c = language === 'c' || language === 'cpp';
  return braceOutline(text, (line, inClass) => {
    let m: RegExpExecArray | null;
    if ((m = cls.exec(line))) return { name: m[2], kind: m[1] === 'interface' || m[1] === 'protocol' ? 'interface' : m[1] === 'enum' ? 'enum' : m[1] === 'struct' ? 'struct' : m[1] === 'trait' ? 'trait' : m[1] === 'namespace' ? 'module' : 'class', scope: true };
    if ((m = keywordFn.exec(line)) || (m = modifierFn.exec(line))) return { name: m[1], kind: inClass ? 'method' : 'function', scope: true };
    if (c && !/^\s/.test(line) && (m = cFn.exec(line)) && !/^(?:else|return|typedef)\b/.test(line)) return { name: m[1], kind: 'function', scope: true };
    return null;
  });
}

function rubyOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^(\s*)(class|module|def)\s+(?:self\.)?([A-Za-z_][\w:?!=]*)/.exec(line);
    if (m) out.push({ name: m[3], kind: m[2] === 'def' ? (m[1].length ? 'method' : 'function') : m[2] === 'module' ? 'module' : 'class', line: i + 1, depth: Math.floor(m[1].length / 2) });
  });
  return out;
}

function markdownOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ name: m[2], kind: 'heading', line: i + 1, depth: m[1].length - 1 });
  });
  return out;
}

const CURLY = new Set(['java', 'kotlin', 'csharp', 'swift', 'php', 'scala', 'dart', 'c', 'cpp', 'groovy', 'gradle']);

export function outlineOf(text: string, language: string): Outline {
  if (JS_FAMILY.has(language)) return { supported: true, symbols: jsOutline(text) };
  if (language === 'python') return { supported: true, symbols: pythonOutline(text) };
  if (language === 'go') return { supported: true, symbols: goOutline(text) };
  if (language === 'rust') return { supported: true, symbols: rustOutline(text) };
  if (language === 'ruby') return { supported: true, symbols: rubyOutline(text) };
  if (language === 'markdown') return { supported: true, symbols: markdownOutline(text) };
  if (CURLY.has(language)) return { supported: true, symbols: curlyOutline(text, language) };
  return { supported: false, symbols: [] };
}
