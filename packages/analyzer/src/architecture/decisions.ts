import { snippet } from './text.ts';
import type { DecisionFact, SourceLanguage } from './types.ts';

/*
 * Decision points in code: `if` statements and try/catch blocks whose branch leaves the function
 * early — a throw/raise, an error response, a redirect or an early return. Only those change what
 * the request does next, so only those become diamonds in a flowchart. Conditions are recorded as
 * written (redacted); the kind is read from the condition and the exit (status code, message),
 * never assumed.
 */

interface FileLines {
  path: string;
  lang: SourceLanguage;
  /** Comment-stripped lines. */
  code: string[];
  raw: string[];
}

const MAX_BLOCK = 14;
const MAX_PER_FILE = 300;

/** Balanced text between the parenthesis at `open` and its match, across up to 4 lines. */
function balanced(code: string[], line: number, open: number): { text: string; endLine: number; endCol: number } | null {
  let depth = 0;
  let text = '';
  for (let l = line; l < Math.min(code.length, line + 4); l++) {
    const s = code[l];
    for (let c = l === line ? open : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return { text: text.slice(1).trim(), endLine: l, endCol: c };
      }
      text += ch;
    }
    text += ' ';
  }
  return null;
}

/** Line index of the `}` closing the block opened on/after (line, col), within MAX_BLOCK lines. */
function closeBrace(code: string[], line: number, col: number): number | null {
  let depth = 0;
  let opened = false;
  for (let l = line; l < Math.min(code.length, line + MAX_BLOCK + 1); l++) {
    const s = code[l];
    for (let c = l === line ? col : 0; c < s.length; c++) {
      if (s[c] === '{') {
        depth++;
        opened = true;
      } else if (s[c] === '}') {
        depth--;
        if (opened && depth === 0) return l;
      }
    }
  }
  return null;
}

const STATUS_RE = [/\.(?:status|code)\(\s*(\d{3})\s*\)/, /status(?:_code)?\s*[:=]\s*(\d{3})/, /,\s*(\d{3})\s*\)\s*;?\s*$/, /\b(?:abort|HTTPException|HttpException|createError)\(\s*(?:status_code\s*=\s*)?(\d{3})/];

function exitOf(line: string): DecisionFact['exit'] | null {
  const t = line.trim();
  let kind: DecisionFact['exit']['kind'] | null = null;
  if (/^throw\b/.test(t) || /^raise\b/.test(t)) kind = 'throw';
  else if (/\bredirect\s*\(|\.redirect\(|RedirectResponse\(|NextResponse\.redirect/.test(t) && /^return\b|^\w+\.redirect|^res\.redirect|^reply\.redirect/.test(t)) kind = 'redirect';
  else if (/^return\b.*(\.status\(|\.code\(|\.json\(|\.send\(|Response\(|NextResponse\.|jsonify|abort\(|HTTPException)/.test(t) || /^(?:res|reply|response)\.(?:status|code|sendStatus)\(/.test(t) || /^abort\(/.test(t)) kind = 'respond';
  else if (/^return\b/.test(t)) kind = 'return';
  if (!kind) return null;
  let status: number | undefined;
  for (const re of STATUS_RE) {
    const m = re.exec(t);
    if (m && +m[1] >= 100 && +m[1] <= 599) {
      status = +m[1];
      break;
    }
  }
  // The longest string literal on the exit line is the message shown to the caller, when there is one.
  const strings = [...t.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).filter((s) => /\s/.test(s) || s.length > 12);
  const message = strings.sort((a, b) => b.length - a.length)[0];
  return { line: 0, kind, status, message: message ? message.slice(0, 120) : undefined, snippet: '' };
}

const KIND_BY_STATUS: Record<number, DecisionFact['kind']> = { 400: 'validation', 401: 'auth', 403: 'auth', 404: 'not-found', 409: 'conflict', 410: 'not-found', 412: 'validation', 413: 'limit', 422: 'validation', 429: 'limit' };

function classify(condition: string, exit: DecisionFact['exit']): DecisionFact['kind'] {
  if (exit.status && KIND_BY_STATUS[exit.status]) return KIND_BY_STATUS[exit.status];
  const c = condition;
  if (/cache|cached|\bhit\b/i.test(c) && exit.kind === 'return') return 'cache';
  if (/\b(user|session|auth\w*|token|logged\w*|role|permission|admin|owner|signed\w*|jwt|api_?key|credential\w*)\b/i.test(c)) return 'auth';
  if (/valid|\.parse\(|safeParse|schema|typeof|\.length|required|missing|empty|\.test\(|\.match\(|isNaN|Number\.is/i.test(c)) return 'validation';
  if (/feature|flag|enabled|process\.env|settings\.|config\./i.test(c)) return 'flag';
  if (/\b(limit|quota|stock|max\w*|min\w*|exceed\w*|remaining|balance)\b/i.test(c)) return 'limit';
  if (/exists|already|duplicate|conflict/i.test(c)) return 'conflict';
  if (exit.message && /not found|does not exist|no such/i.test(exit.message)) return 'not-found';
  return 'condition';
}

export function scanDecisions(f: FileLines, out: DecisionFact[]) {
  if (f.lang !== 'js' && f.lang !== 'python') return;
  const start = out.length;
  const push = (d: DecisionFact) => {
    if (out.length - start < MAX_PER_FILE) out.push(d);
  };
  const { code, raw } = f;

  if (f.lang === 'js') {
    for (let i = 0; i < code.length; i++) {
      const s = code[i];
      // if (...) — the branch is a block or a single statement.
      const m = /(^|[^\w$.])if\s*\(/.exec(s);
      if (m && !/\belse\s+if\b/.test(s.slice(0, m.index + m[0].length))) {
        const open = s.indexOf('(', m.index + m[1].length);
        const cond = balanced(code, i, open);
        if (cond) {
          const after = code[cond.endLine].slice(cond.endCol + 1);
          let body: { line: number; text: string }[] = [];
          let blockEnd = cond.endLine;
          if (/^\s*\{/.test(after)) {
            const close = closeBrace(code, cond.endLine, cond.endCol + 1);
            if (close !== null) {
              blockEnd = close;
              body = code.slice(cond.endLine, close + 1).map((text, k) => ({ line: cond.endLine + k, text: k === 0 ? after.replace(/^\s*\{/, '') : text }));
            }
          } else if (after.trim()) body = [{ line: cond.endLine, text: after }];
          else if (code[cond.endLine + 1]) {
            body = [{ line: cond.endLine + 1, text: code[cond.endLine + 1] }];
            blockEnd = cond.endLine + 1;
          }
          // The exit must be in the branch itself, not in a nested function or loop.
          const exitLine = body.find((b) => exitOf(b.text) && !/=>|function\b|\bfor\b|\bwhile\b/.test(b.text.split(/\b(?:return|throw)\b/)[0]));
          const exit = exitLine ? exitOf(exitLine.text) : null;
          if (exit && cond.text.length > 0) {
            exit.line = exitLine!.line + 1;
            exit.snippet = snippet(raw[exitLine!.line]);
            const condition = cond.text.replace(/\s+/g, ' ').slice(0, 120);
            push({ file: f.path, line: i + 1, endLine: blockEnd + 1, via: 'if', kind: classify(condition, exit), condition: snippet(condition, 120), negative: /^\s*!(?!=)/.test(condition) || /===?\s*(?:null|undefined)\b/.test(condition), exit, snippet: snippet(raw[i]) });
          }
        }
      }
      // try { … } catch (e) { … } — the catch branch decides what a failure does.
      if (/(^|[^\w$.])try\s*\{/.test(s)) {
        for (let l = i + 1; l < Math.min(code.length, i + 80); l++) {
          const c = /\}\s*catch\s*(?:\(([^)]*)\))?\s*\{/.exec(code[l]);
          if (!c) continue;
          const close = closeBrace(code, l, code[l].indexOf('{', c.index + 1));
          const body = code.slice(l, (close ?? l + MAX_BLOCK) + 1);
          const exitIdx = body.findIndex((b, k) => (k === 0 ? exitOf(b.slice(b.indexOf('{', c.index + 1) + 1)) : exitOf(b)));
          const exitText = exitIdx >= 0 ? (exitIdx === 0 ? body[0].slice(body[0].indexOf('{', c.index + 1) + 1) : body[exitIdx]) : '';
          const exit = exitIdx >= 0 ? exitOf(exitText) : null;
          const swallowed = !exit;
          push({
            file: f.path,
            line: i + 1,
            endLine: (close ?? l) + 1,
            via: 'try',
            kind: 'error',
            condition: `throws (caught at line ${l + 1})`,
            negative: false,
            catchLine: l + 1,
            exit: exit ? { ...exit, line: l + exitIdx + 1, snippet: snippet(raw[l + exitIdx]) } : { line: l + 1, kind: 'continue', snippet: snippet(raw[l]), message: undefined, status: undefined },
            swallowed,
            snippet: snippet(raw[i]),
          });
          break;
        }
      }
    }
    return;
  }

  // Python
  const indent = (s: string) => /^\s*/.exec(s)![0].length;
  for (let i = 0; i < code.length; i++) {
    const s = code[i];
    const m = /^\s*(?:el)?if\s+(.+?):\s*(.*)$/.exec(s);
    if (m && !/^\s*elif\b/.test(s)) {
      const condition = m[1].trim();
      const inline = m[2].trim();
      const lines: number[] = [];
      if (inline) lines.push(i);
      else {
        const base = indent(s);
        for (let l = i + 1; l < Math.min(code.length, i + MAX_BLOCK + 1); l++) {
          if (!code[l].trim()) continue;
          if (indent(code[l]) <= base) break;
          lines.push(l);
        }
      }
      const exitL = lines.find((l) => exitOf(l === i && inline ? inline : code[l]));
      const exit = exitL !== undefined ? exitOf(exitL === i && inline ? inline : code[exitL]) : null;
      if (exit) {
        exit.line = exitL! + 1;
        exit.snippet = snippet(raw[exitL!]);
        push({ file: f.path, line: i + 1, endLine: (lines.at(-1) ?? i) + 1, via: 'if', kind: classify(condition, exit), condition: snippet(condition, 120), negative: /^not\s|\bis\s+None\b|==\s*None\b/.test(condition), exit, snippet: snippet(raw[i]) });
      }
    }
    if (/^\s*try\s*:\s*$/.test(s)) {
      const base = indent(s);
      for (let l = i + 1; l < Math.min(code.length, i + 80); l++) {
        if (code[l].trim() && indent(code[l]) < base) break;
        if (indent(code[l]) === base && /^\s*except\b/.test(code[l])) {
          const body: number[] = [];
          for (let k = l + 1; k < Math.min(code.length, l + MAX_BLOCK + 1); k++) {
            if (!code[k].trim()) continue;
            if (indent(code[k]) <= base) break;
            body.push(k);
          }
          const exitL = body.find((k) => exitOf(code[k]));
          const exit = exitL !== undefined ? exitOf(code[exitL]) : null;
          push({
            file: f.path,
            line: i + 1,
            endLine: (body.at(-1) ?? l) + 1,
            via: 'try',
            kind: 'error',
            condition: `raises (handled at line ${l + 1})`,
            negative: false,
            catchLine: l + 1,
            exit: exit ? { ...exit, line: exitL! + 1, snippet: snippet(raw[exitL!]) } : { line: l + 1, kind: 'continue', snippet: snippet(raw[l]), message: undefined, status: undefined },
            swallowed: !exit,
            snippet: snippet(raw[i]),
          });
          break;
        }
      }
    }
  }
}
