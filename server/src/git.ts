import { spawn } from 'node:child_process';
import { AppError, githubAuthExpired } from './errors.ts';

export interface CloneProgress {
  phase: string;
  percent: number;
}

export interface CloneOptions {
  url: string;
  branch: string;
  dest: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (p: CloneProgress) => void;
}

/**
 * Shallow, single-branch clone. The token is passed as an HTTP header through
 * GIT_CONFIG_* environment variables — never in the URL, argv, or .git/config —
 * so it cannot leak through process listings, logs or the cloned repository.
 */
export async function cloneRepository(opts: CloneOptions): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
  };
  if (opts.token) {
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  const args = [
    '-c', 'core.symlinks=false',
    '-c', 'submodule.recurse=false',
    'clone', '--depth', '1', '--single-branch', '--no-tags', '--progress',
    '--branch', opts.branch,
    '--', opts.url, opts.dest,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AppError('clone_timeout', `Cloning took longer than ${Math.round(opts.timeoutMs / 60000)} minutes. Try a smaller branch or retry later.`, 504));
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new AppError('interrupted', 'Analysis was cancelled.', 499));
    };
    opts.signal?.addEventListener('abort', onAbort);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
      // git writes progress lines separated by \r, e.g. "Receiving objects:  45% (450/1000)".
      for (const part of chunk.split(/[\r\n]+/)) {
        const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(part.trim());
        if (m) opts.onProgress?.({ phase: m[1].trim(), percent: Number(m[2]) });
      }
    });
    child.on('error', (err) => finish(new AppError('clone_failed', `git could not be started: ${err.message}`, 500)));
    child.on('close', (code) => {
      if (code === 0) return finish();
      finish(classifyCloneError(stderr, opts.branch));
    });
  });
}

export async function headCommit(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('rev-parse failed'))));
  });
}

export function classifyCloneError(stderr: string, branch: string): AppError {
  if (/Remote branch .* not found|couldn't find remote ref/i.test(stderr)) {
    return new AppError('branch_not_found', `Branch "${branch}" no longer exists on GitHub. Pick another branch and start again.`, 404);
  }
  if (/Authentication failed|could not read Username|invalid credentials|HTTP 401/i.test(stderr)) return githubAuthExpired();
  if (/Repository not found|HTTP 404|does not appear to be a git repository/i.test(stderr)) {
    return new AppError('repo_not_found', 'The repository was not found, or CodePilot lost access to it. Check that it still exists and that access has been granted.', 404);
  }
  if (/HTTP 403/i.test(stderr)) {
    return new AppError('github_forbidden', 'GitHub refused the clone. An organization owner may need to approve CodePilot’s access.', 403);
  }
  return new AppError('clone_failed', 'Cloning the repository failed. Try again; if it keeps failing, check the repository on GitHub.', 502);
}
