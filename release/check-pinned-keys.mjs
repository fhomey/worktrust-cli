/** Fail a release when the Node/Python pins differ from the reviewed public-key configuration. */
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { join } from 'node:path';
const [cli, python, configFile] = process.argv.slice(2);
if (!cli || !python || !configFile) throw Error('Pinned key check requires CLI, Python and configuration paths');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
if (config.format !== 'worktrust-release-keys/1' || !Object.keys(config.keys ?? {}).length) throw Error('Release roots not configured');
for (const [id, pem] of Object.entries(config.keys)) {
  if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----\n') || pem.includes('PRIVATE KEY')) throw Error('Only public release keys may be embedded');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') !== id) throw Error('Invalid release key identity');
}
const js = /^export const RELEASE_KEYS = (.*); \/\/ GENERATED_RELEASE_KEYS$/m.exec(readFileSync(join(cli, 'package-integrity.mjs'), 'utf8'));
const py = /^RELEASE_KEYS = (.*)  # GENERATED_RELEASE_KEYS$/m.exec(readFileSync(join(python, 'src/worktrust_cli/_release.py'), 'utf8'));
const launcher = /^const RELEASE_KEYS = (.*); \/\/ GENERATED_RELEASE_KEYS$/m.exec(readFileSync(join(cli, 'worktrust-launch.mjs'), 'utf8'));
const pythonEntry = /^RELEASE_KEYS = (.*)  # GENERATED_RELEASE_KEYS$/m.exec(readFileSync(join(python, 'src/worktrust_cli/__init__.py'), 'utf8'));
if ([js, py, launcher, pythonEntry].some(found => !found || JSON.stringify(JSON.parse(found[1])) !== JSON.stringify(config.keys))) throw Error('Pinned keys do not match reviewed configuration');
console.log(`PASS: Node and Python pin the same ${Object.keys(config.keys).length} reviewed release keys`);
