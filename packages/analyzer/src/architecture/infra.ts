import { parse as parseToml } from 'smol-toml';
import { isMap, isPair, isScalar, isSeq, LineCounter, parseAllDocuments, type Document, type Node as YamlNode } from 'yaml';
import { dirOf, isSecretKey, lineAt, lineStartsOf, parseUrlish, snippet } from './text.ts';
import type {
  CiFact,
  CiStep,
  ComposeEnvVar,
  ComposeFact,
  ComposeService,
  DockerfileFact,
  InfraFacts,
  KubernetesObject,
  PlatformFact,
  ProxyFact,
  ServerlessFact,
  TerraformFact,
} from './types.ts';

/**
 * Infrastructure files: containers, orchestration, IaC, CI and hosting. YAML is parsed with a
 * line counter so each value keeps the line it was declared on; unreadable files throw and are
 * reported by the caller as warnings.
 */

export function emptyInfra(): InfraFacts {
  return {
    compose: [],
    dockerfiles: [],
    kubernetes: [],
    helm: [],
    terraform: { resources: [], providers: [], modules: [] },
    serverless: [],
    ci: [],
    proxies: [],
    platforms: [],
    processes: [],
  };
}

// --- YAML with line numbers -----------------------------------------------------------------------------

type Path = (string | number)[];

class YamlDoc {
  readonly js: any;
  constructor(
    private readonly doc: Document,
    private readonly lc: LineCounter,
  ) {
    this.js = doc.toJS({ maxAliasCount: 200 }) ?? {};
  }

  private nodeAt(path: Path): { node: YamlNode | null; line: number } {
    let node: unknown = this.doc.contents;
    let line = node && (node as YamlNode).range ? this.lc.linePos((node as YamlNode).range![0]).line : 1;
    for (const key of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === String(key));
        if (!pair) return { node: null, line };
        if (isScalar(pair.key) && pair.key.range) line = this.lc.linePos(pair.key.range[0]).line;
        node = pair.value;
      } else if (isSeq(node) && typeof key === 'number') {
        const item = node.items[key] as YamlNode | undefined;
        if (!item) return { node: null, line };
        if (item.range) line = this.lc.linePos(item.range[0]).line;
        node = item;
      } else {
        return { node: null, line };
      }
    }
    return { node: node as YamlNode, line };
  }

  /** Line of the key (or item) at `path`; the nearest resolvable ancestor's line otherwise. */
  line(path: Path): number {
    return this.nodeAt(path).line;
  }
}

function yamlDocs(text: string): YamlDoc[] {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: lc, merge: true, uniqueKeys: false, prettyErrors: false });
  const list = Array.isArray(docs) ? docs : [docs];
  const out: YamlDoc[] = [];
  for (const d of list) {
    if (d.errors.length) throw new Error(`YAML error: ${d.errors[0].message.split('\n')[0]}`);
    if (d.contents !== null) out.push(new YamlDoc(d, lc));
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// --- File classification -------------------------------------------------------------------------------------

export type InfraKind =
  | 'compose'
  | 'dockerfile'
  | 'github-actions'
  | 'gitlab-ci'
  | 'circleci'
  | 'azure-pipelines'
  | 'bitbucket'
  | 'jenkins'
  | 'travis'
  | 'serverless'
  | 'helm-chart'
  | 'terraform'
  | 'nginx'
  | 'caddy'
  | 'procfile'
  | 'platform'
  | 'yaml';

export function infraKind(file: string): InfraKind | undefined {
  const lower = file.toLowerCase();
  const b = lower.slice(lower.lastIndexOf('/') + 1);
  if (/^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/.test(b)) return 'compose';
  if (b === 'dockerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile')) return 'dockerfile';
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(lower)) return 'github-actions';
  if (b === '.gitlab-ci.yml' || b === '.gitlab-ci.yaml') return 'gitlab-ci';
  if (/(^|\/)\.circleci\/config\.ya?ml$/.test(lower)) return 'circleci';
  if (b === 'azure-pipelines.yml' || b === 'azure-pipelines.yaml') return 'azure-pipelines';
  if (b === 'bitbucket-pipelines.yml') return 'bitbucket';
  if (b === 'jenkinsfile') return 'jenkins';
  if (b === '.travis.yml') return 'travis';
  if (b === 'serverless.yml' || b === 'serverless.yaml') return 'serverless';
  if (b === 'chart.yaml') return 'helm-chart';
  if (b.endsWith('.tf')) return 'terraform';
  if (b === 'nginx.conf' || (b.endsWith('.conf') && /(^|\/)(nginx|conf\.d|sites-(?:available|enabled))\//.test(lower)) || /nginx.*\.conf$/.test(b)) return 'nginx';
  if (b === 'caddyfile') return 'caddy';
  if (b === 'procfile') return 'procfile';
  if (['vercel.json', 'now.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'railway.json', 'railway.toml', 'app.yaml', 'wrangler.toml', 'firebase.json', 'heroku.yml', 'app.json'].includes(b)) return 'platform';
  if ((b.endsWith('.yaml') || b.endsWith('.yml')) && !/(^|\/)templates\//.test(lower)) return 'yaml';
  if ((b.endsWith('.yaml') || b.endsWith('.yml')) && /(^|\/)templates\//.test(lower)) return 'yaml';
  return undefined;
}

// --- Docker Compose ------------------------------------------------------------------------------------------------

function envEntries(doc: YamlDoc, path: Path, env: unknown): ComposeEnvVar[] {
  const out: ComposeEnvVar[] = [];
  const add = (key: string, value: string | undefined, line: number) => {
    const url = value ? parseUrlish(value) : null;
    const literal = value !== undefined && value !== '' && !/^\$\{?[\w]/.test(value);
    out.push({ key, line, scheme: url?.scheme, host: url?.host, secret: literal && isSecretKey(key) && !url });
  };
  if (Array.isArray(env)) {
    env.forEach((item, i) => {
      const s = str(item);
      if (!s) return;
      const eq = s.indexOf('=');
      add(eq < 0 ? s : s.slice(0, eq), eq < 0 ? undefined : s.slice(eq + 1), doc.line([...path, i]));
    });
  } else {
    for (const [key, value] of Object.entries(obj(env))) add(key, str(value), doc.line([...path, key]));
  }
  return out;
}

function parsePort(p: unknown): { published?: string; target: string } | null {
  if (typeof p === 'number') return { target: String(p) };
  if (typeof p === 'string') {
    const clean = p.replace(/\/(tcp|udp)$/, '');
    const parts = clean.split(':');
    if (parts.length === 1) return { target: parts[0] };
    return { published: parts[parts.length - 2], target: parts[parts.length - 1] };
  }
  const o = obj(p);
  if (o.target !== undefined) return { target: String(o.target), published: o.published !== undefined ? String(o.published) : undefined };
  return null;
}

export function parseCompose(file: string, text: string): ComposeFact {
  const [doc] = yamlDocs(text);
  const services: ComposeService[] = [];
  if (!doc) return { file, services };
  for (const [name, raw] of Object.entries(obj(doc.js.services))) {
    const svc = obj(raw);
    const p: Path = ['services', name];
    const build = svc.build;
    const s: ComposeService = {
      name,
      line: doc.line(p),
      image: str(svc.image),
      imageLine: svc.image !== undefined ? doc.line([...p, 'image']) : undefined,
      build:
        build === undefined
          ? undefined
          : typeof build === 'string'
            ? { context: build, line: doc.line([...p, 'build']) }
            : { context: str(obj(build).context) ?? '.', dockerfile: str(obj(build).dockerfile), line: doc.line([...p, 'build']) },
      command:
        svc.command !== undefined
          ? { text: Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command), line: doc.line([...p, 'command']) }
          : svc.entrypoint !== undefined
            ? { text: Array.isArray(svc.entrypoint) ? svc.entrypoint.join(' ') : String(svc.entrypoint), line: doc.line([...p, 'entrypoint']) }
            : undefined,
      ports: arr(svc.ports)
        .map((port, i) => {
          const parsed = parsePort(port);
          return parsed ? { ...parsed, line: doc.line([...p, 'ports', i]) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
      expose: arr(svc.expose).map((port, i) => ({ port: String(port), line: doc.line([...p, 'expose', i]) })),
      dependsOn: (Array.isArray(svc.depends_on) ? svc.depends_on.map(String) : Object.keys(obj(svc.depends_on))).map((dep: string, i: number) => ({
        name: dep,
        line: Array.isArray(svc.depends_on) ? doc.line([...p, 'depends_on', i]) : doc.line([...p, 'depends_on', dep]),
      })),
      links: arr(svc.links).map((l, i) => ({ name: String(l).split(':')[0], line: doc.line([...p, 'links', i]) })),
      environment: envEntries(doc, [...p, 'environment'], svc.environment),
      healthcheck: svc.healthcheck !== undefined ? doc.line([...p, 'healthcheck']) : undefined,
      replicas: typeof obj(svc.deploy).replicas === 'number' ? { count: obj(svc.deploy).replicas, line: doc.line([...p, 'deploy', 'replicas']) } : undefined,
      labels: Array.isArray(svc.labels)
        ? svc.labels.map((l: unknown, i: number) => ({ text: String(l), line: doc.line([...p, 'labels', i]) }))
        : Object.entries(obj(svc.labels)).map(([k, v]) => ({ text: `${k}=${String(v)}`, line: doc.line([...p, 'labels', k]) })),
    };
    services.push(s);
  }
  return { file, services };
}

// --- Dockerfile ----------------------------------------------------------------------------------------------------

export function parseDockerfile(file: string, text: string): DockerfileFact {
  const fact: DockerfileFact = { file, stages: [], expose: [], commands: [] };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, ' ') + lines[++i];
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const instr = m[1].toUpperCase();
    const rest = m[2].trim();
    const at = start + 1;
    if (instr === 'FROM') {
      const f = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(rest);
      if (f) fact.stages.push({ image: f[1], line: at, alias: f[2] });
    } else if (instr === 'EXPOSE') {
      for (const port of rest.split(/\s+/)) if (port) fact.expose.push({ port: port.replace(/\/(tcp|udp)$/, ''), line: at });
    } else if (instr === 'CMD' || instr === 'ENTRYPOINT') {
      let cmd = rest;
      if (rest.startsWith('[')) {
        try {
          cmd = (JSON.parse(rest) as string[]).join(' ');
        } catch {
          /* shell form after all */
        }
      }
      fact.commands.push({ kind: instr, text: cmd, line: at });
    } else if (instr === 'USER') {
      fact.user = { name: rest, line: at };
    } else if (instr === 'HEALTHCHECK') {
      fact.healthcheck = at;
    }
  }
  return fact;
}

// --- Kubernetes / Helm --------------------------------------------------------------------------------------------

const K8S_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'Service', 'Ingress', 'HorizontalPodAutoscaler', 'Gateway', 'HTTPRoute', 'IngressRoute']);

export function parseKubernetes(file: string, text: string): KubernetesObject[] {
  if (!/^\s*apiVersion\s*:/m.test(text) || !/^\s*kind\s*:/m.test(text)) return [];
  if (text.includes('{{')) return []; // Helm templates are not valid YAML until rendered.
  const out: KubernetesObject[] = [];
  for (const doc of yamlDocs(text)) {
    const js = obj(doc.js);
    const kind = str(js.kind);
    if (!kind || !K8S_KINDS.has(kind)) continue;
    const name = str(obj(js.metadata).name) ?? '(unnamed)';
    const o: KubernetesObject = {
      file,
      kind,
      name,
      line: doc.line(['kind']),
      images: [],
      ports: [],
      backends: [],
      labels: Object.fromEntries(Object.entries(obj(obj(js.metadata).labels)).map(([k, v]) => [k, String(v)])),
      selector: {},
    };
    const podPaths: Path[] =
      kind === 'CronJob'
        ? [['spec', 'jobTemplate', 'spec', 'template', 'spec']]
        : kind === 'Pod'
          ? [['spec']]
          : [['spec', 'template', 'spec']];
    for (const pp of podPaths) {
      let spec: any = js;
      for (const k of pp) spec = obj(spec)[k as string];
      for (const field of ['initContainers', 'containers']) {
        arr(obj(spec)[field]).forEach((c, i) => {
          const image = str(obj(c).image);
          if (image) o.images.push({ image, line: doc.line([...pp, field, i, 'image']) });
          arr(obj(c).ports).forEach((port, j) => {
            const cp = obj(port).containerPort;
            if (cp !== undefined) o.ports.push({ port: String(cp), line: doc.line([...pp, field, i, 'ports', j]) });
          });
        });
      }
    }
    const spec = obj(js.spec);
    if (kind === 'Service') {
      if (spec.type) o.serviceType = { value: String(spec.type), line: doc.line(['spec', 'type']) };
      o.selector = Object.fromEntries(Object.entries(obj(spec.selector)).map(([k, v]) => [k, String(v)]));
      arr(spec.ports).forEach((port, i) => o.ports.push({ port: String(obj(port).port ?? obj(port).targetPort ?? ''), line: doc.line(['spec', 'ports', i]) }));
    } else if (spec.selector) {
      o.selector = Object.fromEntries(Object.entries(obj(obj(spec.selector).matchLabels)).map(([k, v]) => [k, String(v)]));
    }
    if (typeof spec.replicas === 'number') o.replicas = { count: spec.replicas, line: doc.line(['spec', 'replicas']) };
    if (kind === 'Ingress') {
      const def = obj(obj(spec.defaultBackend).service).name ?? obj(spec.backend).serviceName;
      if (def) o.backends.push({ service: String(def), line: doc.line(['spec', spec.defaultBackend ? 'defaultBackend' : 'backend']) });
      arr(spec.rules).forEach((rule, i) => {
        arr(obj(obj(rule).http).paths).forEach((p, j) => {
          const b = obj(obj(p).backend);
          const svc = str(obj(b.service).name) ?? str(b.serviceName);
          if (svc) o.backends.push({ service: svc, line: doc.line(['spec', 'rules', i, 'http', 'paths', j]), path: str(obj(p).path), host: str(obj(rule).host) });
        });
      });
    }
    out.push(o);
  }
  return out;
}

export function parseHelmChart(file: string, text: string) {
  const [doc] = yamlDocs(text);
  const js = obj(doc?.js);
  return {
    file,
    name: str(js.name) ?? dirOf(file),
    line: doc ? doc.line(['name']) : 1,
    dependencies: arr(js.dependencies).map((d, i) => ({ name: String(obj(d).name), line: doc!.line(['dependencies', i]) })),
  };
}

// --- Terraform -----------------------------------------------------------------------------------------------------

const TF_ATTRS = new Set(['engine', 'engine_version', 'runtime', 'image', 'image_uri', 'instance_class', 'node_type', 'database_version', 'handler', 'package_type', 'bucket', 'name', 'launch_type']);

export function parseTerraform(file: string, text: string, into: TerraformFact) {
  const lines = text.split('\n');
  let depth = 0;
  let current: { kind: 'resource' | 'provider' | 'module'; type: string; name: string; line: number; attrs: Record<string, { value: string; line: number }>; source?: string } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.kind === 'resource') into.resources.push({ file, line: current.line, type: current.type, name: current.name, attributes: current.attrs });
    else if (current.kind === 'provider') into.providers.push({ file, line: current.line, name: current.type });
    else into.modules.push({ file, line: current.line, name: current.name, source: current.source ?? '' });
    current = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/(^|\s)(#|\/\/).*$/, '');
    if (depth === 0) {
      const r = /^\s*resource\s+"([\w-]+)"\s+"([\w-]+)"/.exec(line);
      const p = /^\s*provider\s+"([\w-]+)"/.exec(line);
      const m = /^\s*module\s+"([\w-]+)"/.exec(line);
      if (r) current = { kind: 'resource', type: r[1], name: r[2], line: i + 1, attrs: {} };
      else if (p) current = { kind: 'provider', type: p[1], name: p[1], line: i + 1, attrs: {} };
      else if (m) current = { kind: 'module', type: 'module', name: m[1], line: i + 1, attrs: {} };
    } else if (depth === 1 && current) {
      const a = /^\s*([\w-]+)\s*=\s*"([^"]*)"/.exec(line);
      if (a && TF_ATTRS.has(a[1])) current.attrs[a[1]] = { value: a[2], line: i + 1 };
      if (a && a[1] === 'source' && current.kind === 'module') current.source = a[2];
    }
    for (const ch of line.replace(/"(?:[^"\\]|\\.)*"/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) flush();
      }
    }
  });
  flush();
}

// --- Serverless ------------------------------------------------------------------------------------------------------

export function parseServerless(file: string, text: string): ServerlessFact {
  const [doc] = yamlDocs(text);
  const js = obj(doc?.js);
  const provider = obj(js.provider);
  const fact: ServerlessFact = { file, functions: [] };
  if (doc && (provider.name || typeof js.provider === 'string')) {
    fact.provider = { name: str(provider.name) ?? String(js.provider), runtime: str(provider.runtime), line: doc.line(['provider']) };
  }
  for (const [name, fn] of Object.entries(obj(js.functions))) {
    const f = obj(fn);
    fact.functions.push({
      name,
      line: doc!.line(['functions', name]),
      handler: str(f.handler),
      events: arr(f.events).map((ev, i) => {
        const [kind, value] = Object.entries(obj(ev))[0] ?? ['unknown', undefined];
        const v = obj(value);
        return {
          kind,
          line: doc!.line(['functions', name, 'events', i]),
          path: str(v.path) ?? (typeof value === 'string' && kind.startsWith('http') ? value.split(' ')[1] : undefined),
          method: str(v.method) ?? (typeof value === 'string' && kind.startsWith('http') ? value.split(' ')[0] : undefined),
        };
      }),
    });
  }
  return fact;
}

// --- CI ----------------------------------------------------------------------------------------------------------------------

function stepsFromScript(doc: YamlDoc, base: Path, script: unknown): CiStep[] {
  if (typeof script === 'string') return [{ line: doc.line(base), run: script }];
  return arr(script).map((s, i) => ({ line: doc.line([...base, i]), run: typeof s === 'string' ? s : str(obj(s).command) ?? JSON.stringify(s) }));
}

export function parseCi(file: string, text: string, system: CiFact['system']): CiFact {
  const fact: CiFact = { file, system, triggers: [], jobs: [] };
  if (system === 'jenkins') {
    const steps: CiStep[] = [];
    text.split('\n').forEach((raw, i) => {
      const m = /\b(?:sh|bat|powershell)\s*\(?\s*(?:script:\s*)?['"]{1,3}(.+?)['"]{1,3}/.exec(raw);
      if (m) steps.push({ line: i + 1, run: m[1] });
    });
    fact.jobs.push({ name: 'pipeline', line: 1, steps });
    return fact;
  }
  const [doc] = yamlDocs(text);
  if (!doc) return fact;
  const js = obj(doc.js);
  if (system === 'github-actions') {
    fact.name = str(js.name);
    const on = js.on ?? js.true; // YAML 1.1 parses `on:` as boolean true in some tools
    fact.triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(obj(on));
    for (const [name, job] of Object.entries(obj(js.jobs))) {
      const j = obj(job);
      const steps: CiStep[] = arr(j.steps).map((s, i) => {
        const w = obj(obj(s).with);
        const step: CiStep = { line: doc.line(['jobs', name, 'steps', i]), name: str(obj(s).name), uses: str(obj(s).uses), run: str(obj(s).run) };
        if (Object.keys(w).length) step.with = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, String(v)]));
        return step;
      });
      if (j.uses) steps.push({ line: doc.line(['jobs', name, 'uses']), uses: str(j.uses) });
      fact.jobs.push({ name, line: doc.line(['jobs', name]), steps });
    }
  } else if (system === 'gitlab-ci') {
    const reserved = new Set(['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'cache', 'before_script', 'after_script']);
    for (const [name, job] of Object.entries(js)) {
      if (reserved.has(name) || name.startsWith('.')) continue;
      const j = obj(job);
      if (!j.script && !j.trigger) continue;
      const steps = [...stepsFromScript(doc, [name, 'before_script'], j.before_script), ...stepsFromScript(doc, [name, 'script'], j.script)];
      fact.jobs.push({ name, line: doc.line([name]), steps });
    }
  } else if (system === 'circleci') {
    for (const [name, job] of Object.entries(obj(js.jobs))) {
      const steps: CiStep[] = arr(obj(job).steps).map((s, i) => {
        const run = typeof s === 'string' ? undefined : obj(s).run;
        return { line: doc.line(['jobs', name, 'steps', i]), run: typeof run === 'string' ? run : str(obj(run).command), uses: typeof s === 'string' ? s : Object.keys(obj(s))[0] };
      });
      fact.jobs.push({ name, line: doc.line(['jobs', name]), steps });
    }
  } else if (system === 'azure-pipelines') {
    const collect = (steps: unknown, base: Path): CiStep[] => arr(steps).map((s, i) => ({ line: doc.line([...base, i]), run: str(obj(s).script) ?? str(obj(s).bash), uses: str(obj(s).task) }));
    fact.jobs.push({ name: 'pipeline', line: 1, steps: collect(js.steps, ['steps']) });
    arr(js.jobs).forEach((j, i) => fact.jobs.push({ name: str(obj(j).job) ?? `job ${i + 1}`, line: doc.line(['jobs', i]), steps: collect(obj(j).steps, ['jobs', i, 'steps']) }));
  } else if (system === 'bitbucket') {
    const pipes = obj(js.pipelines);
    const walk = (node: unknown, path: Path) => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, [...path, i]));
      else if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (o.step) {
          const st = obj(o.step);
          fact.jobs.push({ name: str(st.name) ?? 'step', line: doc.line([...path, 'step']), steps: stepsFromScript(doc, [...path, 'step', 'script'], st.script) });
        } else for (const [k, v] of Object.entries(o)) walk(v, [...path, k]);
      }
    };
    walk(pipes, ['pipelines']);
  } else if (system === 'travis') {
    const steps = [...stepsFromScript(doc, ['script'], js.script), ...stepsFromScript(doc, ['deploy'], js.deploy ? [JSON.stringify(js.deploy)] : [])];
    fact.jobs.push({ name: 'build', line: 1, steps });
  }
  return fact;
}

// --- Proxies ------------------------------------------------------------------------------------------------------------------

export function parseNginx(file: string, text: string): ProxyFact[] {
  const out: ProxyFact[] = [];
  const upstreams = new Map<string, { host: string; port?: string }[]>();
  let currentUpstream: string | null = null;
  let location: string | undefined;
  const lines = text.split('\n');
  lines.forEach((raw) => {
    const line = raw.replace(/#.*$/, '');
    const up = /^\s*upstream\s+([\w.-]+)\s*\{/.exec(line);
    if (up) currentUpstream = up[1];
    const srv = /^\s*server\s+([\w.-]+)(?::(\d+))?/.exec(line);
    if (currentUpstream && srv) {
      if (!upstreams.has(currentUpstream)) upstreams.set(currentUpstream, []);
      upstreams.get(currentUpstream)!.push({ host: srv[1], port: srv[2] });
    }
    if (currentUpstream && /^\s*\}/.test(line)) currentUpstream = null;
  });
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '');
    const loc = /^\s*location\s+(?:[=~^*]+\s*)?(\S+)\s*\{/.exec(line);
    if (loc) location = loc[1];
    const pp = /proxy_pass\s+(?:https?|grpc|uwsgi):\/\/([\w.-]+)(?::(\d+))?/.exec(line) ?? /(?:uwsgi_pass|fastcgi_pass|grpc_pass)\s+(?:grpc:\/\/)?([\w.-]+)(?::(\d+))?/.exec(line);
    if (!pp) return;
    const targets = upstreams.get(pp[1]) ?? [{ host: pp[1], port: pp[2] }];
    for (const t of targets) out.push({ file, line: i + 1, kind: 'nginx', upstream: t.host, port: t.port ?? pp[2], path: location, snippet: snippet(raw) });
  });
  return out;
}

export function parseCaddy(file: string, text: string): ProxyFact[] {
  const out: ProxyFact[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*reverse_proxy\s+(?:(\/\S*)\s+)?(?:https?:\/\/)?([\w.-]+)(?::(\d+))?/.exec(raw.replace(/#.*$/, ''));
    if (m) out.push({ file, line: i + 1, kind: 'caddy', upstream: m[2], port: m[3], path: m[1], snippet: snippet(raw) });
  });
  return out;
}

// --- Platforms and Procfiles -----------------------------------------------------------------------------------------------------

export function parseProcfile(file: string, text: string) {
  const out: { file: string; line: number; name: string; command: string }[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^([\w-]+)\s*:\s*(.+)$/.exec(raw.trim());
    if (m) out.push({ file, line: i + 1, name: m[1], command: m[2] });
  });
  return out;
}

export function parsePlatform(file: string, text: string): PlatformFact[] {
  const b = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const starts = lineStartsOf(text);
  const lines = text.split('\n');
  const first = (re: RegExp) => {
    const m = re.exec(text);
    return m ? lineAt(text, m.index, starts) : 1;
  };
  const fact = (platform: string, detail: string, line = 1): PlatformFact => ({ file, line, platform, detail, snippet: snippet(lines[line - 1]) });
  switch (b) {
    case 'vercel.json':
    case 'now.json': {
      const js = JSON.parse(text) as Record<string, any>;
      const out = [fact('vercel', 'Vercel project configuration', 1)];
      arr(js.crons).forEach((c) => out.push(fact('vercel', `Cron: ${str(obj(c).path)} (${str(obj(c).schedule)})`, first(new RegExp(`"path"\\s*:\\s*"${(str(obj(c).path) ?? '').replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')}"`)))));
      return out;
    }
    case 'netlify.toml':
      parseToml(text);
      return [fact('netlify', 'Netlify build and deploy configuration', 1)];
    case 'fly.toml': {
      const js = parseToml(text) as Record<string, any>;
      return [fact('flyio', `Fly.io app${js.app ? ` "${js.app}"` : ''}`, first(/^\s*app\s*=/m))];
    }
    case 'render.yaml': {
      const [doc] = yamlDocs(text);
      return arr(obj(doc?.js).services).map((s, i) => fact('render', `Render ${str(obj(s).type) ?? 'service'} "${str(obj(s).name) ?? i}"`, doc!.line(['services', i])));
    }
    case 'railway.json':
    case 'railway.toml':
      return [fact('railway', 'Railway deployment configuration', 1)];
    case 'app.yaml': {
      if (!/^\s*runtime\s*:/m.test(text)) return [];
      return [fact('gae', 'Google App Engine app.yaml', first(/^\s*runtime\s*:/m))];
    }
    case 'wrangler.toml':
      parseToml(text);
      return [fact('cloudflare-workers', 'Cloudflare Workers configuration', first(/^\s*name\s*=/m))];
    case 'firebase.json': {
      const js = JSON.parse(text) as Record<string, unknown>;
      return js.hosting ? [fact('firebase-hosting', 'Firebase Hosting configuration', first(/"hosting"\s*:/))] : [];
    }
    case 'heroku.yml':
      return [fact('heroku', 'Heroku container build configuration', 1)];
    case 'app.json': {
      const js = JSON.parse(text) as Record<string, unknown>;
      return js.buildpacks || js.formation ? [fact('heroku', 'Heroku app.json (buildpacks/formation)', first(/"(?:buildpacks|formation)"\s*:/))] : [];
    }
  }
  return [];
}
