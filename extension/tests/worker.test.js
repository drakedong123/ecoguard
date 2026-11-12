import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { browser, tab } from './helpers/browser.js';
import { createBrowserWorker, HISTORY_KEY, SESSION_KEY, SCAN_ALARM } from '../worker.js';
import { MINUTE_MS as MINUTE } from '../policy.js';

test('listeners register synchronously, alarms are repaired, and new tabs get full grace', async () => {
  const b = browser();
  const ready = b.worker.start();
  assert.equal(b.chrome.tabs.onActivated.listeners.length, 1);
  assert.equal(b.chrome.alarms.onAlarm.listeners.length, 1);
  await ready;
  assert.equal(b.alarms.get(SCAN_ALARM).periodInMinutes, 1);
  await b.worker.start();
  assert.equal(b.chrome.tabs.onActivated.listeners.length, 1);
  b.clock.at = 5 * MINUTE - 1;
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  b.clock.at++;
  b.alarm();
  await b.worker.settled();
  assert.deepEqual(b.discarded, [1]);
  assert.equal((await b.worker.status()).cleanupAvailable, true);
});

test('scans prefer the longest inactivity and attempt at most two tabs', async () => {
  const b = browser({ tabs: [tab(3), tab(1)] });
  await b.worker.start();
  b.clock.at = MINUTE;
  b.records.set(2, tab(2));
  b.chrome.tabs.onCreated.emit(tab(2));
  await b.worker.settled();
  b.clock.at = 6 * MINUTE;
  assert.deepEqual(await b.worker.scan(), { discarded: 2, attempted: 2, reason: 'complete' });
  assert.deepEqual(b.discarded, [1, 3]);
  assert.equal(b.records.get(2).discarded, false);
});

test('worker restart preserves session observations while a new browser session grants fresh grace', async () => {
  const first = browser();
  await first.worker.start();
  first.clock.at = 6 * MINUTE;
  const restarted = browser({ session: first.session, local: first.local, clock: first.clock });
  await restarted.worker.start();
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, [1]);
  const newSession = browser({ local: first.local, clock: first.clock });
  await newSession.worker.start();
  await newSession.worker.scan();
  assert.deepEqual(newSession.discarded, []);
});

test('corrupt session data pauses cleanup; corrupt per-tab observations restart grace', async () => {
  const broken = browser({ session: { [SESSION_KEY]: { schemaVersion: 99 } } });
  await broken.worker.start();
  broken.clock.at = 60 * MINUTE;
  assert.equal((await broken.worker.scan()).reason, 'manager-paused');
  const b = browser();
  await b.worker.start();
  b.session[SESSION_KEY].tabs[1].lastActiveAt = 999 * MINUTE;
  b.clock.at = 6 * MINUTE;
  const restarted = browser({ session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, []);
});

test('switching away from a long-active tab starts a fresh inactivity period', async () => {
  const b = browser({ tabs: [tab(1, { active: true }), tab(2)] });
  await b.worker.start();
  b.clock.at = 60 * MINUTE;
  b.records.get(1).active = false;
  b.records.get(2).active = true;
  b.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 });
  await b.worker.settled();
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  assert.equal(b.session[SESSION_KEY].tabs[1].lastActiveAt, b.clock.at);
});

test('navigation and replacement reset inactivity; tab removal cleans session records', async () => {
  const b = browser({ tabs: [tab(1), tab(2)] });
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  b.chrome.tabs.onUpdated.emit(1, { status: 'loading' }); // Even a same-URL reload.
  b.records.delete(2);
  b.records.set(3, tab(3));
  b.chrome.tabs.onReplaced.emit(3, 2);
  await b.worker.settled();
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  assert.equal(b.session[SESSION_KEY].tabs[2], undefined);
  b.records.delete(1);
  b.chrome.tabs.onRemoved.emit(1);
  await b.worker.settled();
  assert.equal(b.session[SESSION_KEY].tabs[1], undefined);
});

test('repeated activations are persisted and veto unloading at the rolling-window boundary', async () => {
  const b = browser({ tabs: [tab(1), tab(2)] });
  await b.worker.start();
  for (const at of [MINUTE, 2 * MINUTE, 3 * MINUTE]) {
    b.clock.at = at;
    b.records.get(1).active = true;
    b.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
    await b.worker.settled();
    b.records.get(1).active = false;
    b.records.get(2).active = true;
    b.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 });
    await b.worker.settled();
  }
  b.clock.at = 31 * MINUTE;
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  assert.equal(b.session[SESSION_KEY].tabs[1].recentActivations.length, 3);
});

test('active tabs in every window, pinned tabs and site/tab exceptions receive no discard calls', async () => {
  const b = browser({ tabs: [tab(1, { active: true }), tab(2, { active: true, windowId: 2 }),
    tab(3, { pinned: true }), tab(4, { url: 'https://docs.google.com/document' }), tab(5)] });
  await b.worker.start();
  await b.worker.setTabProtection(5, true, b.records.get(5).url);
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  assert.deepEqual(b.discarded, []);
  const restarted = browser({ tabs: [...b.records.values()], session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, []);
  assert.equal(restarted.session[SESSION_KEY].tabs[5].protected, true);
});

test('downloads veto scanning, including API failures and a download appearing during inspection', async () => {
  for (const mode of ['busy', 'failure', 'late']) {
    const b = browser();
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    let checks = 0;
    b.chrome.downloads.search = async () => {
      checks++;
      if (mode === 'failure') throw new Error('No download access');
      return mode === 'busy' || checks > 1 ? [{ state: 'in_progress' }] : [];
    };
    await b.worker.scan();
    assert.deepEqual(b.discarded, [], mode);
  }
});

test('edited, media-playing, framed and uninspectable pages never reach tabs.discard', async () => {
  for (const observation of [{ edited: true }, { playingMedia: true }, { hasEmbeddedFrame: true },
    { capturing: true }, { sharing: true }, { inspected: false }, { lastInteractionAt: 6 * MINUTE }]) {
    const b = browser();
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    b.safety.inspect = async target => ({ ...b.safe(target), ...observation });
    await b.worker.scan();
    assert.deepEqual(b.discarded, []);
  }
});

test('fresh inspection and final tab lookup catch late edits, pinning, loading and URL changes', async () => {
  for (const mutation of ['edited', 'pinned', 'loading', 'url']) {
    const b = browser();
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    let calls = 0;
    b.safety.inspect = async target => {
      calls++;
      const observation = b.safe(target);
      if (calls === 2) {
        if (mutation === 'edited') observation.edited = true;
        if (mutation === 'pinned') b.records.get(1).pinned = true;
        if (mutation === 'loading') b.records.get(1).status = 'loading';
        if (mutation === 'url') b.records.get(1).url = 'https://other.example/';
      }
      return observation;
    };
    await b.worker.scan();
    assert.deepEqual(b.discarded, [], mutation);
    assert.equal(calls, 2);
  }
});

test('events arriving during asynchronous probes invalidate the scan before queued mutations run', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  b.safety.inspect = async target => {
    b.chrome.tabs.onUpdated.emit(1, { audible: true });
    return b.safe(target);
  };
  assert.equal((await b.worker.scan()).reason, 'state-changed');
  await b.worker.settled();
  assert.deepEqual(b.discarded, []);
});

test('an event queued behind a scan before execution starts invalidates that scan', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  const pending = b.worker.scan();
  b.chrome.downloads.onCreated.emit({ state: 'in_progress' });
  assert.equal((await pending).reason, 'state-changed');
  await b.worker.settled();
  assert.deepEqual(b.discarded, []);
});

test('pause arriving during a scan cancels it and persists across worker restart', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  let pause;
  b.safety.inspect = async target => {
    pause ??= b.worker.setPaused(true);
    return b.safe(target);
  };
  assert.equal((await b.worker.scan()).reason, 'state-changed');
  await pause;
  const restarted = browser({ session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  assert.equal((await restarted.worker.scan()).reason, 'manager-paused');
  assert.deepEqual(b.discarded, []);
  await restarted.worker.setPaused(false);
  await restarted.worker.scan();
  assert.deepEqual(restarted.discarded, [1]);
});

test('duplicate alarms coalesce, while browser discard events safely yield to the event queue', async () => {
  const b = browser({ tabs: [tab(1), tab(2)], emitOnDiscard: true });
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  const one = b.worker.scan();
  const two = b.worker.scan();
  assert.equal(one, two);
  await one;
  await b.worker.settled();
  assert.deepEqual(b.discarded, [1]);
  assert.equal(b.session[SESSION_KEY].tabs[1].discard.confirmed, true);
  await b.worker.scan();
  assert.deepEqual(b.discarded, [1, 2]);
});

test('failed and unconfirmed discard responses never create confirmed records or successful history', async () => {
  for (const mode of ['rejected', 'undefined', 'not-discarded', 'wrong-tab']) {
    const b = browser();
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    b.chrome.tabs.discard = async () => {
      if (mode === 'rejected') throw new Error('Browser refused');
      if (mode === 'undefined') return undefined;
      return tab(mode === 'wrong-tab' ? 2 : 1);
    };
    assert.equal((await b.worker.scan()).discarded, 0);
    assert.equal(b.session[SESSION_KEY].tabs[1].discard, undefined);
    assert.equal(b.local[HISTORY_KEY].length, 1);
    assert.notEqual(b.local[HISTORY_KEY][0].action, 'discarded');
  }
});

test('rapid restore feedback is applied once, including delayed loading after activation and restart', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  b.clock.at += MINUTE;
  b.records.get(1).active = true; // onActivated can precede the restored state.
  b.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
  await b.worker.settled();
  assert.equal(b.local.settings.learnedHostDelays, undefined);
  b.records.get(1).discarded = false;
  b.chrome.tabs.onUpdated.emit(1, { discarded: false, status: 'loading' });
  await b.worker.settled();
  assert.equal(b.local.settings.learnedHostDelays[0].idleMinutes, 10);
  assert.equal(b.session[SESSION_KEY].tabs[1].discard, undefined);
  const restarted = browser({ tabs: [...b.records.values()], session: b.session, local: b.local, clock: b.clock });
  await restarted.worker.start();
  restarted.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
  await restarted.worker.settled();
  assert.equal(b.local.settings.learnedHostDelays[0].idleMinutes, 10);
  assert.equal(b.local[HISTORY_KEY].filter(event => event.action === 'restore-delay').length, 1);
});

test('late restores and Chrome-discarded tabs do not change learned settings', async () => {
  for (const ownDiscard of [true, false]) {
    const b = browser({ tabs: [tab(1, { discarded: !ownDiscard })] });
    await b.worker.start();
    b.clock.at = 6 * MINUTE;
    if (ownDiscard) await b.worker.scan();
    b.clock.at += 2 * MINUTE + 1;
    Object.assign(b.records.get(1), { active: true, discarded: false });
    b.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
    await b.worker.settled();
    assert.deepEqual(b.local.settings.learnedHostDelays ?? [], []);
  }
});

test('history is bounded and strips full URLs, titles, field values and arbitrary properties', async () => {
  const history = Array.from({ length: 600 }, (_, i) => ({ timestamp: i, tabId: 1,
    hostname: 'example.org', action: 'discarded', reason: 'eligible', url: 'secret', title: 'secret', value: 'secret' }));
  const b = browser({ clock: { at: 1000 }, local: { settings: { idleMinutes: 5 }, [HISTORY_KEY]: history } });
  await b.worker.start();
  b.clock.at += 6 * MINUTE;
  await b.worker.scan();
  assert.equal(b.local[HISTORY_KEY].length, 500);
  assert.deepEqual(Object.keys(b.local[HISTORY_KEY][0]).sort(), ['action', 'hostname', 'reason', 'tabId', 'timestamp']);
});

test('storage failure prevents discards and the queue recovers on the next request', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  const set = b.chrome.storage.session.set;
  b.chrome.storage.session.set = async () => { throw new Error('Session storage failed'); };
  await assert.rejects(b.worker.scan(), /Session storage failed/);
  assert.deepEqual(b.discarded, []);
  b.chrome.storage.session.set = set;
  await b.worker.scan();
  assert.deepEqual(b.discarded, [1]);
});

test('a history write failure after a confirmed discard stops the rest of the scan', async () => {
  const b = browser({ tabs: [tab(1), tab(2)] });
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  b.chrome.storage.local.set = async () => { throw new Error('Local storage failed'); };
  await assert.rejects(b.worker.scan(), /Local storage failed/);
  assert.deepEqual(b.discarded, [1]);
  assert.equal(b.session[SESSION_KEY].tabs[1].discard.confirmed, true);
});

test('restore consumption remains at most once when saving learned feedback fails', async () => {
  const b = browser();
  await b.worker.start();
  b.clock.at = 6 * MINUTE;
  await b.worker.scan();
  b.clock.at += MINUTE;
  const set = b.chrome.storage.local.set;
  b.chrome.storage.local.set = async values => {
    if (values.settings) throw new Error('Preference write failed');
    return set(values);
  };
  Object.assign(b.records.get(1), { active: true, discarded: false });
  b.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
  await b.worker.settled();
  assert.deepEqual(b.errors, ['Preference write failed']);
  assert.equal(b.session[SESSION_KEY].tabs[1].discard, undefined);
  b.chrome.storage.local.set = set;
  b.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 });
  await b.worker.settled();
  assert.deepEqual(b.local.settings.learnedHostDelays ?? [], []);
});

test('the real worker transport and content-script probe unload a safe page and protect edits', async () => {
  const source = await readFile(new URL('../page-safety.js', import.meta.url), 'utf8');
  const b = browser({ tabs: [tab(1), tab(2)] });
  const receivers = new Map();
  const edits = new Map();
  for (const target of b.records.values()) {
    const document = { readyState: 'loading', documentElement: {}, querySelectorAll: () => [],
      addEventListener: (type, handler) => { if (type === 'input') edits.set(target.id, handler); } };
    const window = { addEventListener: () => {} };
    window.top = window;
    vm.runInNewContext(source, {
      document, window, location: { href: target.url }, Date: { now: () => b.clock.at },
      chrome: { runtime: { id: 'ecoguard', onMessage: { addListener: receiver => receivers.set(target.id, receiver) } } }
    });
    document.readyState = 'complete';
  }
  edits.get(2)();
  b.chrome.tabs.sendMessage = async (id, message, options) => {
    assert.equal(options.frameId, 0);
    let response;
    receivers.get(id)(message, { id: 'ecoguard' }, value => { response = value; });
    return response;
  };
  const worker = createBrowserWorker({ chrome: b.chrome, now: () => b.clock.at });
  await worker.start();
  b.clock.at = 6 * MINUTE;
  await worker.scan();
  assert.deepEqual(b.discarded, [1]);
});

test('missing alarms are recreated on browser lifecycle wakeups', async () => {
  const b = browser();
  await b.worker.start();
  b.alarms.clear();
  b.chrome.runtime.onStartup.emit();
  await b.worker.settled();
  assert.equal(b.alarms.get(SCAN_ALARM).periodInMinutes, 1);
});
