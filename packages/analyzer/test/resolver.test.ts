import { describe, expect, it } from 'vitest';
import { ModuleResolver, RepoFs } from '../src/resolver/index.ts';

function resolverFor(files: Record<string, string>, excluded: { path: string; reason: 'excluded-directory' | 'generated' }[] = []) {
  return new ModuleResolver(new RepoFs(Object.keys(files), (p) => files[p], excluded));
}

describe('ModuleResolver', () => {
  it('applies paths relative to baseUrl and inherits them through relative "extends"', () => {
    const r = resolverFor({
      'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { 'app/*': ['modules/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'src/modules/auth.ts': '',
      'src/lib/x.ts': '',
      'src/index.ts': '',
    });
    expect(r.resolve('src/index.ts', 'app/auth')).toMatchObject({ status: 'file', target: 'src/modules/auth.ts' });
    // baseUrl alone also resolves bare specifiers that match files.
    expect(r.resolve('src/index.ts', 'lib/x')).toMatchObject({ status: 'file', target: 'src/lib/x.ts' });
    // Bare specifiers that are not files fall through to packages.
    expect(r.resolve('src/index.ts', 'lodash/fp')).toMatchObject({ status: 'external', packageName: 'lodash' });
  });

  it('prefers the longest matching paths prefix and reports alias misses as unresolved', () => {
    const r = resolverFor({
      'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'], '@/ui/*': ['./design/*'] } } }),
      'src/a.js': '',
      'design/button.js': '',
    });
    expect(r.resolve('src/a.js', '@/ui/button')).toMatchObject({ status: 'file', target: 'design/button.js' });
    const miss = r.resolve('src/a.js', '@/missing');
    expect(miss.status).toBe('unresolved');
    expect(miss.status === 'unresolved' && miss.reason).toContain('"@/*"');
  });

  it('treats unmatched alias-looking specifiers as unresolved, not external', () => {
    const r = resolverFor({ 'src/a.ts': '' });
    expect(r.resolve('src/a.ts', '@/components/x').status).toBe('unresolved');
    expect(r.resolve('src/a.ts', '~/utils').status).toBe('unresolved');
  });

  it('handles builtins, URL imports, virtual modules and query suffixes', () => {
    const r = resolverFor({ 'a.ts': '', 'logo.svg': '' });
    expect(r.resolve('a.ts', 'fs/promises')).toMatchObject({ status: 'external', packageName: 'node:fs', builtin: true });
    expect(r.resolve('a.ts', 'node:crypto')).toMatchObject({ status: 'external', builtin: true });
    expect(r.resolve('a.ts', 'virtual:pwa-register').status).toBe('unresolved');
    expect(r.resolve('a.ts', './logo.svg?react')).toMatchObject({ status: 'file', target: 'logo.svg' });
  });

  it('refuses to resolve outside the repository or into excluded directories', () => {
    const r = resolverFor({ 'src/a.ts': '' }, [{ path: 'dist/', reason: 'excluded-directory' }]);
    expect(r.resolve('src/a.ts', '../../etc/passwd').status).toBe('unresolved');
    const dist = r.resolve('src/a.ts', '../dist/index.js');
    expect(dist.status === 'unresolved' && dist.reason).toContain('excluded directory dist/');
  });

  it('resolves pnpm workspace packages with exports subpath patterns', () => {
    const r = resolverFor({
      'pnpm-workspace.yaml': "packages:\n  - 'libs/*'\n  - '!libs/ignored'\n",
      'libs/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': './src/index.ts', './components/*': './src/components/*.tsx' } }),
      'libs/ui/src/index.ts': '',
      'libs/ui/src/components/Button.tsx': '',
      'libs/ignored/package.json': JSON.stringify({ name: '@acme/ignored', main: 'index.js' }),
      'libs/ignored/index.js': '',
      'app/main.ts': '',
    });
    expect(r.resolve('app/main.ts', '@acme/ui')).toMatchObject({ status: 'file', target: 'libs/ui/src/index.ts' });
    expect(r.resolve('app/main.ts', '@acme/ui/components/Button')).toMatchObject({ status: 'file', target: 'libs/ui/src/components/Button.tsx' });
    // Not a declared workspace member → treated as an external package.
    expect(r.resolve('app/main.ts', '@acme/ignored')).toMatchObject({ status: 'external' });
  });

  it('resolves workspace packages without exports through manifest fields', () => {
    const r = resolverFor({
      'package.json': JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
      'packages/core/package.json': JSON.stringify({ name: 'core', main: './lib/index.js', source: './src/index.ts' }),
      'packages/core/src/index.ts': '',
      'packages/core/src/deep/util.ts': '',
      'app.ts': '',
    });
    expect(r.resolve('app.ts', 'core')).toMatchObject({ status: 'file', target: 'packages/core/src/index.ts' });
    expect(r.resolve('app.ts', 'core/src/deep/util')).toMatchObject({ status: 'file', target: 'packages/core/src/deep/util.ts' });
  });

  it('uses JS-first extension order for JavaScript importers and TS-first for TypeScript importers', () => {
    const r = resolverFor({ 'a.js': '', 'a.ts': '', 'x.js': '', 'x.ts': '' });
    expect(r.resolve('x.js', './a')).toMatchObject({ target: 'a.js' });
    expect(r.resolve('x.ts', './a')).toMatchObject({ target: 'a.ts' });
  });
});
