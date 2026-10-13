import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect } from 'vitest';
import { FIXTURE } from '../../packages/analyzer/test/expected.ts';

/* Shared test harness: a mock GitHub API, a local git remote with the fixture repository, and an SSE reader. */

export const TOKEN = 'gho_testtoken_do_not_leak_0123456789';
export const TOTAL_REPOS = 150;

/** Minimal stand-in for api.github.com with pagination, branches and token expiry. */
export function startMockGitHub() {
  const state = { expired: false, port: 0 };
  const repo = (i: number) => {
    const org = i % 3 === 0;
    const owner = i === 0 ? 'acme' : org ? 'acme' : 'octo';
    const name = i === 0 ? 'fixture' : `repo-${String(i).padStart(3, '0')}`;
    return {
      id: 1000 + i,
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner, type: owner === 'acme' ? 'Organization' : 'User' },
      private: i % 2 === 0,
      language: i % 4 === 0 ? 'TypeScript' : 'Go',
      description: i === 0 ? 'Fixture repository' : null,
      updated_at: new Date(Date.UTC(2026, 0, 1) + (TOTAL_REPOS - i) * 3_600_000).toISOString(),
      pushed_at: null,
      default_branch: 'main',
      html_url: `https://github.com/${owner}/${name}`,
      size: 12,
      archived: false,
      fork: false,
    };
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${state.port}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}` || state.expired) return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/user') return json(200, { id: 42, login: 'octo', name: 'Octo Cat', email: 'octo@example.com', avatar_url: 'https://avatars.githubusercontent.com/u/42' });
    if (url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const last = Math.ceil(TOTAL_REPOS / per);
      const items = Array.from({ length: TOTAL_REPOS }, (_, i) => repo(i)).slice((page - 1) * per, page * per);
      const link = (p: number) => `<http://127.0.0.1:${state.port}/user/repos?per_page=${per}&page=${p}>`;
      return json(200, items, page < last ? { link: `${link(page + 1)}; rel="next", ${link(last)}; rel="last"` } : {});
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/branches)?$/.exec(url.pathname);
    if (m) {
      const r = Array.from({ length: TOTAL_REPOS }, (_, i) => repo(i)).find((x) => x.full_name === `${m[1]}/${m[2]}`);
      if (!r) return json(404, { message: 'Not Found' });
      if (m[3]) return json(200, [{ name: 'feature/x', protected: false, commit: { sha: 'b'.repeat(40) } }, { name: 'main', protected: true, commit: { sha: 'a'.repeat(40) } }]);
      return json(200, r);
    }
    json(404, { message: 'Not Found' });
  });
  return new Promise<{ server: Server; state: typeof state; url: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve({ server, state, url: `http://127.0.0.1:${state.port}` });
    }),
  );
}

/** A bare git remote containing the hand-verified fixture, served over file://. */
export function createRemote(root: string) {
  const work = path.join(root, 'work');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  cpSync(FIXTURE, work, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture');
  mkdirSync(path.join(root, 'remotes/acme'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(root, 'remotes/acme/fixture.git')]);
  return `file://${path.join(root, 'remotes')}`;
}

export interface SseEvent {
  event: string;
  data: any;
}

export async function readSse(url: string, cookie: string): Promise<SseEvent[]> {
  const res = await fetch(url, { headers: { cookie } });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  return events;
}
