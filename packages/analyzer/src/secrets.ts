import path from 'node:path';

/**
 * Secret handling rules. Matching is used only to decide what to exclude or flag;
 * matched values are never returned, logged or stored.
 */

const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|jks|keystore|p8|ppk|gpg|asc|tfstate|tfvars)$/i,
  /\.tfstate\.backup$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|dockercfg|htpasswd|secrets)$/i,
  /^credentials(\.json|\.ya?ml)?$/i,
  /^service[-_]?account.*\.json$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];

export function isSecretFileName(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g,
];

export interface SecretScan {
  /** File is itself a private key and must be excluded entirely. */
  containsPrivateKey: boolean;
  /** Number of credential-shaped values found. */
  credentialCount: number;
}

export function scanForSecrets(text: string): SecretScan {
  const containsPrivateKey = PRIVATE_KEY_BLOCK.test(text);
  let credentialCount = 0;
  for (const re of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    while (re.exec(text)) credentialCount++;
  }
  return { containsPrivateKey, credentialCount };
}

/** Replace credential-shaped values with a marker. Used for every evidence snippet. */
export function redactCredentials(text: string, marker = '‹redacted›'): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, marker);
  }
  return out;
}

/** 1-based line numbers containing credential-shaped values (the values themselves are not returned). */
export function credentialLines(text: string): number[] {
  const lines = new Set<number>();
  for (const re of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let line = 1;
      for (let i = text.indexOf('\n'); i >= 0 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
      lines.add(line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/** What replaces a masked value in stored and served code. */
export const MASK = '‹masked›';

/*
 * Masking for code that is shown to people (the Code tab, its search and copy). Broader than the
 * credential patterns above: it also hides the value of an assignment whose name says it is a
 * secret, passwords in connection URLs and JWTs. Only the value is replaced, so lines, names and
 * structure stay readable and line numbers never move.
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|credential)[A-Za-z0-9_.-]*`;
const SECRET_ASSIGNMENT = new RegExp(String.raw`(\b${SECRET_NAME}["']?\s*(?::|=|:=|=>)\s*)(["'\`])([^"'\`\s]{8,})\2`, 'gi');
const SECRET_ENV_LINE = new RegExp(String.raw`^(\s*(?:export\s+)?${SECRET_NAME}\s*=\s*)([^\s"'#;]{8,})\s*$`, 'gim');
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]{3,})@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * A value that looks generated rather than a word, a placeholder or code: secrets do not contain
 * regex or expression punctuation, so patterns and expressions assigned to secret-named variables
 * stay readable.
 */
const secretLooking = (v: string) =>
  !/^[a-z]+(?:[-_.][a-z]+)*$/i.test(v) && !/^\$\{?[A-Z_]+\}?$/.test(v) && !/^<[^>]+>$/.test(v) && !/^x{6,}$/i.test(v) && !/[\\()[\]|*{}<>,;\s]/.test(v) && !v.includes(MASK);
/** An unquoted value (.env style) also needs letters and digits, and is not a member access like `a.b.c`. */
const bareSecretLooking = (v: string) => secretLooking(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v);

export interface MaskResult {
  text: string;
  /** Number of values replaced. */
  count: number;
  /** 1-based lines that had a value replaced. */
  lines: number[];
}

export function maskSecrets(text: string): MaskResult {
  const hits: { start: number; end: number }[] = [];
  const collect = (re: RegExp, group: (m: RegExpExecArray) => { start: number; end: number } | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const h = group(m);
      if (h) hits.push(h);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  for (const re of CREDENTIAL_PATTERNS) collect(re, (m) => ({ start: m.index, end: m.index + m[0].length }));
  collect(JWT, (m) => ({ start: m.index, end: m.index + m[0].length }));
  collect(SECRET_ASSIGNMENT, (m) => (secretLooking(m[3]) ? { start: m.index + m[1].length + 1, end: m.index + m[1].length + 1 + m[3].length } : null));
  collect(SECRET_ENV_LINE, (m) => (bareSecretLooking(m[2]) ? { start: m.index + m[1].length, end: m.index + m[1].length + m[2].length } : null));
  collect(URL_PASSWORD, (m) => (m[2] !== MASK && !/^\$\{?[A-Z_]+\}?$/.test(m[2]) ? { start: m.index + m[1].length, end: m.index + m[1].length + m[2].length } : null));
  if (!hits.length) return { text, count: 0, lines: [] };

  // Merge overlapping ranges, then rebuild the text once.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  let out = '';
  let at = 0;
  const lines = new Set<number>();
  let line = 1;
  let scanned = 0;
  for (const h of merged) {
    for (let i = text.indexOf('\n', scanned); i >= 0 && i < h.start; i = text.indexOf('\n', i + 1)) {
      line++;
      scanned = i + 1;
    }
    lines.add(line);
    out += text.slice(at, h.start) + MASK;
    at = h.end;
  }
  out += text.slice(at);
  return { text: out, count: merged.length, lines: [...lines].sort((a, b) => a - b) };
}
