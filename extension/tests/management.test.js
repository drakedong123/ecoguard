import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, tab } from './helpers/browser.js';
import { popup } from './helpers/popup.js';
import { background } from './helpers/background.js';
import { SESSION_KEY } from '../worker.js';
import { MINUTE_MS as MINUTE } from '../policy.js';

test('management status targets the active tab in the last focused window and explains inherited protection', async () => {
  const b = browser({ tabs: [tab(1, { active: true, url: 'https://sub.example.org/work' }),
    tab(2, { active: true, windowId: 2 })], local: { settings: { protectedHosts: ['example.org'] } } });
  await b.worker.start();
  const context = await b.worker.managementStatus();
  assert.equal(context.currentTab.tabId, 1);
  assert.deepEqual(context.currentTab.matchingHosts, ['example.org']);
  assert.equal(context.restoreTarget, null);
  b.records.get(1).url = 'chrome://extensions/';
  assert.equal((await b.worker.managementStatus()).currentTab, null);
});

test('tab protection is URL-bound, survives navigation/worker restart and clears in a new browser session', async () => {
  const b = browser();
  await b.worker.start();
  await assert.rejects(b.worker.setTabProtection(1, true, 'https://other.example/'), /changed or is unavailable/);
  await b.worker.setTabProtection(1, true, b.records.get(1).url);
  b.records.get(1).url = 'https://other.example/page';
  b.chrome.tabs.onUpdated.emit(1, { url: b.records.get(1).url });
  await b.worker.settled();
  b.clock.at = 6 * MINUTE;
  const restarted = browser({ tabs: [...b.records.values()], clock: b.clock, local: b.local, session: b.session });
  await restarted.worker.start();
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, []);
  assert.equal(restarted.session[SESSION_KEY].tabs[1].protected, true);
  await restarted.worker.setTabProtection(1, false, b.records.get(1).url);
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, [1]);
  const newSession = browser({ tabs: [...b.records.values()], clock: b.clock, local: b.local });
  await newSession.worker.start();
  assert.equal(newSession.session[SESSION_KEY].tabs[1].protected, false);
});

test('tab protection rejects missing, private and malformed targets without changing exceptions', async () => {
  const b = browser({ tabs: [tab(1), tab(2, { incognito: true })] });
  await b.worker.start();
  for (const args of [[1, 'true', tab(1).url], [1, true], [-1, true, tab(1).url],
    [99, true, tab(1).url], [2, true, tab(2).url]]) {
    await assert.rejects(b.worker.setTabProtection(...args));
  }
  assert.equal(b.session[SESSION_KEY].tabs[1].protected, false);
});

test('site additions/removals persist, preserve preferences and match subdomains on dot boundaries', async () => {
  const learned = [{ hostname: 'other.example', idleMinutes: 60, updatedAt: 0 }];
  const b = browser({ tabs: [tab(1), tab(2, { url: 'https://sub.example.org/' }),
    tab(3, { url: 'https://example.org.evil.test/' })],
  local: { settings: { idleMinutes: 5, protectedHosts: [], learnedHostDelays: learned } } });
  await b.worker.start();
  await b.worker.setSiteProtection('Example.ORG.', true);
  await b.worker.setSiteProtection('example.org', true);
  assert.deepEqual(b.local.settings.protectedHosts, ['example.org']);
  assert.deepEqual(b.local.settings.learnedHostDelays, learned);
  assert.equal(b.local.settings.idleMinutes, 5);
  const newSession = browser({ tabs: [...b.records.values()], clock: b.clock, local: b.local });
  await newSession.worker.start();
  b.clock.at = 6 * MINUTE;
  await newSession.worker.scan();
  assert.deepEqual(newSession.discarded, [3]);
  await newSession.worker.setSiteProtection('sub.example.org', true);
  await newSession.worker.setSiteProtection('example.org', false);
  assert.deepEqual(b.local.settings.protectedHosts, ['sub.example.org']);
});

test('invalid site requests and exceeding the 500-site bound leave stored settings intact', async () => {
  const hosts = Array.from({ length: 500 }, (_, index) => `site${index}.example`);
  const b = browser({ local: { settings: { idleMinutes: 5, protectedHosts: hosts } } });
  await b.worker.start();
  for (const args of [['*.example.org', true], ['https://example.org', true], [null, true], ['example.org', 'true']]) {
    await assert.rejects(b.worker.setSiteProtection(...args), /Invalid site/);
  }
  await assert.rejects(b.worker.setSiteProtection('extra.example', true), /500-site/);
  assert.deepEqual(b.local.settings.protectedHosts, hosts);
  await b.worker.setSiteProtection(hosts[0], false);
  await b.worker.setSiteProtection('extra.example', true);
  assert.equal(b.local.settings.protectedHosts.length, 500);
  assert.ok(b.local.settings.protectedHosts.includes('extra.example'));
});

test('site protection arriving during a scan cancels the in-flight action', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  let protection;
  b.safety.inspect = async target => {
    protection ??= b.worker.setSiteProtection('example.org', true);
    return b.safe(target);
  };
  assert.equal((await b.worker.scan()).reason, 'state-changed');
  await protection;
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
});

test('failed protection writes are reported and durable exceptions are reloaded before retry', async () => {
  const b = browser({ tabs: [tab(1, { active: true })] });
  await b.worker.start();
  const sessionSet = b.chrome.storage.session.set;
  b.chrome.storage.session.set = async () => { throw new Error('Session unavailable'); };
  await assert.rejects(b.worker.setTabProtection(1, true, b.records.get(1).url), /Session unavailable/);
  b.chrome.storage.session.set = sessionSet;
  assert.equal((await b.worker.managementStatus()).currentTab.protected, false);
  const localSet = b.chrome.storage.local.set;
  b.chrome.storage.local.set = async values => {
    if (values.settings) throw new Error('Preferences unavailable');
    return localSet(values);
  };
  await assert.rejects(b.worker.setSiteProtection('example.org', true), /Preferences unavailable/);
  b.chrome.storage.local.set = localSet;
  assert.equal((await b.worker.managementStatus()).protectedHosts.includes('example.org'), false);
});

async function unloadedBrowser(options = {}) {
  const b = browser(options);
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  return b;
}

test('restore finds the newest available EcoGuard discard and skips Chrome-discarded, closed or changed tabs', async () => {
  const b = await unloadedBrowser({ tabs: [tab(1), tab(2), tab(3, { discarded: true })] });
  assert.equal((await b.worker.managementStatus()).restoreTarget.tabId, 2);
  b.records.delete(2);
  assert.equal((await b.worker.managementStatus()).restoreTarget.tabId, 1);
  b.records.get(1).url = 'https://example.org/a-different-page';
  assert.equal((await b.worker.managementStatus()).restoreTarget, null);
  assert.deepEqual(b.selected, []);
});

test('restore preserves actual discard order when timestamps tie, including across worker restart', async () => {
  const b = browser({ tabs: [tab(2)] });
  await b.worker.start();
  b.clock.at = MINUTE;
  b.records.set(1, tab(1));
  b.chrome.tabs.onCreated.emit(tab(1));
  await b.worker.settled();
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  assert.deepEqual(b.discarded, [2, 1]);
  assert.equal((await b.worker.managementStatus()).restoreTarget.tabId, 1);
  const restarted = browser({ tabs: [...b.records.values()], session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  assert.equal((await restarted.worker.managementStatus()).restoreTarget.tabId, 1);
});

test('restore activates the existing tab, focuses its window and consumes rapid feedback once', async () => {
  const b = await unloadedBrowser({ tabs: [tab(1, { windowId: 2 })] });
  const target = (await b.worker.managementStatus()).restoreTarget;
  b.clock.at += MINUTE;
  assert.deepEqual(await b.worker.restoreLastUnloaded(target), { restored: true, hostname: 'example.org', focusFailed: false });
  await b.worker.settled();
  assert.deepEqual(b.selected, [{ id: 1, properties: { active: true } }]);
  assert.deepEqual(b.focused, [{ id: 2, properties: { focused: true } }]);
  assert.equal(b.records.size, 1);
  assert.equal(b.local.settings.learnedHostDelays[0].idleMinutes, 10);
  assert.equal((await b.worker.managementStatus()).restoreTarget, null);
  assert.equal(b.session[SESSION_KEY].tabs[1].recentActivations.length, 1);
  await assert.rejects(b.worker.restoreLastUnloaded(target), /no longer available/);
  assert.equal(b.local.settings.learnedHostDelays[0].idleMinutes, 10);
});

test('restore remains available after worker restart without relying on local history', async () => {
  const b = await unloadedBrowser();
  b.local.browserHistory = [];
  const restarted = browser({ tabs: [...b.records.values()], session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  const target = (await restarted.worker.managementStatus()).restoreTarget;
  await restarted.worker.restoreLastUnloaded(target);
  assert.deepEqual(restarted.selected, [{ id: 1, properties: { active: true } }]);
});

test('stale and malformed restore selections never activate a different or already restored tab', async () => {
  for (const change of ['closed', 'url', 'loaded', 'private', 'record']) {
    const b = await unloadedBrowser();
    const target = (await b.worker.managementStatus()).restoreTarget;
    if (change === 'closed') b.records.delete(1);
    if (change === 'url') b.records.get(1).url += '/changed';
    if (change === 'loaded') b.records.get(1).discarded = false;
    if (change === 'private') b.records.get(1).incognito = true;
    if (change === 'record') target.discardedAt--;
    await assert.rejects(b.worker.restoreLastUnloaded(target));
    assert.deepEqual(b.selected, [], change);
  }
  const b = await unloadedBrowser();
  for (const target of [undefined, {}, { tabId: 1, hostname: null, discardedAt: 0 },
    { tabId: 1, hostname: 'example.org', discardedAt: Infinity }]) {
    await assert.rejects(b.worker.restoreLastUnloaded(target));
  }
  assert.deepEqual(b.selected, []);
});

test('restore API errors are reported without consuming the selection, and focus failure is partial success', async () => {
  const b = await unloadedBrowser();
  const target = (await b.worker.managementStatus()).restoreTarget;
  const update = b.chrome.tabs.update;
  b.chrome.tabs.update = async () => { throw new Error('Activation failed'); };
  await assert.rejects(b.worker.restoreLastUnloaded(target), /Activation failed/);
  assert.equal((await b.worker.managementStatus()).restoreTarget.tabId, 1);
  b.chrome.tabs.update = update;
  b.chrome.windows.update = async () => { throw new Error('Window closed'); };
  assert.equal((await b.worker.restoreLastUnloaded(target)).focusFailed, true);
  assert.equal(b.records.get(1).active, true);
});

test('background validates popup senders for every new management request', async () => {
  const b = browser({ tabs: [tab(1, { active: true })] });
  const bg = background(b.chrome, () => b.clock.at);
  const requests = [{ type: 'managementStatus' },
    { type: 'setTabProtection', tabId: 1, expectedUrl: tab(1).url, protected: true },
    { type: 'setSiteProtection', hostname: 'example.org', protected: true },
    { type: 'restoreLastUnloaded', target: { tabId: 1, hostname: 'example.org', discardedAt: 0 } }];
  for (const sender of [{ id: 'other', url: 'chrome-extension://ecoguard/popup.html' },
    { id: 'ecoguard', url: 'https://example.org', tab: { id: 1 } },
    { id: 'ecoguard', url: 'chrome-extension://ecoguard/other.html' }]) {
    for (const request of requests) assert.equal(await bg.send(request, sender), undefined);
  }
  const initial = await bg.send({ type: 'managementStatus' });
  assert.equal(initial.currentTab.protected, false);
  assert.equal(initial.protectedHosts.includes('example.org'), false);
  assert.equal((await bg.send(requests[1])).ok, true);
  assert.equal((await bg.send(requests[2])).ok, true);
  const after = await bg.send(requests[0]);
  assert.equal(after.currentTab.protected, true);
  assert.ok(after.protectedHosts.includes('example.org'));
  assert.equal((await bg.send({ type: 'setTabProtection', tabId: 1, protected: true })).ok, false);
  assert.deepEqual(b.selected, []);
});

test('background restore route activates the displayed EcoGuard selection', async () => {
  const prepared = await unloadedBrowser();
  const b = browser({ tabs: [...prepared.records.values()], local: prepared.local,
    session: prepared.session, clock: prepared.clock });
  const bg = background(b.chrome, () => b.clock.at);
  const target = (await bg.send({ type: 'managementStatus' })).restoreTarget;
  assert.equal((await bg.send({ type: 'restoreLastUnloaded', target })).restored, true);
  assert.equal(b.selected[0].id, target.tabId);
});

function managementFixture() {
  return { currentTab: { tabId: 1, url: 'https://sub.example.org/work', hostname: 'sub.example.org',
    protected: false, matchingHosts: ['example.org'] }, protectedHosts: ['example.org'],
  restoreTarget: { tabId: 2, hostname: 'other.example', discardedAt: 0 } };
}

test('popup protection controls submit bound targets and retain inherited site explanations', async () => {
  const state = managementFixture();
  const p = await popup(async message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: [] };
    if (message.type === 'setTabProtection') state.currentTab.protected = message.protected;
    if (message.type === 'setSiteProtection') {
      state.protectedHosts = message.protected ? [...state.protectedHosts, message.hostname]
        : state.protectedHosts.filter(host => host !== message.hostname);
      state.currentTab.matchingHosts = [...state.protectedHosts];
    }
    return { ok: true };
  }, { managementStatus: async () => ({ ok: true, ...structuredClone(state) }) });
  assert.match(p.element('protection-state').textContent, /example.org/);
  await p.element('protect-tab').listeners.click();
  assert.deepEqual(p.requests.find(message => message.type === 'setTabProtection'),
    { type: 'setTabProtection', tabId: 1, expectedUrl: 'https://sub.example.org/work', protected: true });
  assert.equal(p.element('protect-tab').textContent, 'Unprotect this tab');
  await p.element('protect-tab').listeners.click();
  assert.equal(p.element('protect-tab').textContent, 'Protect this tab');
  assert.match(p.element('protection-state').textContent, /Site protection: example.org/);
  await p.element('protect-site').listeners.click();
  assert.equal(p.element('protect-site').disabled, true);
  const removeParent = p.element('protected-sites').children[0].children[1];
  assert.match(removeParent.attributes['aria-label'], /example.org and its subdomains/);
  await removeParent.listeners.click();
  assert.deepEqual(state.protectedHosts, ['sub.example.org']);
});

test('popup restore uses the displayed selection, refreshes counts and explains partial focus success', async () => {
  const state = managementFixture();
  const p = await popup(async message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: state.restoreTarget ? [2] : [] };
    assert.equal(message.type, 'restoreLastUnloaded');
    state.restoreTarget = null;
    return { ok: true, restored: true, focusFailed: true };
  }, { managementStatus: async () => ({ ok: true, ...structuredClone(state) }) });
  assert.match(p.element('restore-target').textContent, /other.example/);
  await p.element('restore-last').listeners.click();
  assert.deepEqual(p.requests.find(message => message.type === 'restoreLastUnloaded').target,
    { tabId: 2, hostname: 'other.example', discardedAt: 0 });
  assert.equal(p.element('restore-last').disabled, true);
  assert.equal(p.element('close-unloaded').textContent, 'Close unloaded tabs (0)');
  assert.match(p.element('restore-feedback').textContent, /could not be focused/);
});

test('popup disables unavailable controls while allowing protected-site management on browser pages', async () => {
  const p = await popup(async () => ({ ok: true, tabIds: [] }), {
    managementStatus: async () => ({ ok: true, currentTab: null, protectedHosts: ['example.org'], restoreTarget: null })
  });
  for (const id of ['protect-tab', 'protect-site', 'restore-last']) assert.equal(p.element(id).disabled, true);
  assert.equal(p.element('protected-sites').children[0].children[1].disabled, false);
  await p.element('protect-tab').listeners.click();
  assert.equal(p.requests.some(message => message.type === 'setTabProtection'), false);
});

test('popup blocks duplicate management clicks and reports action errors without changing protection', async () => {
  const state = managementFixture();
  let finish;
  const p = await popup(message => message.type === 'unloadedTabsStatus' ? { ok: true, tabIds: [] }
    : new Promise(resolve => { finish = resolve; }), {
    managementStatus: async () => ({ ok: true, ...structuredClone(state) })
  });
  const button = p.element('protect-tab');
  const pending = button.listeners.click();
  assert.equal(button.disabled, true);
  await button.listeners.click();
  assert.equal(p.requests.filter(message => message.type === 'setTabProtection').length, 1);
  finish({ ok: false, error: 'This tab changed' });
  await pending;
  assert.equal(button.textContent, 'Protect this tab');
  assert.match(p.element('protection-feedback').textContent, /This tab changed/);
});

test('failed context discovery keeps controls disabled with a useful error', async () => {
  const p = await popup(async () => ({ ok: true, tabIds: [] }), {
    managementStatus: async () => ({ ok: false, error: 'Cannot inspect the current tab. Reopen the popup.' })
  });
  assert.match(p.element('protection-feedback').textContent, /Cannot inspect/);
  for (const id of ['protect-tab', 'protect-site', 'restore-last']) assert.equal(p.element(id).disabled, true);
});
