import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, inputs, key, repository, requireDraft, run } from './shared.mjs';

const { sourceTag } = inputs();
await requireDraft(sourceTag);
const logs = process.env.ARYA_BUILD_LOG_DIR ?? join(process.env.RUNNER_TEMP, 'arya-build-logs');
await mkdir(logs, { recursive: true });
const archive = join(process.env.RUNNER_TEMP, 'arya-macos-diagnostics.tar.gz');
const encryptedPath = join(process.env.RUNNER_TEMP, `arya-macos-diagnostics-${process.env.GITHUB_RUN_ID}.enc`);
await run('tar', ['-czf', archive, '-C', logs, '.']);
const encryptionKey = key();
try {
  const bytes = await readFile(archive);
  await writeFile(encryptedPath, encrypt(bytes, encryptionKey), { mode: 0o600 }); bytes.fill(0);
  await run('gh', ['release', 'upload', sourceTag, '--repo', repository, encryptedPath, '--clobber'], { timeoutMs: 300_000, failureMessage: 'Encrypted macOS diagnostics upload failed.' });
  console.log('Encrypted macOS diagnostics retained on the draft transfer release.');
} finally { encryptionKey.fill(0); await rm(archive, { force: true }); await rm(encryptedPath, { force: true }); }
