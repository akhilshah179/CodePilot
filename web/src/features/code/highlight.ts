/*
 * Syntax highlighting for the Code tab. Produces plain tokens per line ([kind, text]) that React
 * renders as text nodes — repository content is never turned into HTML. State carries across
 * lines (block comments, multi-line strings, markup tags), so a line can be rendered on its own
 * once the file is tokenized.
 */

export type TokenKind = '' | 'k' | 's' | 'c' | 'n' | 'f' | 't' | 'p' | 'x' | 'a' | 'm';
export type Token = [TokenKind, string];

/** The marker the server puts in place of a masked secret (kept in sync with the analyzer's MASK). */
export const MASK = '‹masked›';
/** Lines longer than this (minified code) are shown unhighlighted. */
const MAX_LINE = 4000;

interface StringRule {
  open: string;
  close: string;
  multiline: boolean;
}
interface Grammar {
  line: string[];
  block: [string, string][];
  strings: StringRule[];
  keywords: Set<string>;
  constants: Set<string>;
  /** Capitalised identifiers are types. */
  capitalTypes: boolean;
  /** Identifier characters beyond [A-Za-z0-9_]. */
  ident: RegExp;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const Q1: StringRule = { open: "'", close: "'", multiline: false };
const Q2: StringRule = { open: '"', close: '"', multiline: false };
const BT: StringRule = { open: '`', close: '`', multiline: true };
const ID = /[A-Za-z0-9_$]/;
const g = (p: Partial<Grammar>): Grammar => ({ line: [], block: [], strings: [Q2, Q1], keywords: new Set(), constants: words('true false null'), capitalTypes: false, ident: ID, ...p });

const JS_KW =
  'abstract as asserts async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof unique var void while with yield';
const C_LIKE_BLOCK: [string, string][] = [['/*', '*/']];

const GRAMMARS: Record<string, Grammar> = {
  js: g({ line: ['//'], block: C_LIKE_BLOCK, strings: [Q2, Q1, BT], keywords: words(JS_KW), constants: words('true false null undefined NaN Infinity'), capitalTypes: true }),
  python: g({
    line: ['#'],
    strings: [
      { open: '"""', close: '"""', multiline: true },
      { open: "'''", close: "'''", multiline: true },
      Q2,
      Q1,
    ],
    keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self cls'),
    constants: words('True False None'),
    capitalTypes: true,
  }),
  go: g({ line: ['//'], block: C_LIKE_BLOCK, strings: [Q2, Q1, BT], keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'), constants: words('true false nil iota'), capitalTypes: true }),
  rust: g({ line: ['//'], block: C_LIKE_BLOCK, strings: [Q2], keywords: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'), constants: words('true false None Some Ok Err'), capitalTypes: true }),
  java: g({ line: ['//'], block: C_LIKE_BLOCK, keywords: words('abstract assert break case catch class const continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public record return static super switch synchronized this throw throws transient try var void volatile while yield'), constants: words('true false null'), capitalTypes: true }),
  kotlin: g({ line: ['//'], block: C_LIKE_BLOCK, strings: [{ open: '"""', close: '"""', multiline: true }, Q2, Q1], keywords: words('as break class continue data do else enum false for fun if import in interface is lateinit object open override package private protected public return sealed super suspend this throw try typealias val var when while companion internal'), constants: words('true false null'), capitalTypes: true }),
  csharp: g({ line: ['//'], block: C_LIKE_BLOCK, keywords: words('abstract as async await base bool break case catch class const continue default delegate do else enum event explicit extern finally fixed for foreach get if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed set sizeof static struct switch this throw try typeof using var virtual void volatile while yield'), constants: words('true false null'), capitalTypes: true }),
  swift: g({ line: ['//'], block: C_LIKE_BLOCK, strings: [{ open: '"""', close: '"""', multiline: true }, Q2], keywords: words('actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate for func guard if import in init inout internal let mutating open operator private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws try typealias var where while'), constants: words('true false nil'), capitalTypes: true }),
  php: g({ line: ['//', '#'], block: C_LIKE_BLOCK, keywords: words('abstract and as break case catch class clone const continue declare default do echo else elseif enum extends final finally fn for foreach function global if implements include interface match namespace new or private protected public readonly require return static switch throw trait try use var while yield'), constants: words('true false null TRUE FALSE NULL'), capitalTypes: true, ident: /[A-Za-z0-9_$]/ }),
  c: g({ line: ['//'], block: C_LIKE_BLOCK, keywords: words('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while #include #define #ifdef #ifndef #endif #if #else #pragma class namespace template typename public private protected virtual override new delete this using try catch throw nullptr constexpr auto bool'), constants: words('true false NULL nullptr'), capitalTypes: false, ident: /[A-Za-z0-9_#]/ }),
  ruby: g({ line: ['#'], keywords: words('alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor attr_reader private protected public'), constants: words('true false nil'), capitalTypes: true }),
  shell: g({ line: ['#'], keywords: words('if then else elif fi case esac for while until do done in function return export local readonly set unset source exit echo cd'), constants: words('true false') }),
  config: g({ line: ['#'], constants: words('true false null yes no on off True False') }),
  ini: g({ line: ['#', ';'], constants: words('true false yes no on off') }),
  dockerfile: g({ line: ['#'], keywords: words('FROM AS RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL') }),
  sql: g({ line: ['--'], block: C_LIKE_BLOCK, strings: [Q1, Q2], keywords: words('select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all exists in is null like begin commit rollback if returning with case when then else end default unique cascade integer text real blob varchar int boolean timestamp SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS DISTINCT UNION ALL EXISTS IN IS NULL LIKE BEGIN COMMIT ROLLBACK IF RETURNING WITH CASE WHEN THEN ELSE END DEFAULT UNIQUE CASCADE INTEGER TEXT REAL BLOB VARCHAR INT BOOLEAN TIMESTAMP NOT'), constants: words('true false TRUE FALSE') }),
  css: g({ line: [], block: C_LIKE_BLOCK, keywords: words('@media @import @keyframes @font-face @supports @layer @container @tailwind @apply @use @mixin @include @extend @if @else @each @function @return !important'), constants: words(''), ident: /[A-Za-z0-9_@!-]/ }),
  scss: g({ line: ['//'], block: C_LIKE_BLOCK, keywords: words('@media @import @keyframes @font-face @supports @layer @container @use @mixin @include @extend @if @else @each @function @return @forward !important'), constants: words(''), ident: /[A-Za-z0-9_@!$-]/ }),
  json: g({ strings: [Q2], constants: words('true false null') }),
  graphql: g({ line: ['#'], strings: [{ open: '"""', close: '"""', multiline: true }, Q2], keywords: words('query mutation subscription fragment on type interface union enum input scalar schema extend implements directive'), constants: words('true false null'), capitalTypes: true }),
  prisma: g({ line: ['//'], keywords: words('model enum datasource generator type view'), constants: words('true false null'), capitalTypes: true }),
  hcl: g({ line: ['#', '//'], block: C_LIKE_BLOCK, keywords: words('resource data variable output module provider locals terraform for in if'), constants: words('true false null') }),
  makefile: g({ line: ['#'], keywords: words('ifeq ifneq ifdef ifndef else endif include define endef export .PHONY') }),
};

const LANGUAGE_GRAMMAR: Record<string, string> = {
  typescript: 'js', tsx: 'js', javascript: 'js', jsx: 'js', mdx: 'js', astro: 'js',
  python: 'python', go: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', gradle: 'kotlin', groovy: 'java', scala: 'java', dart: 'java',
  csharp: 'csharp', swift: 'swift', php: 'php', c: 'c', cpp: 'c', ruby: 'ruby', shell: 'shell',
  yaml: 'config', toml: 'config', 'pip-requirements': 'config', procfile: 'config', caddyfile: 'config', nginx: 'config', conf: 'config', 'go-mod': 'go', properties: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', sql: 'sql', css: 'css', scss: 'scss', less: 'scss', json: 'json', graphql: 'graphql', prisma: 'prisma', hcl: 'hcl', makefile: 'makefile',
};
const MARKUP = new Set(['html', 'xml', 'svg', 'vue', 'svelte']);

/** Whether a language gets highlighting (otherwise it is shown as readable plain text). */
export function isHighlighted(language: string): boolean {
  return language in LANGUAGE_GRAMMAR || MARKUP.has(language) || language === 'markdown';
}

/** Split a token list so masked secrets are their own token. */
function withMasks(tokens: Token[]): Token[] {
  if (!tokens.some(([, t]) => t.includes(MASK))) return tokens;
  const out: Token[] = [];
  for (const [k, t] of tokens) {
    if (!t.includes(MASK)) {
      out.push([k, t]);
      continue;
    }
    t.split(MASK).forEach((part, i) => {
      if (i) out.push(['m', MASK]);
      if (part) out.push([k, part]);
    });
  }
  return out;
}

class Line {
  tokens: Token[] = [];
  push(kind: TokenKind, text: string) {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else this.tokens.push([kind, text]);
  }
}

const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;

function scanCode(lines: string[], gr: Grammar): Token[][] {
  let open: { close: string; kind: 'c' | 's'; escape: boolean } | null = null;
  return lines.map((text) => {
    const line = new Line();
    let i = 0;
    if (text.length > MAX_LINE) {
      line.push('', text);
      return line.tokens;
    }
    const closeAt = (from: number, close: string, escape: boolean): number => {
      for (let j = from; j < text.length; j++) {
        if (escape && text[j] === '\\') {
          j++;
          continue;
        }
        if (text.startsWith(close, j)) return j;
      }
      return -1;
    };
    if (open) {
      const end = closeAt(0, open.close, open.escape);
      if (end < 0) {
        line.push(open.kind, text);
        return line.tokens;
      }
      line.push(open.kind, text.slice(0, end + open.close.length));
      i = end + open.close.length;
      open = null;
    }
    outer: while (i < text.length) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t') {
        let j = i;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
        line.push('', text.slice(i, j));
        i = j;
        continue;
      }
      for (const lc of gr.line) {
        if (text.startsWith(lc, i)) {
          line.push('c', text.slice(i));
          break outer;
        }
      }
      for (const [b, e] of gr.block) {
        if (text.startsWith(b, i)) {
          const end = text.indexOf(e, i + b.length);
          if (end < 0) {
            line.push('c', text.slice(i));
            open = { close: e, kind: 'c', escape: false };
            break outer;
          }
          line.push('c', text.slice(i, end + e.length));
          i = end + e.length;
          continue outer;
        }
      }
      for (const s of gr.strings) {
        if (text.startsWith(s.open, i)) {
          const end = closeAt(i + s.open.length, s.close, true);
          if (end < 0) {
            line.push('s', text.slice(i));
            if (s.multiline) open = { close: s.close, kind: 's', escape: true };
            break outer;
          }
          line.push('s', text.slice(i, end + s.close.length));
          i = end + s.close.length;
          continue outer;
        }
      }
      if (/[\d.]/.test(ch) && !(i > 0 && gr.ident.test(text[i - 1]))) {
        const m = NUMBER.exec(text.slice(i, i + 64));
        if (m && m[0] !== '.') {
          line.push('n', m[0]);
          i += m[0].length;
          continue;
        }
      }
      if (gr.ident.test(ch)) {
        let j = i;
        while (j < text.length && gr.ident.test(text[j])) j++;
        const word = text.slice(i, j);
        let k = j;
        while (text[k] === ' ') k++;
        const kind: TokenKind = gr.keywords.has(word) ? 'k' : gr.constants.has(word) ? 'n' : text[k] === '(' ? 'f' : gr.capitalTypes && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word) ? 't' : '';
        line.push(kind, word);
        i = j;
        continue;
      }
      line.push('p', ch);
      i++;
    }
    return line.tokens;
  });
}

/** JSON keys are attributes: a string followed by a colon. */
function jsonKeys(lines: Token[][]): Token[][] {
  return lines.map((tokens) =>
    tokens.map((t, i) => {
      if (t[0] !== 's') return t;
      const next = tokens.slice(i + 1).find((n) => n[1].trim());
      return next && next[0] === 'p' && next[1].startsWith(':') ? (['a', t[1]] as Token) : t;
    }),
  );
}

function scanMarkup(lines: string[]): Token[][] {
  let mode: 'text' | 'tag' | 'comment' | 'value' = 'text';
  let quote = '';
  return lines.map((text) => {
    const line = new Line();
    if (text.length > MAX_LINE) {
      line.push('', text);
      return line.tokens;
    }
    let i = 0;
    while (i < text.length) {
      if (mode === 'comment') {
        const end = text.indexOf('-->', i);
        if (end < 0) {
          line.push('c', text.slice(i));
          break;
        }
        line.push('c', text.slice(i, end + 3));
        i = end + 3;
        mode = 'text';
      } else if (mode === 'value') {
        const end = text.indexOf(quote, i);
        if (end < 0) {
          line.push('s', text.slice(i));
          break;
        }
        line.push('s', text.slice(i, end + 1));
        i = end + 1;
        mode = 'tag';
      } else if (mode === 'text') {
        if (text.startsWith('<!--', i)) {
          mode = 'comment';
          continue;
        }
        const m = /^<\/?[A-Za-z!?][\w:.-]*/.exec(text.slice(i));
        if (m) {
          line.push('x', m[0]);
          i += m[0].length;
          mode = 'tag';
          continue;
        }
        const next = text.indexOf('<', i + 1);
        const end = next < 0 ? text.length : next;
        line.push('', text.slice(i, end));
        i = end;
      } else {
        const ch = text[i];
        if (text.startsWith('/>', i) || ch === '>') {
          const t = ch === '>' ? '>' : '/>';
          line.push('x', t);
          i += t.length;
          mode = 'text';
        } else if (ch === '"' || ch === "'") {
          quote = ch;
          mode = 'value';
          line.push('s', ch);
          i++;
        } else if (/\s/.test(ch)) {
          line.push('', ch);
          i++;
        } else if (ch === '=') {
          line.push('p', ch);
          i++;
        } else {
          const m = /^[^\s=>/"']+/.exec(text.slice(i));
          const w = m ? m[0] : ch;
          line.push('a', w);
          i += w.length;
        }
      }
    }
    return line.tokens;
  });
}

function scanMarkdown(lines: string[]): Token[][] {
  let fence = false;
  return lines.map((text) => {
    const line = new Line();
    if (/^\s*(```|~~~)/.test(text)) {
      fence = !fence;
      line.push('c', text);
      return line.tokens;
    }
    if (fence) {
      line.push('s', text);
      return line.tokens;
    }
    if (/^#{1,6}\s/.test(text)) {
      line.push('k', text);
      return line.tokens;
    }
    const lead = /^(\s*(?:[-*+]|\d+\.)\s+|\s*>\s?)/.exec(text);
    let rest = text;
    if (lead) {
      line.push('p', lead[0]);
      rest = text.slice(lead[0].length);
    }
    rest.split(/(`[^`]+`)/).forEach((part) => line.push(part.startsWith('`') && part.endsWith('`') && part.length > 1 ? 's' : '', part));
    return line.tokens;
  });
}

/** Tokens for every line of `text` (lines split on \n; a trailing \r is dropped). */
export function highlight(text: string, language: string): Token[][] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) lines.pop();
  let out: Token[][];
  if (MARKUP.has(language)) out = scanMarkup(lines);
  else if (language === 'markdown') out = scanMarkdown(lines);
  else if (LANGUAGE_GRAMMAR[language]) {
    out = scanCode(lines, GRAMMARS[LANGUAGE_GRAMMAR[language]]);
    if (language === 'json') out = jsonKeys(out);
  } else out = lines.map((l) => (l ? ([['', l]] as Token[]) : []));
  return out.map(withMasks);
}
