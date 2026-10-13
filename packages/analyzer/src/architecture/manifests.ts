import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { dirOf, escapeRegExp, lineAt, lineStartsOf } from './text.ts';
import type { Ecosystem, LockfileFact, ManifestDependency, ManifestFact } from './types.ts';

/**
 * Dependency manifests and lockfiles. Every dependency carries the line it is declared on so
 * the UI can link to it. Malformed files throw; the caller records a warning and moves on.
 */

type Parser = (file: string, text: string) => ManifestFact;

function base(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).toLowerCase();
}

/** Line of the first `"key":` (or `key =`) at or after `from`; falls back to the section line. */
function keyLine(text: string, starts: number[], key: string, from: number, style: 'json' | 'toml' | 'yaml' = 'json'): number {
  const k = escapeRegExp(key);
  const re =
    style === 'json'
      ? new RegExp(`"${k}"\\s*:`, 'g')
      : style === 'toml'
        ? new RegExp(`^\\s*["']?${k}["']?\\s*=`, 'gmi')
        : new RegExp(`^\\s*["']?${k}["']?\\s*:`, 'gm');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? lineAt(text, m.index, starts) : lineAt(text, from, starts);
}

function sectionOffset(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m ? m.index : -1;
}

const parsePackageJson: Parser = (file, text) => {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  for (const [section, dev] of [
    ['dependencies', false],
    ['devDependencies', true],
    ['peerDependencies', false],
    ['optionalDependencies', false],
  ] as const) {
    const obj = pkg[section];
    if (!obj || typeof obj !== 'object') continue;
    const at = sectionOffset(text, new RegExp(`"${section}"\\s*:\\s*\\{`));
    for (const [name, spec] of Object.entries(obj as Record<string, unknown>)) {
      deps.push({ name, spec: typeof spec === 'string' ? spec : '', line: keyLine(text, starts, name, Math.max(0, at)), dev });
    }
  }
  const scripts: ManifestFact['scripts'] = [];
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    const at = sectionOffset(text, /"scripts"\s*:\s*\{/);
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof cmd === 'string') scripts.push({ name, command: cmd, line: keyLine(text, starts, name, Math.max(0, at)) });
    }
  }
  return { file, ecosystem: 'npm', dir: dirOf(file), name: typeof pkg.name === 'string' ? pkg.name : undefined, dependencies: deps, scripts };
};

/** PEP 508 requirement → name + constraint. */
function splitRequirement(req: string): { name: string; spec: string } | null {
  const r = req.trim();
  if (!r || r.startsWith('-') || r.startsWith('#')) return null;
  const egg = /#egg=([\w.-]+)/.exec(r);
  if (egg) return { name: egg[1], spec: r.replace(/#.*/, '').trim() };
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(r);
  if (!m) return null;
  return { name: m[1], spec: m[3].replace(/;.*$/, '').replace(/#.*$/, '').trim() };
}

const parseRequirements: Parser = (file, text) => {
  const dev = /dev|test|lint|doc/i.test(base(file));
  const deps: ManifestDependency[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    const req = splitRequirement(line);
    if (req) deps.push({ ...req, line: i + 1, dev });
  });
  return { file, ecosystem: 'pypi', dir: dirOf(file), dependencies: deps, scripts: [] };
};

const parsePyproject: Parser = (file, text) => {
  const data = parseToml(text) as Record<string, any>;
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  const findLine = (name: string) => {
    const re = new RegExp(`(^|["'\\s])${escapeRegExp(name)}(\\s*[=<>!~\\[;"']|\\s*$)`, 'mi');
    const m = re.exec(text);
    return m ? lineAt(text, m.index + m[1].length, starts) : 1;
  };
  const addList = (list: unknown, dev: boolean) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const req = splitRequirement(item);
      if (req) deps.push({ ...req, line: findLine(req.name), dev });
    }
  };
  const addTable = (table: unknown, dev: boolean) => {
    if (!table || typeof table !== 'object') return;
    for (const [name, spec] of Object.entries(table as Record<string, unknown>)) {
      if (name.toLowerCase() === 'python') continue;
      const s = typeof spec === 'string' ? spec : spec && typeof spec === 'object' && 'version' in spec ? String((spec as { version: unknown }).version) : '';
      deps.push({ name, spec: s, line: findLine(name), dev });
    }
  };
  const project = data.project ?? {};
  addList(project.dependencies, false);
  for (const [group, list] of Object.entries((project['optional-dependencies'] ?? {}) as Record<string, unknown>)) addList(list, /dev|test|lint|doc/i.test(group));
  for (const [group, list] of Object.entries((data['dependency-groups'] ?? {}) as Record<string, unknown>)) addList(list, /dev|test|lint|doc/i.test(group));
  const poetry = data.tool?.poetry ?? {};
  addTable(poetry.dependencies, false);
  addTable(poetry['dev-dependencies'], true);
  for (const [group, g] of Object.entries((poetry.group ?? {}) as Record<string, any>)) addTable(g?.dependencies, /dev|test|lint|doc/i.test(group));
  addList(data.tool?.pdm?.['dev-dependencies'] && Object.values(data.tool.pdm['dev-dependencies']).flat(), true);
  const scripts: ManifestFact['scripts'] = [];
  for (const table of [project.scripts, poetry.scripts]) {
    if (!table || typeof table !== 'object') continue;
    for (const [name, cmd] of Object.entries(table as Record<string, unknown>)) {
      if (typeof cmd === 'string') scripts.push({ name, command: cmd, line: keyLine(text, starts, name, 0, 'toml') });
    }
  }
  return { file, ecosystem: 'pypi', dir: dirOf(file), name: project.name ?? poetry.name, dependencies: deps, scripts };
};

const parsePipfile: Parser = (file, text) => {
  const data = parseToml(text) as Record<string, any>;
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  for (const [section, dev] of [
    ['packages', false],
    ['dev-packages', true],
  ] as const) {
    const at = sectionOffset(text, new RegExp(`^\\[${section}\\]`, 'm'));
    for (const [name, spec] of Object.entries((data[section] ?? {}) as Record<string, unknown>)) {
      deps.push({ name, spec: typeof spec === 'string' ? spec : '', line: keyLine(text, starts, name, Math.max(0, at), 'toml'), dev });
    }
  }
  return { file, ecosystem: 'pypi', dir: dirOf(file), dependencies: deps, scripts: [] };
};

const parseSetupPy: Parser = (file, text) => {
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  const block = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (block) {
    const offset = block.index + block[0].indexOf('[') + 1;
    for (const m of block[1].matchAll(/["']([^"']+)["']/g)) {
      const req = splitRequirement(m[1]);
      if (req) deps.push({ ...req, line: lineAt(text, offset + m.index!, starts), dev: false });
    }
  }
  return { file, ecosystem: 'pypi', dir: dirOf(file), dependencies: deps, scripts: [] };
};

const parseGoMod: Parser = (file, text) => {
  const deps: ManifestDependency[] = [];
  let inBlock = false;
  let name: string | undefined;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const mod = /^module\s+(\S+)/.exec(line);
    if (mod) name = mod[1];
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      return;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      return;
    }
    const m = inBlock ? /^(\S+)\s+(\S+)/.exec(line) : /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (m) deps.push({ name: m[1], spec: m[2], line: i + 1, dev: /\/\/\s*indirect/.test(raw) });
  });
  return { file, ecosystem: 'go', dir: dirOf(file), name, dependencies: deps, scripts: [] };
};

const parseCargo: Parser = (file, text) => {
  const data = parseToml(text) as Record<string, any>;
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  for (const [section, dev] of [
    ['dependencies', false],
    ['dev-dependencies', true],
    ['build-dependencies', true],
  ] as const) {
    const tables = [data[section], data.workspace?.[section]];
    const at = sectionOffset(text, new RegExp(`^\\[(?:workspace\\.)?${section}\\]`, 'm'));
    for (const table of tables) {
      for (const [name, spec] of Object.entries((table ?? {}) as Record<string, unknown>)) {
        const s = typeof spec === 'string' ? spec : spec && typeof spec === 'object' && 'version' in spec ? String((spec as { version: unknown }).version) : '';
        deps.push({ name, spec: s, line: keyLine(text, starts, name, Math.max(0, at), 'toml'), dev });
      }
    }
  }
  return { file, ecosystem: 'cargo', dir: dirOf(file), name: data.package?.name, dependencies: deps, scripts: [] };
};

const parseGemfile: Parser = (file, text) => {
  const deps: ManifestDependency[] = [];
  let group = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (/^group\b.*\b(development|test)\b/.test(line)) group = true;
    else if (line === 'end') group = false;
    const m = /^gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(line);
    if (m) deps.push({ name: m[1], spec: m[2] ?? '', line: i + 1, dev: group });
  });
  return { file, ecosystem: 'gem', dir: dirOf(file), dependencies: deps, scripts: [] };
};

const parseComposer: Parser = (file, text) => {
  const data = JSON.parse(text) as Record<string, any>;
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  for (const [section, dev] of [
    ['require', false],
    ['require-dev', true],
  ] as const) {
    const at = sectionOffset(text, new RegExp(`"${section}"\\s*:\\s*\\{`));
    for (const [name, spec] of Object.entries((data[section] ?? {}) as Record<string, unknown>)) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      deps.push({ name, spec: typeof spec === 'string' ? spec : '', line: keyLine(text, starts, name, Math.max(0, at)), dev });
    }
  }
  return { file, ecosystem: 'composer', dir: dirOf(file), name: data.name, dependencies: deps, scripts: [] };
};

const parsePom: Parser = (file, text) => {
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  const tag = (block: string, name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(block)?.[1];
  for (const m of text.matchAll(/<(dependency|parent|plugin)>([\s\S]*?)<\/\1>/g)) {
    const group = tag(m[2], 'groupId');
    const artifact = tag(m[2], 'artifactId');
    if (!group || !artifact) continue;
    const scope = tag(m[2], 'scope');
    deps.push({ name: `${group}:${artifact}`, spec: tag(m[2], 'version') ?? '', line: lineAt(text, m.index!, starts), dev: scope === 'test' || m[1] === 'plugin' });
  }
  return { file, ecosystem: 'maven', dir: dirOf(file), name: tag(text.replace(/<parent>[\s\S]*?<\/parent>/, ''), 'artifactId'), dependencies: deps, scripts: [] };
};

const parseGradle: Parser = (file, text) => {
  const deps: ManifestDependency[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*(\w+)\s*\(?\s*["']([\w.-]+):([\w.-]+)(?::([^"']+))?["']/.exec(raw);
    if (m && /implementation|api|compile|runtimeOnly|testImplementation|kapt|annotationProcessor/.test(m[1])) {
      deps.push({ name: `${m[2]}:${m[3]}`, spec: m[4] ?? '', line: i + 1, dev: /^test/.test(m[1]) });
    }
  });
  return { file, ecosystem: 'maven', dir: dirOf(file), dependencies: deps, scripts: [] };
};

const parseCsproj: Parser = (file, text) => {
  const starts = lineStartsOf(text);
  const deps: ManifestDependency[] = [];
  for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]*)")?/g)) {
    deps.push({ name: m[1], spec: m[2] ?? '', line: lineAt(text, m.index!, starts), dev: false });
  }
  return { file, ecosystem: 'nuget', dir: dirOf(file), dependencies: deps, scripts: [] };
};

/** Which parser handles a repo-relative path, if any. */
export function manifestParser(file: string): Parser | undefined {
  const b = base(file);
  if (b === 'package.json') return parsePackageJson;
  if (/^requirements([-_.][\w.-]+)?\.(txt|in)$/.test(b)) return parseRequirements;
  if (b === 'pyproject.toml') return parsePyproject;
  if (b === 'pipfile') return parsePipfile;
  if (b === 'setup.py') return parseSetupPy;
  if (b === 'go.mod') return parseGoMod;
  if (b === 'cargo.toml') return parseCargo;
  if (b === 'gemfile') return parseGemfile;
  if (b === 'composer.json') return parseComposer;
  if (b === 'pom.xml') return parsePom;
  if (b === 'build.gradle' || b === 'build.gradle.kts') return parseGradle;
  if (b.endsWith('.csproj')) return parseCsproj;
  return undefined;
}

// --- Lockfiles -------------------------------------------------------------------------------------------

type LockParser = (text: string) => Record<string, string>;

const lockPackageJson: LockParser = (text) => {
  const data = JSON.parse(text) as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  const out: Record<string, string> = {};
  if (data.packages) {
    for (const [key, v] of Object.entries(data.packages)) {
      // Only top-level installs: `node_modules/<name>` (not nested copies).
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && v.version) out[m[1]] = v.version;
    }
  } else if (data.dependencies) {
    for (const [name, v] of Object.entries(data.dependencies)) if (v.version) out[name] = v.version;
  }
  return out;
};

const lockYarn: LockParser = (text) => {
  const out: Record<string, string> = {};
  let names: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\S/.test(line) && line.trimEnd().endsWith(':')) {
      names = line
        .slice(0, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .map((spec) => spec.replace(/@(?:npm:)?[^@]*$/, ''))
        .filter(Boolean);
    } else {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m && names.length) {
        for (const n of names) if (!out[n]) out[n] = m[1];
        names = [];
      }
    }
  }
  return out;
};

const lockPnpm: LockParser = (text) => {
  const data = parseYaml(text) as Record<string, any>;
  const out: Record<string, string> = {};
  const importer = data.importers?.['.'] ?? data;
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, v] of Object.entries((importer?.[section] ?? {}) as Record<string, unknown>)) {
      const version = typeof v === 'string' ? v : v && typeof v === 'object' && 'version' in v ? String((v as { version: unknown }).version) : undefined;
      if (version) out[name] = version.replace(/\(.*$/, '');
    }
  }
  return out;
};

const lockTomlPackages: LockParser = (text) => {
  const data = parseToml(text) as { package?: { name?: string; version?: string }[] };
  const out: Record<string, string> = {};
  for (const p of data.package ?? []) if (p.name && p.version) out[p.name.toLowerCase()] = p.version;
  return out;
};

const lockPipfile: LockParser = (text) => {
  const data = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
  const out: Record<string, string> = {};
  for (const section of ['default', 'develop']) {
    for (const [name, v] of Object.entries(data[section] ?? {})) if (v.version) out[name.toLowerCase()] = v.version.replace(/^==/, '');
  }
  return out;
};

const lockGemfile: LockParser = (text) => {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^ {4}([\w.-]+) \(([^)]+)\)$/gm)) out[m[1]] = m[2];
  return out;
};

const lockComposer: LockParser = (text) => {
  const data = JSON.parse(text) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
  const out: Record<string, string> = {};
  for (const p of [...(data.packages ?? []), ...(data['packages-dev'] ?? [])]) out[p.name] = p.version;
  return out;
};

const LOCKFILES: Record<string, [Ecosystem, LockParser]> = {
  'package-lock.json': ['npm', lockPackageJson],
  'npm-shrinkwrap.json': ['npm', lockPackageJson],
  'yarn.lock': ['npm', lockYarn],
  'pnpm-lock.yaml': ['npm', lockPnpm],
  'poetry.lock': ['pypi', lockTomlPackages],
  'uv.lock': ['pypi', lockTomlPackages],
  'pipfile.lock': ['pypi', lockPipfile],
  'cargo.lock': ['cargo', lockTomlPackages],
  'gemfile.lock': ['gem', lockGemfile],
  'composer.lock': ['composer', lockComposer],
};

export function isLockfile(file: string): boolean {
  return base(file) in LOCKFILES;
}

export function parseLockfile(file: string, text: string): LockfileFact {
  const [ecosystem, parser] = LOCKFILES[base(file)];
  return { file, ecosystem, dir: dirOf(file), versions: parser(text) };
}
