import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { inputs } from './shared.mjs';

inputs();
const source = process.env.ARYA_SOURCE_DIR, logs = process.env.ARYA_BUILD_LOG_DIR;
if (!isAbsolute(source ?? '') || !isAbsolute(logs ?? '')) throw new Error('Authenticated source preparation is required.');
await mkdir(logs, { recursive: true });
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); await access(npm);
const phases = [['install', ['ci'], 20], ['check', ['run', 'check'], 20], ['tools', ['run', 'tools:fetch'], 25], ['editor-source', ['run', 'upstream:fetch'], 15], ['editor-setup', ['run', 'upstream:setup'], 45], ['editor-compile', ['run', 'upstream:compile'], 40], ['desktop-package', ['run', 'release:windows'], 60]];
const summary = [];
for (const [name, args, minutes] of phases) {
  console.log(`Starting Windows build phase: ${name}`);
  const started = Date.now();
  const output = createWriteStream(join(logs, `${name}.log`), { mode: 0o600 });
  const code = await new Promise(ok => {
    const child = spawn(process.execPath, [npm, ...args], { cwd: source, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    const timer = setTimeout(() => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.once('error', () => child.kill()); }, minutes * 60_000);
    child.once('error', () => { clearTimeout(timer); output.end(() => ok(-1)); });
    child.once('close', value => { clearTimeout(timer); output.end(() => ok(value ?? -1)); });
  });
  summary.push({ phase: name, exitCode: code, durationMs: Date.now() - started });
  await writeFile(join(logs, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (code !== 0) { console.log(`::error::Windows build phase ${name} failed. Full diagnostics are retained only as encrypted release assets.`); process.exitCode = 1; break; }
  console.log(`Completed Windows build phase: ${name}`);
}
