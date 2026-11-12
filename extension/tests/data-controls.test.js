import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { browser, tab } from './helpers/browser.js';
import { popup } from './helpers/popup.js';
import { background } from './helpers/background.js';
import { createBrowserWorker, HISTORY_KEY, SESSION_KEY } from '../worker.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../settings.js';
import { MINUTE_MS as MINUTE } from '../policy.js';

async function prepared() {
  const b = browser({ tabs: [tab(1), tab(2, { active: true })], local: {
    unrelatedKey: 'keep-me', settings: { idleMinutes: 5, protectedHosts: ['safe.example'],
      learnedHostDelays: [{ hostname: 'other.example', idleMinutes: 45, updatedAt: 0 }] }
  } });
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  await b.worker.setTabProtection(2, true, tab(2).url);
  return b;
}

test('history export is bounded JSON with metadata only and a local save dialog', async () => {
  const events = Array.from({ length: 600 }, (_, timestamp) => ({ timestamp, tabId: 1,
    hostname: 'example.org', action: 'discarded', reason: 'eligible',
    url: 'https://secret.example/private', title: 'secret title', value: 'secret field value' }));
  const b = browser({ clock: { at: 1000 }, local: { [HISTORY_KEY]: events } });
  await b.worker.start();
  const result = await b.worker.exportHistory();
  assert.equal(result.eventCount, 500);
  assert.equal(result.downloadId, 1);
  const download = b.downloads[0];
  assert.equal(download.saveAs, true);
  assert.match(download.filename, /^EcoGuard-history-[\dTZ-]+\.json$/);
  const payload = JSON.parse(decodeURIComponent(download.url.split(',')[1]));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.application, 'EcoGuard');
  assert.equal(payload.events.length, 500);
  assert.deepEqual(Object.keys(payload.events[0]).sort(), ['action', 'hostname', 'reason', 'tabId', 'timestamp']);
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(b.local[HISTORY_KEY].length, 500);
});

test('empty export is valid and download cancellation/failure does not clear history', async () => {
  const empty = browser();
  await empty.worker.start();
  assert.equal((await empty.worker.exportHistory()).eventCount, 0);
  const b = await prepared();
  const before = structuredClone(b.local[HISTORY_KEY]);
  b.chrome.downloads.download = async () => { throw new Error('User canceled'); };
  await assert.rejects(b.worker.exportHistory(), /User canceled/);
  assert.deepEqual(b.local[HISTORY_KEY], before);
  b.chrome.downloads.download = async () => undefined;
  await assert.rejects(b.worker.exportHistory(), /did not start/);
});

test('every reset requires literal confirmation before any reset side effects', async () => {
  const b = await prepared();
  const local = structuredClone(b.local);
  const session = structuredClone(b.session);
  for (const value of [undefined, false, 'true', 1, null]) {
    for (const method of ['clearHistory', 'resetLearning', 'resetLocalData']) {
      await assert.rejects(b.worker[method](value), /Confirm/);
    }
  }
  assert.deepEqual(b.local, local);
  assert.deepEqual(b.session, session);
});

test('clearing history preserves settings, tab protections, pause and confirmed restore records', async () => {
  const b = await prepared();
  await b.worker.setPaused(true);
  const settings = structuredClone(b.local.settings);
  await b.worker.clearHistory(true);
  assert.equal((await b.worker.status()).historyCount, 0);
  assert.deepEqual(b.local.settings, settings);
  assert.equal(b.session[SESSION_KEY].tabs[2].protected, true);
  assert.equal((await b.worker.managementStatus()).restoreTarget.tabId, 1);
  const restarted = browser({ tabs: [...b.records.values()], local: b.local, session: b.session, clock: b.clock });
  await restarted.worker.start();
  assert.equal((await restarted.worker.status()).historyCount, 0);
  assert.equal((await restarted.worker.status()).paused, true);
});

test('resetting learned delays preserves unrelated data and allows new rapid-restore feedback', async () => {
  const b = await prepared();
  const history = structuredClone(b.local[HISTORY_KEY]);
  await b.worker.resetLearning(true);
  assert.deepEqual(b.local.settings.learnedHostDelays, []);
  assert.deepEqual(b.local.settings.protectedHosts, ['safe.example']);
  assert.equal(b.local.settings.idleMinutes, 5);
  assert.deepEqual(b.local[HISTORY_KEY], history);
  assert.equal(b.session[SESSION_KEY].tabs[2].protected, true);
  b.clock.at += MINUTE;
  await b.worker.restoreLastUnloaded((await b.worker.managementStatus()).restoreTarget);
  await b.worker.settled();
  assert.equal(b.local.settings.learnedHostDelays[0].idleMinutes, 10);
});

test('full reset restores defaults, removes session exceptions/restore records and stays paused without touching tabs', async () => {
  const b = await prepared();
  b.clock.at += MINUTE;
  const records = structuredClone([...b.records.values()]);
  const result = await b.worker.resetLocalData(true);
  assert.equal(result.paused, true);
  assert.deepEqual(result.settings, normalizeSettings(DEFAULT_SETTINGS));
  assert.deepEqual(b.local[HISTORY_KEY], []);
  assert.equal(b.local.unrelatedKey, 'keep-me');
  assert.equal(b.session[SESSION_KEY].tabs[2].protected, false);
  assert.equal(b.session[SESSION_KEY].tabs[1].discard, undefined);
  assert.equal(b.session[SESSION_KEY].tabs[1].lastActiveAt, b.clock.at);
  assert.equal((await b.worker.managementStatus()).restoreTarget, null);
  assert.deepEqual([...b.records.values()], records);
  assert.deepEqual(b.removed, []);
  assert.deepEqual(b.selected, []);
  const restarted = browser({ tabs: records, session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  assert.equal((await restarted.worker.scan()).reason, 'manager-paused');
});

test('reset arriving during inspection invalidates the scan before changes run', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  let reset;
  b.safety.inspect = async target => {
    reset ??= b.worker.resetLocalData(true);
    return b.safe(target);
  };
  assert.equal((await b.worker.scan()).reason, 'state-changed');
  await reset;
  assert.deepEqual(b.discarded, []);
  assert.equal((await b.worker.status()).paused, true);
});

for (const failure of ['local-write', 'final-session-write']) {
  test(`full reset recovers a durable intent after ${failure} failure across worker restart`, async () => {
    const b = await prepared();
    if (failure === 'local-write') {
      b.chrome.storage.local.set = async () => { throw new Error('Reset write interrupted'); };
    } else {
      const set = b.chrome.storage.session.set;
      b.chrome.storage.session.set = async values => {
        if (values[SESSION_KEY].resetPending === false) throw new Error('Reset write interrupted');
        return set(values);
      };
    }
    await assert.rejects(b.worker.resetLocalData(true), /Reset write interrupted/);
    assert.equal(b.session[SESSION_KEY].resetPending, true);
    assert.equal(b.session[SESSION_KEY].paused, true);
    const restarted = browser({ tabs: [...b.records.values()], local: b.local, session: b.session, clock: b.clock });
    await restarted.worker.start();
    assert.deepEqual(b.local.settings, normalizeSettings(DEFAULT_SETTINGS));
    assert.deepEqual(b.local[HISTORY_KEY], []);
    assert.equal(b.session[SESSION_KEY].resetPending, false);
    assert.equal((await restarted.worker.scan()).reason, 'manager-paused');
  });
}

test('failure to persist reset intent prevents deletion, and failed narrow resets preserve durable data', async () => {
  const b = await prepared();
  const before = structuredClone(b.local);
  const sessionSet = b.chrome.storage.session.set;
  b.chrome.storage.session.set = async () => { throw new Error('Session unavailable'); };
  await assert.rejects(b.worker.resetLocalData(true), /Session unavailable/);
  assert.deepEqual(b.local, before);
  b.chrome.storage.session.set = sessionSet;
  await b.worker.status();
  const localSet = b.chrome.storage.local.set;
  b.chrome.storage.local.set = async () => { throw new Error('Local unavailable'); };
  await assert.rejects(b.worker.clearHistory(true), /Local unavailable/);
  b.chrome.storage.local.set = localSet;
  await b.worker.status();
  b.chrome.storage.local.set = async () => { throw new Error('Local unavailable'); };
  await assert.rejects(b.worker.resetLearning(true), /Local unavailable/);
  b.chrome.storage.local.set = localSet;
  assert.deepEqual(b.local, before);
});

test('edit reset rejects unconfirmed, changed, private and discarded targets before contacting the page', async () => {
  const b = browser({ tabs: [tab(1), tab(2, { incognito: true }), tab(3, { discarded: true })] });
  await b.worker.start();
  let resets = 0;
  b.safety.resetEdits = async () => { resets++; };
  for (const args of [[1, tab(1).url, false], [1, tab(1).url, 'true'],
    [1, 'https://changed.example/', true], [2, tab(2).url, true], [3, tab(3).url, true],
    [-1, tab(1).url, true], [1, 'chrome://settings', true]]) {
    await assert.rejects(b.worker.resetPageEdits(...args));
  }
  assert.equal(resets, 0);
});

test('edit reset restarts interaction grace and preserves site/tab/learning settings', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  const settings = (await b.worker.status()).settings;
  let interaction = 0;
  b.safety.resetEdits = async target => {
    interaction = b.clock.at;
    return { ...b.safe(target), reset: true, lastInteractionAt: interaction };
  };
  b.safety.inspect = async target => ({ ...b.safe(target), lastInteractionAt: interaction });
  await b.worker.resetPageEdits(1, tab(1).url, true);
  assert.equal(b.session[SESSION_KEY].tabs[1].lastInteractionAt, b.clock.at);
  assert.deepEqual((await b.worker.status()).settings, settings);
  b.clock.at += 5 * MINUTE - 1;
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  b.clock.at++;
  await b.worker.scan();
  assert.deepEqual(b.discarded, [1]);
});

test('unconfirmed or stale page reset replies fail, and a navigation during reset cannot alter the new page state', async () => {
  for (const fields of [{ inspected: false }, { reset: false }, { edited: true }, { tabId: 2 },
    { checkedAt: 0 }, { lastInteractionAt: Infinity }]) {
    const b = browser();
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    b.safety.resetEdits = async target => ({ ...b.safe(target), reset: true, ...fields });
    await assert.rejects(b.worker.resetPageEdits(1, tab(1).url, true), /Could not confirm/);
  }
  const b = browser();
  await b.worker.start();
  b.safety.resetEdits = async target => {
    b.records.get(1).url = 'https://changed.example/';
    return { ...b.safe(target), reset: true };
  };
  await assert.rejects(b.worker.resetPageEdits(1, tab(1).url, true), /page changed/);
  assert.equal(b.session[SESSION_KEY].tabs[1].url, tab(1).url);
});

test('real edit-reset transport clears only edits, retains media protection and protects future edits again', async () => {
  const source = await readFile(new URL('../page-safety.js', import.meta.url), 'utf8');
  const b = browser({ tabs: [tab(1, { active: true })] });
  let receive;
  let edit;
  const document = { readyState: 'loading', documentElement: {},
    querySelectorAll: () => [{ localName: 'video', paused: false, ended: false, srcObject: null }],
    addEventListener: (type, handler) => { if (type === 'input') edit = handler; } };
  const window = { addEventListener: () => {} };
  window.top = window;
  vm.runInNewContext(source, { document, window, location: { href: tab(1).url }, Date: { now: () => b.clock.at },
    chrome: { runtime: { id: 'ecoguard', onMessage: { addListener: callback => { receive = callback; } } } } });
  document.readyState = 'complete';
  edit();
  b.chrome.tabs.sendMessage = async (id, message, options) => {
    assert.equal(id, 1);
    assert.equal(options.frameId, 0);
    let reply;
    receive(message, { id: 'ecoguard' }, value => { reply = value; });
    return reply;
  };
  const worker = createBrowserWorker({ chrome: b.chrome, now: () => b.clock.at });
  await worker.start();
  b.clock.at = 6 * MINUTE;
  assert.equal((await worker.managementStatus()).currentTab.safety.edited, true);
  await worker.resetPageEdits(1, tab(1).url, true);
  const safety = (await worker.managementStatus()).currentTab.safety;
  assert.equal(safety.edited, false);
  assert.equal(safety.playingMedia, true);
  assert.equal(safety.lastInteractionAt, b.clock.at);
  edit();
  assert.equal((await worker.managementStatus()).currentTab.safety.edited, true);
});

test('background gates all data controls to the popup and routes confirmed reset/export commands', async () => {
  const b = browser({ tabs: [tab(1, { active: true })] });
  const bg = background(b.chrome, () => b.clock.at);
  const messages = [{ type: 'exportHistory' }, { type: 'clearHistory', confirmed: true },
    { type: 'resetLearning', confirmed: true }, { type: 'resetLocalData', confirmed: true },
    { type: 'resetPageEdits', tabId: 1, expectedUrl: tab(1).url, confirmed: true }];
  for (const sender of [{ id: 'other', url: 'chrome-extension://ecoguard/popup.html' },
    { id: 'ecoguard', url: 'https://example.org', tab: { id: 1 } }]) {
    for (const message of messages) assert.equal(await bg.send(message, sender), undefined);
  }
  assert.deepEqual(b.downloads, []);
  assert.equal((await bg.send({ type: 'exportHistory' })).eventCount, 0);
  b.chrome.tabs.sendMessage = async (id, message) => ({
    inspected: true, url: message.expectedUrl, checkedAt: b.clock.at, lastInteractionAt: b.clock.at,
    edited: false, playingMedia: false, hasEmbeddedFrame: false, capturing: false, sharing: false,
    ...(message.type === 'resetPageEdits' ? { reset: true } : {})
  });
  assert.equal((await bg.send(messages[4])).reset, true);
  for (const type of ['clearHistory', 'resetLearning', 'resetLocalData']) {
    assert.equal((await bg.send({ type })).ok, false);
    assert.equal((await bg.send({ type, confirmed: true })).ok, true);
  }
  assert.equal((await bg.send({ type: 'resetPageEdits', tabId: 1, expectedUrl: tab(1).url })).ok, false);
});

const context = edited => ({ currentTab: { tabId: 1, url: tab(1).url, hostname: 'example.org',
  protected: false, matchingHosts: [], safety: { inspected: true, edited } }, protectedHosts: [], restoreTarget: null });

test('popup reset confirmation is cancellable, and export never claims the file already completed', async () => {
  const p = await popup(async message => message.type === 'unloadedTabsStatus'
    ? { ok: true, tabIds: [] } : { ok: true, eventCount: 3 }, {
    managementStatus: async () => ({ ok: true, ...context(false) })
  });
  await p.element('clear-history').listeners.click();
  assert.equal(p.element('confirmation').open, true);
  assert.equal(p.requests.some(message => message.type === 'clearHistory'), false);
  await p.element('cancel-reset').listeners.click();
  await p.element('confirm-reset').listeners.click();
  assert.equal(p.requests.some(message => message.type === 'clearHistory'), false);
  await p.element('export-history').listeners.click();
  assert.match(p.element('data-feedback').textContent, /export started \(3 events\)/);
});

test('popup confirms resets explicitly, blocks duplicate submits and refreshes defaults/pause', async () => {
  let done = false;
  let finish;
  const p = await popup(message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: [] };
    return new Promise(resolve => { finish = () => { done = true; resolve({ ok: true }); }; });
  }, { status: async () => ({ ok: true, settings: { idleMinutes: done ? 30 : 5, learnedHostDelays: [] }, paused: done,
    historyCount: done ? 0 : 3 }), managementStatus: async () => ({ ok: true, ...context(false) }) });
  await p.element('reset-local').listeners.click();
  assert.match(p.element('confirmation-text').textContent, /pauses automatic unloading/);
  const operation = p.element('confirm-reset').listeners.click();
  await p.element('confirm-reset').listeners.click();
  assert.equal(p.requests.filter(message => message.type === 'resetLocalData').length, 1);
  assert.equal(p.element('save').disabled, true);
  assert.equal(p.element('protect-tab').disabled, true);
  finish();
  await operation;
  assert.equal(p.requests.find(message => message.type === 'resetLocalData').confirmed, true);
  assert.equal(p.element('idle').value, 30);
  assert.equal(p.element('pause').textContent, 'Resume automatic unloading');
  assert.match(p.element('data-summary').textContent, /0 history events/);
});

test('popup edit reset confirmation binds the original tab and leaves refreshed protections visible', async () => {
  let edited = true;
  const p = await popup(async message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: [] };
    assert.equal(message.type, 'resetPageEdits');
    edited = false;
    return { ok: true, reset: true };
  }, { managementStatus: async () => ({ ok: true, ...context(edited) }) });
  await p.element('reset-edits').listeners.click();
  assert.match(p.element('confirmation-text').textContent, /Save your work first/);
  assert.match(p.element('confirmation-text').textContent, /five-minute interaction grace/);
  assert.equal(p.requests.some(message => message.type === 'resetPageEdits'), false);
  await p.element('confirm-reset').listeners.click();
  assert.deepEqual(p.requests.find(message => message.type === 'resetPageEdits'),
    { type: 'resetPageEdits', tabId: 1, expectedUrl: tab(1).url, confirmed: true });
  assert.equal(p.element('reset-edits').disabled, true);
  assert.match(p.element('edit-state').textContent, /No edited-page protection/);
});

test('popup disables edit reset for unedited/uninspectable pages and shows backend errors without reporting success', async () => {
  for (const safety of [{ inspected: true, edited: false }, { inspected: false }]) {
    const state = context(false);
    state.currentTab.safety = safety;
    const p = await popup(async () => ({ ok: true, tabIds: [] }), {
      managementStatus: async () => ({ ok: true, ...state })
    });
    assert.equal(p.element('reset-edits').disabled, true);
    await p.element('reset-edits').listeners.click();
    assert.equal(p.element('confirmation').open, undefined);
  }
  const p = await popup(async message => message.type === 'unloadedTabsStatus'
    ? { ok: true, tabIds: [] } : { ok: false, error: 'Storage unavailable' }, {
    managementStatus: async () => ({ ok: true, ...context(false) })
  });
  await p.element('reset-learning').listeners.click();
  await p.element('confirm-reset').listeners.click();
  assert.match(p.element('data-feedback').textContent, /Storage unavailable/);
  assert.equal(p.element('reset-learning').disabled, false);
});

test('Escape cancels a reset confirmation and a failed dialog cannot authorize a reset', async () => {
  const p = await popup(async () => ({ ok: true, tabIds: [] }), {
    managementStatus: async () => ({ ok: true, ...context(false) })
  });
  await p.element('reset-learning').listeners.click();
  p.element('confirmation').listeners.cancel();
  p.element('confirmation').close();
  await p.element('confirm-reset').listeners.click();
  assert.equal(p.requests.some(message => message.type === 'resetLearning'), false);
  p.element('confirmation').showModal = () => { throw new Error('Dialog unavailable'); };
  await p.element('reset-local').listeners.click();
  await p.element('confirm-reset').listeners.click();
  assert.equal(p.requests.some(message => message.type === 'resetLocalData'), false);
  assert.match(p.element('data-feedback').textContent, /Dialog unavailable/);
});

test('reset controls wait for an outstanding preference save, preventing a reset/write race', async () => {
  let finish;
  const p = await popup(message => message.type === 'unloadedTabsStatus' ? { ok: true, tabIds: [] }
    : new Promise(resolve => { finish = resolve; }), {
    managementStatus: async () => ({ ok: true, ...context(false) })
  });
  const saving = p.element('settings').listeners.submit({ preventDefault: () => {} });
  assert.equal(p.element('reset-local').disabled, true);
  await p.element('reset-local').listeners.click();
  assert.equal(p.element('confirmation').open, undefined);
  finish({ ok: true, settings: { idleMinutes: 30 } });
  await saving;
  assert.equal(p.element('reset-local').disabled, false);
});
