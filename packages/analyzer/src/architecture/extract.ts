import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge } from '../types.ts';
import { toolsForPackage } from './catalog.ts';
import { emptyInfra, infraKind, parseCaddy, parseCi, parseCompose, parseDockerfile, parseHelmChart, parseKubernetes, parseNginx, parsePlatform, parseProcfile, parseServerless, parseTerraform } from './infra.ts';
import { isLockfile, manifestParser, parseLockfile } from './manifests.ts';
import { scanSources, sourceLanguage, type ConfigInput, type JsParseInfo, type SourceInput } from './source.ts';
import { ARCH_EXTRACTOR_VERSION, type ArchitectureFacts, type CiFact } from './types.ts';

export interface ExtractFile {
  path: string;
  language: string;
  category: string;
  content?: string;
}

export interface ExtractInput {
  /** Checkout root; lockfiles (excluded from the graph) are read from here. */
  root: string;
  files: ExtractFile[];
  /** Paths the scanner excluded, with the reason. Only lockfiles are read. */
  excluded: { path: string; reason: string }[];
  js: Map<string, JsParseInfo>;
  edges: GraphEdge[];
  signal?: AbortSignal;
}

const MAX_LOCKFILE_BYTES = 25 * 1024 * 1024;
const CONFIG_TEXT = /\.(ya?ml|properties|prisma|toml|ini|cfg|conf)$|(?:^|\/)appsettings[\w.-]*\.json$|(?:^|\/)(?:knexfile|drizzle\.config)\.[cm]?[jt]s$/i;
const CI_SYSTEMS: Record<string, CiFact['system']> = {
  'github-actions': 'github-actions',
  'gitlab-ci': 'gitlab-ci',
  circleci: 'circleci',
  'azure-pipelines': 'azure-pipelines',
  bitbucket: 'bitbucket',
  jenkins: 'jenkins',
  travis: 'travis',
};

/**
 * Stage 1 of architecture detection: read the checkout and record facts. Must run while file
 * contents are still in memory. Unreadable or malformed files become warnings, never failures.
 */
export async function extractArchitectureFacts(input: ExtractInput): Promise<ArchitectureFacts> {
  const facts: ArchitectureFacts = {
    version: ARCH_EXTRACTOR_VERSION,
    manifests: [],
    lockfiles: [],
    imports: [],
    internalImports: [],
    symbols: [],
    clients: [],
    calls: [],
    routes: [],
    mounts: [],
    httpCalls: [],
    uiTriggers: [],
    middleware: [],
    envRefs: [],
    definitions: [],
    configs: [],
    secrets: [],
    infra: emptyInfra(),
    languages: {},
    warnings: [],
  };
  const warn = (file: string, err: unknown) => facts.warnings.push({ file, message: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) });

  // Manifests
  for (const f of input.files) {
    const parser = manifestParser(f.path);
    if (!parser || f.content === undefined) continue;
    try {
      facts.manifests.push(parser(f.path, f.content));
    } catch (err) {
      warn(f.path, err);
    }
  }

  // Lockfiles are excluded from the dependency graph but pin the versions we report.
  for (const ex of input.excluded) {
    if (ex.reason !== 'lockfile' || !isLockfile(ex.path)) continue;
    input.signal?.throwIfAborted();
    try {
      const abs = path.join(input.root, ex.path);
      const stat = await fs.stat(abs);
      if (stat.size > MAX_LOCKFILE_BYTES) {
        warn(ex.path, new Error('Lockfile is larger than 25 MB; versions fall back to manifest constraints.'));
        continue;
      }
      facts.lockfiles.push(parseLockfile(ex.path, await fs.readFile(abs, 'utf8')));
    } catch (err) {
      warn(ex.path, err);
    }
  }

  const declared = new Set<string>();
  for (const m of facts.manifests) {
    for (const d of m.dependencies) for (const t of toolsForPackage(m.ecosystem, d.name)) declared.add(t.id);
  }

  // Infrastructure
  const infra = facts.infra;
  for (const f of input.files) {
    if (f.content === undefined) continue;
    const kind = infraKind(f.path);
    if (!kind) continue;
    try {
      switch (kind) {
        case 'compose':
          infra.compose.push(parseCompose(f.path, f.content));
          break;
        case 'dockerfile':
          infra.dockerfiles.push(parseDockerfile(f.path, f.content));
          break;
        case 'serverless':
          infra.serverless.push(parseServerless(f.path, f.content));
          break;
        case 'helm-chart':
          infra.helm.push(parseHelmChart(f.path, f.content));
          break;
        case 'terraform':
          parseTerraform(f.path, f.content, infra.terraform);
          break;
        case 'nginx':
          infra.proxies.push(...parseNginx(f.path, f.content));
          break;
        case 'caddy':
          infra.proxies.push(...parseCaddy(f.path, f.content));
          break;
        case 'procfile':
          infra.processes.push(...parseProcfile(f.path, f.content));
          break;
        case 'platform':
          infra.platforms.push(...parsePlatform(f.path, f.content));
          break;
        case 'yaml':
          infra.kubernetes.push(...parseKubernetes(f.path, f.content));
          break;
        default:
          infra.ci.push(parseCi(f.path, f.content, CI_SYSTEMS[kind]));
      }
    } catch (err) {
      warn(f.path, err);
    }
  }

  // Source files and configuration text
  const sources: SourceInput[] = [];
  const configs: ConfigInput[] = [];
  for (const f of input.files) {
    if (f.content === undefined) continue;
    const lang = sourceLanguage(f.language);
    if (lang && f.category === 'source') {
      sources.push({ path: f.path, lang, text: f.content, js: input.js.get(f.path) });
      facts.languages[f.language] = (facts.languages[f.language] ?? 0) + 1;
    } else if (CONFIG_TEXT.test(f.path)) {
      configs.push({ path: f.path, text: f.content });
    }
  }
  const goModules = facts.manifests.filter((m) => m.ecosystem === 'go' && m.name).map((m) => ({ dir: m.dir, module: m.name! }));
  const jsFiles = new Set(sources.filter((s) => s.lang === 'js').map((s) => s.path));
  const jsEdges = input.edges
    .filter((e) => e.resolved && !e.external && jsFiles.has(e.source))
    .map((e) => ({ source: e.source, target: e.target, line: e.line, specifier: e.specifier, symbols: e.symbols }));

  input.signal?.throwIfAborted();
  const scanned = scanSources({ sources, configs, repoFiles: new Set(input.files.map((f) => f.path)), jsEdges, goModules, declared });
  Object.assign(facts, scanned);
  return facts;
}
