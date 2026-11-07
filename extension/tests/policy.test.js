import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROTECTED_HOSTS, normalizeHostname, hostnameFromUrl,
  hostnameMatches, normalizeProtectedHosts
} from '../hostname.js';
import { evaluateBasicEligibility, MINUTE_MS, INTERACTION_GRACE_MS } from '../policy.js';
import { normalizeSettings, createSettingsService } from '../settings.js';

const now = 100 * MINUTE_MS;
const tab = Object.freeze({
  id: 7, url: 'https://example.org/article', status: 'complete',
  active: false, pinned: false, audible: false, incognito: false,
  discarded: false, autoDiscardable: true
});
const activity = Object.freeze({ lastActiveAt: now - 31 * MINUTE_MS });
const evaluate = (changes = {}) => evaluateBasicEligibility({ tab, activity, now, ...changes });

test('hostname normalization handles case, trailing dots, IDN and local fixtures', () => {
  assert.equal(normalizeHostname(' EXAMPLE.ORG. '), 'example.org');
  assert.equal(normalizeHostname('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeHostname('localhost'), 'localhost');
  assert.equal(hostnameFromUrl('http://127.0.0.1:8765/fixture'), '127.0.0.1');
  assert.equal(hostnameFromUrl('https://EXAMPLE.ORG.:443/private?query=1'), 'example.org');
});

test('host rules reject schemes, credentials, ports, wildcards and malformed labels', () => {
  for (const value of [null, {}, '', 'https://example.org', 'user@example.org', 'example.org:443',
    '*.example.org', 'example.org/path', 'a..org', 'a.org..', '-a.org', 'a-.org',
    'a b.org', 'a\\b.org', 'a?b.org', 'a#b.org', 'a%2eb.org', `${'a'.repeat(64)}.org`]) {
    assert.equal(normalizeHostname(value), null, String(value));
  }
});

test('URL filtering excludes browser pages, files and malformed input', () => {
  for (const url of ['chrome://settings', 'file:///tmp/work', 'about:blank', 'javascript:alert(1)',
    'data:text/html,test', 'ftp://example.org', 'not a URL', undefined]) {
    assert.equal(hostnameFromUrl(url), null, String(url));
  }
});

test('protection applies to exact hosts and subdomains on dot boundaries', () => {
  assert.equal(hostnameMatches('EXAMPLE.ORG.', 'example.org'), true);
  assert.equal(hostnameMatches('deep.sub.example.org', 'example.org'), true);
  assert.equal(hostnameMatches('badexample.org', 'example.org'), false);
  assert.equal(hostnameMatches('example.org.attacker.test', 'example.org'), false);
  assert.equal(hostnameMatches('example.org', 'sub.example.org'), false);
  assert.equal(hostnameMatches(null, 'example.org'), false);
});

test('protected-host settings migrate defaults, deduplicate and bound persisted data', () => {
  assert.deepEqual(normalizeSettings({ idleMinutes: 45 }).protectedHosts, [...DEFAULT_PROTECTED_HOSTS]);
  assert.deepEqual(normalizeProtectedHosts(['EXAMPLE.ORG', 'example.org.', 'safe.org']), ['example.org', 'safe.org']);
  assert.deepEqual(normalizeProtectedHosts([]), []);
  assert.ok(normalizeProtectedHosts(['*.invalid']).includes('docs.google.com'));
  assert.ok(normalizeProtectedHosts('broken').includes('docs.google.com'));
  assert.equal(normalizeProtectedHosts(Array.from({ length: 600 }, (_, i) => `site${i}.org`)).length, 500);
});

test('changing idle threshold preserves existing site protections after a worker restart', async () => {
  const data = { settings: { idleMinutes: 30, protectedHosts: ['saved.example.org'] } };
  const storage = {
    get: async () => structuredClone(data),
    set: async value => { Object.assign(data, structuredClone(value)); }
  };
  await createSettingsService(storage).save(90);
  const reloaded = await createSettingsService(storage).read();
  assert.equal(reloaded.idleMinutes, 90);
  assert.deepEqual(reloaded.protectedHosts, ['saved.example.org']);
});

test('idle threshold uses exact millisecond boundaries and the chosen preference', () => {
  assert.equal(evaluate({ activity: { lastActiveAt: now - 30 * MINUTE_MS + 1 } }).candidate, false);
  assert.equal(evaluate({ activity: { lastActiveAt: now - 30 * MINUTE_MS } }).candidate, true);
  assert.equal(evaluate({ settings: { idleMinutes: 60 } }).candidate, false);
  assert.equal(evaluate({ settings: { idleMinutes: 5 } }).candidate, true);
});

test('interaction grace protects just below five minutes and allows the exact boundary', () => {
  assert.equal(evaluate({ activity: { ...activity, lastInteractionAt: now - INTERACTION_GRACE_MS + 1 } }).reason, 'recent-interaction');
  assert.equal(evaluate({ activity: { ...activity, lastInteractionAt: now - INTERACTION_GRACE_MS } }).candidate, true);
});

for (const [name, field, value, reason] of [
  ['active', 'active', true, 'active-tab'], ['pinned', 'pinned', true, 'pinned-tab'],
  ['audible', 'audible', true, 'audible-tab'], ['incognito', 'incognito', true, 'private-tab'],
  ['discarded', 'discarded', true, 'already-discarded'],
  ['browser protected', 'autoDiscardable', false, 'browser-protected'],
  ['loading', 'status', 'loading', 'loading-or-unknown']
]) {
  test(`${name} tabs never become basic candidates`, () => {
    const result = evaluate({ tab: { ...tab, [field]: value } });
    assert.equal(result.candidate, false); assert.equal(result.reason, reason);
  });
}

test('unavailable tab fields and unknown activity fail closed', () => {
  for (const field of ['active', 'pinned', 'audible', 'incognito', 'discarded', 'autoDiscardable']) {
    const incomplete = { ...tab }; delete incomplete[field];
    assert.equal(evaluate({ tab: incomplete }).reason, 'unknown-tab-state');
  }
  for (const value of [null, {}, { lastActiveAt: Infinity }, { lastActiveAt: -1 },
    { lastActiveAt: now + 1 }, { ...activity, lastInteractionAt: now + 1 }, { ...activity, protected: 'false' }]) {
    assert.equal(evaluate({ activity: value }).candidate, false);
  }
  assert.equal(evaluate({ now: NaN }).reason, 'invalid-clock');
  assert.equal(evaluate({ tab: { ...tab, id: -1 } }).reason, 'unknown-tab');
  assert.equal(evaluate({ tab: { ...tab, url: 'chrome://newtab' } }).reason, 'unsupported-url');
  assert.equal(evaluateBasicEligibility(null).candidate, false);
});

test('paused manager, protected tab and protected site veto candidates', () => {
  assert.equal(evaluate({ paused: true }).reason, 'manager-paused');
  assert.equal(evaluate({ activity: { ...activity, protected: true } }).reason, 'protected-tab');
  assert.equal(evaluate({ settings: { protectedHosts: ['example.org'] } }).reason, 'protected-site');
  assert.equal(evaluate({ tab: { ...tab, url: 'https://sub.docs.google.com/document' } }).reason, 'protected-site');
  assert.equal(evaluate({ tab: { ...tab, url: 'https://docs.google.com.attacker.test/' } }).candidate, true);
});

test('basic candidate remains pending safety checks and evaluation does not mutate inputs', () => {
  const settings = Object.freeze({ idleMinutes: 30, protectedHosts: Object.freeze(['safe.org']) });
  const result = evaluate({ settings });
  assert.equal(result.candidate, true);
  assert.equal(result.requiresSafetyCheck, true);
  assert.equal(result.hostname, 'example.org');
  assert.equal(result.idleForMs, 31 * MINUTE_MS);
  assert.equal(result.thresholdMs, 30 * MINUTE_MS);
  assert.equal(Object.hasOwn(result, 'eligible'), false);
  assert.equal(tab.discarded, false);
  assert.equal(activity.lastActiveAt, now - 31 * MINUTE_MS);
  assert.deepEqual(settings.protectedHosts, ['safe.org']);
});
