import { normalizeHostname } from './hostname.js';

export const MAX_LEARNED_HOSTS = 100;
export const MAX_IDLE_MINUTES = 1440;

/** Keep the newest valid rule for each exact hostname; evict oldest rules first. */
export function normalizeLearnedHostDelays(value) {
  if (!Array.isArray(value)) return [];
  const hosts = new Map();
  for (const entry of value) {
    const hostname = normalizeHostname(entry?.hostname);
    if (!hostname || !Number.isInteger(entry.idleMinutes) || entry.idleMinutes < 5 ||
        entry.idleMinutes > MAX_IDLE_MINUTES || !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0) continue;
    const previous = hosts.get(hostname);
    if (!previous || entry.updatedAt >= previous.updatedAt) {
      hosts.set(hostname, { hostname, idleMinutes: entry.idleMinutes, updatedAt: entry.updatedAt });
    }
  }
  return [...hosts.values()].sort((a, b) => b.updatedAt - a.updatedAt ||
    a.hostname.localeCompare(b.hostname)).slice(0, MAX_LEARNED_HOSTS);
}
