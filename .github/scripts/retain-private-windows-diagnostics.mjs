import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inputs, repository, requireDraft, run } from './shared.mjs';
const { sourceTag } = inputs();
if (process.env.GITHUB_ACTOR !== 'HamzaArya') throw new Error('Only the owner can retain protected plaintext diagnostics.');
await requireDraft(sourceTag);
const logs = process.env.ARYA_BUILD_LOG_DIR ?? join(process.env.RUNNER_TEMP, 'arya-build-logs'); await mkdir(logs, { recursive: true });
const archive = join(process.env.RUNNER_TEMP, `arya-windows-server-diagnostics-${process.env.GITHUB_RUN_ID}.tar.gz`);
try {
  await run('tar', ['-czf', archive, '-C', logs, '.']);
  await requireDraft(sourceTag);
  await run('gh', ['release', 'upload', sourceTag, '--repo', repository, archive, '--clobber'], { failureMessage: 'Protected diagnostic upload failed.' });
  console.log('Native server diagnostics retained only on the protected draft transfer release.');
} finally { await rm(archive, { force: true }); }
