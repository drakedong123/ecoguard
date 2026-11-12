import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnloadedTabsService } from '../unloaded-tabs.js';
import { browser as workerBrowser } from './helpers/browser.js';
import { popup } from './helpers/popup.js';
import { background } from './helpers/background.js';

const tab = (id, fields = {}) => ({ id, discarded: true, active: false, pinned: false, incognito: false, ...fields });

function browser(initial) {
  const records = new Map(initial.map(value => [value.id, value]));
  const removed = [];
  const tabs = {
    query: async query => {
      assert.ok(query.discarded === true || Object.keys(query).length === 0);
      return [...records.values()];
    },
    get: async id => {
      if (!records.has(id)) throw new Error('No such tab');
      return records.get(id);
    },
    remove: async id => { removed.push(id); records.delete(id); }
  };
  return { records, removed, tabs, service: createUnloadedTabsService(tabs) };
}

test('listing unloaded tabs across windows excludes active, pinned, private and unknown states', async () => {
  const b = browser([
    tab(1, { windowId: 10 }), tab(2, { windowId: 20 }),
    tab(3, { discarded: false }), tab(4, { active: true }), tab(5, { pinned: true }),
    tab(6, { incognito: true }), tab(7, { discarded: undefined }),
    tab(8, { active: undefined }), tab(9, { pinned: undefined }),
    tab(10, { incognito: undefined }), tab(-1)
  ]);
  assert.deepEqual(await b.service.list(), [1, 2]);
  assert.deepEqual(b.removed, []);
});

test('close rechecks the displayed selection and skips restored, active, pinned or missing tabs', async () => {
  const b = browser([tab(1), tab(2), tab(3), tab(4), tab(5)]);
  const selection = await b.service.list();
  b.records.set(1, tab(1, { discarded: false }));
  b.records.set(2, tab(2, { active: true }));
  b.records.set(3, tab(3, { pinned: true }));
  b.records.delete(4);
  b.records.set(6, tab(6)); // A newly unloaded tab was never shown to the user.
  assert.deepEqual(await b.service.close(selection), { closed: 1, skipped: 4, failed: 0 });
  assert.deepEqual(b.removed, [5]);
  assert.ok(b.records.has(6));
});

test('individual close failures are reported and do not stop the remaining selection', async () => {
  const b = browser([tab(1), tab(2)]);
  const remove = b.tabs.remove;
  b.tabs.remove = async id => {
    if (id === 1) throw new Error('Browser refused');
    await remove(id);
  };
  assert.deepEqual(await b.service.close([1, 2]), { closed: 1, skipped: 0, failed: 1 });
  assert.deepEqual(b.removed, [2]);
});

test('invalid selections cannot close tabs, and duplicate IDs are removed once', async () => {
  const b = browser([tab(1)]);
  for (const selection of [undefined, null, '1', [1, -1], [1, '2'], [1, 1.5]]) {
    await assert.rejects(b.service.close(selection), /Invalid unloaded-tab selection/);
  }
  assert.deepEqual(b.removed, []);
  assert.deepEqual(await b.service.close([1, 1]), { closed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(b.removed, [1]);
});

test('a mismatched lookup result never closes the requested tab', async () => {
  const b = browser([tab(1)]);
  b.tabs.get = async () => tab(2);
  assert.deepEqual(await b.service.close([1]), { closed: 0, skipped: 1, failed: 0 });
  assert.deepEqual(b.removed, []);
});

test('popup displays the count and closes only after a click, then refreshes the count', async () => {
  let closed = false;
  const p = await popup(async message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: closed ? [] : [1, 2] };
    assert.equal(message.type, 'closeUnloadedTabs');
    assert.deepEqual(Array.from(message.tabIds), [1, 2]);
    closed = true;
    return { ok: true, closed: 1, skipped: 1, failed: 0 };
  });
  const button = p.element('close-unloaded');
  assert.equal(button.textContent, 'Close unloaded tabs (2)');
  assert.equal(button.disabled, false);
  assert.equal(closed, false);
  await button.listeners.click();
  assert.equal(closed, true);
  assert.equal(button.textContent, 'Close unloaded tabs (0)');
  assert.equal(button.disabled, true);
  assert.match(p.element('unloaded-feedback').textContent, /Closed 1 unloaded tab\. Skipped 1/);
  assert.equal(p.element('idle').value, 30);
});

test('popup keeps the action disabled when there are no unloaded tabs or discovery fails', async () => {
  for (const response of [{ ok: true, tabIds: [] }, { ok: false, error: 'Tab discovery failed' }]) {
    const p = await popup(async () => response);
    assert.equal(p.element('close-unloaded').disabled, true);
    assert.match(p.element('unloaded-feedback').textContent, /No unloaded tabs|Tab discovery failed/);
    await p.element('close-unloaded').listeners.click();
    assert.equal(p.requests.some(message => message.type === 'closeUnloadedTabs'), false);
    assert.equal(p.element('save').disabled, false);
  }
});

test('popup blocks repeated clicks while closing and reports failures without losing the count', async () => {
  let finish;
  const p = await popup(message => message.type === 'unloadedTabsStatus'
    ? { ok: true, tabIds: [1] }
    : new Promise(resolve => { finish = resolve; }));
  const button = p.element('close-unloaded');
  const pending = button.listeners.click();
  assert.equal(button.disabled, true);
  await button.listeners.click();
  assert.equal(p.requests.filter(message => message.type === 'closeUnloadedTabs').length, 1);
  finish({ ok: true, closed: 0, skipped: 0, failed: 1 });
  await pending;
  assert.match(p.element('unloaded-feedback').textContent, /Could not close 1 tab/);
  assert.equal(button.textContent, 'Close unloaded tabs (1)');
  assert.equal(button.disabled, false);
});

test('popup pause/resume reflects confirmed worker state and reports rejected changes', async () => {
  let fail = false;
  const p = await popup(async message => {
    if (message.type === 'unloadedTabsStatus') return { ok: true, tabIds: [] };
    if (fail) return { ok: false, error: 'Pause could not be saved' };
    return { ok: true, paused: message.paused };
  });
  const pause = p.element('pause');
  assert.equal(pause.textContent, 'Pause automatic unloading');
  await pause.listeners.click();
  assert.equal(pause.textContent, 'Resume automatic unloading');
  assert.match(p.element('feedback').textContent, /paused/);
  fail = true;
  await pause.listeners.click();
  assert.equal(pause.textContent, 'Resume automatic unloading');
  assert.match(p.element('feedback').textContent, /Pause could not be saved/);
  fail = false;
  await pause.listeners.click();
  assert.equal(pause.textContent, 'Pause automatic unloading');
  assert.equal(pause.disabled, false);
});

function worker(tabs) {
  const chrome = workerBrowser({ tabs: [], local: {} }).chrome;
  Object.assign(chrome.tabs, tabs);
  return background(chrome);
}

test('worker restricts tab closing to its own popup and routes the explicit selection', async () => {
  const b = browser([tab(1), tab(2)]);
  const w = worker(b.tabs);
  for (const sender of [
    { id: 'other', url: 'chrome-extension://ecoguard/popup.html' },
    { id: 'ecoguard', url: 'https://example.com', tab: { id: 1 } },
    { id: 'ecoguard', url: 'chrome-extension://ecoguard/other.html' }
  ]) {
    assert.equal(await w.send({ type: 'closeUnloadedTabs', tabIds: [1] }, sender), undefined);
  }
  assert.deepEqual(b.removed, []);
  assert.deepEqual(await w.send({ type: 'unloadedTabsStatus' }), { ok: true, tabIds: [1, 2] });
  assert.deepEqual(await w.send({ type: 'closeUnloadedTabs', tabIds: [1] }),
    { ok: true, closed: 1, skipped: 0, failed: 0 });
  assert.deepEqual(b.removed, [1]);
  assert.equal((await w.send({ type: 'status' })).settings.idleMinutes, 30);
});

test('worker returns discovery and validation errors to the popup', async () => {
  const b = browser([tab(1)]);
  b.tabs.query = async () => { throw new Error('Tab discovery failed'); };
  const w = worker(b.tabs);
  assert.deepEqual(await w.send({ type: 'unloadedTabsStatus' }), { ok: false, error: 'Tab discovery failed' });
  assert.equal((await w.send({ type: 'closeUnloadedTabs' })).ok, false);
  assert.deepEqual(b.removed, []);
});
