import type { Project } from './api.ts';

/**
 * Single integration point for "Open file". Today it links to the file on GitHub at the
 * analyzed commit; the File Explorer will register itself here to open files in-app.
 */
export interface FileOpener {
  href(path: string, line?: number): string | null;
  label: string;
}

let override: ((project: Project, commitSha: string | null) => FileOpener) | null = null;

export function registerFileOpener(factory: (project: Project, commitSha: string | null) => FileOpener) {
  override = factory;
}

export function fileOpener(project: Project, commitSha: string | null): FileOpener {
  if (override) return override(project, commitSha);
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
