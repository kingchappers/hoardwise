import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chooseSqliteFile } from '../../container/config';
import { clearThrottle, deleteAllSessions, getAccount, replacePassword } from '../auth/localData';
import { validatePassword } from '../auth/password';
import { promptHidden } from '../auth/prompt';
import { revokeAllTokens } from '../auth/tokens';
import { initStore, type Store } from '.';
import { exportUser, importUser, parseJsonl, toJsonl } from './transfer';

const USAGE = `Usage:
  export <userId> --out <file>             write one user's data as JSONL (owner-only file, never overwritten)
  import --in <file> --as-user <userId> [--replace]
                                           load a JSONL file under a user id; refuses a user that has data unless --replace
  backup --out <file>                      write a consistent, verified, owner-only copy of the SQLite database (never overwrites; STORE=sqlite only)
  reset-password                           set a new password for the built-in login, end every session and access token and clear any lock-out (prompts; the password is never taken from arguments)

The backend comes from the environment: STORE=dynamodb with DYNAMODB_TABLE (and your AWS credentials),
or STORE=sqlite, which opens the database in DATA_DIR (default /data) the way the container does, or the file named by SQLITE_PATH.
Only import creates a missing SQLite database. The export holds financial data: keep it private and never commit it.

Moving from AWS to a self-hosted instance: export your Auth0 user id (e.g. auth0|abc) from DynamoDB, finish the first-run
setup on the new instance, read your local user id (local|<uuid>) from GET /api/auth/me, then import with --as-user <that id>
against STORE=sqlite (add --replace only if the account already has data).`;

// Opens the same file the container would, so commands need no hard-coded file name. An explicit SQLITE_PATH still wins.
// Only import may create the file: for every other command a missing one means a wrong path, and opening it would leave an
// empty database that the container then prefers over the real one.
function openStore(command: string, env: NodeJS.ProcessEnv): Promise<Store> {
  if (env.STORE !== 'sqlite') return initStore(env);
  const path = env.SQLITE_PATH || chooseSqliteFile(env.DATA_DIR || '/data', existsSync).path;
  if (command !== 'import' && !existsSync(path)) {
    throw new Error(`No SQLite database at ${path}; nothing was created. Check SQLITE_PATH, or leave it unset and point DATA_DIR at the folder holding your database.`);
  }
  return initStore({ ...env, SQLITE_PATH: path });
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, io: { readPassword?: (prompt: string) => Promise<string> } = {}): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      in: { type: 'string' },
      'as-user': { type: 'string' },
      replace: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) return USAGE;

  const [command, userId] = positionals;
  if (command === 'export') {
    if (!userId || !values.out) throw new Error(USAGE);
    const store = await openStore('export', env);
    const items = await exportUser(store, userId);
    if (items.length === 0) throw new Error(`No data found for user "${userId}"; nothing was exported`);
    writeFileSync(values.out, toJsonl(items), { mode: 0o600, flag: 'wx' });
    return `Exported ${items.length} items for ${userId} to ${values.out}`;
  }

  if (command === 'import') {
    const asUser = values['as-user'];
    if (!values.in || !asUser) throw new Error(USAGE);
    const items = parseJsonl(readFileSync(values.in, 'utf8'));
    const store = await openStore('import', env);
    const count = await importUser(store, items, { asUser, replace: values.replace });
    return `Imported ${count} items as ${asUser}`;
  }

  if (command === 'reset-password') {
    if (userId) throw new Error(USAGE); // a password-shaped argument is a mistake, and must not be echoed back
    const store = await openStore('reset-password', env);
    if (!(await getAccount(store))) {
      throw new Error('No account exists yet. Open the app and complete the first-run setup first.');
    }
    const password = await (io.readPassword ?? promptHidden)('New password: ');
    const problem = validatePassword(password);
    if (problem) throw new Error(problem);
    await deleteAllSessions(store);
    await revokeAllTokens(store);
    await replacePassword(store, password);
    await clearThrottle(store);
    return 'Password reset. All sessions and access tokens have ended and any login lock-out is cleared.';
  }

  if (command === 'backup') {
    if (!values.out) throw new Error(USAGE);
    const store = await openStore('backup', env);
    // Loaded here so the AWS export path never touches node:sqlite.
    const { SqliteStore } = await import('./sqlite');
    if (!(store instanceof SqliteStore)) throw new Error('backup works with STORE=sqlite only');
    const { backupToFile } = await import('./backup');
    backupToFile(store, values.out);
    return `Backed up the database to ${values.out}`;
  }

  throw new Error(USAGE);
}
