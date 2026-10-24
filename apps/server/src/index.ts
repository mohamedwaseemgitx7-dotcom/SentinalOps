import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app, setup } = await buildApp(config);

const address = await app.listen({ host: config.host, port: config.port });
app.log.info(`SentinelOps listening on ${address}`);
if (setup) {
  // Printed locally only — the token grants one-time creation of the first administrator.
  console.log(`\n  First-run setup: open ${address.replace('127.0.0.1', 'localhost')}/setup`);
  console.log(`  Setup token (also saved to ${setup.file}):\n\n      ${setup.token}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
