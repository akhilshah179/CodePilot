import { redactCredentials } from '../secrets.ts';
import type { SourceLanguage } from './types.ts';

/**
 * Text helpers for evidence extraction. Comment stripping keeps line numbers intact so every
 * reported line points at the real source line; snippets are always redacted.
 */

export type CommentStyle = 'c' | 'hash' | 'python' | 'none';

export function commentStyle(lang: SourceLanguage | 'yaml' | 'shell' | 'toml' | 'hcl' | 'dockerfile' | 'conf'): CommentStyle {
  switch (lang) {
    case 'python':
      return 'python';
    case 'ruby':
    case 'yaml':
    case 'shell':
    case 'toml':
    case 'dockerfile':
    case 'conf':
      return 'hash';
    case 'hcl':
    case 'php':
      return 'c'; // `#` comments in HCL/PHP are handled below as well
    default:
      return 'c';
  }
}

/** Can a `/` here start a regex literal (rather than divide)? Decided by what precedes it on the line. */
function isRegexStart(before: string): boolean {
  const t = before.trimEnd();
  if (!t) return true;
  if (/(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|yield|await)$/.test(t)) return true;
  return /[(,=:[!&|?{};+\-*%<>~^]$/.test(t);
}

/**
 * Blank out comments (and Python docstring bodies) while keeping string literals and line
 * breaks, so line-based patterns never match commented-out code.
 */
export function stripComments(text: string, style: CommentStyle, hashToo = false): string[] {
  if (style === 'none') return text.split('\n');
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = text.length;
  type Mode = 'code' | 'line' | 'block' | 'str' | 'tpl' | 'triple';
  let mode: Mode = 'code';
  let quote = '';
  const tplDepth: number[] = [];
  let braceDepth = 0;
  const hash = style === 'hash' || style === 'python' || hashToo;
  const cLike = style === 'c';

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      out.push(buf);
      buf = '';
      if (mode === 'line') mode = 'code';
      if (mode === 'str') mode = 'code'; // unterminated single-line string: recover
      i++;
      continue;
    }
    switch (mode) {
      case 'code':
        if (cLike && ch === '/' && next === '/') {
          mode = 'line';
          buf += '  ';
          i += 2;
          continue;
        }
        if (cLike && ch === '/' && next === '*') {
          mode = 'block';
          buf += '  ';
          i += 2;
          continue;
        }
        // Regex literals (`/["'`]/`) are copied through whole, so quotes inside them do not open strings.
        if (cLike && ch === '/' && isRegexStart(buf)) {
          let j = i + 1;
          let inClass = false;
          while (j < n && text[j] !== '\n') {
            const c = text[j];
            if (c === '\\') j += 2;
            else {
              if (c === '[') inClass = true;
              else if (c === ']') inClass = false;
              else if (c === '/' && !inClass) break;
              j++;
            }
          }
          if (j < n && text[j] === '/') {
            buf += text.slice(i, j + 1);
            i = j + 1;
            continue;
          }
        }
        if (hash && ch === '#' && !(style === 'c' && next === '[')) {
          mode = 'line';
          buf += ' ';
          i++;
          continue;
        }
        if (style === 'python' && (ch === '"' || ch === "'") && text.startsWith(ch.repeat(3), i)) {
          mode = 'triple';
          quote = ch.repeat(3);
          buf += quote;
          i += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          mode = 'str';
          quote = ch;
          buf += ch;
          i++;
          continue;
        }
        if (ch === '`' && cLike) {
          mode = 'tpl';
          buf += ch;
          i++;
          continue;
        }
        if (ch === '{') braceDepth++;
        if (ch === '}') {
          if (tplDepth.length && tplDepth[tplDepth.length - 1] === braceDepth) {
            tplDepth.pop();
            mode = 'tpl';
            buf += ch;
            i++;
            continue;
          }
          braceDepth--;
        }
        buf += ch;
        i++;
        continue;
      case 'line':
        buf += ' ';
        i++;
        continue;
      case 'block':
        if (ch === '*' && next === '/') {
          mode = 'code';
          buf += '  ';
          i += 2;
          continue;
        }
        buf += ' ';
        i++;
        continue;
      case 'str':
        if (ch === '\\') {
          buf += ch + (next === '\n' ? '' : (next ?? ''));
          i += next === '\n' ? 1 : 2;
          continue;
        }
        if (ch === quote) mode = 'code';
        buf += ch;
        i++;
        continue;
      case 'tpl':
        if (ch === '\\') {
          buf += ch + (next ?? '');
          i += 2;
          continue;
        }
        if (ch === '`') {
          mode = 'code';
          buf += ch;
          i++;
          continue;
        }
        if (ch === '$' && next === '{') {
          braceDepth++;
          tplDepth.push(braceDepth);
          mode = 'code';
          buf += '${';
          i += 2;
          continue;
        }
        buf += ch;
        i++;
        continue;
      case 'triple':
        if (text.startsWith(quote, i)) {
          mode = 'code';
          buf += quote;
          i += 3;
          continue;
        }
        buf += ' ';
        i++;
        continue;
    }
  }
  out.push(buf);
  return out;
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const SECRET_KEY = '[\\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credentials?|auth[_-]?key)[\\w.-]*';
const SECRET_QUOTED = new RegExp(`(["']?${SECRET_KEY}["']?\\s*[:=]\\s*)(["'])([^"'\\n]{3,})\\2`, 'gi');
const SECRET_BARE = new RegExp(`(^|[\\s,{(-])(${SECRET_KEY}\\s*[:=]\\s*)(?!["'$\\s{(=]|process\\.|os\\.|env\\b|ENV\\b|getenv|settings\\.|config\\.|(?:await|new|null|undefined|true|false|None|nil|this|self|function|async)\\b|[A-Za-z_$][\\w$.]*\\s*\\()([^\\s,;#)}]{3,})`, 'gi');
export const REDACTED = '‹redacted›';

/** One line of evidence: trimmed, credentials and secret-looking values removed, length-capped. */
export function snippet(line: string | undefined, max = 180): string {
  if (!line) return '';
  let s = line.trim().replace(/\s+/g, ' ');
  s = s.replace(URL_USERINFO, `$1${REDACTED}@`);
  s = redactCredentials(s, REDACTED);
  s = s.replace(SECRET_QUOTED, (_m, pre: string, q: string) => `${pre}${q}${REDACTED}${q}`);
  s = s.replace(SECRET_BARE, (_m, lead: string, pre: string) => `${lead}${pre}${REDACTED}`);
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** Is this env/config key the name of a secret? */
export function isSecretKey(key: string): boolean {
  return new RegExp(`^${SECRET_KEY}$`, 'i').test(key) && !/(?:_URL|_HOST|_PORT|_USER(?:NAME)?|_ID|_NAME|_REGION|_BUCKET|_PATH|_FILE)$/i.test(key);
}

/** 1-based line number for a character offset. */
export function lineAt(text: string, offset: number, lineStarts?: number[]): number {
  const starts = lineStarts ?? lineStartsOf(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** Parse a URL-ish string loosely; returns scheme and host without credentials. */
export function parseUrlish(value: string): { scheme: string; host?: string; port?: string; path?: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s,]+)?(?::(\d+))?([^?#\s]*)?/i.exec(value.trim());
  if (!m) return null;
  const host = m[2] && !m[2].includes('$') && !m[2].includes('{') ? m[2].toLowerCase() : undefined;
  return { scheme: m[1].toLowerCase(), host, port: m[3], path: m[4] || undefined };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Directory of a repo-relative path ('' at the root). */
export function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Join and normalize repo-relative paths; returns null when the result escapes the repository. */
export function joinPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
