import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createPageSafetyClient } from '../page-probe.js';
import { evaluateEligibility, MINUTE_MS, SAFETY_MAX_AGE_MS } from '../policy.js';

const script = await readFile(new URL('../page-safety.js', import.meta.url), 'utf8');
const url = 'https://example.org/work';
const tab = Object.freeze({
  id: 7, url, active: false, pinned: false, audible: false, incognito: false,
  discarded: false, autoDiscardable: true, status: 'complete'
});
const root = nodes => ({ querySelectorAll: () => nodes });
const element = (localName, fields = {}) => ({ localName, shadowRoot: null, ...fields });
const media = fields => element('video', { paused: true, ended: false, srcObject: null, ...fields });

// Execute the packaged classic content script, rather than a duplicate policy.
// Only DOM/event and Chrome message surfaces are supplied; no DOM package needed.
function page({ nodes = [], readyState = 'loading', topLevel = true } = {}) {
  let at = 60 * MINUTE_MS;
  let listener;
  const handlers = new Map();
  const listen = surface => (type, handler, options) => {
    handlers.set(`${surface}:${type}`, { handler, options });
  };
  const document = { ...root(nodes), readyState, documentElement: {}, addEventListener: listen('document') };
  const window = { addEventListener: listen('window') };
  window.top = topLevel ? window : {};
  const location = { href: url };
  vm.runInNewContext(script, {
    document, window, location, Date: { now: () => at },
    chrome: { runtime: { id: 'ecoguard', onMessage: { addListener: value => { listener = value; } } } }
  });
  document.readyState = 'complete';
  const send = (message, sender = { id: 'ecoguard' }) => {
    let result;
    listener?.(message, sender, value => { result = structuredClone(value); });
    return result;
  };
  return {
    document, location, nodes, handlers,
    get time() { return at; },
    set time(value) { at = value; },
    send,
    inspect: () => send({ type: 'inspectPageSafety', expectedUrl: location.href }),
    reset: () => send({ type: 'resetPageEdits', expectedUrl: location.href, confirmed: true }),
    emit: (type, event = {}, surface = 'document') => handlers.get(`${surface}:${type}`)?.handler(event),
    client: () => createPageSafetyClient({
      now: () => at,
      tabs: { sendMessage: async (id, message, options) => {
        assert.equal(id, tab.id);
        assert.deepEqual(options, { frameId: 0 });
        return send(message);
      } }
    })
  };
}

function decision(safety, now) {
  return evaluateEligibility({
    tab, now, safety, settings: { idleMinutes: 5 }, downloadsInProgress: false,
    activity: { lastActiveAt: now - 10 * MINUTE_MS, recentActivations: [] }
  });
}

test('fresh page gets interaction grace, then its top-level probe can satisfy policy', async () => {
  const p = page();
  const client = p.client();
  assert.equal(decision(await client.inspect(tab), p.time).reason, 'recent-interaction');
  p.time += 5 * MINUTE_MS;
  const observation = await client.inspect(tab);
  assert.equal(observation.tabId, tab.id);
  assert.equal(observation.url, url);
  assert.equal(decision(observation, p.time).eligible, true);
});

for (const type of ['beforeinput', 'input', 'change', 'compositionstart']) {
  test(`${type} protects edits without reading field contents, including synthetic edits`, async () => {
    const p = page();
    p.time += MINUTE_MS;
    const event = { isTrusted: false };
    Object.defineProperty(event, 'target', { get() { throw new Error('Must not read input data'); } });
    p.emit(type, event);
    p.emit('submit');
    p.emit('reset');
    p.time += 10 * MINUTE_MS;
    const observation = await p.client().inspect(tab);
    assert.equal(observation.lastInteractionAt, 61 * MINUTE_MS);
    assert.equal(decision(observation, p.time).reason, 'edited-page');
    assert.equal(p.handlers.get(`document:${type}`).options.capture, true);
  });
}

test('explicit confirmed reset clears only edit protection and restarts interaction grace', async () => {
  const p = page();
  p.emit('input');
  p.time += 10 * MINUTE_MS;
  const client = p.client();
  assert.equal((await client.resetEdits(tab)).reason, 'reset-not-confirmed');
  assert.equal(p.inspect().edited, true);
  const observation = await client.resetEdits(tab, { confirmed: true });
  assert.equal(observation.reset, true);
  assert.equal(observation.edited, false);
  assert.equal(observation.lastInteractionAt, p.time);
  assert.equal(decision(observation, p.time).reason, 'recent-interaction');
  p.time += 5 * MINUTE_MS;
  assert.equal(decision(await client.inspect(tab), p.time).eligible, true);
  p.emit('change');
  assert.equal(p.inspect().edited, true);
});

test('hash/history navigation and BFCache retain edits; a new document starts fresh', () => {
  const p = page();
  p.emit('input');
  p.location.href += '#section';
  p.emit('hashchange', {}, 'window');
  assert.equal(p.inspect().edited, true);
  p.location.href = 'https://example.org/next';
  p.emit('popstate', {}, 'window');
  assert.equal(p.inspect().edited, true);
  p.emit('pagehide', {}, 'window');
  assert.equal(p.inspect().inspected, false);
  p.time += MINUTE_MS;
  p.emit('pageshow', { persisted: true }, 'window');
  assert.equal(p.inspect().edited, true);
  assert.equal(p.inspect().lastInteractionAt, p.time);
  assert.equal(page().inspect().edited, false);
});

test('trusted keyboard, pointer, touch, wheel and scroll activity updates grace', () => {
  const p = page();
  for (const type of ['keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll']) {
    const previous = p.inspect().lastInteractionAt;
    p.time += MINUTE_MS;
    p.emit(type, { isTrusted: false });
    assert.equal(p.inspect().lastInteractionAt, previous);
    p.emit(type, { isTrusted: true });
    assert.equal(p.inspect().lastInteractionAt, p.time);
    assert.equal(p.inspect().edited, false);
  }
});

test('playing media protects even when muted; ended and paused media can be safe', async () => {
  const video = media({ paused: false, muted: true });
  const p = page({ nodes: [video] });
  p.time += 10 * MINUTE_MS;
  assert.equal(decision(await p.client().inspect(tab), p.time).reason, 'playing-media');
  video.ended = true;
  assert.equal(decision(await p.client().inspect(tab), p.time).eligible, true);
  video.ended = false;
  video.paused = true;
  assert.equal(p.inspect().playingMedia, false);
  video.localName = 'audio';
  video.paused = false;
  assert.equal(p.inspect().playingMedia, true);
});

test('attached streams protect even paused media, and reset cannot remove that protection', async () => {
  const p = page({ nodes: [media({ srcObject: {} })] });
  const observation = await p.client().resetEdits(tab, { confirmed: true });
  assert.equal(observation.capturing, true);
  assert.equal(observation.sharing, true);
  p.time += 10 * MINUTE_MS;
  assert.equal(decision(await p.client().inspect(tab), p.time).reason, 'capturing');
});

test('embedded frames/plugins protect without reading their documents, including shadow trees', async () => {
  for (const tag of ['iframe', 'frame', 'object', 'embed']) {
    const frame = element(tag);
    Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Do not inspect frames'); } });
    const p = page({ nodes: [element('custom-host', { shadowRoot: root([frame]) })] });
    p.time += 10 * MINUTE_MS;
    assert.equal(decision(await p.client().inspect(tab), p.time).reason, 'embedded-frame');
    p.reset();
    assert.equal(p.inspect().hasEmbeddedFrame, true);
  }
});

test('media is inspected afresh, including newly inserted media in nested open shadow trees', () => {
  const nested = [];
  const p = page({ nodes: [element('host-a', {
    shadowRoot: root([element('host-b', { shadowRoot: root(nested) })])
  })] });
  assert.equal(p.inspect().playingMedia, false);
  nested.push(media({ paused: false }));
  assert.equal(p.inspect().playingMedia, true);
  nested.length = 0;
  assert.equal(p.inspect().playingMedia, false);
});

test('late attachment, loading, missing DOM, inspection errors and invalid clocks fail closed', async () => {
  const late = page({ readyState: 'complete' });
  assert.equal(late.reset().inspected, false);
  const loading = page(); loading.document.readyState = 'interactive';
  const missing = page(); missing.document.documentElement = null;
  const broken = page(); broken.document.querySelectorAll = () => { throw new Error('DOM unavailable'); };
  const clock = page(); clock.time = NaN;
  const backwards = page(); backwards.time--; backwards.emit('input'); backwards.time += MINUTE_MS;
  const unknownMedia = page({ nodes: [media({ paused: undefined })] });
  for (const p of [late, loading, missing, broken, clock, backwards, unknownMedia]) {
    assert.equal(p.inspect().inspected, false);
    assert.equal((await p.client().inspect(tab)).inspected, false);
  }
});

test('excessive document and shadow-tree inspections fail closed', () => {
  const large = page({ nodes: Array.from({ length: 20_001 }, () => element('div')) });
  assert.equal(large.inspect().inspected, false);
  const deep = page({ nodes: Array.from({ length: 101 }, () => element('host', { shadowRoot: root([]) })) });
  assert.equal(deep.inspect().inspected, false);
});

test('only same-extension, non-tab messages for the exact current URL can inspect or reset', () => {
  const p = page();
  p.emit('input');
  const message = { type: 'resetPageEdits', expectedUrl: url, confirmed: true };
  assert.equal(p.send(message, { id: 'other-extension' }), undefined);
  assert.equal(p.send(message, { id: 'ecoguard', tab: { id: 20 } }), undefined);
  assert.equal(p.send({ ...message, type: 'unknown' }), undefined);
  assert.equal(p.send({ ...message, expectedUrl: url + '#old' }).inspected, false);
  assert.equal(p.send({ ...message, confirmed: 'true' }).inspected, false);
  assert.equal(p.inspect().edited, true);
  assert.equal(page({ topLevel: false }).inspect(), undefined);
});

test('probe output contains only safety metadata, with no field contents or page text', () => {
  const input = element('input');
  for (const key of ['value', 'defaultValue', 'textContent', 'innerHTML']) {
    Object.defineProperty(input, key, { get() { throw new Error('Private content'); } });
  }
  const p = page({ nodes: [input] });
  p.emit('input');
  assert.deepEqual(Object.keys(p.inspect()).sort(), [
    'inspected', 'url', 'checkedAt', 'lastInteractionAt', 'edited', 'playingMedia',
    'hasEmbeddedFrame', 'capturing', 'sharing'
  ].sort());
});

test('missing receivers, rejected requests, missing replies and timeouts never grant inspection', async () => {
  for (const sendMessage of [
    () => { throw new Error('Missing receiver'); },
    async () => { throw new Error('Tab closed'); },
    async () => undefined,
    () => new Promise(() => {})
  ]) {
    const client = createPageSafetyClient({ tabs: { sendMessage }, timeoutMs: 10 });
    const safety = await client.inspect(tab);
    assert.equal(safety.inspected, false);
    assert.equal(decision(safety, 90 * MINUTE_MS).eligible, false);
  }
});

test('client rejects malformed, mismatched, stale, cached and future observations', async () => {
  const p = page();
  const valid = p.inspect();
  const at = p.time;
  const check = async (response, time = () => at) => createPageSafetyClient({
    tabs: { sendMessage: async () => response }, now: time
  }).inspect(tab);
  const invalid = [null, {}, { ...valid, inspected: false }, { ...valid, url: url + '#other' },
    { ...valid, checkedAt: at - 1 }, { ...valid, checkedAt: at + 1 },
    { ...valid, checkedAt: NaN }, { ...valid, lastInteractionAt: -1 },
    { ...valid, lastInteractionAt: at + 1 }];
  for (const field of ['edited', 'playingMedia', 'hasEmbeddedFrame', 'capturing', 'sharing']) {
    invalid.push({ ...valid, [field]: undefined }, { ...valid, [field]: 'false' });
  }
  for (const response of invalid) assert.equal((await check(response)).inspected, false);
  let calls = 0;
  assert.equal((await check(valid, () => at + (calls++ ? SAFETY_MAX_AGE_MS + 1 : 0))).inspected, false);
  calls = 0;
  assert.equal((await check(valid, () => at - (calls++ ? 1 : 0))).inspected, false);
  assert.equal((await check(valid, () => NaN)).inspected, false);
});

test('client binds tab identity before awaiting and strips unexpected response data', async () => {
  const p = page();
  const mutableTab = { ...tab };
  const client = createPageSafetyClient({ now: () => p.time, tabs: {
    sendMessage: async () => {
      mutableTab.id = 999;
      mutableTab.url = 'https://other.org/';
      return { ...p.inspect(), tabId: 999, value: 'must not propagate' };
    }
  } });
  const result = await client.inspect(mutableTab);
  assert.equal(result.tabId, tab.id);
  assert.equal(result.url, url);
  assert.equal(result.value, undefined);
});

test('client rejects unsupported targets and reset responses without confirmed cleared edits', async () => {
  let sent = 0;
  const p = page();
  const client = createPageSafetyClient({ now: () => p.time, tabs: {
    sendMessage: async () => { sent++; return p.inspect(); }
  } });
  for (const target of [null, {}, { ...tab, id: -1 }, { ...tab, url: 'chrome://settings/' }]) {
    assert.equal((await client.inspect(target)).inspected, false);
  }
  assert.equal((await client.resetEdits(tab)).inspected, false);
  assert.equal(sent, 0);
  assert.equal((await client.resetEdits(tab, { confirmed: true })).inspected, false);
  for (const timeoutMs of [0, -1, NaN, Infinity, SAFETY_MAX_AGE_MS + 1]) {
    assert.throws(() => createPageSafetyClient({ tabs: {}, timeoutMs }));
  }
});
