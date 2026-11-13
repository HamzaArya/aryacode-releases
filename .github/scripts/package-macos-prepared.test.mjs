import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDanglingNpmBinLinks } from './package-macos-prepared.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'arya-package-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), extensions = join(source, 'app/extensions'), modules = join(extensions, 'node_modules');
  const runtime = join(modules, 'typescript/lib/tsserver.js'), license = join(extensions, 'LICENSE');
  await mkdir(join(modules, '.bin'), { recursive: true }); await mkdir(join(modules, 'typescript/lib'), { recursive: true });
  await writeFile(runtime, 'actual runtime fixture'); await writeFile(license, 'retained third-party rights');
  const options = { sourceRoot: source, scanRoots: [extensions], allowedRoots: [extensions], runtimeFiles: [runtime, license] };
  return { root, source, extensions, modules, runtime, license, options };
}

test('removes only dangling npm bin symlinks and preserves runtime, licenses, valid links and ordinary files', async t => {
  const f = await fixture(t);
  const broken = join(f.modules, '.bin/tsserver'), valid = join(f.modules, '.bin/valid'), ordinary = join(f.modules, '.bin/ordinary');
  await symlink('../typescript/bin/tsserver', broken); await symlink('../typescript/lib/tsserver.js', valid); await writeFile(ordinary, 'ordinary wrapper');
  const other = join(f.modules, 'missing-runtime-link'); await symlink('missing-runtime', other);
  const nonNpmBin = join(f.extensions, 'tooling/.bin/unrelated'); await mkdir(join(f.extensions, 'tooling/.bin'), { recursive: true }); await symlink('missing', nonNpmBin);
  const result = await pruneDanglingNpmBinLinks(f.options);
  assert.equal(result.removedCount, 1); assert.equal(result.runtimeIntegrityVerified, true);
  assert.match(result.removed[0].path, /node_modules[/\\]\.bin[/\\]tsserver$/);
  await assert.rejects(lstat(broken), /ENOENT/);
  assert.equal(await readlink(valid), '../typescript/lib/tsserver.js');
  assert.equal(await readFile(ordinary, 'utf8'), 'ordinary wrapper');
  assert.equal(await readFile(f.runtime, 'utf8'), 'actual runtime fixture');
  assert.equal(await readFile(f.license, 'utf8'), 'retained third-party rights');
  assert.equal(await readlink(other), 'missing-runtime');
  assert.equal(await readlink(nonNpmBin), 'missing');
});

test('deduplicates a generated shared cache alias and leaves unapproved directories untouched', async t => {
  const f = await fixture(t);
  const cache = join(f.source, 'upstream/extensions/node_modules'); await mkdir(join(f.source, 'upstream/extensions'), { recursive: true });
  await rename(f.modules, cache); await symlink(cache, f.modules);
  await symlink('../absent', join(cache, '.bin/broken'));
  const outside = join(f.root, 'outside'); await mkdir(join(outside, 'node_modules/.bin'), { recursive: true });
  await symlink('../absent', join(outside, 'node_modules/.bin/untouched')); await symlink(outside, join(f.extensions, 'external-cache'));
  const result = await pruneDanglingNpmBinLinks({ ...f.options, scanRoots: [f.extensions, cache], allowedRoots: [f.extensions, join(f.source, 'upstream/extensions')] });
  assert.equal(result.removedCount, 1);
  assert.equal(await readlink(join(outside, 'node_modules/.bin/untouched')), '../absent');
});

test('refuses cleanup when a required runtime is missing or an approved root escapes source ownership', async t => {
  const f = await fixture(t); const broken = join(f.modules, '.bin/tsserver'); await symlink('../absent', broken);
  await assert.rejects(pruneDanglingNpmBinLinks({ ...f.options, runtimeFiles: [join(f.modules, 'missing-runtime.js')] }), /ENOENT/);
  assert.equal(await readlink(broken), '../absent');
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await assert.rejects(pruneDanglingNpmBinLinks({ ...f.options, allowedRoots: [outside] }), /inside the verified source/);
  assert.equal(await readlink(broken), '../absent');
});
