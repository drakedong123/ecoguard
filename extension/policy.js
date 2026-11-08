import { hostnameFromUrl, hostnameMatches, normalizeHostname } from './hostname.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';
import { MAX_IDLE_MINUTES, normalizeLearnedHostDelays } from './learning.js';

export const MINUTE_MS = 60_000;
export const INTERACTION_GRACE_MS = 5 * MINUTE_MS;
export const REUSE_WINDOW_MS = 30 * MINUTE_MS;
export const FREQUENT_USE_COUNT = 3;
export const RESTORE_FEEDBACK_MS = 2 * MINUTE_MS;
export const SAFETY_MAX_AGE_MS = 5_000;

function observedTimestamp(value, now) {
  return Number.isFinite(value) && value >= 0 && value <= now;
}

/**
 * Pure first-stage filter. Activity timestamps and `now` are epoch milliseconds.
 * A candidate still needs the remaining safety/reuse checks before discarding.
 * This function neither inspects pages nor calls any browser API.
 */
export function evaluateBasicEligibility(input = {}) {
  const { tab, activity, settings = DEFAULT_SETTINGS, now, paused = false } = input ?? {};
  const reject = reason => ({ candidate: false, reason });
  if (paused !== false) return reject('manager-paused');
  if (!Number.isFinite(now) || now < 0) return reject('invalid-clock');
  if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return reject('unknown-tab');

  for (const [field, reason] of [
    ['active', 'active-tab'], ['pinned', 'pinned-tab'], ['audible', 'audible-tab'],
    ['incognito', 'private-tab'], ['discarded', 'already-discarded']
  ]) {
    if (tab[field] === true) return reject(reason);
  }
  if (tab.autoDiscardable === false) return reject('browser-protected');
  if (tab.status !== 'complete') return reject('loading-or-unknown');
  if (['active', 'pinned', 'audible', 'incognito', 'discarded', 'autoDiscardable']
    .some(field => typeof tab[field] !== 'boolean')) return reject('unknown-tab-state');

  const hostname = hostnameFromUrl(tab.url);
  if (!hostname) return reject('unsupported-url');
  if (activity?.protected === true) return reject('protected-tab');
  if (activity?.protected !== undefined && typeof activity.protected !== 'boolean') {
    return reject('unknown-activity');
  }
  const config = normalizeSettings(settings);
  if (config.protectedHosts.some(rule => hostnameMatches(hostname, rule))) {
    return reject('protected-site');
  }

  // Missing history and future timestamps never establish observed inactivity.
  if (!observedTimestamp(activity?.lastActiveAt, now)) return reject('unknown-activity');
  if (activity.lastInteractionAt !== undefined) {
    if (!observedTimestamp(activity.lastInteractionAt, now)) return reject('unknown-activity');
    if (now - activity.lastInteractionAt < INTERACTION_GRACE_MS) return reject('recent-interaction');
  }
  const idleForMs = now - activity.lastActiveAt;
  const learned = config.learnedHostDelays.find(entry => entry.hostname === hostname);
  const thresholdMs = Math.max(config.idleMinutes, learned?.idleMinutes ?? 0) * MINUTE_MS;
  if (idleForMs < thresholdMs) return reject('recently-active');

  return {
    candidate: true, reason: 'idle-candidate', hostname, idleForMs, thresholdMs,
    requiresSafetyCheck: true
  };
}

/** Three newest activations suffice to establish the rolling-window veto.
 * Missing/corrupt observations return null, rather than an invented empty history.
 * The window includes its exact lower boundary. Callers may append a new event
 * before pruning and persist the returned array in session state.
 */
export function pruneRecentActivations(activations, now) {
  if (!observedTimestamp(now, now) || !Array.isArray(activations) ||
      !activations.every(at => observedTimestamp(at, now))) return null;
  return activations.filter(at => now - at <= REUSE_WINDOW_MS)
    .sort((a, b) => b - a).slice(0, FREQUENT_USE_COUNT);
}

/** Final pure decision over supplied observations, never a browser API action.
 * The worker must obtain fresh tab/download/probe state immediately before use.
 * A probe is bound to a tab ID and exact URL, with a five-second maximum age.
 */
export function evaluateEligibility(input = {}) {
  const basic = evaluateBasicEligibility(input);
  const reject = reason => ({ eligible: false, reason });
  if (!basic.candidate) return reject(basic.reason);
  const { tab, activity, now, safety, downloadsInProgress } = input;
  const activations = pruneRecentActivations(activity.recentActivations, now);
  if (activations === null) return reject('unknown-reuse');
  if (activations.length >= FREQUENT_USE_COUNT) return reject('frequent-use');
  if (downloadsInProgress !== false) {
    return reject(downloadsInProgress === true ? 'download-in-progress' : 'unknown-downloads');
  }
  if (safety?.inspected !== true) return reject('inspection-failed');
  if (safety.tabId !== tab.id || safety.url !== tab.url) return reject('mismatched-safety');
  if (!observedTimestamp(safety.checkedAt, now) || now - safety.checkedAt > SAFETY_MAX_AGE_MS) {
    return reject('stale-safety');
  }
  for (const [field, reason] of [
    ['edited', 'edited-page'], ['playingMedia', 'playing-media'],
    ['hasEmbeddedFrame', 'embedded-frame'], ['capturing', 'capturing'], ['sharing', 'sharing']
  ]) {
    if (safety[field] === true) return reject(reason);
    if (safety[field] !== false) return reject('unknown-safety');
  }
  if (!observedTimestamp(safety.lastInteractionAt, now)) return reject('unknown-interaction');
  if (now - safety.lastInteractionAt < INTERACTION_GRACE_MS) return reject('recent-interaction');
  return {
    eligible: true, reason: 'eligible', hostname: basic.hostname,
    idleForMs: basic.idleForMs, thresholdMs: basic.thresholdMs
  };
}

/** Apply feedback for a confirmed discard followed by activation of the same tab
 * and exact hostname within two minutes (inclusive). The worker must consume each
 * discard record once. This pure function neither persists state nor verifies APIs.
 */
export function applyRestoreFeedback(input = {}) {
  const { settings, discard, tab, now } = input ?? {};
  const config = normalizeSettings(settings);
  const unchanged = reason => ({ adjusted: false, reason, settings: config });
  if (!Number.isFinite(now) || now < 0) return unchanged('invalid-clock');
  const hostname = normalizeHostname(discard?.hostname);
  if (discard?.confirmed !== true || !hostname || !Number.isInteger(discard.tabId) ||
      discard.tabId < 0 || !observedTimestamp(discard.discardedAt, now)) {
    return unchanged('invalid-discard');
  }
  if (tab?.id !== discard.tabId || tab.active !== true || tab.discarded !== false ||
      hostnameFromUrl(tab.url) !== hostname) return unchanged('unmatched-restore');
  if (now - discard.discardedAt > RESTORE_FEEDBACK_MS) return unchanged('late-restore');
  const previous = config.learnedHostDelays.find(entry => entry.hostname === hostname);
  const idleMinutes = Math.min(MAX_IDLE_MINUTES,
    Math.max(config.idleMinutes, previous?.idleMinutes ?? 0) * 2);
  return {
    adjusted: true, reason: 'rapid-restore',
    settings: {
      ...config,
      learnedHostDelays: normalizeLearnedHostDelays([
        ...config.learnedHostDelays.filter(entry => entry.hostname !== hostname),
        { hostname, idleMinutes, updatedAt: now }
      ])
    }
  };
}

export function resetLearnedDelays(settings) {
  return { ...normalizeSettings(settings), learnedHostDelays: [] };
}
