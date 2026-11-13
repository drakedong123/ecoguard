import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchChrome, until, delay } from './chrome.mjs';
import { startFixtures } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'build', 'browser-acceptance');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'ecoguard-acceptance-'));
const fixtures = await startFixtures();
let browser;
let driver;
let popup;
let extensionId;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode: 'real Chrome, isolated profile',
  source: 'build/extension', checks: [], limitations: [
    'Headless Chrome: native permission prompts and OS save-picker interaction require a headed check.',
    'The download behavior is directed to the disposable output directory, bypassing the OS save picker.',
    'Acceptance timing is not a paired resource-savings benchmark.'
  ] };
const digest = createHash('sha256');
for (const file of (await readdir(path.join(root, 'build', 'extension'))).sort()) {
  digest.update(file + '\0'); digest.update(await readFile(path.join(root, 'build', 'extension', file)));
}
report.sourceSHA256 = digest.digest('hex');

async function check(name, test) {
  const started = Date.now();
  try {
    const evidence = await test();
    report.checks.push({ name, passed: true, durationMs: Date.now() - started, ...(evidence ? { evidence } : {}) });
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message });
    throw error;
  }
}
const evaluate = expression => driver.evaluate(expression);
const tabs = () => evaluate('chrome.tabs.query({})');
const local = () => evaluate('chrome.storage.local.get(null)');
const session = () => evaluate('chrome.storage.session.get("browserSession").then(x=>x.browserSession)');
const tabFor = async page => (await tabs()).find(tab => tab.url === page.url);
async function openPopup(page) {
  if (popup) { try { await popup.close(); } catch {} }
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  const url = await page.evaluate('location.href');
  await evaluate(`(async()=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(url)});await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});})()`);
  popup = await browser.popup(extensionId, page);
  await until(() => popup.evaluate('document.getElementById("protection-feedback").textContent === "Protection controls ready."'),
    { label: 'protection controls' });
  return popup;
}
async function command(message) {
  const response = await popup.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  assert.equal(response?.ok, true, response?.error ?? 'No worker reply');
  return response;
}
async function click(id, outputId, expected) {
  assert.equal(await popup.evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`), false, `${id} is disabled`);
  await popup.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  if (outputId) await until(() => popup.evaluate(`document.getElementById(${JSON.stringify(outputId)}).textContent.includes(${JSON.stringify(expected)})`),
    { label: `${id} result` });
}
async function fixture(name, suffix = '', active = false) {
  const url = `${fixtures.origin}/${name}${suffix}`;
  const page = await browser.page(url, { background: !active });
  page.url = url;
  return page;
}
async function screenshot(name) {
  const { data } = await popup.send('Page.captureScreenshot', { captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(data, 'base64'));
}

try {
  browser = await launchChrome({ profile });
  report.browser = await browser.version();
  ({ id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: path.join(root, 'build/extension') }));
  driver = await browser.page(`chrome-extension://${extensionId}/popup.html`);
  const control = await fixture('', '', true);
  await openPopup(control);
  await check('Packaged extension loads and popup discovers the worker', async () => {
    const status = await command({ type: 'status' });
    assert.equal(status.settings.idleMinutes, 30);
    assert.equal(status.paused, false);
    assert.equal((await evaluate('chrome.alarms.get("ecoguard-scan")')).periodInMinutes, 1);
    const permissions = await evaluate('chrome.permissions.getAll()');
    assert.deepEqual(permissions.permissions.sort(), ['alarms', 'downloads', 'storage', 'tabs']);
    return { version: status.version, permissions };
  });
  await check('Popup saves threshold and pauses automatic unloading', async () => {
    await popup.evaluate('document.getElementById("idle").value="5";document.getElementById("settings").requestSubmit()');
    await until(() => popup.evaluate('document.getElementById("feedback").textContent.includes("Preference saved")'));
    await click('pause', 'feedback', 'paused');
    assert.equal((await command({ type: 'status' })).settings.idleMinutes, 5);
    assert.equal((await command({ type: 'status' })).paused, true);
  });
  await check('Popup layout has a bounded scroll area and no horizontal overflow', async () => {
    const layout = await popup.evaluate('({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.getBoundingClientRect().width,scrollHeight:document.documentElement.scrollHeight})');
    assert.equal(layout.bodyWidth, 360);
    assert.ok(layout.scrollWidth <= layout.width);
    await screenshot('popup.png');
    return layout;
  });
  await check('Site protection persists and can be removed without changing defaults', async () => {
    await click('protect-site', 'protection-feedback', 'protected on this device');
    assert.ok((await local()).settings.protectedHosts.includes('127.0.0.1'));
    await openPopup(control);
    const info = await command({ type: 'managementStatus' });
    assert.deepEqual(info.currentTab.matchingHosts, ['127.0.0.1']);
    await command({ type: 'setSiteProtection', hostname: '127.0.0.1', protected: false });
    assert.ok(!(await local()).settings.protectedHosts.includes('127.0.0.1'));
    assert.ok((await local()).settings.protectedHosts.includes('docs.google.com'));
  });
  const safe = await fixture('allocation', '?case=eligible');
  const edited = await fixture('editable', '', true);
  await edited.evaluate('document.getElementById("draft").focus()');
  await edited.send('Input.insertText', { text: 'Disposable unsaved test draft' });
  const media = await fixture('media', '', true);
  await media.evaluate('document.getElementById("audio").play()');
  const framed = await fixture('frame');
  const pinned = await fixture('allocation', '?case=pinned');
  const protectedTab = await fixture('allocation', '?case=protected');
  const downloadCandidate = await fixture('allocation', '?case=download-veto');
  await openPopup(protectedTab);
  await click('protect-tab', 'protection-feedback', 'Tab protected');
  const protectedId = (await tabFor(protectedTab)).id;
  const pinnedId = (await tabFor(pinned)).id;
  const downloadCandidateId = (await tabFor(downloadCandidate)).id;
  await command({ type: 'setTabProtection', tabId: downloadCandidateId,
    expectedUrl: downloadCandidate.url, protected: true });
  await evaluate(`chrome.tabs.update(${pinnedId},{pinned:true})`);
  await check('Trusted edits, actual media and embedded frames are reported by the content script', async () => {
    await openPopup(edited);
    const inspected = (await command({ type: 'managementStatus' })).currentTab;
    assert.equal(inspected.url, edited.url);
    assert.equal(inspected.safety.edited, true, JSON.stringify({ inspected, value: await edited.evaluate('document.getElementById("draft").value') }));
    await click('reset-edits');
    assert.equal(await popup.evaluate('document.getElementById("confirmation").open'), true);
    assert.equal(await popup.evaluate('document.activeElement.id'), 'cancel-reset');
    await screenshot('confirmation.png');
    await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => popup.evaluate('!document.getElementById("confirmation").open'));
    assert.equal((await command({ type: 'managementStatus' })).currentTab.safety.edited, true);
    await openPopup(media);
    assert.equal((await command({ type: 'managementStatus' })).currentTab.safety.playingMedia, true);
    await openPopup(framed);
    assert.equal((await command({ type: 'managementStatus' })).currentTab.safety.hasEmbeddedFrame, true);
  });
  await openPopup(control);
  await check('Service worker shutdown preserves pause, preferences and tab protection', async () => {
    const before = await session();
    await control.send('ServiceWorker.enable');
    await control.send('ServiceWorker.stopAllWorkers');
    const status = await command({ type: 'status' });
    assert.equal(status.paused, true);
    assert.equal(status.settings.idleMinutes, 5);
    const after = await session();
    assert.equal(after.tabs[protectedId].protected, true);
    const safeId = (await tabFor(safe)).id;
    assert.equal(after.tabs[safeId].lastActiveAt, before.tabs[safeId].lastActiveAt);
  });
  await check('Only genuine popup senders may mutate worker state', async () => {
    const denied = await driver.evaluate('chrome.runtime.sendMessage({type:"setPaused",paused:false})');
    assert.equal(denied, undefined);
    assert.equal((await command({ type: 'status' })).paused, true);
  });
  // Headless Chrome does not reliably change lastFocusedWindow between existing
  // windows. Create the second window after current-page UI checks, then remove
  // it after checking that both windows' active tabs resist automatic unloading.
  const secondWindowUrl = `${fixtures.origin}/?case=second-window`;
  const secondWindow = await evaluate(`chrome.windows.create({url:${JSON.stringify(secondWindowUrl)}})`);
  const secondControl = { url: secondWindowUrl };
  // Detach fixture debuggers before measuring actual eligibility/intervention.
  for (const page of [safe, edited, media, framed, pinned, protectedTab, downloadCandidate]) await page.detach();
  await command({ type: 'setPaused', paused: false });
  await popup.close(); popup = null;
  const countBeforeScan = (await tabs()).length;
  console.log('Waiting for the real five-minute threshold and one-minute Chrome alarm (up to seven minutes)…');
  await check('Real alarm unloads an idle safe page without closing or unloading protected fixtures', async () => {
    await until(async () => (await tabFor(safe))?.discarded === true,
      { timeout: 7 * 60_000, interval: 2000, label: 'natural alarm discard' });
    const safeId = (await tabFor(safe)).id;
    await until(async () => (await local()).browserHistory?.some(event => event.tabId === safeId && event.action === 'discarded'),
      { label: 'confirmed EcoGuard discard history' });
    const snapshot = await tabs();
    assert.equal(snapshot.length, countBeforeScan);
    for (const page of [edited, media, framed, pinned, protectedTab, downloadCandidate, control, secondControl]) {
      assert.equal(snapshot.find(tab => tab.url === page.url)?.discarded, false, page.url);
    }
    const history = (await local()).browserHistory;
    assert.equal(history.filter(event => event.action === 'discarded').length, 1);
    report.unwantedInterventions = { count: 0, protectedFixtures: 8 };
    return { discarded: 1, retainedTabCount: snapshot.length, history };
  });
  await evaluate(`chrome.windows.remove(${secondWindow.id})`);
  await openPopup(control);
  await check('An active real download vetoes an otherwise idle eligible tab across an alarm', async () => {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
    const id = await evaluate(`chrome.downloads.download({url:${JSON.stringify(fixtures.origin + '/download-long')}})`);
    await until(() => evaluate(`chrome.downloads.search({id:${id}}).then(x=>x[0]?.state === 'in_progress')`));
    await command({ type: 'setTabProtection', tabId: downloadCandidateId,
      expectedUrl: downloadCandidate.url, protected: false });
    const started = Date.now();
    await until(async () => (await session()).lastScanAt > started,
      { timeout: 80_000, interval: 1000, label: 'scan during active download' });
    await command({ type: 'status' }); // Queued behind the scan: assertions see its completed outcome.
    assert.equal((await tabFor(downloadCandidate)).discarded, false);
    assert.equal(await evaluate(`chrome.downloads.search({id:${id}}).then(x=>x[0]?.state)`), 'in_progress');
    await command({ type: 'setTabProtection', tabId: downloadCandidateId,
      expectedUrl: downloadCandidate.url, protected: true });
    await evaluate(`chrome.downloads.cancel(${id})`);
  });
  await check('Restore control selects the same tab, reloads it and learns a longer host delay', async () => {
    const selected = (await command({ type: 'managementStatus' })).restoreTarget;
    assert.equal(selected.tabId, (await tabFor(safe)).id);
    const started = Date.now();
    await click('restore-last');
    await until(async () => { const tab = await tabFor(safe); return tab?.active && !tab.discarded && tab.status === 'complete'; },
      { label: 'restored fixture' });
    const elapsedMs = Date.now() - started;
    await until(async () => (await local()).settings.learnedHostDelays.some(host => host.hostname === '127.0.0.1' && host.idleMinutes === 10));
    assert.equal((await tabs()).filter(tab => tab.url === safe.url).length, 1);
    return { elapsedMs, samples: 1, note: 'One automation-observed reload; not a median benchmark.' };
  });
  popup = null;
  await openPopup(control);
  await check('Edit reset confirmation clears only edits and new trusted edits protect again', async () => {
    const editedPage = await browser.attach(edited.targetId);
    editedPage.url = edited.url;
    await openPopup(editedPage);
    await click('reset-edits');
    await click('confirm-reset', 'protection-feedback', 'Edit protection cleared');
    const safety = (await command({ type: 'managementStatus' })).currentTab.safety;
    assert.equal(safety.edited, false);
    assert.ok(Date.now() - safety.lastInteractionAt < 5000);
    await editedPage.evaluate('document.getElementById("draft").focus()');
    await editedPage.send('Input.insertText', { text: ' more disposable edits' });
    assert.equal((await command({ type: 'managementStatus' })).currentTab.safety.edited, true);
    await editedPage.detach();
  });
  await openPopup(control);
  await check('History export produces a completed metadata-only JSON download', async () => {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output, eventsEnabled: true });
    await click('export-history', 'data-feedback', 'History export started');
    const download = await until(async () => (await evaluate('chrome.downloads.search({})')).find(item => item.filename.endsWith('.json') && item.state === 'complete'),
      { label: 'completed JSON export' });
    const payload = JSON.parse(await readFile(download.filename, 'utf8'));
    assert.ok(payload.events.length > 0);
    for (const event of payload.events) assert.deepEqual(Object.keys(event).sort(), ['action', 'hostname', 'reason', 'tabId', 'timestamp']);
    assert.ok(!JSON.stringify(payload).includes(fixtures.origin));
    return { eventCount: payload.events.length, filename: path.basename(download.filename) };
  });
  await check('Cancel and confirmed history/learning/full resets honor their documented scopes', async () => {
    const historyBefore = (await local()).browserHistory.length;
    await click('clear-history');
    await click('cancel-reset');
    assert.equal((await local()).browserHistory.length, historyBefore);
    await click('reset-learning'); await click('confirm-reset', 'data-feedback', 'Learned delays reset');
    assert.deepEqual((await local()).settings.learnedHostDelays, []);
    assert.equal((await local()).browserHistory.length, historyBefore);
    await click('clear-history'); await click('confirm-reset', 'data-feedback', 'History cleared');
    assert.deepEqual((await local()).browserHistory, []);
    assert.equal((await session()).tabs[protectedId].protected, true);
    const count = (await tabs()).length;
    await click('reset-local'); await click('confirm-reset', 'data-feedback', 'EcoGuard data reset');
    assert.equal((await local()).settings.idleMinutes, 30);
    assert.equal((await session()).paused, true);
    assert.equal((await session()).tabs[protectedId].protected, false);
    assert.equal((await tabs()).length, count);
  });
  await check('Manual close skips a restored selection and closes only a still-discarded selected tab', async () => {
    let safeId = (await tabFor(safe)).id;
    safeId = (await evaluate(`chrome.tabs.discard(${safeId})`)).id;
    const list = await command({ type: 'unloadedTabsStatus' });
    assert.ok(list.tabIds.includes(safeId));
    await evaluate(`chrome.tabs.update(${safeId},{active:true})`);
    await until(async () => (await tabFor(safe))?.discarded === false);
    await openPopup(control);
    const skipped = await command({ type: 'closeUnloadedTabs', tabIds: [safeId] });
    assert.equal(skipped.skipped, 1);
    safeId = (await evaluate(`chrome.tabs.discard(${safeId})`)).id;
    await openPopup(control);
    await click('close-unloaded', 'unloaded-feedback', 'Closed 1 unloaded tab');
    assert.equal(await tabFor(safe), undefined);
    assert.ok(await tabFor(pinned));
  });
  await check('Browser settings pages disable current-page controls', async () => {
    const settings = await browser.page('chrome://settings/', { background: false });
    await openPopup(settings);
    assert.equal((await command({ type: 'managementStatus' })).currentTab, null);
    assert.equal(await popup.evaluate('document.getElementById("protect-tab").disabled'), true);
    assert.equal(await popup.evaluate('document.getElementById("reset-edits").disabled'), true);
  });
  await check('Browser restart retains local settings but grants new unpaused session grace', async () => {
    await command({ type: 'saveSettings', idleMinutes: 7 });
    await command({ type: 'setSiteProtection', hostname: 'example.test', protected: true });
    await command({ type: 'setPaused', paused: true });
    await browser.close({ removeProfile: false });
    popup = null;
    browser = await launchChrome({ profile });
    const restartAt = Date.now();
    ({ id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: path.join(root, 'build/extension') }));
    driver = await browser.page(`chrome-extension://${extensionId}/popup.html`);
    const fresh = await fixture('allocation', '?case=restart', true);
    await openPopup(fresh);
    const status = await command({ type: 'status' });
    assert.equal(status.settings.idleMinutes, 7);
    assert.ok(status.settings.protectedHosts.includes('example.test'));
    assert.equal(status.paused, false);
    for (const record of Object.values((await session()).tabs)) assert.ok(record.lastActiveAt >= restartAt);
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  try { report.diagnostics = { session: await session(), local: await local(), tabs: await tabs() }; } catch {}
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close({ removeProfile: false });
  await rm(profile, { recursive: true, force: true });
  await fixtures.close();
  console.log(`Acceptance evidence: ${path.join(output, 'results.json')}`);
}
