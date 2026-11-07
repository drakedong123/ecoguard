import { hostnameFromUrl, hostnameMatches } from './hostname.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';

export const MINUTE_MS = 60_000;
export const INTERACTION_GRACE_MS = 5 * MINUTE_MS;

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
  const thresholdMs = config.idleMinutes * MINUTE_MS;
  if (idleForMs < thresholdMs) return reject('recently-active');

  return {
    candidate: true, reason: 'idle-candidate', hostname, idleForMs, thresholdMs,
    requiresSafetyCheck: true
  };
}
