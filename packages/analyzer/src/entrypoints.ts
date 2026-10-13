import path from 'node:path';
import type { ModuleResolver } from './resolver/index.ts';
import { conditionalTargets, type PackageJson } from './resolver/packages.ts';
import { joinRel } from './resolver/repoFs.ts';
import type { EntryPoint, GraphNode } from './types.ts';

const FRAMEWORK_PACKAGES: Record<string, string> = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  '@sveltejs/kit': 'SvelteKit',
  '@remix-run/react': 'Remix',
  '@remix-run/node': 'Remix',
  'react-router': 'React Router',
  astro: 'Astro',
  'expo-router': 'Expo Router',
  vite: 'Vite',
  'react-scripts': 'Create React App',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  hono: 'Hono',
  koa: 'Koa',
  '@nestjs/core': 'NestJS',
  electron: 'Electron',
};

export function detectFrameworks(manifests: Map<string, PackageJson>): string[] {
  const found = new Set<string>();
  for (const pkg of manifests.values()) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const name of Object.keys(deps)) {
      if (FRAMEWORK_PACKAGES[name]) found.add(FRAMEWORK_PACKAGES[name]);
    }
  }
  return [...found].sort();
}

export interface EntryInputs {
  resolver: ModuleResolver;
  fileNodes: Map<string, GraphNode>;
  frameworks: string[];
  /** Text of HTML files and the first line of every source file, keyed by path. */
  html: Map<string, string>;
  shebangs: Set<string>;
}

/**
 * Entry points are only reported with concrete evidence: a manifest field, an npm script
 * argument, an HTML script tag, a framework filename convention the repo actually uses,
 * or a tooling convention (tests, configs, shebang executables).
 */
export function detectEntryPoints(inputs: EntryInputs): EntryPoint[] {
  const { resolver, fileNodes, frameworks } = inputs;
  const reasons = new Map<string, Set<string>>();
  const add = (id: string, reason: string) => {
    if (!fileNodes.has(id)) return;
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id)!.add(reason);
  };

  for (const [dir, pkg] of resolver.packages.manifests) {
    const manifestPath = dir ? `${dir}/package.json` : 'package.json';
    const tryTarget = (target: string, reason: string) => {
      const hit = resolver.resolveFileOrDir(joinRel(dir, target), true, false);
      if (hit) add(hit.path, reason);
    };
    for (const field of ['main', 'module', 'source'] as const) {
      const v = pkg[field];
      if (typeof v === 'string') tryTarget(v, `"${field}" in ${manifestPath}`);
    }
    if (typeof pkg.bin === 'string') tryTarget(pkg.bin, `"bin" in ${manifestPath}`);
    else if (pkg.bin) for (const [name, t] of Object.entries(pkg.bin)) tryTarget(t, `"bin.${name}" in ${manifestPath}`);
    if (pkg.exports !== undefined) {
      const values = typeof pkg.exports === 'object' && pkg.exports && !Array.isArray(pkg.exports) ? Object.values(pkg.exports) : [pkg.exports];
      for (const v of values) for (const t of conditionalTargets(v)) tryTarget(t.target, `"exports" in ${manifestPath}`);
    }
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      for (const token of cmd.split(/[\s;&|()"'=]+/)) {
        if (!token || token.startsWith('-') || !/[./]/.test(token)) continue;
        const target = joinRel(dir, token);
        if (!target.startsWith('..') && resolver.fs.isFile(target)) add(target, `npm script "${name}" in ${manifestPath}`);
      }
    }
  }

  for (const [htmlPath, text] of inputs.html) {
    const htmlDir = path.posix.dirname(htmlPath) === '.' ? '' : path.posix.dirname(htmlPath);
    for (const m of text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const src = m[1];
      if (/^[a-z]+:\/\//i.test(src) || src.startsWith('//')) continue;
      const rel = src.startsWith('/') ? joinRel(htmlDir, '.' + src) : joinRel(htmlDir, src);
      const hit = resolver.resolveFileOrDir(rel, true, false);
      if (hit) add(hit.path, `<script src> in ${htmlPath}`);
    }
  }

  const uses = (name: string) => frameworks.includes(name);
  for (const node of fileNodes.values()) {
    const p = node.path;
    const rule = node.classification_evidence[0]?.rule ?? '';
    if (uses('Next.js')) {
      if (rule === 'path:next-app-page' || rule === 'path:next-app-route' || rule === 'path:next-app-segment' || rule === 'path:middleware') {
        add(p, 'Next.js file convention (loaded by the framework router)');
      }
      if (/(^|\/)app\/(.*\/)?(robots|sitemap|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[jt]sx?$/.test(p)) {
        add(p, 'Next.js metadata file convention');
      }
      if (/^(src\/)?instrumentation(-client)?\.[jt]s$/.test(p)) add(p, 'Next.js instrumentation convention');
      if (/(^|\/)pages\/(?!_)[^]*\.[jt]sx?$/.test(p) || /(^|\/)pages\/_(app|document|error)\.[jt]sx?$/.test(p)) {
        add(p, 'Next.js pages/ convention (loaded by the framework router)');
      }
    }
    if (uses('SvelteKit') && /(^|\/)src\/routes\/.*\+(page|layout|server|error)(\.server)?\.(svelte|[jt]s)$/.test(p)) add(p, 'SvelteKit route file convention');
    if (uses('SvelteKit') && /(^|\/)src\/hooks\.(server|client)\.[jt]s$/.test(p)) add(p, 'SvelteKit hooks convention');
    if (uses('Remix') && /(^|\/)app\/(root|entry\.(client|server))\.[jt]sx?$|(^|\/)app\/routes\//.test(p)) add(p, 'Remix route/entry convention');
    if (uses('Nuxt') && /(^|\/)(pages|layouts|middleware|plugins|server\/(api|routes|middleware))\//.test(p)) add(p, 'Nuxt directory convention');
    if (uses('Astro') && /(^|\/)src\/pages\//.test(p)) add(p, 'Astro pages convention');
    if (uses('Expo Router') && /(^|\/)app\//.test(p) && /\.[jt]sx?$/.test(p)) add(p, 'Expo Router app/ convention');
    if (rule === 'path:test') add(p, 'Test file (run by the test runner)');
    if (rule === 'path:story') add(p, 'Storybook story (loaded by Storybook)');
    if (rule === 'path:config-pattern') add(p, 'Tool configuration (loaded by tooling)');
    if (inputs.shebangs.has(p)) add(p, 'Executable script (#! shebang)');
  }

  return [...reasons.entries()]
    .map(([id, rs]) => ({ id, reasons: [...rs].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
