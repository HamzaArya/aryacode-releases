import { createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { key, magic, repository, requireDraft, run } from './shared.mjs';

const sourceTag = process.env.SOURCE_TAG, runId = process.env.DIAGNOSTIC_RUN_ID;
if (process.env.GITHUB_ACTOR !== 'HamzaArya') throw new Error('Only the repository owner can restore protected diagnostics.');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(sourceTag ?? '') || !/^[0-9]{5,20}$/.test(runId ?? '')) throw new Error('Invalid protected diagnostic identity.');
await requireDraft(sourceTag);
const directory = join(process.env.RUNNER_TEMP, 'arya-protected-diagnostics'); await mkdir(directory, { recursive: true });
const encryptedName = `arya-windows-diagnostics-${runId}.enc`;
const encryptedPath = join(directory, encryptedName);
const plaintextPath = join(directory, `arya-windows-diagnostics-${runId}.tar.gz`);
const encryptionKey = key();
try {
  await run('gh', ['release', 'download', sourceTag, '--repo', repository, '--pattern', encryptedName, '--dir', directory], { timeoutMs: 300_000, failureMessage: 'Protected encrypted diagnostics download failed.' });
  if ((await stat(encryptedPath)).size > 256 * 1024 * 1024) throw new Error('Diagnostic archive exceeds the restore limit.');
  const encrypted = await readFile(encryptedPath);
  if (!encrypted.subarray(0, magic.length).equals(magic) || encrypted.length <= magic.length + 28) throw new Error('Invalid encrypted diagnostic envelope.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.subarray(magic.length, magic.length + 12));
  decipher.setAuthTag(encrypted.subarray(magic.length + 12, magic.length + 28));
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(encrypted.subarray(magic.length + 28)), decipher.final()]); }
  catch { throw new Error('Protected diagnostic authentication failed.'); }
  await writeFile(plaintextPath, plaintext, { mode: 0o600 }); plaintext.fill(0);
  await requireDraft(sourceTag);
  await run('gh', ['release', 'upload', sourceTag, '--repo', repository, plaintextPath, '--clobber'], { timeoutMs: 300_000, failureMessage: 'Protected draft diagnostic upload failed.' });
  console.log(`Restored diagnostics for run ${runId} only to draft transfer release ${sourceTag}.`);
} finally { encryptionKey.fill(0); await rm(directory, { recursive: true, force: true }); }
