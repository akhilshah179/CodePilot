import { describe, expect, it } from 'vitest';
import { classifyFile, type ContentFacts } from '../src/classifier.ts';
import { parseSource } from '../src/parser/index.ts';

const facts = (src: string, file = 'x.tsx'): ContentFacts => {
  const r = parseSource(src, file, file.endsWith('x') ? 'tsx' : 'typescript');
  return { directives: r.directives, hasJsx: r.hasJsx, exportedHttpMethods: r.exportedHttpMethods, exportsCapitalized: r.capitalizedExport };
};

describe('classifyFile', () => {
  it.each([
    ['app/dashboard/page.tsx', 'page', 'path:next-app-page'],
    ['src/app/api/users/route.ts', 'api', 'path:next-app-route'],
    ['app/layout.tsx', 'route', 'path:next-app-segment'],
    ['pages/api/login.ts', 'api', 'path:pages-api'],
    ['api/handler.ts', 'api', 'path:dir-api'],
    ['src/components/Nav.tsx', 'component', 'path:dir-component'],
    ['src/services/billing.ts', 'service', 'path:dir-service'],
    ['src/utils/strings.ts', 'utility', 'path:dir-utility'],
    ['src/components/utils/cx.ts', 'utility', 'path:dir-utility'],
    ['src/user.service.ts', 'service', 'path:suffix-service'],
    ['next.config.mjs', 'config', 'path:config-pattern'],
    ['src/components/Nav.test.tsx', 'other', 'path:test'],
    ['src/misc.ts', 'other', 'default:other'],
  ])('%s → %s', (file, type, rule) => {
    const c = classifyFile(file, 'source');
    expect(c.type).toBe(type);
    expect(c.evidence[0].rule).toBe(rule);
  });

  it('falls back to source content with line evidence', () => {
    const action = classifyFile('src/mutations.ts', 'source', facts("'use server';\nexport async function save() {}", 'm.ts'));
    expect(action).toMatchObject({ type: 'action', evidence: [{ rule: 'content:use-server', line: 1 }] });

    const api = classifyFile('src/handler.ts', 'source', facts('export async function GET() {}\nexport const POST = () => {};', 'h.ts'));
    expect(api.type).toBe('api');
    expect(api.evidence[0].detail).toContain('GET, POST');

    const comp = classifyFile('src/Widget.tsx', 'source', facts('export default function Widget() { return <div/>; }'));
    expect(comp).toMatchObject({ type: 'component', evidence: [{ rule: 'content:jsx-component' }] });
  });

  it('path rules take precedence over content rules', () => {
    const c = classifyFile('src/utils/render.tsx', 'source', facts("'use server';\nexport const X = () => <b/>;"));
    expect(c.type).toBe('utility');
  });
});
