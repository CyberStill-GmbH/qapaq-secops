import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./pin-base-images.mjs', import.meta.url));

test('pins frontend bases to immutable digests and rejects unknown upstream Dockerfiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ankay-pin-'));
  try {
    const dockerfile = join(directory, 'Dockerfile');
    writeFileSync(dockerfile, 'FROM node:23 AS builder\nFROM nginx:1.29.3\n');
    const result = spawnSync(process.execPath, [script, 'frontend', dockerfile], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const pinned = readFileSync(dockerfile, 'utf8');
    assert.match(pinned, /^FROM .+@sha256:[0-9a-f]{64} AS builder$/m);
    assert.match(pinned, /^FROM .+@sha256:[0-9a-f]{64}$/m);

    writeFileSync(dockerfile, 'FROM node:latest\nFROM nginx:latest\n');
    const mismatch = spawnSync(process.execPath, [script, 'frontend', dockerfile], {
      encoding: 'utf8',
    });
    assert.notEqual(mismatch.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
