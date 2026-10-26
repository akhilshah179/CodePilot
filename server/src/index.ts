```typescript
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

// Render deployment configuration
const port = Number(process.env.PORT) || config.port;
const host = process.env.HOST || '0.0.0.0';

await ctx.app.listen({ port, host });

ctx.app.log.info(`CodePilot server listening on ${host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    ctx.app.close().finally(() => process.exit(0));
  });
}
```
