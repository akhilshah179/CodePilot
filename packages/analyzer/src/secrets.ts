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
