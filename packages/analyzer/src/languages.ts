import path from 'node:path';

export type FileCategory = 'source' | 'config' | 'style' | 'markup' | 'data' | 'doc' | 'asset' | 'unknown';

interface LanguageInfo {
  language: string;
  category: FileCategory;
}

const BY_EXTENSION: Record<string, LanguageInfo> = {
  '.ts': { language: 'typescript', category: 'source' },
  '.mts': { language: 'typescript', category: 'source' },
  '.cts': { language: 'typescript', category: 'source' },
  '.tsx': { language: 'tsx', category: 'source' },
  '.js': { language: 'javascript', category: 'source' },
  '.mjs': { language: 'javascript', category: 'source' },
  '.cjs': { language: 'javascript', category: 'source' },
  '.jsx': { language: 'jsx', category: 'source' },
  '.vue': { language: 'vue', category: 'source' },
  '.svelte': { language: 'svelte', category: 'source' },
  '.astro': { language: 'astro', category: 'source' },
  '.py': { language: 'python', category: 'source' },
  '.go': { language: 'go', category: 'source' },
  '.rs': { language: 'rust', category: 'source' },
  '.java': { language: 'java', category: 'source' },
  '.kt': { language: 'kotlin', category: 'source' },
  '.rb': { language: 'ruby', category: 'source' },
  '.php': { language: 'php', category: 'source' },
  '.cs': { language: 'csharp', category: 'source' },
  '.swift': { language: 'swift', category: 'source' },
  '.c': { language: 'c', category: 'source' },
  '.h': { language: 'c', category: 'source' },
  '.cpp': { language: 'cpp', category: 'source' },
  '.hpp': { language: 'cpp', category: 'source' },
  '.sh': { language: 'shell', category: 'source' },
  '.sql': { language: 'sql', category: 'source' },
  '.graphql': { language: 'graphql', category: 'source' },
  '.gql': { language: 'graphql', category: 'source' },
  '.prisma': { language: 'prisma', category: 'source' },
  '.css': { language: 'css', category: 'style' },
  '.scss': { language: 'scss', category: 'style' },
  '.sass': { language: 'scss', category: 'style' },
  '.less': { language: 'less', category: 'style' },
  '.html': { language: 'html', category: 'markup' },
  '.json': { language: 'json', category: 'data' },
  '.jsonc': { language: 'json', category: 'data' },
  '.yaml': { language: 'yaml', category: 'config' },
  '.yml': { language: 'yaml', category: 'config' },
  '.toml': { language: 'toml', category: 'config' },
  '.ini': { language: 'ini', category: 'config' },
  '.cfg': { language: 'ini', category: 'config' },
  '.properties': { language: 'properties', category: 'config' },
  '.conf': { language: 'conf', category: 'config' },
  '.tf': { language: 'hcl', category: 'config' },
  '.hcl': { language: 'hcl', category: 'config' },
  '.gradle': { language: 'gradle', category: 'config' },
  '.kts': { language: 'kotlin', category: 'source' },
  '.xml': { language: 'xml', category: 'data' },
  '.csproj': { language: 'xml', category: 'config' },
  '.md': { language: 'markdown', category: 'doc' },
  '.mdx': { language: 'mdx', category: 'source' },
  '.txt': { language: 'text', category: 'doc' },
  '.svg': { language: 'svg', category: 'asset' },
  '.png': { language: 'image', category: 'asset' },
  '.jpg': { language: 'image', category: 'asset' },
  '.jpeg': { language: 'image', category: 'asset' },
  '.gif': { language: 'image', category: 'asset' },
  '.webp': { language: 'image', category: 'asset' },
  '.avif': { language: 'image', category: 'asset' },
  '.ico': { language: 'image', category: 'asset' },
  '.woff': { language: 'font', category: 'asset' },
  '.woff2': { language: 'font', category: 'asset' },
  '.ttf': { language: 'font', category: 'asset' },
  '.otf': { language: 'font', category: 'asset' },
  '.mp4': { language: 'media', category: 'asset' },
  '.webm': { language: 'media', category: 'asset' },
  '.mp3': { language: 'media', category: 'asset' },
  '.wasm': { language: 'wasm', category: 'asset' },
};

/** JSON files that configure tooling rather than hold application data. */
const CONFIG_JSON = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'vercel.json',
  'components.json',
  'deno.json',
  'biome.json',
  '.babelrc',
  '.eslintrc',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.json',
  '.swcrc',
  'renovate.json',
  'app.json',
]);

/** Manifests and infrastructure files that have no extension (or a generic one) but configure the project. */
const BY_NAME: Record<string, LanguageInfo> = {
  'go.mod': { language: 'go-mod', category: 'config' },
  'go.work': { language: 'go-mod', category: 'config' },
  gemfile: { language: 'ruby', category: 'config' },
  'pom.xml': { language: 'xml', category: 'config' },
  procfile: { language: 'procfile', category: 'config' },
  caddyfile: { language: 'caddyfile', category: 'config' },
  pipfile: { language: 'toml', category: 'config' },
  jenkinsfile: { language: 'groovy', category: 'config' },
  'nginx.conf': { language: 'nginx', category: 'config' },
  'build.gradle.kts': { language: 'gradle', category: 'config' },
  'settings.gradle.kts': { language: 'gradle', category: 'config' },
};

/** Languages whose imports the parser extracts. */
export const ANALYZABLE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte']);

export function detectLanguage(relPath: string): LanguageInfo {
  const base = path.posix.basename(relPath);
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')) {
    return { language: 'dockerfile', category: 'config' };
  }
  if (CONFIG_JSON.has(lower) || /^tsconfig\..+\.json$/.test(lower) || /\.config\.json$/.test(lower)) {
    return { language: 'json', category: 'config' };
  }
  if (lower === 'makefile') return { language: 'makefile', category: 'config' };
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (/^requirements([-_.][\w.-]+)?\.(txt|in)$/.test(lower)) return { language: 'pip-requirements', category: 'config' };
  const ext = path.posix.extname(lower);
  return BY_EXTENSION[ext] ?? { language: 'unknown', category: 'unknown' };
}

/** Categories that always become graph nodes; others appear only when imported. */
export function isAlwaysNode(category: FileCategory): boolean {
  return category === 'source' || category === 'config' || category === 'style' || category === 'markup';
}
