import { createDecipheriv, createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { inputs, key, magic, repository, requireDraft, run } from './shared.mjs';

const { sourceTag, sourceSha, sourceCommit, releaseTag } = inputs();
const encryptionKey = key();
if (!isAbsolute(process.env.RUNNER_TEMP ?? '')) throw new Error('Missing native runner temporary directory.');
const directory = join(process.env.RUNNER_TEMP, 'arya-transfer');
const source = join(process.env.RUNNER_TEMP, 'arya-source');
const logs = join(process.env.RUNNER_TEMP, 'arya-build-logs');
await mkdir(directory, { recursive: true }); await mkdir(logs, { recursive: true });
await requireDraft(sourceTag); await requireDraft(releaseTag);
await run('gh', ['release', 'download', sourceTag, '--repo', repository, '--pattern', 'arya-source.bundle.enc', '--dir', directory], { timeoutMs: 300_000, failureMessage: 'Encrypted source download failed.' });
const encryptedPath = join(directory, 'arya-source.bundle.enc');
if ((await stat(encryptedPath)).size > 512 * 1024 * 1024) throw new Error('Encrypted source bundle exceeds the transfer limit.');
const encrypted = await readFile(encryptedPath);
if (createHash('sha256').update(encrypted).digest('hex') !== sourceSha) throw new Error('Encrypted source checksum mismatch.');
if (!encrypted.subarray(0, magic.length).equals(magic) || encrypted.length <= magic.length + 28) throw new Error('Invalid encrypted source envelope.');
const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.subarray(magic.length, magic.length + 12));
decipher.setAuthTag(encrypted.subarray(magic.length + 12, magic.length + 28));
let bundle;
try { bundle = Buffer.concat([decipher.update(encrypted.subarray(magic.length + 28)), decipher.final()]); }
catch { throw new Error('The encrypted source bundle could not be authenticated.'); }
const bundlePath = join(directory, 'source.bundle');
try {
  await writeFile(bundlePath, bundle, { mode: 0o600 }); bundle.fill(0);
  await run('git', ['config', '--global', 'core.longpaths', 'true']);
  await run('git', ['clone', bundlePath, source], { failureMessage: 'Could not clone the authenticated source bundle.' });
  await run('git', ['checkout', '--detach', sourceCommit], { cwd: source, failureMessage: 'Source commit is absent from the authenticated bundle.' });
  if (await run('git', ['rev-parse', 'HEAD'], { cwd: source }) !== sourceCommit || await run('git', ['status', '--porcelain'], { cwd: source })) throw new Error('Source provenance verification failed.');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (`v${manifest.version}` !== releaseTag) throw new Error('Source version differs from the destination release.');
  await appendFile(process.env.GITHUB_ENV, `ARYA_SOURCE_DIR=${source}\nARYA_RELEASE_VERSION=${manifest.version}\nARYA_BUILD_LOG_DIR=${logs}\n`);
  console.log(`Authenticated source ${sourceCommit} for Arya Code ${manifest.version}.`);
} finally { encryptionKey.fill(0); await rm(bundlePath, { force: true }); await rm(encryptedPath, { force: true }); }
