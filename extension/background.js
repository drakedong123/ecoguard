import { createSettingsService, VERSION } from './settings.js';

const settings = createSettingsService(chrome.storage.local);

// Register synchronously so the popup can wake a newly started MV3 worker.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('popup.html')) return false;

  let operation;
  if (message?.type === 'status') operation = settings.read();
  else if (message?.type === 'saveSettings') operation = settings.save(message.idleMinutes);
  else { reply({ ok: false, error: 'Unsupported EcoGuard request.' }); return false; }

  operation.then(
    value => reply({ ok: true, settings: value, version: VERSION, cleanupAvailable: false }),
    error => reply({ ok: false, error: error.message })
  );
  return true;
});
