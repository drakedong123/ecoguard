export const DEFAULT_PROTECTED_HOSTS = Object.freeze([
  'docs.google.com', 'drive.google.com', 'mail.google.com', 'outlook.live.com',
  'outlook.office.com', 'meet.google.com', 'zoom.us', 'teams.microsoft.com',
  'notion.so', 'figma.com'
]);

/** Accept a DNS hostname or IPv4 address, without a scheme, port or wildcard. */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim().toLowerCase().replace(/\.$/, '');
  if (!input || input.length > 253 || /[\s/\\:@?#%*]/.test(input)) return null;
  try {
    // The URL parser also canonicalizes international names to ASCII/punycode.
    const host = new URL(`https://${input}`).hostname.toLowerCase();
    if (host.length > 253 || !host.split('.').every(label =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return host;
  } catch { return null; }
}

export function hostnameFromUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? normalizeHostname(url.hostname) : null;
  } catch { return null; }
}

export function hostnameMatches(hostname, rule) {
  const host = normalizeHostname(hostname);
  const normalizedRule = normalizeHostname(rule);
  return host !== null && normalizedRule !== null &&
    (host === normalizedRule || host.endsWith(`.${normalizedRule}`));
}

export function normalizeProtectedHosts(value) {
  if (!Array.isArray(value)) return [...DEFAULT_PROTECTED_HOSTS];
  const normalized = value.slice(0, 500).map(normalizeHostname);
  // A corrupt list retains the default protections instead of silently removing them.
  const defaults = normalized.includes(null) ? DEFAULT_PROTECTED_HOSTS : [];
  return [...new Set([...defaults, ...normalized.filter(Boolean)])].slice(0, 500);
}
