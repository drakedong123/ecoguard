import { createUnloadedTabsService } from './unloaded-tabs.js';
import { createBrowserWorker } from './worker.js';

const unloadedTabs = createUnloadedTabsService(chrome.tabs);
const worker = createBrowserWorker({ chrome });
worker.start().catch(error => console.warn('EcoGuard initialization:', error.message));

// Register synchronously so the popup can wake a newly started MV3 worker.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('popup.html')) return false;

  let operation;
  if (message?.type === 'status') {
    operation = worker.status();
  } else if (message?.type === 'saveSettings') {
    operation = worker.saveSettings(message.idleMinutes);
  } else if (message?.type === 'setPaused') {
    operation = worker.setPaused(message.paused);
  } else if (message?.type === 'managementStatus') {
    operation = worker.managementStatus();
  } else if (message?.type === 'setTabProtection') {
    operation = worker.setTabProtection(message.tabId, message.protected, message.expectedUrl);
  } else if (message?.type === 'setSiteProtection') {
    operation = worker.setSiteProtection(message.hostname, message.protected);
  } else if (message?.type === 'restoreLastUnloaded') {
    operation = worker.restoreLastUnloaded(message.target);
  } else if (message?.type === 'unloadedTabsStatus') {
    operation = worker.run(() => unloadedTabs.list().then(tabIds => ({ tabIds })));
  } else if (message?.type === 'closeUnloadedTabs') {
    operation = worker.run(() => unloadedTabs.close(message.tabIds));
  }
  else { reply({ ok: false, error: 'Unsupported EcoGuard request.' }); return false; }

  operation.then(
    value => reply({ ok: true, ...value }),
    error => reply({ ok: false, error: error.message })
  );
  return true;
});
