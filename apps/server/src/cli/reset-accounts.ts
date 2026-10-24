// Account recovery: run on the host while the server is stopped.
//   npm run reset-accounts -w @sentinelops/server
// Removes all user accounts, sessions and invitations (monitoring data, findings and history are kept).
// The next server start prints a new one-time setup token so a new administrator can be created.
import { loadConfig } from '../config.ts';
import { openDb, tx } from '../db.ts';
import { audit } from '../lib/events.ts';

const config = loadConfig();
if (!process.argv.includes('--yes')) {
  console.log(`This removes ALL SentinelOps accounts and sessions in ${config.dataDir} (data is kept).`);
  console.log('Stop the server first, then re-run with --yes.');
  process.exit(1);
}
const db = openDb(config.dataDir, config.dbFile);
const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
tx(db, () => {
  db.exec('DELETE FROM sessions; DELETE FROM invites; DELETE FROM users;');
  audit(db, { action: 'auth.accounts_reset', detail: `${users} account(s) removed via local CLI` });
});
db.close();
console.log(`Removed ${users} account(s). Start the server to get a new setup token.`);
