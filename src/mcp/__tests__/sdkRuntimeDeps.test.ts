import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { installedVersion } = createRequire(import.meta.url)('../../../scripts/sdk-runtime-deps.cjs') as {
  installedVersion: (root: string, name: string) => string;
};

let root: string;

function install(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
}

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installedVersion', () => {
  it('prefers the copy nested under the SDK over a hoisted one', () => {
    root = mkdtempSync(join(tmpdir(), 'sdk-deps-'));
    install(join(root, 'node_modules', 'zod'), '3.25.0');
    install(join(root, 'node_modules', '@modelcontextprotocol', 'server', 'node_modules', 'zod'), '4.6.7');
    expect(installedVersion(root, 'zod')).toBe('4.6.7');
  });

  it('falls back to the hoisted copy', () => {
    root = mkdtempSync(join(tmpdir(), 'sdk-deps-'));
    install(join(root, 'node_modules', 'zod'), '4.6.7');
    expect(installedVersion(root, 'zod')).toBe('4.6.7');
  });

  it('names the package and says to run yarn install when neither exists', () => {
    root = mkdtempSync(join(tmpdir(), 'sdk-deps-'));
    expect(() => installedVersion(root, 'zod')).toThrow(/zod.*yarn install/);
  });
});
