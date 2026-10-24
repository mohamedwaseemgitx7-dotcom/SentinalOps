// Bundles the server (and its load-test worker) into self-contained ESM files and
// copies the built web UI, so the packaged app has no node_modules at runtime.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(root, '..', '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', banner, legalComments: 'none', logLevel: 'info' };
await build({ ...common, entryPoints: [path.join(repo, 'apps/server/src/embedded.ts')], outfile: path.join(out, 'server.mjs') });
await build({ ...common, entryPoints: [path.join(repo, 'apps/server/src/loadtest/worker.ts')], outfile: path.join(out, 'worker.mjs') });
await build({ bundle: false, platform: 'node', format: 'cjs', target: 'node22', entryPoints: [path.join(root, 'src/main.cts'), path.join(root, 'src/preload.cts')], outdir: out, outExtension: { '.js': '.cjs' }, logLevel: 'info' });

const web = path.join(repo, 'apps/web/dist');
if (!fs.existsSync(path.join(web, 'index.html'))) throw new Error('Build the web UI first: npm run build -w @sentinelops/web');
fs.cpSync(web, path.join(out, 'web'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/error.html'), path.join(out, 'error.html'));
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(out, 'icon.png'));
console.log('desktop bundle ready:', out);
