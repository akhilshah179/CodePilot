import path from 'node:path';
import type { ClassificationEvidence, FileNodeType } from './types.ts';
import type { FileCategory } from './languages.ts';

export interface ContentFacts {
  directives: { value: string; line: number }[];
  hasJsx: boolean;
  exportedHttpMethods: string[];
  /** First line importing `express`/`koa`/`hono`/`fastify` router APIs, if any. */
  routerImportLine?: number;
  exportsCapitalized: boolean;
}

export interface Classification {
  type: FileNodeType;
  evidence: ClassificationEvidence[];
}

/** Next.js App Router special files that define route segments. */
const NEXT_SEGMENT_FILES = new Set(['layout', 'template', 'loading', 'error', 'not-found', 'default', 'global-error']);

/** Directory-name rules. The nearest (deepest) matching ancestor directory wins. */
const DIRECTORY_RULES: { names: string[]; type: FileNodeType; label: string }[] = [
  { names: ['api'], type: 'api', label: 'api' },
  { names: ['controllers', 'controller', 'handlers'], type: 'api', label: 'controllers' },
  { names: ['routes', 'router', 'routers'], type: 'route', label: 'routes' },
  { names: ['pages', 'views', 'screens'], type: 'page', label: 'pages' },
  { names: ['components', 'component', 'ui', 'widgets'], type: 'component', label: 'components' },
  { names: ['actions'], type: 'action', label: 'actions' },
  { names: ['services', 'service', 'repositories', 'repository', 'clients'], type: 'service', label: 'services' },
  { names: ['utils', 'util', 'utilities', 'helpers', 'helper', 'lib', 'libs', 'hooks'], type: 'utility', label: 'utilities' },
  { names: ['config', 'configs', 'configuration'], type: 'config', label: 'configuration' },
];

/** Filename-suffix rules such as `user.service.ts`. */
const SUFFIX_RULES: { re: RegExp; type: FileNodeType; label: string }[] = [
  { re: /\.(controller|handler)s?$/, type: 'api', label: '*.controller' },
  { re: /\.(routes?|router)$/, type: 'route', label: '*.routes / *.router' },
  { re: /\.page$/, type: 'page', label: '*.page' },
  { re: /\.component$/, type: 'component', label: '*.component' },
  { re: /\.actions?$/, type: 'action', label: '*.action' },
  { re: /\.(service|repository|client)$/, type: 'service', label: '*.service' },
  { re: /\.(utils?|helpers?)$/, type: 'utility', label: '*.util / *.helper' },
];

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__)\//;
const STORY_FILE = /\.stories\.[cm]?[jt]sx?$|\.stories\.mdx$/;

function ev(rule: string, detail: string, source: ClassificationEvidence['source'], line?: number): ClassificationEvidence {
  return line === undefined ? { rule, detail, source } : { rule, detail, source, line };
}

export function classifyFile(relPath: string, category: FileCategory, facts?: ContentFacts): Classification {
  const base = path.posix.basename(relPath);
  const stem = base.replace(/\.[^.]+$/, '');
  const segments = relPath.split('/').slice(0, -1);

  // 1. Configuration files by name.
  if (category === 'config') {
    return { type: 'config', evidence: [ev('path:config-file', `${base} is a configuration file`, 'path')] };
  }
  if (/\.config\.[cm]?[jt]s$/.test(base) || /^\.[a-z]+rc(\.[cm]?[jt]s|\.json)?$/.test(base)) {
    return { type: 'config', evidence: [ev('path:config-pattern', `${base} matches *.config.* / .*rc`, 'path')] };
  }

  // 2. Tests and stories are tooling entry points, not application layers.
  if (TEST_FILE.test(relPath)) return { type: 'other', evidence: [ev('path:test', 'Test file (*.test.*, *.spec.*, __tests__)', 'path')] };
  if (STORY_FILE.test(relPath)) return { type: 'other', evidence: [ev('path:story', 'Storybook story (*.stories.*)', 'path')] };

  if (category !== 'source') {
    return { type: 'other', evidence: [ev('path:non-source', `${category} file (${path.posix.extname(base) || base})`, 'path')] };
  }

  // 3. Framework filename conventions.
  const appIdx = segments.lastIndexOf('app');
  if (appIdx >= 0) {
    if (stem === 'page') return { type: 'page', evidence: [ev('path:next-app-page', 'app/**/page.* (Next.js App Router page)', 'path')] };
    if (stem === 'route') return { type: 'api', evidence: [ev('path:next-app-route', 'app/**/route.* (Next.js route handler)', 'path')] };
    if (NEXT_SEGMENT_FILES.has(stem)) return { type: 'route', evidence: [ev('path:next-app-segment', `app/**/${stem}.* (Next.js route segment)`, 'path')] };
  }
  if ((stem === 'middleware' || stem === 'proxy') && (segments.length === 0 || (segments.length === 1 && segments[0] === 'src'))) {
    return { type: 'route', evidence: [ev('path:middleware', `${base} at the project root (request middleware)`, 'path')] };
  }
  const pagesIdx = segments.lastIndexOf('pages');
  if (pagesIdx >= 0 && segments[pagesIdx + 1] === 'api') {
    return { type: 'api', evidence: [ev('path:pages-api', 'pages/api/** (API route)', 'path')] };
  }

  for (const rule of SUFFIX_RULES) {
    if (rule.re.test(stem)) return { type: rule.type, evidence: [ev(`path:suffix-${rule.type}`, `File name matches ${rule.label}`, 'path')] };
  }

  // 4. Nearest ancestor directory.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].toLowerCase();
    const rule = DIRECTORY_RULES.find((r) => r.names.includes(seg));
    if (rule) {
      const dirPath = segments.slice(0, i + 1).join('/');
      return { type: rule.type, evidence: [ev(`path:dir-${rule.type}`, `Inside ${dirPath}/ (${rule.label} directory)`, 'path')] };
    }
  }

  // 5. Source-content fallback.
  if (facts) {
    const useServer = facts.directives.find((d) => d.value === 'use server');
    if (useServer) return { type: 'action', evidence: [ev('content:use-server', "'use server' directive (server actions)", 'content', useServer.line)] };
    if (facts.exportedHttpMethods.length) {
      return { type: 'api', evidence: [ev('content:http-handlers', `Exports HTTP method handlers: ${[...new Set(facts.exportedHttpMethods)].join(', ')}`, 'content')] };
    }
    if (facts.routerImportLine) {
      return { type: 'route', evidence: [ev('content:router', 'Imports a server router (express/koa/hono/fastify)', 'content', facts.routerImportLine)] };
    }
    const useClient = facts.directives.find((d) => d.value === 'use client');
    if (facts.hasJsx && (useClient || facts.exportsCapitalized)) {
      return {
        type: 'component',
        evidence: [ev('content:jsx-component', useClient ? "'use client' module that renders JSX" : 'Renders JSX and exports a capitalized component', 'content', useClient?.line)],
      };
    }
  }

  return { type: 'other', evidence: [ev('default:other', 'No path or content rule matched', 'default')] };
}
