import { createSettingsService, VERSION } from './settings.js';
import { createPageSafetyClient } from './page-probe.js';
import { hostnameFromUrl, normalizeHostname } from './hostname.js';
import { evaluateBasicEligibility, evaluateEligibility, pruneRecentActivations,
  applyRestoreFeedback } from './policy.js';

export const SCAN_ALARM = 'ecoguard-scan';
export const SESSION_KEY = 'browserSession';
export const HISTORY_KEY = 'browserHistory';
const HISTORY_LIMIT = 500;
const validId = id => Number.isInteger(id) && id >= 0;
const validTime = (at, now) => Number.isFinite(at) && at >= 0 && at <= now;
const HISTORY_ACTIONS = new Set(['discarded', 'discard-failed', 'discard-unconfirmed', 'restore-delay']);

function freshRecord(tab, at, protectedTab = false) {
  return {
    url: typeof tab.url === 'string' ? tab.url : '', windowId: tab.windowId,
    active: tab.active === true, protected: protectedTab,
    lastActiveAt: at, lastInteractionAt: at, recentActivations: []
  };
}

function restoreRecord(raw, tab, at) {
  const fresh = () => freshRecord(tab, at, raw?.protected === true);
  if (!raw || raw.url !== tab.url || !validTime(raw.lastActiveAt, at) ||
      !validTime(raw.lastInteractionAt, at) || typeof raw.protected !== 'boolean' ||
      typeof raw.active !== 'boolean' || raw.windowId !== tab.windowId) return fresh();
  const activations = pruneRecentActivations(raw.recentActivations, at);
  if (activations === null) return fresh();
  const record = { ...fresh(), lastActiveAt: raw.lastActiveAt,
    lastInteractionAt: raw.lastInteractionAt, recentActivations: activations };
  // An active tab, or a tab whose active state changed while asleep, gets grace.
  if (tab.active === true || raw.active !== tab.active) record.lastActiveAt = at;
  const discard = raw.discard;
  if (discard?.confirmed === true && discard.tabId === tab.id &&
      normalizeHostname(discard.hostname) === hostnameFromUrl(tab.url) &&
      validTime(discard.discardedAt, at)) {
    record.discard = { confirmed: true, tabId: tab.id,
      hostname: discard.hostname, discardedAt: discard.discardedAt };
  }
  return record;
}

function restoreHistory(raw, at) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(event => validTime(event?.timestamp, at) && validId(event.tabId) &&
    normalizeHostname(event.hostname) === event.hostname && HISTORY_ACTIONS.has(event.action) &&
    typeof event.reason === 'string' && /^[a-z-]{1,64}$/.test(event.reason))
    .slice(-HISTORY_LIMIT).map(({ timestamp, tabId, hostname, action, reason }) =>
      ({ timestamp, tabId, hostname, action, reason }));
}

/** One queue owns session state, preferences, feedback, scans and popup mutations.
 * Event listeners invalidate in-flight observations synchronously, before joining
 * the queue. No interval or worker keepalive is used.
 */
export function createBrowserWorker({ chrome, now = Date.now, probe,
  onError = error => console.warn('EcoGuard worker:', error.message) }) {
  const settings = createSettingsService(chrome.storage.local);
  const safetyClient = probe ?? createPageSafetyClient({ tabs: chrome.tabs, now });
  let session;
  let history;
  let initialized = false;
  let started = false;
  let revision = 0;
  let tail = Promise.resolve();
  let pendingScan;
  let lastError = null;

  const time = () => {
    const at = now();
    if (!Number.isFinite(at) || at < 0) throw new Error('Invalid browser observation clock.');
    return at;
  };
  const persist = () => chrome.storage.session.set({ [SESSION_KEY]: session });
  async function ensureAlarm() {
    const alarm = await chrome.alarms.get(SCAN_ALARM);
    if (!alarm || alarm.periodInMinutes !== 1) {
      await chrome.alarms.create(SCAN_ALARM, { periodInMinutes: 1 });
    }
  }
  async function initialize() {
    const [stored, local, tabs] = await Promise.all([
      chrome.storage.session.get(SESSION_KEY), chrome.storage.local.get(HISTORY_KEY), chrome.tabs.query({})
    ]);
    const at = time();
    const raw = stored[SESSION_KEY];
    const valid = raw?.schemaVersion === 1 && raw.tabs && typeof raw.tabs === 'object' &&
      !Array.isArray(raw.tabs) && typeof raw.paused === 'boolean';
    session = { schemaVersion: 1, paused: raw === undefined ? false : !valid || raw.paused,
      tabs: {}, lastScanAt: valid && validTime(raw.lastScanAt, at) ? raw.lastScanAt : null };
    for (const tab of tabs) {
      if (validId(tab.id) && tab.incognito === false) {
        session.tabs[tab.id] = restoreRecord(valid ? raw.tabs[tab.id] : undefined, tab, at);
      }
    }
    history = restoreHistory(local[HISTORY_KEY], at);
    await persist();
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
    await ensureAlarm();
    initialized = true;
  }
  function enqueue(operation) {
    const result = tail.then(async () => {
      if (!initialized) await initialize();
      return operation();
    }).catch(error => {
      // Reload durable state before retrying after an unexpected/storage failure.
      initialized = false;
      lastError = error.message;
      throw error;
    });
    tail = result.catch(() => {});
    return result;
  }
  const run = operation => { revision++; return enqueue(operation); };
  function dispatch(operation) { run(operation).catch(onError); }

  async function appendHistory(tab, action, reason) {
    const hostname = hostnameFromUrl(tab.url);
    if (!hostname) return;
    history.push({ timestamp: time(), tabId: tab.id, hostname, action, reason });
    history = history.slice(-HISTORY_LIMIT);
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  }
  async function restoreFeedback(tab, record) {
    if (!record?.discard || tab.active !== true || tab.discarded !== false) return;
    const discard = record.discard;
    delete record.discard;
    // Consume before updating preferences: a crash may lose an adjustment but
    // cannot double it again on the next activation or worker restart.
    await persist();
    let adjusted = false;
    await settings.update(value => {
      const feedback = applyRestoreFeedback({ settings: value, discard, tab, now: time() });
      adjusted = feedback.adjusted;
      return feedback.settings;
    });
    if (adjusted) await appendHistory(tab, 'restore-delay', 'rapid-restore');
  }
  async function observe(tab, { at = time(), activated = false, navigation = false } = {}) {
    if (!validId(tab?.id) || tab.incognito !== false) return;
    let record = session.tabs[tab.id];
    await restoreFeedback(tab, record);
    if (!record || navigation || record.url !== tab.url ||
        !validTime(record.lastActiveAt, time()) || !validTime(record.lastInteractionAt, time())) {
      record = freshRecord(tab, at, record?.protected === true);
      session.tabs[tab.id] = record;
    }
    if (activated) {
      for (const [id, other] of Object.entries(session.tabs)) {
        if (Number(id) !== tab.id && other.windowId === tab.windowId && other.active) {
          other.active = false;
          other.lastActiveAt = at;
        }
      }
      record.lastActiveAt = at;
      record.recentActivations = pruneRecentActivations([at, ...record.recentActivations], time()) ?? [at];
    }
    if (tab.active === true || record.active !== tab.active) record.lastActiveAt = at;
    record.active = tab.active === true;
    record.windowId = tab.windowId;
  }
  async function getTab(id) {
    try { return await chrome.tabs.get(id); }
    catch { return null; }
  }
  async function downloadsBusy() {
    try {
      const downloads = await chrome.downloads.search({ state: 'in_progress' });
      return Array.isArray(downloads) ? downloads.length !== 0 : undefined;
    } catch { return undefined; }
  }

  async function scan(stamp) {
    const result = { discarded: 0, attempted: 0, reason: 'complete' };
    if (revision !== stamp) return { ...result, reason: 'state-changed' };
    if (session.paused) return { ...result, reason: 'manager-paused' };
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set(tabs.map(tab => String(tab.id)));
    for (const id of Object.keys(session.tabs)) if (!liveIds.has(id)) delete session.tabs[id];
    for (const tab of tabs) await observe(tab);
    session.lastScanAt = time();
    // Refuse interventions when observations cannot be durably saved.
    await persist();
    const config = await settings.read();
    const candidates = tabs.map(tab => ({ tab,
      decision: evaluateBasicEligibility({ tab, activity: session.tabs[tab.id], settings: config, now: time() })
    })).filter(value => value.decision.candidate)
      .sort((a, b) => b.decision.idleForMs - a.decision.idleForMs || a.tab.id - b.tab.id);
    if (await downloadsBusy() !== false) return { ...result, reason: 'downloads-unavailable-or-busy' };
    for (const { tab } of candidates) {
      if (result.attempted >= 2) break;
      if (revision !== stamp) return { ...result, reason: 'state-changed' };
      const activity = session.tabs[tab.id];
      const initial = await safetyClient.inspect(tab);
      if (!evaluateEligibility({ tab, activity, settings: config, now: time(), safety: initial,
        downloadsInProgress: false }).eligible) continue;
      // A second inspection catches edits/media since the preliminary probe.
      // Read downloads and tab state again, then synchronously evaluate/call discard.
      const safety = await safetyClient.inspect(tab);
      const busy = await downloadsBusy();
      const finalTab = await getTab(tab.id);
      if (revision !== stamp) return { ...result, reason: 'state-changed' };
      const decision = evaluateEligibility({ tab: finalTab, activity, settings: config, now: time(),
        safety, downloadsInProgress: busy, paused: session.paused });
      if (!decision.eligible) continue;
      result.attempted++;
      let discarded;
      try { discarded = await chrome.tabs.discard(tab.id); }
      catch {
        await appendHistory(finalTab, 'discard-failed', 'browser-rejected');
        continue;
      }
      if (discarded?.id !== tab.id || discarded.discarded !== true ||
          discarded.url !== finalTab.url) {
        await appendHistory(finalTab, 'discard-unconfirmed', 'unconfirmed-result');
        continue;
      }
      activity.discard = { confirmed: true, tabId: tab.id,
        hostname: decision.hostname, discardedAt: time() };
      await persist();
      await appendHistory(finalTab, 'discarded', 'eligible');
      result.discarded++;
    }
    lastError = null;
    return result;
  }
  function requestScan() {
    if (!pendingScan) {
      // Capture when queued, not when execution starts: an event queued behind
      // this scan must invalidate it even before its first asynchronous step.
      const stamp = revision;
      pendingScan = enqueue(() => scan(stamp)).finally(() => { pendingScan = undefined; });
    }
    return pendingScan;
  }

  return {
    start() {
      if (started) return tail;
      started = true;
      // Every listener is registered before the first asynchronous storage read.
      chrome.tabs.onCreated.addListener(tab => {
        const at = time();
        dispatch(async () => { await observe(tab, { at, navigation: true }); await persist(); });
      });
      chrome.tabs.onActivated.addListener(({ tabId }) => {
        const at = time();
        dispatch(async () => {
          const tab = await getTab(tabId);
          if (tab) await observe(tab, { at, activated: true });
          await persist();
        });
      });
      chrome.tabs.onUpdated.addListener((id, change) => {
        const at = time();
        const navigation = change.status === 'loading' || typeof change.url === 'string';
        dispatch(async () => {
          const tab = await getTab(id);
          if (tab) await observe(tab, { at, navigation });
          await persist();
        });
      });
      chrome.tabs.onRemoved.addListener(id => dispatch(async () => {
        delete session.tabs[id]; await persist();
      }));
      chrome.tabs.onReplaced.addListener((addedId, removedId) => dispatch(async () => {
        delete session.tabs[removedId];
        const tab = await getTab(addedId);
        if (tab) await observe(tab, { navigation: true });
        await persist();
      }));
      // Download events cancel any scan already awaiting an API response.
      chrome.downloads.onCreated.addListener(() => dispatch(async () => {}));
      chrome.downloads.onChanged.addListener(() => dispatch(async () => {}));
      chrome.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === SCAN_ALARM) requestScan().catch(onError);
      });
      chrome.runtime.onStartup.addListener(() => dispatch(ensureAlarm));
      chrome.runtime.onInstalled.addListener(() => dispatch(ensureAlarm));
      return enqueue(async () => {});
    },
    run,
    scan: requestScan,
    settled: () => tail,
    status: () => enqueue(async () => ({ settings: await settings.read(), version: VERSION,
      cleanupAvailable: true, paused: session.paused, lastScanAt: session.lastScanAt,
      historyCount: history.length, lastError })),
    saveSettings: idleMinutes => run(async () => ({ settings: await settings.save(idleMinutes), version: VERSION })),
    setPaused: paused => run(async () => {
      if (typeof paused !== 'boolean') throw new Error('Pause must be true or false.');
      session.paused = paused;
      await persist();
      return { paused: session.paused };
    }),
    setTabProtection: (id, protectedTab) => run(async () => {
      if (!validId(id) || typeof protectedTab !== 'boolean' || !session.tabs[id]) {
        throw new Error('Invalid tab protection request.');
      }
      session.tabs[id].protected = protectedTab;
      await persist();
      return { protected: protectedTab };
    })
  };
}
