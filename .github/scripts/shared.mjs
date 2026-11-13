import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';

export const repository = 'HamzaArya/aryacode-releases';
export const magic = Buffer.from('ARYA-BUILD-V1\n', 'ascii');
export function inputs() {
  const { SOURCE_TAG: sourceTag, SOURCE_SHA: sourceSha, SOURCE_COMMIT: sourceCommit, RELEASE_TAG: releaseTag } = process.env;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(sourceTag ?? '')) throw new Error('Invalid source transfer tag.');
  if (!/^[a-f0-9]{64}$/.test(sourceSha ?? '')) throw new Error('Invalid encrypted source SHA-256.');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('Invalid source commit.');
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag ?? '')) throw new Error('Invalid desktop release tag.');
  return { sourceTag, sourceSha, sourceCommit, releaseTag };
}
export function key() {
  const encoded = process.env.ARYA_BUILD_SOURCE_KEY ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('A base64 AES-256 source key is required.');
  const result = Buffer.from(encoded, 'base64');
  if (result.length !== 32) throw new Error('Invalid AES-256 source key.');
  return result;
}
export function encrypt(bytes, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext]);
}
export function run(command, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); fail(new Error('Host operation timed out.')); }, options.timeoutMs ?? 120_000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? ok(stdout.trim()) : fail(new Error(options.failureMessage ?? `${command} failed (${code}).`)); });
  });
}
export async function requireDraft(tag) {
  const result = JSON.parse(await run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'isDraft']));
  if (!result.isDraft) throw new Error('Source transfers and build uploads require a draft release.');
}
