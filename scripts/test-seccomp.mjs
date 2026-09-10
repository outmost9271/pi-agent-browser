import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const baseline = '.cache/sources/moby-profiles/seccomp/default.json';

test('derived policy preserves the entire pinned default policy', () => {
  const original = JSON.parse(readFileSync(baseline, 'utf8'));
  const derived = JSON.parse(readFileSync('config/seccomp-browser.json', 'utf8'));
  const addition = derived.syscalls.pop();
  assert.deepEqual(derived, original);
  assert.deepEqual(addition.names, ['clone', 'setns', 'unshare']);
  assert.equal(addition.action, 'SCMP_ACT_ALLOW');
  assert.equal(Object.keys(addition).length, 3);
});

test('generation is reproducible and rejects unreviewed source changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'piab-seccomp-'));
  try {
    const output = join(directory, 'generated.json');
    let result = spawnSync(process.execPath, ['scripts/generate-seccomp.mjs', baseline, output]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(readFileSync(output), readFileSync('config/seccomp-browser.json'));
    const modified = join(directory, 'modified.json');
    writeFileSync(modified, readFileSync(baseline, 'utf8') + '\n');
    result = spawnSync(process.execPath, ['scripts/generate-seccomp.mjs', modified, output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /checksum mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
