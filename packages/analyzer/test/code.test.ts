import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outlineOf } from '../src/outline.ts';
import { walkRepositoryFiles, type RepoEntry } from '../src/repoFiles.ts';
import { MASK, maskSecrets } from '../src/secrets.ts';

// Fake credentials, assembled so the literal never appears in one piece in this file.
const GH = ['ghp', 'A'.repeat(36)].join('_');
const STRIPE = ['sk', 'live', '0123456789abcdefghijklmn'].join('_');

describe('secret masking for the Code tab', () => {
  it('masks credentials, secret-named values, URL passwords and JWTs without moving lines', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'s'.repeat(20)}`;
    const text = [
      `const token = '${GH}';`,
      `export const STRIPE_KEY = "${STRIPE}";`,
      'DATABASE_URL=postgres://app:Sup3rS3cret@db:5432/app',
      `API_KEY=AbC123xyz789Q`,
      `auth: "${jwt}"`,
      `client_secret: 'x9F2kLm0Qw'`,
      'const a = 1;',
    ].join('\n');
    const m = maskSecrets(text);
    expect(m.text).not.toContain(GH);
    expect(m.text).not.toContain(STRIPE);
    expect(m.text).not.toContain('Sup3rS3cret');
    expect(m.text).not.toContain('AbC123xyz789Q');
    expect(m.text).not.toContain(jwt);
    expect(m.text).not.toContain('x9F2kLm0Qw');
    expect(m.text.split('\n')).toHaveLength(7);
    expect(m.lines).toEqual([1, 2, 3, 4, 5, 6]);
    expect(m.text).toContain(`const token = '${MASK}';`);
    expect(m.text).toContain(`postgres://app:${MASK}@db:5432/app`);
    expect(m.text.split('\n')[6]).toBe('const a = 1;');
  });

  it('leaves code that only looks like an assignment to a secret name alone', () => {
    const text = [
      'file.secretsDetected = secrets.credentialCount;',
      "const SECRET_KEY = '[\\\\w.-]*(?:pass|secret|token)[\\\\w.-]*';",
      "const tokenName = 'session-cookie';",
      'password: z.string().min(8),',
      'const apiKey = process.env.API_KEY;',
      "const PASSWORD_PLACEHOLDER = '<your-password>';",
      'DATABASE_URL=postgres://app:${DB_PASSWORD}@db/app',
    ].join('\n');
    expect(maskSecrets(text)).toEqual({ text, count: 0, lines: [] });
  });
});

describe('outline', () => {
  it('lists TypeScript declarations with members nested under classes, and skips locals', () => {
    const ts = [
      'export interface User {',
      '  id: string;',
      '}',
      'export type Id = string;',
      'export enum Role { Admin, User }',
      'export class Store {',
      '  private items = new Map();',
      '  constructor(private db: Db) {}',
      '  async load(id: string): Promise<User> {',
      '    const local = () => 1;',
      '    return this.items.get(id);',
      '  }',
      '  save = (u: User) => {',
      '    return u;',
      '  };',
      '}',
      'export function helper({ a, b }: { a: number; b: number }) {',
      '  function inner() {}',
      '  return a + b;',
      '}',
      'export const Button = ({ label }: Props) => {',
      '  return label;',
      '};',
      'const add = (a: number, b: number) => a + b;',
    ].join('\n');
    expect(outlineOf(ts, 'typescript').symbols).toEqual([
      { name: 'User', kind: 'interface', line: 1, depth: 0 },
      { name: 'Id', kind: 'type', line: 4, depth: 0 },
      { name: 'Role', kind: 'enum', line: 5, depth: 0 },
      { name: 'Store', kind: 'class', line: 6, depth: 0 },
      { name: 'load', kind: 'method', line: 9, depth: 1 },
      { name: 'save', kind: 'method', line: 13, depth: 1 },
      { name: 'helper', kind: 'function', line: 17, depth: 0 },
      { name: 'Button', kind: 'component', line: 21, depth: 0 },
      { name: 'add', kind: 'function', line: 24, depth: 0 },
    ]);
  });

  it('covers Python, Go, Rust and Markdown, and says when a language has no outline', () => {
    expect(outlineOf('class A:\n    def m(self):\n        pass\n\ndef f():\n    pass\n', 'python').symbols).toEqual([
      { name: 'A', kind: 'class', line: 1, depth: 0 },
      { name: 'm', kind: 'method', line: 2, depth: 1 },
      { name: 'f', kind: 'function', line: 5, depth: 0 },
    ]);
    expect(outlineOf('package x\n\ntype S struct {\n}\n\nfunc (s *S) Run() {}\nfunc main() {}\n', 'go').symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['struct:S', 'method:S.Run', 'function:main']);
    expect(outlineOf('pub struct P {}\nimpl P {\n    pub fn new() -> Self { P {} }\n}\nfn main() {}\n', 'rust').symbols.map((s) => `${s.kind}:${s.name}:${s.depth}`)).toEqual(['struct:P:0', 'module:P:0', 'method:new:1', 'function:main:0']);
    expect(outlineOf('# Title\n\n```\n# not a heading\n```\n## Part\n', 'markdown').symbols).toEqual([
      { name: 'Title', kind: 'heading', line: 1, depth: 0 },
      { name: 'Part', kind: 'heading', line: 6, depth: 1 },
    ]);
    expect(outlineOf('{}', 'json')).toEqual({ supported: false, symbols: [] });
  });
});

describe('stored files', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'codepilot-files-'));
    const w = (p: string, c: string | Buffer) => {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), c);
    };
    w('src/a.ts', `export const KEY = '${STRIPE}';\n`);
    w('README', 'plain text\n');
    w('.env.local', `KEY=${STRIPE}\n`);
    w('id.pem', '-----BEGIN PRIVATE KEY-----\n');
    w('notes.txt', '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
    w('img/logo.png', Buffer.from([137, 80, 78, 71]));
    w('blob.dat', Buffer.from([1, 0, 2]));
    w('big.json', `"${'x'.repeat(1_000_001)}"`);
    w('yarn.lock', '');
    w('app.min.js', 'x');
    w('node_modules/x/index.js', 'x');
    w('dist/out.js', 'x');
    try {
      symlinkSync('/etc/passwd', path.join(root, 'link'));
    } catch {
      // Non-elevated symlinks on Windows throw EPERM
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('stores readable text with secrets masked and lists everything else with its reason', async () => {
    const out: RepoEntry[] = [];
    for await (const e of walkRepositoryFiles(root, { ignore: ['ignored'] })) out.push(e);
    const by = Object.fromEntries(out.map((e) => [e.path, e]));
    const expected = ['.env.local', 'README', 'app.min.js', 'big.json', 'blob.dat', 'dist', 'id.pem', 'img/logo.png', 'node_modules', 'notes.txt', 'src/a.ts', 'yarn.lock'];
    if (by.link) expected.push('link');
    expect(Object.keys(by).sort()).toEqual(expected.sort());
    const reason = (p: string) => (by[p].kind === 'excluded' ? by[p].reason : 'stored');
    expect(reason('.env.local')).toBe('secret-file');
    expect(reason('id.pem')).toBe('secret-file');
    expect(reason('notes.txt')).toBe('secret-content');
    expect(reason('img/logo.png')).toBe('binary');
    expect(reason('blob.dat')).toBe('binary');
    expect(reason('big.json')).toBe('too-large');
    expect(reason('yarn.lock')).toBe('lockfile');
    expect(reason('app.min.js')).toBe('generated');
    expect(reason('node_modules')).toBe('excluded-directory');
    expect(reason('dist')).toBe('excluded-directory');
    if (by.link) expect(reason('link')).toBe('symlink');
    const a = by['src/a.ts'];
    expect(a.kind === 'file' && a.content).toBe(`export const KEY = '${MASK}';\n`);
    expect(a.kind === 'file' && a.maskedLines).toEqual([1]);
    const readme = by.README;
    expect(readme.kind === 'file' && readme.language).toBe('text');
  });
});
