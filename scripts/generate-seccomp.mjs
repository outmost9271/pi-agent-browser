import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Derived from moby/profiles, Apache-2.0, pinned in config/upstream-lock.json.
const input = resolve(process.argv[2] ?? '.cache/sources/moby-profiles/seccomp/default.json');
const output = resolve(process.argv[3] ?? 'config/seccomp-browser.json');
const source = readFileSync(input);
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74') {
  throw new Error('Moby seccomp baseline checksum mismatch; review before updating');
}
const policy = JSON.parse(source.toString('utf8'));
if (policy.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(policy.syscalls)) {
  throw new Error('Unexpected Moby seccomp baseline');
}
policy.syscalls.push({
  comment: 'Permit non-root Chromium user namespaces; no container capabilities are added.',
  names: ['clone', 'setns', 'unshare'],
  action: 'SCMP_ACT_ALLOW',
});
writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`);
