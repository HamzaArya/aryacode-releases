import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { inputs } from './shared.mjs';

inputs();
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build and verify this package on native Apple silicon macOS.');
const source = process.env.ARYA_SOURCE_DIR, logs = process.env.ARYA_BUILD_LOG_DIR;
if (!isAbsolute(source ?? '') || !isAbsolute(logs ?? '')) throw new Error('Authenticated source preparation is required.');
const executable = join(source, '.build/desktop/AryaCode.app/Contents/MacOS/AryaCode');
const phases = {
  install: { args: ['ci'], minutes: 20 },
  extensions: { args: ['run', 'build'], minutes: 10 },
  check: { args: ['run', 'check'], minutes: 25 },
  tools: { args: ['run', 'tools:fetch'], minutes: 25 },
  'editor-source': { args: ['run', 'upstream:fetch'], minutes: 20 },
  'editor-setup': { args: ['run', 'upstream:setup'], minutes: 45 },
  'editor-compile': { args: ['run', 'upstream:compile'], minutes: 45 },
  'server-tools': { args: ['run', 'servers:fetch'], minutes: 25 },
  application: { args: ['run', 'app:build'], minutes: 60 },
  'native-extension': { args: ['scripts/test-workbench.mjs', '--arya-native'], minutes: 8, direct: true, test: true },
  'servers-extension': { args: ['scripts/test-workbench.mjs', '--servers'], minutes: 6, direct: true, test: true },
  'motion-extension': { args: ['scripts/test-workbench.mjs', '--motion'], minutes: 6, direct: true, test: true },
  package: { args: ['run', 'release:mac'], minutes: 60 },
};
const name = process.argv[2], phase = phases[name];
if (!phase || process.argv.length !== 3) throw new Error('Choose one supported macOS build phase.');
let npm;
for (const candidate of [resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]) {
  try { await access(candidate); npm = candidate; break; } catch { /* Try the other native Node layout. */ }
}
if (!npm) throw new Error('The selected Node runtime has no npm CLI.');
await mkdir(logs, { recursive: true });
let summary = [];
try { summary = JSON.parse(await readFile(join(logs, 'summary.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const started = Date.now();
const output = createWriteStream(join(logs, `${name}.log`), { mode: 0o600 });
console.log(`Starting native macOS build phase: ${name}`);
const exitCode = await new Promise(ok => {
  const env = { ...process.env, ...(phase.test ? { ARYACODE_TEST_WORKBENCH: executable, VSCODE_DEV: '1' } : {}) };
  delete env.ARYA_BUILD_SOURCE_KEY; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const child = spawn(process.execPath, phase.direct ? phase.args : [npm, ...phase.args], { cwd: source, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let forceTimer;
  const terminate = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
  const timer = setTimeout(() => { terminate('SIGTERM'); forceTimer = setTimeout(() => terminate('SIGKILL'), 3_000); }, phase.minutes * 60_000);
  let settled = false;
  const finish = code => {
    if (settled) return; settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer);
    output.end(() => ok(code));
  };
  child.once('error', () => finish(-1));
  child.once('close', code => finish(code ?? -1));
});
summary.push({ phase: name, exitCode, durationMs: Date.now() - started });
await writeFile(join(logs, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (exitCode !== 0) { console.log(`::error::Native macOS build phase ${name} failed. Private command output is retained only in encrypted diagnostics.`); process.exitCode = 1; }
else console.log(`Completed native macOS build phase: ${name}`);
