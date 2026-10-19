/** Idempotent GitHub release asset publication. Existing bytes are never overwritten. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [directory] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY, tag = process.env.GITHUB_REF_NAME, sha = process.env.GITHUB_SHA;
if (repository !== 'fhomey/worktrust-cli' || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('RELEASE_PUBLISH_CONTEXT_REQUIRED');
const envelope = JSON.parse(readFileSync(join(directory, 'release-artifacts.json'), 'utf8'));
if (`v${envelope.payload.version}` !== tag || envelope.payload.sourceCommit !== sha) throw Error('RELEASE_IDENTITY_MISMATCH');
const names = [...Object.keys(envelope.payload.files), 'release-artifacts.json'];
const basenames = names.map(name => name.split('/').at(-1));
if (new Set(basenames).size !== names.length || names.some(name => !/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('..'))) throw Error('RELEASE_ASSET_NAMES');
const json = args => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
for (const name of names) {
  const path = join(directory, name);
  if (!existsSync(path)) throw Error('RELEASE_ASSET_MISSING');
  const digest = 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
  const release = json([`repos/${repository}/releases/tags/${tag}`]);
  const prior = release.assets.find(asset => asset.name === name.split('/').at(-1));
  if (prior) { if (prior.digest !== digest) throw Error('RELEASE_EXISTING_ASSET_DIFFERS'); }
  else execFileSync('gh', ['release', 'upload', tag, path, '--repo', repository], { stdio: 'inherit' });
}
console.log(`Published ${names.length} immutable signed release assets for ${tag}`);
