import { buildApp, startSampleAnalysis } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const ctx = await buildApp(config);

if (!config.github.clientId) {
  ctx.app.log.warn(
    config.devGithubToken
      ? 'GitHub OAuth is not configured; development sign-in with DEV_GITHUB_TOKEN is enabled.'
      : 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET (or DEV_GITHUB_TOKEN for local development).',
  );
}

startSampleAnalysis(ctx, config);
await ctx.app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.app.close().finally(() => process.exit(0));
  });
}
