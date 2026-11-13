import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inputs } from './shared.mjs';
inputs();
const source = process.env.ARYA_SOURCE_DIR, logs = process.env.ARYA_BUILD_LOG_DIR;
await mkdir(logs, { recursive: true });
const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); await access(npm);
const phases = [
  ['install', [npm, 'ci'], 300_000],
  ['compile-test', ['-e', "require('esbuild').buildSync({entryPoints:['tests/local-server.test.ts'],outfile:'.build/server-diagnostic.cjs',bundle:true,platform:'node',format:'cjs',target:'node22'})"], 60_000],
  ['server-health', ['--test', '--test-reporter=tap', '--test-timeout=30000', '--test-force-exit', '--test-name-pattern=native service health', '.build/server-diagnostic.cjs'], 90_000],
];
for (const [name, args, deadline] of phases) {
  console.log(`Starting bounded native diagnostic phase: ${name}`);
  const output = createWriteStream(join(logs, `${name}.log`), { mode: 0o600 });
  const code = await new Promise(ok => {
    const child = spawn(process.execPath, args, { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    const timer = setTimeout(() => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('error', () => child.kill()); }, deadline);
    child.once('error', () => { clearTimeout(timer); output.end(() => ok(-1)); });
    child.once('close', value => { clearTimeout(timer); output.end(() => ok(value ?? -1)); });
  });
  console.log(`Completed bounded native diagnostic phase: ${name} (exit ${code})`);
  if (code !== 0) { process.exitCode = 1; break; }
}
