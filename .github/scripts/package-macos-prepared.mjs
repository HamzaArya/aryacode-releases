/** Prepare generated npm launchers without changing the authenticated application source. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inputs, run } from './shared.mjs';

const within = (root, path) => path === root || path.startsWith(root + sep);
const npmBinEntry = path => basename(dirname(path)) === '.bin' && basename(dirname(dirname(path))) === 'node_modules';
async function fingerprint(path, source) {
  const actual = await realpath(path);
  if (!within(source, actual)) throw new Error('A required runtime file escapes the verified source checkout.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('A required runtime path is not a regular file.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path: relative(source, actual), bytes: info.size, sha256: hash.digest('hex') };
}

export async function pruneDanglingNpmBinLinks({ sourceRoot, scanRoots, allowedRoots, runtimeFiles }) {
  const source = await realpath(sourceRoot);
  const allowed = await Promise.all(allowedRoots.map(path => realpath(path)));
  if (allowed.some(path => !within(source, path))) throw new Error('Cleanup roots must remain inside the verified source checkout.');
  const scans = await Promise.all(scanRoots.map(path => realpath(path)));
  for (const path of scans) if (!allowed.some(root => within(root, path))) throw new Error('A cleanup scan root is not approved.');
  const before = await Promise.all(runtimeFiles.map(path => fingerprint(path, source)));
  const visited = new Set(), removed = [];
  const visit = async directory => {
    const canonical = await realpath(directory);
    if (!allowed.some(root => within(root, canonical)) || visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let targetInfo;
        try { targetInfo = await stat(path); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const parent = await realpath(dirname(path));
          const launcher = join(parent, entry.name);
          if (!npmBinEntry(launcher)) continue; // Preserve all other links for the unchanged bundle audit.
          if (!allowed.some(root => within(root, parent))) throw new Error('A launcher parent escapes the approved generated cache.');
          const current = await lstat(launcher);
          if (!current.isSymbolicLink()) throw new Error('A launcher changed while preparing the bundle.');
          const target = resolve(dirname(launcher), await readlink(launcher));
          await unlink(launcher); // Remove only the broken link, never its target or a runtime file.
          removed.push({ path: relative(source, launcher), target: within(source, target) ? relative(source, target) : '<outside-verified-source>', reason: 'ENOENT dangling npm .bin symlink' });
          continue;
        }
        if (targetInfo.isDirectory()) await visit(path);
      } else if (entry.isDirectory()) await visit(path);
    }
  };
  for (const path of scans) await visit(path);
  const after = await Promise.all(runtimeFiles.map(path => fingerprint(path, source)));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Runtime or license contents changed during launcher preparation.');
  return { onlyDanglingNpmBinSymlinks: true, removedCount: removed.length, removed, runtimeIntegrityVerified: true, runtimeFiles: after };
}

async function sourceCommand(source, args) {
  await new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { cwd: source, env: process.env, stdio: 'inherit', shell: false });
    child.once('error', fail);
    child.once('close', code => code === 0 ? ok() : fail(new Error('A required source packaging command failed.')));
  });
}

async function main() {
  const { sourceCommit, releaseTag } = inputs();
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin' || process.arch !== 'arm64' || !isAbsolute(process.env.ARYA_SOURCE_DIR ?? '')) throw new Error('Use the authenticated Apple silicon build host.');
  const source = await realpath(process.env.ARYA_SOURCE_DIR);
  const verifySource = async () => {
    if (await run('git', ['rev-parse', 'HEAD'], { cwd: source }) !== sourceCommit || await run('git', ['status', '--porcelain'], { cwd: source })) throw new Error('Application source provenance changed before packaging.');
  };
  await verifySource();
  // Keep the source recipe's order: refresh first, then prepare generated inputs, then package.
  await sourceCommand(source, ['scripts/refresh-app.mjs', '--for-release']);
  const application = join(source, '.build/desktop/AryaCode.app/Contents/Resources/app');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const product = JSON.parse(await readFile(join(application, 'product.json'), 'utf8'));
  const appManifest = JSON.parse(await readFile(join(application, 'package.json'), 'utf8'));
  if (`v${manifest.version}` !== releaseTag || product.aryaVersion !== manifest.version || appManifest.name !== 'aryacode') throw new Error('The generated app is not the requested Arya Code release.');
  const extensions = join(application, 'extensions');
  const extensionCache = join(source, 'upstream/vscode/extensions');
  const shared = join(extensions, 'node_modules');
  const expectedShared = await realpath(join(extensionCache, 'node_modules'));
  if (await realpath(shared) !== expectedShared) throw new Error('The generated shared extension cache differs from the pinned checkout.');
  const lock = JSON.parse(await readFile(join(source, 'tooling.lock.json'), 'utf8'));
  const upstreamCommit = await run('git', ['rev-parse', 'HEAD'], { cwd: join(source, 'upstream/vscode') });
  if (upstreamCommit !== lock.upstream.commit) throw new Error('The extension cache does not belong to the pinned editor source.');
  const result = await pruneDanglingNpmBinLinks({
    sourceRoot: source, scanRoots: [extensions, expectedShared], allowedRoots: [extensions, extensionCache],
    runtimeFiles: [
      join(extensions, 'arya-workbench/dist/extension.cjs'), join(extensions, 'arya-workbench/dist/service.cjs'),
      join(shared, 'typescript/package.json'), join(shared, 'typescript/lib/tsserver.js'), join(shared, 'typescript/lib/typescript.js'),
      join(application, 'runtime/arya/arya'), join(application, 'runtime/node/bin/node'),
      join(application, 'LICENSE.txt'), join(application, 'ThirdPartyNotices.txt'), join(application, 'ARYA-CODE-LICENSE.txt'),
    ],
  });
  await verifySource();
  const evidence = { schemaVersion: 1, sourceCommit, upstreamCommit, applicationVersion: manifest.version, ...result };
  const directory = join(source, '.build/evidence'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'macos-package-preparation.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Prepared generated npm launchers: ${result.removedCount} dangling symlinks removed; runtime and license hashes unchanged.`);
  await sourceCommand(source, ['scripts/package-macos.mjs']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
