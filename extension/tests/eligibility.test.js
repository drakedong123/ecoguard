import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEligibility, applyRestoreFeedback, resetLearnedDelays,
  pruneRecentActivations, MINUTE_MS, REUSE_WINDOW_MS, RESTORE_FEEDBACK_MS,
  SAFETY_MAX_AGE_MS
} from '../policy.js';
import { normalizeLearnedHostDelays, MAX_LEARNED_HOSTS } from '../learning.js';
import { normalizeSettings, createSettingsService } from '../settings.js';

const now = 120 * MINUTE_MS;
const tab = Object.freeze({
  id: 7, url: 'https://example.org/article', status: 'complete',
  active: false, pinned: false, audible: false, incognito: false,
  discarded: false, autoDiscardable: true
});
const activity = Object.freeze({
  lastActiveAt: now - 6 * MINUTE_MS, recentActivations: Object.freeze([])
});
const safety = Object.freeze({
  inspected: true, tabId: tab.id, url: tab.url, checkedAt: now,
  edited: false, playingMedia: false, hasEmbeddedFrame: false,
  capturing: false, sharing: false, lastInteractionAt: now - 6 * MINUTE_MS
});
const settings = Object.freeze({ idleMinutes: 5 });
const evaluate = (changes = {}) => evaluateEligibility({
  tab, activity, settings, safety, now, downloadsInProgress: false, ...changes
});
const discard = Object.freeze({
  confirmed: true, tabId: tab.id, hostname: 'example.org', discardedAt: now - MINUTE_MS
});
const restoredTab = Object.freeze({ ...tab, active: true });
const feedback = (changes = {}) => applyRestoreFeedback({
  settings, discard, tab: restoredTab, now, ...changes
});

test('final decision requires basic eligibility and preserves exclusion reasons', () => {
  assert.equal(evaluate().eligible, true);
  assert.equal(evaluate({ tab: { ...tab, active: true } }).reason, 'active-tab');
  assert.equal(evaluate({ paused: true }).reason, 'manager-paused');
  assert.equal(evaluate({ activity: { ...activity, lastActiveAt: now } }).reason, 'recently-active');
  assert.equal(evaluate({ tab: { ...tab, url: 'https://docs.google.com/' } }).reason, 'protected-site');
  assert.equal(evaluateEligibility(null).eligible, false);
});

test('three activations veto unloading through the exact 30-minute boundary', () => {
  const check = recentActivations => evaluate({ activity: { ...activity, recentActivations } });
  assert.equal(check([now - 6 * MINUTE_MS, now - 10 * MINUTE_MS]).eligible, true);
  assert.equal(check([now - 6 * MINUTE_MS, now - 10 * MINUTE_MS, now - REUSE_WINDOW_MS]).reason, 'frequent-use');
  assert.equal(check([now - 6 * MINUTE_MS, now - 10 * MINUTE_MS, now - REUSE_WINDOW_MS - 1]).eligible, true);
});

test('missing, corrupt and future reuse observations fail closed', () => {
  for (const recentActivations of [undefined, null, {}, [NaN], [-1], [now + 1], ['12']]) {
    assert.equal(evaluate({ activity: { ...activity, recentActivations } }).reason, 'unknown-reuse');
  }
});

test('activation pruning retains only the newest three observations without mutation', () => {
  const events = Object.freeze([now - 20, now - REUSE_WINDOW_MS - 1, now - 10, now - 40, now - 30]);
  assert.deepEqual(pruneRecentActivations(events, now), [now - 10, now - 20, now - 30]);
  assert.equal(events.length, 5);
  assert.equal(pruneRecentActivations([], NaN), null);
});

test('active downloads and unavailable download state veto unloading', () => {
  assert.equal(evaluate({ downloadsInProgress: true }).reason, 'download-in-progress');
  for (const downloadsInProgress of [undefined, null, 0, 'false']) {
    assert.equal(evaluate({ downloadsInProgress }).reason, 'unknown-downloads');
  }
});

test('inspection must succeed for the exact tab and URL', () => {
  for (const value of [undefined, null, {}, { ...safety, inspected: false }]) {
    assert.equal(evaluate({ safety: value }).reason, 'inspection-failed');
  }
  assert.equal(evaluate({ safety: { ...safety, tabId: 8 } }).reason, 'mismatched-safety');
  assert.equal(evaluate({ safety: { ...safety, url: tab.url + '#navigation' } }).reason, 'mismatched-safety');
});

test('safety freshness accepts the exact age limit and rejects older or invalid times', () => {
  assert.equal(evaluate({ safety: { ...safety, checkedAt: now - SAFETY_MAX_AGE_MS } }).eligible, true);
  for (const checkedAt of [now - SAFETY_MAX_AGE_MS - 1, now + 1, undefined, NaN, -1]) {
    assert.equal(evaluate({ safety: { ...safety, checkedAt } }).reason, 'stale-safety');
  }
});

for (const [field, reason] of [
  ['edited', 'edited-page'], ['playingMedia', 'playing-media'],
  ['hasEmbeddedFrame', 'embedded-frame'], ['capturing', 'capturing'], ['sharing', 'sharing']
]) {
  test(`${field} and unknown ${field} state veto final eligibility`, () => {
    assert.equal(evaluate({ safety: { ...safety, [field]: true } }).reason, reason);
    for (const value of [undefined, null, 0, 'false']) {
      assert.equal(evaluate({ safety: { ...safety, [field]: value } }).reason, 'unknown-safety');
    }
  });
}

test('probe interaction grace accepts the exact boundary and rejects unknown timestamps', () => {
  assert.equal(evaluate({ safety: { ...safety, lastInteractionAt: now - 5 * MINUTE_MS } }).eligible, true);
  assert.equal(evaluate({ safety: { ...safety, lastInteractionAt: now - 5 * MINUTE_MS + 1 } }).reason, 'recent-interaction');
  for (const lastInteractionAt of [undefined, null, now + 1, NaN, -1]) {
    assert.equal(evaluate({ safety: { ...safety, lastInteractionAt } }).reason, 'unknown-interaction');
  }
});

test('rapid restore doubles the effective threshold through the exact two-minute boundary', () => {
  for (const age of [0, RESTORE_FEEDBACK_MS - 1, RESTORE_FEEDBACK_MS]) {
    const result = feedback({ discard: { ...discard, discardedAt: now - age } });
    assert.equal(result.adjusted, true);
    assert.deepEqual(result.settings.learnedHostDelays, [
      { hostname: 'example.org', idleMinutes: 10, updatedAt: now }
    ]);
  }
  assert.equal(feedback({ discard: { ...discard, discardedAt: now - RESTORE_FEEDBACK_MS - 1 } }).reason, 'late-restore');
});

test('feedback requires a confirmed discard and matching restored active tab', () => {
  for (const value of [undefined, null, {}, { ...discard, confirmed: false },
    { ...discard, discardedAt: now + 1 }, { ...discard, discardedAt: -1 },
    { ...discard, tabId: -1 }, { ...discard, hostname: '*.example.org' }]) {
    assert.equal(feedback({ discard: value }).reason, 'invalid-discard');
  }
  for (const value of [null, { ...restoredTab, id: 8 }, { ...restoredTab, active: false },
    { ...restoredTab, discarded: true }, { ...restoredTab, url: 'https://sub.example.org/' }]) {
    assert.equal(feedback({ tab: value }).reason, 'unmatched-restore');
  }
  assert.equal(feedback({ now: NaN }).reason, 'invalid-clock');
  assert.equal(applyRestoreFeedback(null).adjusted, false);
});

test('feedback doubles learned delays, respects a raised base and caps at 24 hours', () => {
  let config = settings;
  for (let i = 0; i < 12; i++) config = feedback({ settings: config }).settings;
  assert.equal(config.learnedHostDelays[0].idleMinutes, 1440);
  assert.equal(feedback({ settings: {
    idleMinutes: 90, learnedHostDelays: [{ hostname: 'example.org', idleMinutes: 60, updatedAt: 0 }]
  } }).settings.learnedHostDelays[0].idleMinutes, 180);
});

test('learned delays affect exact hosts, never shorten the base and preserve time boundaries', () => {
  const config = feedback().settings;
  assert.equal(evaluate({ settings: config }).reason, 'recently-active');
  assert.equal(evaluate({ settings: config, activity: {
    ...activity, lastActiveAt: now - 10 * MINUTE_MS
  } }).eligible, true);
  assert.equal(evaluate({ settings: config, activity: {
    ...activity, lastActiveAt: now - 10 * MINUTE_MS + 1
  } }).eligible, false);
  assert.equal(evaluate({ settings: config, tab: { ...tab, url: 'https://sub.example.org/' },
    safety: { ...safety, url: 'https://sub.example.org/' } }).eligible, true);
  assert.equal(evaluate({ settings: { ...config, idleMinutes: 60 } }).eligible, false);
});

test('learned rules normalize names, reject corruption and keep the newest duplicate', () => {
  assert.deepEqual(normalizeLearnedHostDelays([
    null, {}, { hostname: 'bad.org', idleMinutes: 4, updatedAt: 0 },
    { hostname: 'bad.org', idleMinutes: 1441, updatedAt: 0 },
    { hostname: 'bad.org', idleMinutes: 30.5, updatedAt: 0 },
    { hostname: 'bad.org', idleMinutes: 30, updatedAt: NaN },
    { hostname: 'bad.org', idleMinutes: 30, updatedAt: -1 },
    { hostname: 'EXAMPLE.ORG.', idleMinutes: 60, updatedAt: 2 },
    { hostname: 'example.org', idleMinutes: 30, updatedAt: 1 }
  ]), [{ hostname: 'example.org', idleMinutes: 60, updatedAt: 2 }]);
  assert.deepEqual(normalizeLearnedHostDelays('broken'), []);
  assert.deepEqual(normalizeSettings({ idleMinutes: 5 }).learnedHostDelays, []);
});

test('feedback refreshes existing rules and evicts the oldest beyond 100 hosts', () => {
  const rules = Array.from({ length: MAX_LEARNED_HOSTS }, (_, i) => ({
    hostname: `site${i}.org`, idleMinutes: 10, updatedAt: i
  }));
  const config = feedback({ settings: { ...settings, learnedHostDelays: rules } }).settings;
  assert.equal(config.learnedHostDelays.length, 100);
  assert.equal(config.learnedHostDelays[0].hostname, 'example.org');
  assert.equal(config.learnedHostDelays.some(entry => entry.hostname === 'site0.org'), false);
  assert.equal(feedback({ settings: config }).settings.learnedHostDelays.length, 100);
});

test('learning survives preference saves and service recreation; reset preserves other settings', async () => {
  const data = { settings: feedback().settings };
  const storage = {
    get: async () => structuredClone(data),
    set: async value => Object.assign(data, structuredClone(value))
  };
  await createSettingsService(storage).save(15);
  const saved = await createSettingsService(storage).read();
  assert.equal(saved.idleMinutes, 15);
  assert.equal(saved.learnedHostDelays[0].idleMinutes, 10);
  assert.deepEqual(resetLearnedDelays(saved), { ...saved, learnedHostDelays: [] });
  assert.equal(saved.learnedHostDelays.length, 1);
});

test('policy and feedback do not mutate frozen inputs', () => {
  assert.equal(evaluate().eligible, true);
  const config = Object.freeze({ ...settings, learnedHostDelays: Object.freeze([
    Object.freeze({ hostname: 'example.org', idleMinutes: 10, updatedAt: 0 })
  ]) });
  const result = feedback({ settings: config });
  assert.equal(result.settings.learnedHostDelays[0].idleMinutes, 20);
  assert.equal(config.learnedHostDelays[0].idleMinutes, 10);
  assert.equal(discard.discardedAt, now - MINUTE_MS);
});
