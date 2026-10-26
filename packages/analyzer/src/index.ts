import path from 'node:path';
import { classifyFile, type ContentFacts } from './classifier.ts';
import { detectEntryPoints, detectFrameworks } from './entrypoints.ts';
import { canParse, parseSource, type ParseResult } from './parser/index.ts';
import { ModuleResolver, RepoFs } from './resolver/index.ts';
import { scanRepository, type ScannedFile } from './scanner.ts';
import { computeSummary } from './summary.ts';
import { extractArchitectureFacts } from './architecture/extract.ts';
import type { ArchitectureFacts } from './architecture/types.ts';
import type { JsParseInfo } from './architecture/source.ts';
import type {
  AnalysisProgress,
  AnalyzeOptions,
  DependencyGraph,
  FileFacts,
  GraphEdge,
  GraphNode,
} from './types.ts';

export * from './types.ts';
export { SCAN_POLICY } from './scanner.ts';
export { classifyFile } from './classifier.ts';
export { ModuleResolver, RepoFs } from './resolver/index.ts';
export { parseSource } from './parser/index.ts';
export { findCycles, computeSummary } from './summary.ts';
export * as architecture from './architecture/index.ts';

const ROUTER_MODULES = new Set(['express', '@koa/router', 'koa-router', 'hono', 'fastify', '@hono/node-server']);
const PARTIAL_BATCH = 150;

const tick = () => new Promise<void>((r) => setImmediate(r));

function topDirectory(p: string): string {
  const i = p.indexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/**
 * Analyze a checked-out repository at `root` and return its dependency graph.
 * The result contains only relationships extracted from source code.
 */
export async function analyzeRepository(root: string, opts: AnalyzeOptions = {}): Promise<DependencyGraph> {
  return (await analyze(root, opts, false)).graph;
}

/**
 * Analyze a repository and also extract architecture evidence (manifests, infrastructure,
 * source-level signals). Facts must be collected here: file contents are dropped afterwards.
 */
export async function analyzeRepositoryWithFacts(root: string, opts: AnalyzeOptions = {}): Promise<{ graph: DependencyGraph; facts: ArchitectureFacts }> {
  const r = await analyze(root, opts, true);
  return { graph: r.graph, facts: r.facts! };
}

async function analyze(root: string, opts: AnalyzeOptions, collectFacts: boolean): Promise<{ graph: DependencyGraph; facts?: ArchitectureFacts }> {
  const progress: AnalysisProgress = { stage: 'scanning', filesScanned: 0, nodesClassified: 0, edgesFound: 0 };
  const emit = () => opts.onProgress?.({ ...progress });
  emit();

  // 1. Scan
  const scan = await scanRepository(root, {
    ignore: opts.ignore,
    maxParseBytes: opts.maxParseBytes,
    maxFiles: opts.maxFiles,
    signal: opts.signal,
    onFile: (n) => {
      progress.filesScanned = n;
      emit();
    },
  });
  progress.filesScanned = scan.stats.filesScanned;
  const byPath = new Map<string, ScannedFile>(scan.files.map((f) => [f.path, f]));

  // 2. Parse + classify
  progress.stage = 'parsing';
  emit();
  const parsed = new Map<string, ParseResult>();
  const files: Record<string, FileFacts> = {};
  const nodes = new Map<string, GraphNode>();
  const html = new Map<string, string>();
  const shebangs = new Set<string>();
  let pendingNodes: GraphNode[] = [];

  const flushNodes = () => {
    if (pendingNodes.length) opts.onPartial?.({ nodes: pendingNodes, edges: [] });
    pendingNodes = [];
  };

  const makeFileNode = (f: ScannedFile, facts?: ContentFacts, parseResult?: ParseResult): GraphNode => {
    const { type, evidence } = classifyFile(f.path, f.category, facts);
    const analyzable = canParse(f.language);
    const node: GraphNode = {
      id: f.path,
      path: f.path,
      type,
      language: f.language,
      size: f.size,
      classification_evidence: evidence,
      directory: topDirectory(f.path),
      analyzed: analyzable && !!parseResult,
    };
    if (!node.analyzed) {
      node.not_analyzed_reason = f.tooLarge
        ? 'File is larger than the 1 MB parse limit.'
        : analyzable
          ? 'File could not be read.'
          : `Import extraction for ${f.language} files is not supported yet.`;
    }
    if (f.lines !== undefined) node.loc = f.lines;
    if (parseResult) node.complexity = parseResult.complexity;
    const flags: GraphNode['flags'] = {};
    if (f.secretsDetected) flags.secretsDetected = f.secretsDetected;
    if (parseResult?.parseErrorCount) flags.parseErrors = parseResult.parseErrorCount;
    if (Object.keys(flags).length) node.flags = flags;
    return node;
  };

  let i = 0;
  for (const f of scan.files) {
    opts.signal?.throwIfAborted();
    if (f.content !== undefined && f.content.startsWith('#!')) shebangs.add(f.path);
    if (f.language === 'html' && f.content !== undefined) html.set(f.path, f.content);
    if (f.importOnly) continue;

    let facts: ContentFacts | undefined;
    let result: ParseResult | undefined;
    if (canParse(f.language) && f.content !== undefined) {
      result = parseSource(f.content, f.path, f.language);
      parsed.set(f.path, result);
      files[f.path] = { exports: result.exports, diagnostics: result.diagnostics };
      const routerImport = result.imports.find((imp) => ROUTER_MODULES.has(imp.specifier) && (imp.symbols.includes('Router') || imp.specifier.includes('router') || imp.symbols.includes('Hono')));
      facts = {
        directives: result.directives,
        hasJsx: result.hasJsx,
        exportedHttpMethods: result.exportedHttpMethods,
        routerImportLine: routerImport?.line,
        exportsCapitalized: result.capitalizedExport,
      };
    }
    const node = makeFileNode(f, facts, result);
    nodes.set(node.id, node);
    pendingNodes.push(node);
    progress.nodesClassified++;
    if (++i % 25 === 0) {
      emit();
      await tick();
    }
    if (pendingNodes.length >= PARTIAL_BATCH) flushNodes();
  }
  flushNodes();
  emit();

  // 3. Resolve
  progress.stage = 'resolving';
  emit();
  const repoFs = new RepoFs(byPath.keys(), (p) => byPath.get(p)?.content, scan.excluded);
  const resolver = new ModuleResolver(repoFs);
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  let pendingEdges: GraphEdge[] = [];

  const flushEdges = () => {
    if (pendingEdges.length || pendingNodes.length) opts.onPartial?.({ nodes: pendingNodes, edges: pendingEdges });
    pendingEdges = [];
    pendingNodes = [];
  };

  const ensureNode = (id: string, make: () => GraphNode) => {
    if (!nodes.has(id)) {
      const n = make();
      nodes.set(id, n);
      pendingNodes.push(n);
    }
  };

  i = 0;
  for (const [source, result] of parsed) {
    opts.signal?.throwIfAborted();
    for (const imp of result.imports) {
      const r = resolver.resolve(source, imp.specifier);
      let target: string;
      const edge: Omit<GraphEdge, 'id' | 'target'> = {
        source,
        symbols: imp.symbols,
        kind: imp.kind,
        line: imp.line,
        resolved: r.status !== 'unresolved',
        specifier: imp.specifier,
        typeOnly: imp.typeOnly,
        external: r.status === 'external',
      };
      if (r.status === 'file') {
        target = r.target;
        edge.resolution = r.via;
        const f = byPath.get(r.target)!;
        // Assets/data files only become nodes when source code imports them.
        ensureNode(target, () => ({
          ...makeFileNode(f),
          type: 'other',
          classification_evidence: [{ rule: 'path:imported-file', detail: `${f.category} file (${f.language}) referenced by an import`, source: 'path' }],
          analyzed: false,
          not_analyzed_reason: `${f.language} file — included because source code imports it.`,
        }));
      } else if (r.status === 'external') {
        target = `ext:${r.packageName}`;
        edge.resolution = r.via;
        ensureNode(target, () => ({
          id: target,
          path: r.packageName,
          type: 'external',
          language: r.builtin ? 'builtin' : 'package',
          size: 0,
          classification_evidence: [{ rule: 'resolver:external', detail: r.builtin ? 'Runtime built-in module' : 'Bare specifier that is not a workspace package or path alias', source: 'default' }],
          directory: 'External dependencies',
          analyzed: false,
          flags: r.builtin ? { builtin: true } : undefined,
        }));
      } else {
        target = `unresolved:${r.key}`;
        edge.unresolved_reason = r.reason;
        ensureNode(target, () => ({
          id: target,
          path: r.key,
          type: 'unresolved',
          language: 'unknown',
          size: 0,
          classification_evidence: [{ rule: 'resolver:unresolved', detail: r.reason, source: 'default' }],
          directory: 'Unresolved',
          analyzed: false,
        }));
      }
      let id = `${source}->${target}@${imp.line}`;
      for (let n = 2; edgeIds.has(id); n++) id = `${source}->${target}@${imp.line}~${n}`;
      edgeIds.add(id);
      const full: GraphEdge = { id, target, ...edge };
      edges.push(full);
      pendingEdges.push(full);
      progress.edgesFound++;
    }
    if (pendingEdges.length >= PARTIAL_BATCH * 2) flushEdges();
    if (++i % 25 === 0) {
      emit();
      await tick();
    }
  }
  flushEdges();
  emit();

  // 4. Build graph
  progress.stage = 'building';
  emit();
  const frameworks = detectFrameworks(resolver.packages.manifests);
  const fileNodes = new Map([...nodes].filter(([, n]) => n.type !== 'external' && n.type !== 'unresolved'));
  const entryPoints = detectEntryPoints({ resolver, fileNodes, frameworks, html, shebangs });

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  edges.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.line - b.line || (a.target < b.target ? -1 : 1)));
  const summary = computeSummary(nodeList, edges, entryPoints);

  let facts: ArchitectureFacts | undefined;
  if (collectFacts) {
    const js = new Map<string, JsParseInfo>();
    for (const [p, r] of parsed) js.set(p, { imports: r.imports, directives: r.directives, exportedHttpMethods: r.exportedHttpMethods, exports: r.exports });
    facts = await extractArchitectureFacts({
      root,
      files: scan.files.map((f) => ({ path: f.path, language: f.language, category: f.category, content: f.content })),
      excluded: scan.excluded,
      js,
      edges,
      signal: opts.signal,
    });
  }

  // Drop file contents as soon as analysis is done.
  for (const f of scan.files) delete f.content;

  const graph: DependencyGraph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repository: opts.repository ?? { name: path.basename(root) },
    nodes: nodeList,
    edges,
    files,
    summary,
    scan: scan.stats,
    frameworks,
    warnings: [...new Set(resolver.warnings)],
  };
  return { graph, facts };
}
export { walkRepositoryFiles, STORE_EXCLUSION_TEXT, type RepoEntry, type StoreExclusion } from './repoFiles.ts';
export { outlineOf, type Outline, type OutlineSymbol, type OutlineKind } from './outline.ts';
export { maskSecrets, MASK } from './secrets.ts';
export { ANALYZABLE_LANGUAGES } from './languages.ts';
