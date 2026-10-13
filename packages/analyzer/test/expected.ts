import path from 'node:path';
import type { GraphEdge } from '../src/types.ts';

export const FIXTURE = path.join(import.meta.dirname, 'fixtures/basic-repo');

/**
 * Hand-verified edge set for fixtures/basic-repo. Each row was checked against the
 * fixture source: [source, target, kind, line, resolved].
 */
export const EXPECTED_EDGES: [string, string, GraphEdge['kind'], number, boolean][] = [
  ['src/app.test.ts', 'src/app.tsx', 'static', 1, true],
  ['src/app.tsx', 'ext:react', 'static', 1, true],
  ['src/app.tsx', 'src/components/index.ts', 'static', 2, true],
  ['src/app.tsx', 'src/hooks/useSession.ts', 'static', 3, true],
  ['src/app.tsx', 'unresolved:src/does-not-exist', 'static', 4, false],
  ['src/components/Button.tsx', 'src/lib/format.ts', 'static', 1, true],
  ['src/components/Card.tsx', 'src/components/index.ts', 'static', 1, true],
  ['src/components/Legacy.jsx', 'src/lib/legacy-helpers.cjs', 'require', 2, true],
  ['src/components/index.ts', 'src/components/Button.tsx', 're-export', 1, true],
  ['src/components/index.ts', 'src/components/Card.tsx', 're-export', 2, true],
  ['src/components/index.ts', 'src/components/Legacy.jsx', 're-export', 3, true],
  ['src/hooks/useSession.ts', 'src/services/session.ts', 'static', 1, true],
  ['src/lib/legacy-helpers.cjs', 'ext:node:path', 'require', 1, true],
  ['src/main.ts', 'src/app.tsx', 'static', 1, true],
  ['src/main.ts', 'src/config/types.ts', 'static', 2, true],
  ['src/main.ts', 'src/styles.css', 'static', 3, true],
  ['src/main.ts', 'src/lib/format.ts', 'static', 4, true],
  ['src/main.ts', 'src/pages/admin/index.tsx', 'dynamic', 6, true],
  ['src/orphan.ts', 'src/lib/format.ts', 'static', 1, true],
  ['src/pages/admin/index.tsx', 'src/components/Card.tsx', 'static', 1, true],
  ['src/routes/users.ts', 'ext:express', 'static', 1, true],
  ['src/server.ts', 'ext:express', 'require', 1, true],
  ['src/server.ts', 'src/routes/users.ts', 'require', 2, true],
  ['src/services/session.ts', 'packages/shared/src/index.ts', 'static', 1, true],
  ['src/services/session.ts', 'packages/shared/src/tokens.ts', 'static', 2, true],
  ['src/services/session.ts', 'unresolved:@fixture/shared/private', 'static', 3, false],
  ['src/services/session.ts', 'unresolved:@fixture/broken', 'static', 4, false],
  ['src/utils/a.ts', 'src/utils/b.ts', 'static', 1, true],
  ['src/utils/b.ts', 'src/utils/a.ts', 'static', 1, true],
  ['src/widgets/Hello.vue', 'src/lib/format.ts', 'static', 3, true],
  ['vite.config.ts', 'ext:vite', 'static', 1, true],
];

export const edgeKey = (e: { source: string; target: string; kind: string; line: number; resolved: boolean }) =>
  `${e.source} -> ${e.target} [${e.kind}] L${e.line} ${e.resolved ? 'resolved' : 'unresolved'}`;

export const expectedEdgeKeys = () =>
  EXPECTED_EDGES.map(([source, target, kind, line, resolved]) => edgeKey({ source, target, kind, line, resolved })).sort();
