import { createSettingsService, VERSION } from './settings.js';
import { createUnloadedTabsService } from './unloaded-tabs.js';

const settings = createSettingsService(chrome.storage.local);
const unloadedTabs = createUnloadedTabsService(chrome.tabs);

// Register synchronously so the popup can wake a newly started MV3 worker.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('popup.html')) return false;

  let operation;
  if (message?.type === 'status') {
    operation = settings.read().then(value => ({ settings: value, version: VERSION, cleanupAvailable: false }));
  } else if (message?.type === 'saveSettings') {
    operation = settings.save(message.idleMinutes).then(value => ({ settings: value, version: VERSION }));
  } else if (message?.type === 'unloadedTabsStatus') {
    operation = unloadedTabs.list().then(tabIds => ({ tabIds }));
  } else if (message?.type === 'closeUnloadedTabs') {
    operation = unloadedTabs.close(message.tabIds);
  }
  else { reply({ ok: false, error: 'Unsupported EcoGuard request.' }); return false; }

  operation.then(
    value => reply({ ok: true, ...value }),
    error => reply({ ok: false, error: error.message })
  );
  return true;
});
