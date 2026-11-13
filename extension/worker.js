import { createSettingsService, DEFAULT_SETTINGS, normalizeSettings, VERSION } from './settings.js';
import { createPageSafetyClient } from './page-probe.js';
import { hostnameFromUrl, normalizeHostname, hostnameMatches } from './hostname.js';
import { evaluateBasicEligibility, evaluateEligibility, pruneRecentActivations,
  applyRestoreFeedback, resetLearnedDelays, SAFETY_MAX_AGE_MS } from './policy.js';

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
      hostname: discard.hostname, discardedAt: discard.discardedAt,
      sequence: Number.isSafeInteger(discard.sequence) && discard.sequence >= 0 ? discard.sequence : 0 };
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
  let discardAttempt;
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
  async function completeLocalReset(tabs) {
    const at = time();
    session = { schemaVersion: 1, paused: true, resetPending: true,
      tabs: {}, lastScanAt: null, discardSequence: 0 };
    for (const tab of tabs) {
      if (validId(tab.id) && tab.incognito === false) session.tabs[tab.id] = freshRecord(tab, at);
    }
    // Keep a durable reset intent until both storage areas reflect the reset.
    await persist();
    const defaults = normalizeSettings(DEFAULT_SETTINGS);
    await chrome.storage.local.set({ settings: defaults, [HISTORY_KEY]: [] });
    history = [];
    session.resetPending = false;
    await persist();
    lastError = null;
    return defaults;
  }
  async function initialize() {
    const [stored, local, tabs] = await Promise.all([
      chrome.storage.session.get(SESSION_KEY), chrome.storage.local.get(HISTORY_KEY), chrome.tabs.query({})
    ]);
    const at = time();
    const raw = stored[SESSION_KEY];
    if (raw?.resetPending === true) {
      await completeLocalReset(tabs);
      await ensureAlarm();
      initialized = true;
      return;
    }
    const valid = raw?.schemaVersion === 1 && raw.tabs && typeof raw.tabs === 'object' &&
      !Array.isArray(raw.tabs) && typeof raw.paused === 'boolean';
    session = { schemaVersion: 1, paused: raw === undefined ? false : !valid || raw.paused,
      tabs: {}, lastScanAt: valid && validTime(raw.lastScanAt, at) ? raw.lastScanAt : null,
      discardSequence: 0 };
    for (const tab of tabs) {
      if (validId(tab.id) && tab.incognito === false) {
        session.tabs[tab.id] = restoreRecord(valid ? raw.tabs[tab.id] : undefined, tab, at);
        session.discardSequence = Math.max(session.discardSequence, session.tabs[tab.id].discard?.sequence ?? 0);
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

  async function restoreTarget() {
    const records = Object.entries(session.tabs).filter(([, record]) => record.discard?.confirmed)
      .sort(([a, left], [b, right]) => right.discard.discardedAt - left.discard.discardedAt ||
        (right.discard.sequence ?? 0) - (left.discard.sequence ?? 0) || Number(b) - Number(a));
    for (const [id, record] of records) {
      const tab = await getTab(Number(id));
      if (tab?.id === Number(id) && tab.incognito === false && tab.discarded === true &&
          tab.url === record.url && hostnameFromUrl(tab.url) === record.discard.hostname) {
        const { tabId, hostname, discardedAt } = record.discard;
        return { tabId, hostname, discardedAt };
      }
    }
    return null;
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
      const attempt = { currentId: tab.id };
      discardAttempt = attempt;
      try {
        discarded = await chrome.tabs.discard(tab.id);
        // Recent Chrome builds replace WebContents (and the tab ID) while
        // discarding. Yield for that event and validate the returned live tab.
        if (validId(discarded?.id) && discarded.id !== tab.id) {
          const current = await getTab(discarded.id);
          if (current?.id !== discarded.id || current.url !== finalTab.url ||
              current.discarded !== true || current.incognito !== false ||
              current.windowId !== finalTab.windowId) discarded = undefined;
        }
      }
      catch {
        await appendHistory(finalTab, 'discard-failed', 'browser-rejected');
        continue;
      } finally {
        discardAttempt = undefined;
      }
      if (discarded?.id !== attempt.currentId || discarded.discarded !== true ||
          discarded.url !== finalTab.url) {
        await appendHistory(finalTab, 'discard-unconfirmed', 'unconfirmed-result');
        continue;
      }
      if (discarded.id !== tab.id) {
        delete session.tabs[tab.id];
        session.tabs[discarded.id] = activity;
      }
      activity.discard = { confirmed: true, tabId: discarded.id,
        hostname: decision.hostname, discardedAt: time(), sequence: ++session.discardSequence };
      await persist();
      await appendHistory(discarded, 'discarded', 'eligible');
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
      chrome.tabs.onReplaced.addListener((addedId, removedId) => {
        // Correlate synchronously while the discard API is pending; never accept
        // an unrelated returned ID just because its URL happens to match.
        if (discardAttempt?.currentId === removedId) discardAttempt.currentId = addedId;
        dispatch(async () => {
          const protectedTab = session.tabs[removedId]?.protected === true || session.tabs[addedId]?.protected === true;
          delete session.tabs[removedId];
          const tab = await getTab(addedId);
          if (tab) {
            const confirmed = session.tabs[addedId]?.discard;
            await observe(tab, { navigation: !(confirmed?.confirmed && confirmed.tabId === addedId &&
              session.tabs[addedId].url === tab.url) });
            if (session.tabs[addedId]) session.tabs[addedId].protected = protectedTab;
          }
          await persist();
        });
      });
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
    managementStatus: () => enqueue(async () => {
      const config = await settings.read();
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const hostname = hostnameFromUrl(tab?.url);
      const currentTab = validId(tab?.id) && tab.incognito === false && hostname
        ? { tabId: tab.id, url: tab.url, hostname, protected: session.tabs[tab.id]?.protected === true,
          matchingHosts: config.protectedHosts.filter(rule => hostnameMatches(hostname, rule)),
          safety: await safetyClient.inspect(tab) } : null;
      return { currentTab, protectedHosts: config.protectedHosts, restoreTarget: await restoreTarget() };
    }),
    exportHistory: () => run(async () => {
      const exportedAt = new Date(time()).toISOString();
      const events = restoreHistory(history, time());
      const payload = { schemaVersion: 1, application: 'EcoGuard', version: VERSION, exportedAt, events };
      const filename = `EcoGuard-history-${exportedAt.replace(/[:.]/g, '-')}.json`;
      const downloadId = await chrome.downloads.download({
        url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`,
        filename, saveAs: true
      });
      if (!validId(downloadId)) throw new Error('Chrome did not start the history export. Try again.');
      return { downloadId, eventCount: events.length };
    }),
    clearHistory: confirmed => run(async () => {
      if (confirmed !== true) throw new Error('Confirm before clearing history.');
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      history = [];
      return { historyCount: 0 };
    }),
    resetLearning: confirmed => run(async () => {
      if (confirmed !== true) throw new Error('Confirm before resetting learned delays.');
      return { settings: await settings.update(resetLearnedDelays), version: VERSION };
    }),
    resetLocalData: confirmed => run(async () => {
      if (confirmed !== true) throw new Error('Confirm before resetting EcoGuard data.');
      session.paused = true;
      session.resetPending = true;
      await persist();
      const defaults = await completeLocalReset(await chrome.tabs.query({}));
      return { settings: defaults, version: VERSION, paused: true, historyCount: 0 };
    }),
    resetPageEdits: (id, expectedUrl, confirmed) => run(async () => {
      if (confirmed !== true) throw new Error('Save your work and confirm before clearing edit protection.');
      if (!validId(id) || !hostnameFromUrl(expectedUrl)) throw new Error('Invalid edit reset request.');
      const tab = await getTab(id);
      if (tab?.id !== id || tab.incognito !== false || tab.url !== expectedUrl || tab.discarded !== false) {
        throw new Error('This tab changed or is unavailable. Reopen the popup and try again.');
      }
      const safety = await safetyClient.resetEdits(tab, { confirmed: true });
      if (safety?.inspected !== true || safety.reset !== true || safety.edited !== false ||
          safety.tabId !== id || safety.url !== expectedUrl || !validTime(safety.checkedAt, time()) ||
          time() - safety.checkedAt > SAFETY_MAX_AGE_MS || !validTime(safety.lastInteractionAt, time())) {
        throw new Error('Could not confirm clearing edit protection. Refresh the page and reopen EcoGuard.');
      }
      const current = await getTab(id);
      if (current?.url !== expectedUrl || current.id !== id || current.incognito !== false) {
        throw new Error('The page changed during the reset. Reopen the popup to check its protection.');
      }
      await observe(current);
      session.tabs[id].lastInteractionAt = time();
      await persist();
      return { reset: true };
    }),
    setTabProtection: (id, protectedTab, expectedUrl) => run(async () => {
      if (!validId(id) || typeof protectedTab !== 'boolean' || !hostnameFromUrl(expectedUrl)) {
        throw new Error('Invalid tab protection request.');
      }
      const tab = await getTab(id);
      if (tab?.id !== id || tab.incognito !== false || tab.url !== expectedUrl) {
        throw new Error('This tab changed or is unavailable. Reopen the popup and try again.');
      }
      await observe(tab);
      session.tabs[id].protected = protectedTab;
      await persist();
      return { protected: protectedTab };
    }),
    setSiteProtection: (hostname, protectedSite) => run(async () => {
      const host = normalizeHostname(hostname);
      if (!host || typeof protectedSite !== 'boolean') throw new Error('Invalid site protection request.');
      const config = await settings.update(value => {
        const hosts = value.protectedHosts;
        if (protectedSite && !hosts.includes(host) && hosts.length >= 500) {
          throw new Error('The 500-site protection limit is full. Remove a site before adding another.');
        }
        return { ...value, protectedHosts: protectedSite ? [...new Set([...hosts, host])]
          : hosts.filter(rule => rule !== host) };
      });
      return { protectedHosts: config.protectedHosts };
    }),
    restoreLastUnloaded: target => run(async () => {
      if (!validId(target?.tabId) || !normalizeHostname(target.hostname) || normalizeHostname(target.hostname) !== target.hostname ||
          !validTime(target.discardedAt, time())) throw new Error('Invalid restore request.');
      const record = session.tabs[target.tabId];
      const discard = record?.discard;
      if (!discard || discard.tabId !== target.tabId || discard.hostname !== target.hostname ||
          discard.discardedAt !== target.discardedAt) {
        throw new Error('That unloaded tab is no longer available. Reopen the popup and try again.');
      }
      const tab = await getTab(target.tabId);
      if (tab?.id !== target.tabId || tab.incognito !== false || tab.discarded !== true ||
          tab.url !== record.url || hostnameFromUrl(tab.url) !== target.hostname) {
        throw new Error('That tab was restored, closed or changed. Reopen the popup and try again.');
      }
      // Activate the existing tab; Chrome performs its normal discarded-tab reload.
      // Never create a replacement tab or navigate back to a saved URL.
      const selected = await chrome.tabs.update(tab.id, { active: true });
      if (selected?.id !== tab.id || selected.active !== true) {
        throw new Error('Chrome did not confirm selecting the tab. Check the tab before retrying.');
      }
      await observe(selected);
      await persist();
      let focusFailed = false;
      try { await chrome.windows.update(selected.windowId, { focused: true }); }
      catch { focusFailed = true; }
      return { restored: true, hostname: target.hostname, focusFailed };
    })
  };
}
