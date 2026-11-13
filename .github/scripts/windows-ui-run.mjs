// Copyright 2026 Hamza Arya. No build or application child receives release credentials.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inputs } from './shared.mjs';

inputs();
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run packaged interface acceptance on Windows x64.');
const source = process.env.ARYA_SOURCE_DIR, logs = process.env.ARYA_BUILD_LOG_DIR;
const phase = process.argv[2];
if (!['install', 'build', 'servers', 'motion'].includes(phase)) throw new Error('Choose a supported packaged interface phase.');
await mkdir(logs, { recursive: true });
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); await access(npm);
const env = { ...process.env };
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ARYA_BUILD_SOURCE_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']) delete env[key];
let command = process.execPath, args, deadline = 300_000;
if (phase === 'install' || phase === 'build') args = [npm, ...(phase === 'install' ? ['ci'] : ['run', 'build'])];
else {
  const packaged = process.env.ARYA_PACKAGED_ROOT;
  const extension = join(packaged, 'resources/app/extensions/arya-workbench');
  await access(join(extension, 'dist/extension.cjs'));
  const folder = join(source, '.build/windows-ui-tests', phase); await mkdir(folder, { recursive: true });
  const testBundle = join(folder, 'index.cjs');
  const { build } = createRequire(join(source, 'package.json'))('esbuild');
  await build({ entryPoints: [join(source, `tests/workbench/${phase === 'servers' ? 'local-server' : 'motion'}-host.ts`)], outfile: testBundle, external: ['vscode'], bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const fixture = await mkdtemp(join(folder, 'fixture-'));
  await cp(join(source, `fixtures/${phase === 'servers' ? 'php' : 'motion'}`), fixture, { recursive: true, filter: path => !['.arya', 'node_modules', '__pycache__'].includes(basename(path)) });
  const profile = await mkdtemp(join(folder, 'profile-')), extensions = await mkdtemp(join(folder, 'extensions-'));
  await mkdir(join(profile, 'User'), { recursive: true });
  await writeFile(join(profile, 'User/settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'security.workspace.trust.enabled': false, 'files.eol': '\n' }));
  const evidence = join(source, '.build/evidence'); await mkdir(evidence, { recursive: true });
  Object.assign(env, { ARYACODE_TEST_WORKBENCH: process.env.ARYA_PACKAGED_EXE, ARYACODE_TEST_EVIDENCE: evidence, VSCODE_DEV: '1' });
  command = process.env.ARYA_PACKAGED_EXE;
  args = [fixture, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', extensions, `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${testBundle}`];
  deadline = 360_000;
}
console.log(`Starting packaged Windows interface phase: ${phase}`);
const output = createWriteStream(join(logs, `gui-${phase}.log`), { mode: 0o600 });
const exitCode = await new Promise(ok => {
  const child = spawn(command, args, { cwd: source, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const timer = setTimeout(() => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.once('error', () => child.kill()); }, deadline);
  let settled = false;
  const finish = code => { if (settled) return; settled = true; clearTimeout(timer); output.end(() => ok(code)); };
  child.once('error', () => finish(-1)); child.once('close', code => finish(code ?? -1));
});
if (exitCode !== 0) { console.log(`::error::Packaged Windows interface phase ${phase} failed; details remain in protected diagnostics.`); process.exitCode = 1; }
else console.log(`Passed packaged Windows interface phase: ${phase}`);
