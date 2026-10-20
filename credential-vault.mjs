/** Native OS facilities only. Secrets travel over stdin/stdout, never arguments or log output.
 * Only explicit protect-key writes a vault item. Runtime reads never request an unlock prompt.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { macKeychainScript, windowsCredentialScript } from './credential-vault-scripts.mjs';
const SERVICE = 'io.worktrust.cli.credentials.v1';
function invoke(executable, args, input) {
  // Do not inherit credential-bearing WorkTrust environment variables into the OS helper.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKTRUST_|NODE_|PYTHON|DYLD_|LD_)/.test(key)));
  if (process.platform === "darwin") env.HOME = userInfo().homedir; // Keychain belongs to the OS user, not a caller-supplied HOME.
  // Windows PowerShell compiles the small Credential Manager binding on every call; a cold start on a slow or busy
  // machine passed eight seconds on native CI (2026-10-20), so it gets thirty there. Elsewhere eight remain.
  const r = spawnSync(executable, args, { input, env, encoding: 'utf8', timeout: process.platform === 'win32' ? 30000 : 8000, maxBuffer: 32768, windowsHide: true });
  if (r.error || r.status !== 0) throw Error('KEYSTORE_UNAVAILABLE');
  return r.stdout.trim();
}
export function nativeKeyStore() {
  const platform = process.platform;
  const name = platform === 'darwin' ? 'macos-keychain' : platform === 'win32' ? 'windows-credential-manager' : platform === 'linux' ? 'linux-secret-service' : 'unsupported';
  function call(op, id, value) {
    if (!/^[a-f0-9]{64}$/.test(id) || (value !== undefined && !/^[a-f0-9]{64}$/.test(value))) throw Error('KEYSTORE_INVALID_REQUEST');
    if (platform === 'darwin' || platform === 'win32') {
      const executable = platform === 'darwin' ? '/usr/bin/osascript' : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const args = platform === 'darwin' ? ['-l', 'JavaScript', '-e', macKeychainScript] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsCredentialScript];
      const out = invoke(executable, args, JSON.stringify({ op, id, value, service: SERVICE }));
      try { const reply = JSON.parse(out); if (reply.ok === true) return reply.value ?? null; } catch { /* never log OS error payloads */ }
      throw Error('KEYSTORE_UNAVAILABLE');
    }
    if (platform === 'linux') {
      const executable = '/usr/bin/secret-tool';
      if (!existsSync(executable)) throw Error('KEYSTORE_UNAVAILABLE');
      const attributes = ['service', SERVICE, 'account', id];
      if (op === 'get') {
        // `lookup` can unlock and prompt. `search` without --unlock never does.
        const out = invoke(executable, ['search', '--all', ...attributes], '');
        const secrets = [...out.matchAll(/^secret = ([a-f0-9]{64})$/gm)];
        if (secrets.length !== 1) throw Error('KEYSTORE_UNAVAILABLE');
        return secrets[0][1];
      }
      if (op === 'put') return invoke(executable, ['store', '--label=WorkTrust CLI credential encryption', ...attributes], value);
      if (op === 'remove') return invoke(executable, ['clear', ...attributes], '');
    }
    throw Error('KEYSTORE_UNAVAILABLE');
  }
  return { name, get: id => call('get', id), put: (id, value) => call('put', id, value), remove: id => call('remove', id) };
}
