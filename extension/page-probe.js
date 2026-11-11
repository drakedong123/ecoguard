import { hostnameFromUrl } from './hostname.js';
import { SAFETY_MAX_AGE_MS } from './policy.js';

const FLAGS = ['edited', 'playingMedia', 'hasEmbeddedFrame', 'capturing', 'sharing'];
const validTime = at => Number.isFinite(at) && at >= 0;

/** On-demand transport for chunk 05's worker and chunk 06's confirmed reset.
 * Bind observations to the requested top-level tab, never a page-supplied ID.
 * Consumers must still reacquire tab/download state before any intervention.
 */
export function createPageSafetyClient({ tabs, now = Date.now, timeoutMs = SAFETY_MAX_AGE_MS }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SAFETY_MAX_AGE_MS) {
    throw new Error('Probe timeout must be positive and at most five seconds.');
  }

  async function request(tab, type, confirmed) {
    const fail = reason => ({ inspected: false, reason });
    if (!Number.isInteger(tab?.id) || tab.id < 0 || !hostnameFromUrl(tab.url)) {
      return fail('unsupported-tab');
    }
    if (type === 'resetPageEdits' && confirmed !== true) return fail('reset-not-confirmed');
    // Snapshot before awaiting: callers may reuse or mutate their tab objects.
    const tabId = tab.id;
    const url = tab.url;
    let timer;
    try {
      const startedAt = now();
      if (!validTime(startedAt)) return fail('invalid-clock');
      const response = await Promise.race([
        tabs.sendMessage(tabId, { type, expectedUrl: url, ...(confirmed === true ? { confirmed } : {}) },
          { frameId: 0 }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Probe timed out')), timeoutMs);
        })
      ]);
      const receivedAt = now();
      if (!validTime(receivedAt) || receivedAt < startedAt) return fail('invalid-clock');
      if (response?.inspected !== true) return fail('inspection-failed');
      if (response.url !== url) return fail('mismatched-safety');
      if (!validTime(response.checkedAt) || response.checkedAt < startedAt ||
          response.checkedAt > receivedAt || receivedAt - startedAt > SAFETY_MAX_AGE_MS) {
        return fail('stale-safety');
      }
      if (FLAGS.some(field => typeof response[field] !== 'boolean') ||
          !validTime(response.lastInteractionAt) || response.lastInteractionAt > response.checkedAt ||
          (type === 'resetPageEdits' && (response.reset !== true || response.edited !== false))) {
        return fail('invalid-safety');
      }
      return {
        inspected: true, tabId, url, checkedAt: response.checkedAt,
        lastInteractionAt: response.lastInteractionAt,
        ...Object.fromEntries(FLAGS.map(field => [field, response[field]])),
        ...(type === 'resetPageEdits' ? { reset: true } : {})
      };
    } catch {
      return fail('inspection-failed');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    inspect: tab => request(tab, 'inspectPageSafety'),
    resetEdits: (tab, { confirmed = false } = {}) => request(tab, 'resetPageEdits', confirmed)
  };
}
