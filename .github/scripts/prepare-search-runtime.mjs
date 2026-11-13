/** Fill the upstream installer's verified binary cache without exposing API credentials to npm. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inputs, run } from './shared.mjs';

inputs();
if (process.env.GITHUB_ACTIONS !== 'true' || !isAbsolute(process.env.ARYA_SOURCE_DIR ?? '')) throw new Error('Authenticated source preparation on a hosted runner is required.');
const packageVersion = '1.17.1', releaseTag = 'v15.0.1', repository = 'microsoft/ripgrep-prebuilt';
const pins = {
  'darwin-arm64': { filename: 'ripgrep-v15.0.1-aarch64-apple-darwin.tar.gz', bytes: 1851046, sha256: '2fa16464fd8638588a67c7fc172d3c4b57fbdc65dff366e10b0b0e90734628a6' },
  'win32-x64': { filename: 'ripgrep-v15.0.1-x86_64-pc-windows-msvc.zip', bytes: 2042875, sha256: 'bd28761f4918ea8fcb7a95f636b4422a915d55af268d9805be82d8ce0fdfc823' },
};
const platform = `${process.platform}-${process.arch}`, pin = pins[platform];
if (!pin) throw new Error('No search-runtime cache pin is defined for this native host.');
const lock = JSON.parse(await readFile(join(process.env.ARYA_SOURCE_DIR, 'upstream/vscode/package-lock.json'), 'utf8'));
if (lock.packages?.['node_modules/@vscode/ripgrep']?.version !== packageVersion) throw new Error('The pinned upstream search-runtime package changed; review its installer before updating the binary cache.');
const directory = join(tmpdir(), `vscode-ripgrep-cache-${packageVersion}`);
const archive = join(directory, pin.filename);
async function verified() {
  try {
    const info = await stat(archive);
    if (!info.isFile() || info.size !== pin.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return hash.digest('hex') === pin.sha256;
  } catch { return false; }
}
await mkdir(directory, { recursive: true });
if (!await verified()) {
  await rm(archive, { force: true });
  // Only this trusted helper receives GH_TOKEN; npm phases explicitly remove it.
  const release = JSON.parse(await run('gh', ['api', `repos/${repository}/releases/tags/${releaseTag}`], { timeoutMs: 120_000, failureMessage: 'Authenticated search-runtime metadata lookup failed.' }));
  const asset = release.assets?.find(asset => asset.name === pin.filename);
  const expectedUrl = `https://github.com/${repository}/releases/download/${releaseTag}/${pin.filename}`;
  if (release.tag_name !== releaseTag || !asset || asset.state !== 'uploaded' || asset.size !== pin.bytes || asset.digest !== `sha256:${pin.sha256}` || asset.browser_download_url !== expectedUrl) throw new Error('The public search-runtime asset differs from its reviewed binary pin.');
  await run('gh', ['release', 'download', releaseTag, '--repo', repository, '--pattern', pin.filename, '--dir', directory, '--clobber'], { timeoutMs: 300_000, failureMessage: 'Authenticated search-runtime download failed.' });
  if (!await verified()) { await rm(archive, { force: true }); throw new Error('Search-runtime archive failed its pinned size or SHA-256 verification.'); }
}
console.log(`Prepared verified upstream search-runtime cache for ${platform}. npm receives no API credentials.`);
