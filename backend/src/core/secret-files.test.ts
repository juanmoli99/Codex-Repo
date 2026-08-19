import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSecretFileEnvironment } from './secret-files.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('resolveSecretFileEnvironment', () => {
  it('loads a trimmed secret from an absolute file path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aegis-secret-'));
    directories.push(directory);
    const path = join(directory, 'session-secret');
    writeFileSync(path, 'a-secret-value-with-sufficient-entropy\n', { encoding: 'utf8' });

    const resolved = resolveSecretFileEnvironment({ SESSION_SIGNING_SECRET_FILE: path });

    expect(resolved.SESSION_SIGNING_SECRET).toBe('a-secret-value-with-sufficient-entropy');
  });

  it('rejects ambiguous inline and file-backed values', () => {
    expect(() =>
      resolveSecretFileEnvironment({
        SESSION_SIGNING_SECRET: 'inline',
        SESSION_SIGNING_SECRET_FILE: 'C:\\secrets\\session',
      }),
    ).toThrow(/cannot both be configured/);
  });
});
