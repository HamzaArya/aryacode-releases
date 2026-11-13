import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inputs, repository, requireDraft, run } from './shared.mjs';

const { sourceCommit, releaseTag } = inputs();
await requireDraft(releaseTag);
const version = process.env.ARYA_RELEASE_VERSION;
const output = join(process.env.ARYA_SOURCE_DIR, '.build/releases', version);
const evidence = JSON.parse(await readFile(join(output, 'release-windows.json'), 'utf8'));
const filename = `AryaCode-${version}-Windows-x64.zip`;
if (evidence.version !== version || evidence.sourceCommit !== sourceCommit || evidence.artifact !== filename || evidence.architecture !== 'x64' || !evidence.portableDistribution || !evidence.executableSmokeVerification || evidence.smokeMode !== 'electron-node-cli') throw new Error('Windows package evidence does not match the requested source.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(join(output, filename))) hash.update(chunk);
if (hash.digest('hex') !== evidence.sha256) throw new Error('Windows package checksum verification failed.');
await run('gh', ['release', 'upload', releaseTag, '--repo', repository, '--clobber', ...[filename, 'SHA256SUMS-Windows.txt', 'release-windows.json'].map(file => join(output, file))], { timeoutMs: 900_000, failureMessage: 'Verified Windows release upload failed.' });
console.log(`Uploaded verified Windows x64 package for ${sourceCommit} to draft ${releaseTag}.`);
