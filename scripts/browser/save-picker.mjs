import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { launchChrome, until } from './chrome.mjs';
import { startFixtures } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'build', 'browser-picker');
await mkdir(output, { recursive: true });
const fixtures = await startFixtures();
let browser;
let terminal;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), checks: [] };
try {
  browser = await launchChrome({ headed: true });
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  report.browser = await browser.version();
  const { id } = await browser.send('Extensions.loadUnpacked', { path: path.join(root, 'build/extension') });
  const control = await browser.page(fixtures.origin, { background: false });
  const target = await until(async () => (await browser.send('Target.getTargets')).targetInfos.find(target =>
    target.type === 'service_worker' && target.url === `chrome-extension://${id}/background.js`));
  const worker = await browser.attach(target.targetId);
  // Keep the worker attachment alive while the operator uses the native picker;
  // dispatch through the actual popup with no download override or API mock.
  let popup = await browser.popup(id, control);
  async function startExport() {
    await until(() => popup.evaluate('document.getElementById("export-history")?.disabled === false'));
    await popup.evaluate('document.getElementById("export-history").click()');
  }
  console.log('PICKER 1: Click Cancel in the native save dialog.');
  await startExport();
  await terminal.question('After clicking Cancel, press Enter here to continue. ');
  assert.equal(await worker.evaluate('chrome.downloads.search({}).then(items=>items.filter(item=>item.state==="complete" || item.state==="in_progress").length)'), 0);
  assert.deepEqual(await worker.evaluate('chrome.storage.local.get("browserHistory").then(x=>x.browserHistory)'), []);
  report.checks.push({ name: 'Native save-picker cancellation preserves history', passed: true });
  console.log(`PICKER 2: Save the JSON file into ${output}`);
  try { await popup.close(); } catch {}
  popup = await browser.popup(id, control);
  await startExport();
  const download = await until(() => worker.evaluate('chrome.downloads.search({}).then(items=>items.find(item=>item.state==="complete" && item.filename.endsWith(".json")))'),
    { timeout: 120_000, label: 'native-picker completed export' });
  assert.equal(path.dirname(download.filename), output, 'Save this disposable export in the specified build directory.');
  const payload = JSON.parse(await readFile(download.filename, 'utf8'));
  assert.equal(payload.application, 'EcoGuard');
  assert.deepEqual(payload.events, []);
  report.checks.push({ name: 'Native save-picker acceptance completes a valid empty JSON export', passed: true,
    filename: path.basename(download.filename) });
  report.passed = true;
  console.log('PASS Native picker Cancel and Save, history preservation and completed empty export.');
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  terminal?.close();
  if (browser) await browser.close();
  await fixtures.close();
}
