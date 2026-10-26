import type { Project } from './api.ts';

/**
 * Single integration point for "Open file". On a project page every file:line link opens the
 * Code tab (registered by the project page); elsewhere (share links) it links to GitHub at the
 * analyzed commit, since shared views do not expose code.
 */
export interface FileOpener {
  href(path: string, line?: number): string | null;
  label: string;
}

let override: ((project: Project, commitSha: string | null) => FileOpener) | null = null;

export function registerFileOpener(factory: ((project: Project, commitSha: string | null) => FileOpener) | null) {
  override = factory;
}

/** The Code tab at a file and line (or range), pinned to a commit when known. */
export function codeHref(projectId: string, path: string, line?: number | string, commitSha?: string | null): string {
  const q = new URLSearchParams({ view: 'code' });
  if (commitSha) q.set('commit', commitSha);
  q.set('file', path);
  if (line) q.set('line', String(line));
  return `/projects/${encodeURIComponent(projectId)}?${q.toString()}`;
}

export function fileOpener(project: Project, commitSha: string | null): FileOpener {
  // Only on the project page itself: shared and embedded views never link into the Code tab.
  if (override && typeof window !== 'undefined' && window.location.pathname.startsWith('/projects/')) return override(project, commitSha);
  return {
    label: 'Open on GitHub',
    href(path, line) {
      if (!project.htmlUrl) return null;
      const ref = commitSha ?? project.branch;
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      return `${project.htmlUrl}/blob/${encodeURIComponent(ref)}/${encoded}${line ? `#L${line}` : ''}`;
    },
  };
}
