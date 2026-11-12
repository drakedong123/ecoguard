import { createBrowserWorker, SCAN_ALARM } from '../../worker.js';

export function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener),
    emit: (...args) => listeners.forEach(listener => listener(...args)) };
}

export function tab(id, fields = {}) {
  return { id, windowId: 1, url: `https://example.org/tab-${id}`, active: false,
    pinned: false, incognito: false, audible: false, discarded: false,
    autoDiscardable: true, status: 'complete', ...fields };
}

export function storage(data = {}) {
  return {
    data,
    get: async key => structuredClone({ [key]: data[key] }),
    set: async values => { Object.assign(data, structuredClone(values)); }
  };
}

export function browser({ tabs = [tab(1)], clock = { at: 0 }, local = { settings: { idleMinutes: 5 } },
  session = {}, probe, emitOnDiscard = false } = {}) {
  const records = new Map(tabs.map(value => [value.id, structuredClone(value)]));
  const discarded = [];
  const selected = [];
  const focused = [];
  const removed = [];
  const downloads = [];
  const errors = [];
  const alarms = new Map();
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(), onReplaced: event(),
      query: async query => [...records.values()]
        .filter(tab => (query.discarded === undefined || tab.discarded === query.discarded) &&
          (query.active === undefined || tab.active === query.active) &&
          (!query.lastFocusedWindow || tab.windowId === 1)).map(tab => structuredClone(tab)),
      get: async id => {
        if (!records.has(id)) throw new Error('No such tab');
        return structuredClone(records.get(id));
      },
      discard: async id => {
        discarded.push(id);
        const value = records.get(id);
        value.discarded = true;
        if (emitOnDiscard) chrome.tabs.onUpdated.emit(id, { discarded: true }, structuredClone(value));
        return structuredClone(value);
      },
      update: async (id, properties) => {
        selected.push({ id, properties: structuredClone(properties) });
        if (!records.has(id)) throw new Error('No such tab');
        const target = records.get(id);
        if (properties.active === true) {
          for (const other of records.values()) if (other.windowId === target.windowId) other.active = false;
          Object.assign(target, { active: true, discarded: false });
          chrome.tabs.onActivated.emit({ tabId: id, windowId: target.windowId });
        }
        return structuredClone(target);
      },
      remove: async id => { removed.push(id); records.delete(id); chrome.tabs.onRemoved.emit(id); }
    },
    windows: { update: async (id, properties) => { focused.push({ id, properties }); return { id, ...properties }; } },
    downloads: { onCreated: event(), onChanged: event(), search: async () => [],
      download: async options => { downloads.push(structuredClone(options)); return downloads.length; } },
    alarms: { onAlarm: event(), get: async name => alarms.get(name),
      create: async (name, info) => { alarms.set(name, { name, ...info }); } },
    runtime: {
      id: 'ecoguard', getURL: path => `chrome-extension://ecoguard/${path}`,
      onStartup: event(), onInstalled: event(), onMessage: event()
    }
  };
  const safe = target => ({ inspected: true, tabId: target.id, url: target.url,
    checkedAt: clock.at, lastInteractionAt: 0, edited: false, playingMedia: false,
    hasEmbeddedFrame: false, capturing: false, sharing: false });
  const safety = probe ?? { inspect: async target => safe(target),
    resetEdits: async target => ({ ...safe(target), reset: true, lastInteractionAt: clock.at }) };
  const worker = createBrowserWorker({ chrome, now: () => clock.at, probe: safety,
    onError: error => errors.push(error.message) });
  return { chrome, records, discarded, selected, focused, removed, downloads, errors, alarms, clock, local, session,
    safe, safety, worker, alarm: () => chrome.alarms.onAlarm.emit({ name: SCAN_ALARM }) };
}
