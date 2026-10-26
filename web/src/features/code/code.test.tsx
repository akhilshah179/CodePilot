import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeEntry, CodeFile } from '../../lib/api.ts';
import { highlight, MASK } from './highlight.ts';
import { ancestors, buildTree, flatten, parseLines, parseLocation } from './tree.ts';
import { Viewer } from './Viewer.tsx';

const kinds = (line: [string, string][]) => line.filter(([k]) => k).map(([k, t]) => `${k}:${t}`);

describe('highlighting', () => {
  it('tokenizes TypeScript with state across lines and keeps every character', () => {
    const src = "import { a } from './a';\n/* block\n still */ const x = `multi\nline` + 42; // done\nfoo(Bar);\n";
    const lines = highlight(src, 'typescript');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.map(([, t]) => t).join(''))).toEqual(src.split('\n').slice(0, 5));
    expect(kinds(lines[0])).toContain("s:'./a'");
    expect(kinds(lines[1])[0]).toBe('c:/* block');
    expect(kinds(lines[2])).toEqual(expect.arrayContaining(['c: still */', 'k:const', 's:`multi']));
    expect(kinds(lines[3])).toEqual(expect.arrayContaining(['s:line`', 'n:42', 'c:// done']));
    expect(kinds(lines[4])).toEqual(['f:foo', 'p:(', 't:Bar', 'p:);']);
    expect(kinds(highlight('foo(Bar);', 'typescript')[0])).toEqual(['f:foo', 'p:(', 't:Bar', 'p:);']);
  });

  it('handles Python strings, markup, JSON keys and plain text', () => {
    const py = highlight('def f():\n    """doc\n    more"""\n    return None  # c\n', 'python');
    expect(kinds(py[0])).toContain('k:def');
    expect(kinds(py[2])).toContain('s:    more"""');
    expect(kinds(py[3])).toEqual(expect.arrayContaining(['k:return', 'n:None', 'c:# c']));
    const html = highlight('<a href="x">hi</a><!-- c -->', 'html');
    expect(kinds(html[0])).toEqual(['x:<a', 'a:href', 'p:=', 's:"x"', 'x:>', 'x:</a>', 'c:<!-- c -->']);
    expect(kinds(highlight('{"key": 1, "v": "s"}', 'json')[0])).toEqual(expect.arrayContaining(['a:"key"', 'n:1', 's:"s"']));
    expect(highlight('just words\n', 'text')).toEqual([[['', 'just words']]]);
  });

  it('marks masked secrets as their own token', () => {
    const [line] = highlight(`const k = '${MASK}';`, 'typescript');
    expect(line).toContainEqual(['m', MASK]);
    expect(line.map(([, t]) => t).join('')).toBe(`const k = '${MASK}';`);
  });
});

describe('explorer model', () => {
  const entries: CodeEntry[] = [
    { p: 'src/b.ts', l: 'typescript' },
    { p: 'README.md', l: 'markdown' },
    { p: 'src/a/z.ts', l: 'typescript' },
    { p: 'node_modules/', r: 'excluded-directory', d: 1 },
    { p: '.env', r: 'secret-file' },
    { p: 'src/a10.ts', l: 'typescript' },
    { p: 'src/a2.ts', l: 'typescript' },
  ];
  const root = buildTree(entries);

  it('sorts folders first and names naturally, keeps excluded entries, counts stored files', () => {
    expect(root.children.map((c) => c.name)).toEqual(['node_modules', 'src', '.env', 'README.md']);
    expect(root.files).toBe(5);
    const src = root.children[1];
    expect(src.children.map((c) => c.name)).toEqual(['a', 'a2.ts', 'a10.ts', 'b.ts']);
    expect(root.children[0]).toMatchObject({ dir: true, reason: 'excluded-directory' });
  });

  it('flattens expanded folders and filters by path with folders kept', () => {
    expect(flatten(root, new Set()).map((r) => r.node.path)).toEqual(['node_modules', 'src', '.env', 'README.md']);
    expect(flatten(root, new Set(['src', 'src/a'])).map((r) => `${r.depth}:${r.node.path}`)).toContain('2:src/a/z.ts');
    expect(flatten(root, new Set(), 'z.ts').map((r) => r.node.path)).toEqual(['src', 'src/a', 'src/a/z.ts']);
    expect(ancestors('src/a/z.ts')).toEqual(['src', 'src/a']);
  });

  it('parses line links', () => {
    expect(parseLines('12')).toEqual({ from: 12, to: 12 });
    expect(parseLines('20-12')).toEqual({ from: 20, to: 20 });
    expect(parseLines('5-9')).toEqual({ from: 5, to: 9 });
    expect(parseLines('x')).toBeNull();
    expect(parseLocation('src/a.ts:42')).toEqual({ path: 'src/a.ts', from: 42, to: 42 });
    expect(parseLocation('src/a.ts')).toEqual({ path: 'src/a.ts' });
  });
});

describe('viewer', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(cleanup);
  const base = { range: null, scrollNonce: 0, imports: [], githubHref: null, copied: null, onCrumb: vi.fn(), onOpen: vi.fn(), onLine: vi.fn(), onCopy: vi.fn(), onNote: vi.fn() };

  it('renders HTML and scripts in a file as text — nothing is parsed or executed', () => {
    const xss = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"><b>bold</b>';
    const file: CodeFile = { path: 'evil.html', stored: true, language: 'html', size: xss.length, lines: 1, maskedLines: [], content: `${xss}\n`, analysisId: 'a' };
    const { container } = render(<Viewer {...base} file={file} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('.cv-text')?.textContent).toBe(xss);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // Paths are text too.
    const named: CodeFile = { ...file, path: 'src/<img src=x onerror=alert(1)>.ts' };
    const r2 = render(<Viewer {...base} file={named} />);
    expect(r2.container.querySelectorAll('img')).toHaveLength(0);
  });

  it('shows masked secrets, line numbers, highlighted ranges and clickable imports', () => {
    const file: CodeFile = { path: 'src/a.ts', stored: true, language: 'typescript', size: 60, lines: 3, maskedLines: [2], content: `import x from './b';\nconst KEY = '${MASK}';\nimport y from 'nope';\n`, analysisId: 'a' };
    const onOpen = vi.fn();
    const onNote = vi.fn();
    const imports = [
      { specifier: './b', line: 1, symbols: ['default'], typeOnly: false, resolved: true, external: false, target: 'src/b.ts', packageName: null, reason: null },
      { specifier: 'nope', line: 3, symbols: ['default'], typeOnly: false, resolved: false, external: false, target: null, packageName: null, reason: 'Package "nope" is not installed' },
    ];
    const { container, getByText, getByLabelText } = render(<Viewer {...base} file={file} imports={imports} range={{ from: 2, to: 3 }} onOpen={onOpen} onNote={onNote} />);
    expect(container.querySelector('.t-m')?.textContent).toBe(MASK);
    expect(getByText('1 masked')).toBeTruthy();
    expect([...container.querySelectorAll('.cv-line.is-hl')].map((l) => l.querySelector('.cv-ln')?.textContent)).toEqual(['2', '3']);
    fireEvent.click(getByLabelText('Open src/b.ts'));
    expect(onOpen).toHaveBeenCalledWith('src/b.ts');
    fireEvent.click(getByLabelText('Unresolved import: Package "nope" is not installed'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onNote.mock.calls[0][0]).toMatch(/nope: unresolved/);
  });

  it('explains files that were not stored', () => {
    const file: CodeFile = { path: '.env', stored: false, directory: false, reason: 'secret-file', reasonText: 'Sensitive file (environment, key or credentials) — never stored', size: null };
    const { getByText } = render(<Viewer {...base} file={file} />);
    expect(getByText('.env was not stored')).toBeTruthy();
  });
});
