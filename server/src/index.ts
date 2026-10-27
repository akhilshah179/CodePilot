import { buildApp, startSampleAnalysis } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const ctx = await buildApp(config);

if (config.google.clientId && config.google.clientSecret) {
  ctx.app.log.info({ callbackUrl: config.google.callbackUrl }, 'Google OAuth configured');
} else {
  ctx.app.log.warn('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
}

if (config.github.clientId && config.github.clientSecret) {
  ctx.app.log.info({ callbackUrl: config.github.callbackUrl }, 'GitHub OAuth configured');
} else if (config.devGithubToken) {
  ctx.app.log.warn('GitHub OAuth is not configured; development sign-in with DEV_GITHUB_TOKEN is enabled.');
} else {
  ctx.app.log.warn(
    'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET (or DEV_GITHUB_TOKEN for local development).',
  );
}

startSampleAnalysis(ctx, config);
await ctx.app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.app.close().finally(() => process.exit(0));
  });
}
