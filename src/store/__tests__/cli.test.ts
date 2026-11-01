import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '..';
import { createAccount, createSession, getAccount, recordFailure, throttleRemaining } from '../../auth/localData';
import { verifyPassword } from '../../auth/password';
import { createToken, findToken, listTokens } from '../../auth/tokens';
import { runCli } from '../cli';
import { SqliteStore } from '../sqlite';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-cli-'));
  env = { STORE: 'sqlite', SQLITE_PATH: join(dir, 'budget.sqlite') };
});

afterEach(() => {
  setStore(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function seedDatabase(): Promise<void> {
  const store = new SqliteStore(env.SQLITE_PATH as string);
  await store.put({ PK: 'USER#auth0|abc', SK: 'CAT#c1', name: 'Garden' });
  store.close();
}

describe('runCli', () => {
  it('exports to an owner-only file and refuses to overwrite it', async () => {
    await seedDatabase();
    const out = join(dir, 'budget-export.jsonl');

    const message = await runCli(['export', 'auth0|abc', '--out', out], env);

    expect(message).toContain('Exported 1 items');
    expect(readFileSync(out, 'utf8')).toContain('"CAT#c1"');
    expect(statSync(out).mode & 0o077).toBe(0);
    setStore(undefined);
    await expect(runCli(['export', 'auth0|abc', '--out', out], env)).rejects.toThrow(/EEXIST/);
  });

  it('imports a file under a new user id', async () => {
    const input = join(dir, 'in.jsonl');
    writeFileSync(input, '{"PK":"USER#auth0|abc","SK":"CAT#c1","name":"Garden"}\n');

    const message = await runCli(['import', '--in', input, '--as-user', 'local-1'], env);

    expect(message).toContain('Imported 1 items');
    setStore(undefined);
    const store = new SqliteStore(env.SQLITE_PATH as string);
    expect(await store.get({ PK: 'USER#local-1', SK: 'CAT#c1' })).toMatchObject({ name: 'Garden' });
  });

  it('prints usage for a missing argument, an unknown command and --help', async () => {
    await expect(runCli(['export'], env)).rejects.toThrow('Usage');
    await expect(runCli(['frobnicate'], env)).rejects.toThrow('Usage');
    expect(await runCli(['--help'], env)).toContain('Usage');
  });

  it('does not create any file when the output path is missing', async () => {
    await seedDatabase();
    const before = readdirSync(dir);
    await expect(runCli(['export', 'someone'], env)).rejects.toThrow('Usage');
    expect(readdirSync(dir)).toEqual(before);
  });

  it('refuses to export a user with no data and writes no file', async () => {
    await seedDatabase();
    const out = join(dir, 'empty-export.jsonl');
    await expect(runCli(['export', 'auth0|typo', '--out', out], env)).rejects.toThrow('No data found for user "auth0|typo"');
    expect(existsSync(out)).toBe(false);
  });

  describe('a missing SQLite database', () => {
    it.each([
      ['export', ['export', 'auth0|abc', '--out', 'out.jsonl']],
      ['backup', ['backup', '--out', 'copy.sqlite']],
      ['reset-password', ['reset-password']],
    ])('is not created by %s', async (_name, args) => {
      const argv = args.map(arg => (arg.endsWith('.jsonl') || arg.endsWith('.sqlite') ? join(dir, arg) : arg));

      await expect(runCli(argv, env)).rejects.toThrow(/No SQLite database at .*budget\.sqlite/);

      expect(readdirSync(dir)).toEqual([]);
    });

    it('is still created by import, which is how a fresh instance gets its first data', async () => {
      const input = join(dir, 'in.jsonl');
      writeFileSync(input, '{"PK":"USER#auth0|abc","SK":"CAT#c1","name":"Garden"}\n');

      await runCli(['import', '--in', input, '--as-user', 'local-1'], env);

      expect(existsSync(env.SQLITE_PATH as string)).toBe(true);
    });
  });

  describe('finding the database from DATA_DIR', () => {
    it('uses the legacy budget.sqlite when it is the only database', async () => {
      await seedDatabase();
      const out = join(dir, 'copy.sqlite');

      await runCli(['backup', '--out', out], { STORE: 'sqlite', DATA_DIR: dir });

      expect(existsSync(out)).toBe(true);
      expect(existsSync(join(dir, 'hoardwise.sqlite'))).toBe(false);
    });

    it('lets an explicit SQLITE_PATH win over DATA_DIR', async () => {
      await seedDatabase();
      const out = join(dir, 'copy.sqlite');

      await runCli(['backup', '--out', out], { ...env, DATA_DIR: join(dir, 'elsewhere') });

      expect(existsSync(out)).toBe(true);
    });
  });

  describe('reset-password', () => {
    async function seedAccount(): Promise<void> {
      const store = new SqliteStore(env.SQLITE_PATH as string);
      await createAccount(store, 'me@example.com', 'the old password 1');
      await createSession(store, 'local|u1', Math.floor(Date.now() / 1000));
      for (let i = 0; i < 6; i++) await recordFailure(store, Math.floor(Date.now() / 1000));
      store.close();
    }

    it('sets the new password, ends every session and clears the lock-out', async () => {
      await seedAccount();
      const message = await runCli(['reset-password'], env, { readPassword: async () => 'the new password 22' });
      expect(message).toMatch(/all sessions and access tokens/i);

      const store = new SqliteStore(env.SQLITE_PATH as string);
      expect(await verifyPassword('the new password 22', (await getAccount(store))!)).toBe(true);
      expect(await store.query('AUTH#SESSIONS')).toEqual([]);
      expect(await throttleRemaining(store, Math.floor(Date.now() / 1000))).toBe(0);
      store.close();
    });

    it('revokes every access token and leaves other data alone', async () => {
      await seedAccount();
      const now = Math.floor(Date.now() / 1000);
      const seed = new SqliteStore(env.SQLITE_PATH as string);

      const read = await createToken(seed, { userId: 'local|u1', name: 'r', scope: 'read', expiryDays: null }, now);
      const write = await createToken(seed, { userId: 'local|u1', name: 'w', scope: 'write', expiryDays: null }, now);
      await seed.put({ PK: 'USER#local|u1', SK: 'CAT#c1', name: 'Garden' });
      seed.close();

      await runCli(['reset-password'], env, { readPassword: async () => 'the new password 22' });

      const store = new SqliteStore(env.SQLITE_PATH as string);

      expect(await listTokens(store, 'local|u1')).toEqual([]);
      expect(await findToken(store, read.token, now)).toBeUndefined();
      expect(await findToken(store, write.token, now)).toBeUndefined();
      expect(await store.get({ PK: 'USER#local|u1', SK: 'CAT#c1' })).toBeDefined();
      store.close();
    });

    it('replaces the password before ending sessions, so no old-password session can outlive the reset', async () => {
      await seedAccount();
      const realDelete = SqliteStore.prototype.delete;
      let oldPasswordStillWorkedAtSessionDelete: boolean | undefined;
      vi.spyOn(SqliteStore.prototype, 'delete').mockImplementation(async function (this: SqliteStore, key, options) {
        if (key.PK === 'AUTH#SESSIONS' && oldPasswordStillWorkedAtSessionDelete === undefined) {
          oldPasswordStillWorkedAtSessionDelete = await verifyPassword('the old password 1', (await getAccount(this))!);
        }
        return realDelete.call(this, key, options);
      });

      await runCli(['reset-password'], env, { readPassword: async () => 'the new password 22' });
      vi.restoreAllMocks();

      expect(oldPasswordStillWorkedAtSessionDelete).toBe(false);
      const store = new SqliteStore(env.SQLITE_PATH as string);
      expect(await store.query('AUTH#SESSIONS')).toEqual([]);
      expect(await verifyPassword('the new password 22', (await getAccount(store))!)).toBe(true);
      store.close();
    });

    it('has already replaced the password, and says to run again, when the token sweep cannot finish', async () => {
      await seedAccount();
      const seed = new SqliteStore(env.SQLITE_PATH as string);
      await createToken(seed, { userId: 'local|u1', name: 'r', scope: 'read', expiryDays: null }, Math.floor(Date.now() / 1000));
      seed.close();

      const realDelete = SqliteStore.prototype.delete;
      let n = 0;
      vi.spyOn(SqliteStore.prototype, 'delete').mockImplementation(async function (this: SqliteStore, key, options) {
        await realDelete.call(this, key, options);
        await this.put({ PK: 'AUTH#TOKENS', SK: `again-${n++}`, userId: 'local|u1', tokenId: `t${n}` });
      });

      const failure = await runCli(['reset-password'], env, { readPassword: async () => 'the new password 22' }).then(
        () => undefined,
        (error: Error) => error,
      );
      vi.restoreAllMocks();

      expect(failure?.message).toBe('The password was changed, but not every access token could be revoked. Run this command again to finish.');
      expect(failure?.message).not.toContain('the new password 22');
      const store = new SqliteStore(env.SQLITE_PATH as string);
      expect(await verifyPassword('the new password 22', (await getAccount(store))!)).toBe(true);
      expect(await verifyPassword('the old password 1', (await getAccount(store))!)).toBe(false);
      store.close();
    });

    it('refuses a password that fails the policy, changing nothing', async () => {
      await seedAccount();
      await expect(runCli(['reset-password'], env, { readPassword: async () => 'short' })).rejects.toThrow(/at least 12/);
      const store = new SqliteStore(env.SQLITE_PATH as string);
      expect(await verifyPassword('the old password 1', (await getAccount(store))!)).toBe(true);
      expect((await store.query('AUTH#SESSIONS')).length).toBe(1);
      store.close();
    });

    it('refuses when no account exists yet', async () => {
      await seedDatabase();
      await expect(runCli(['reset-password'], env, { readPassword: async () => 'the new password 22' })).rejects.toThrow(/No account/);
    });

    it('never takes the password from argv or the environment', async () => {
      await seedAccount();
      const readPassword = vi.fn(async () => 'a valid password 99');
      await expect(runCli(['reset-password', 'sneaky-password-123'], env, { readPassword })).rejects.toThrow(/Usage/);
      expect(readPassword).not.toHaveBeenCalled();
      const store = new SqliteStore(env.SQLITE_PATH as string);
      expect(await verifyPassword('the old password 1', (await getAccount(store))!)).toBe(true);
      expect((await store.query('AUTH#SESSIONS')).length).toBe(1);
      store.close();
    });
  });

  describe('backup', () => {
    it('writes a verified owner-only copy and refuses to overwrite', async () => {
      await seedDatabase();
      const out = join(dir, 'copy.sqlite');
      const message = await runCli(['backup', '--out', out], env);
      expect(message).toContain('Backed up');
      expect(statSync(out).mode & 0o077).toBe(0);
      setStore(undefined);
      await expect(runCli(['backup', '--out', out], env)).rejects.toThrow(/already exists/);
    });

    it('needs --out and a SQLite store', async () => {
      await expect(runCli(['backup'], env)).rejects.toThrow(/Usage/);
      setStore(undefined);
      await expect(runCli(['backup', '--out', join(dir, 'x.sqlite')], { STORE: 'dynamodb', DYNAMODB_TABLE: 't' })).rejects.toThrow(/sqlite/i);
    });
  });
});
