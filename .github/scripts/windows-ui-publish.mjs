// Copyright 2026 Hamza Arya. Publish only the compact acceptance receipt.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inputs, repository, requireDraft, run } from './shared.mjs';

const { sourceCommit, releaseTag } = inputs();
await requireDraft(releaseTag);
const source = process.env.ARYA_SOURCE_DIR, version = process.env.ARYA_RELEASE_VERSION;
const packageReceipt = JSON.parse(await readFile(process.env.ARYA_PACKAGE_RECEIPT, 'utf8'));
if (packageReceipt.sourceCommit !== sourceCommit || packageReceipt.sha256 !== process.env.ARYA_PACKAGE_SHA) throw new Error('Packaged acceptance provenance changed.');
const servers = JSON.parse(await readFile(join(source, '.build/evidence/local-server-workbench.json'), 'utf8'));
const motion = JSON.parse(await readFile(join(source, '.build/evidence/motion-workbench.json'), 'utf8'));
if (servers.status !== 'passed' || servers.platform !== 'win32' || motion.status !== 'passed' || motion.version !== version) throw new Error('Both packaged interface suites must pass.');
const receipt = { application: 'Arya Code', version, sourceCommit, artifact: packageReceipt.artifact, sha256: packageReceipt.sha256, platform: 'win32', architecture: 'x64', packagedExtension: true, desktopGuiVerification: true, checkedAt: new Date().toISOString(), workflowRun: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`, suites: { localServers: { status: servers.status, runtime: servers.runtime, checks: servers.checks }, motion: { status: motion.status, checks: motion.checks } } };
const output = join(process.env.RUNNER_TEMP, 'windows-gui-verification.json');
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
await run('gh', ['release', 'upload', releaseTag, '--repo', repository, output, '--clobber'], { failureMessage: 'Packaged interface receipt upload failed.' });
console.log(`Packaged Windows interface acceptance published for source ${sourceCommit}.`);
