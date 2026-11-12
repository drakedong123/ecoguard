import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBrowserWorker } from '../../worker.js';
import { createUnloadedTabsService } from '../../unloaded-tabs.js';

const source = (await readFile(new URL('../../background.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');

export function background(chrome, now = Date.now) {
  let listener;
  chrome.runtime.onMessage.addListener = callback => { listener = callback; };
  vm.runInNewContext(source, {
    createBrowserWorker: options => createBrowserWorker({ ...options, now }),
    createUnloadedTabsService, chrome, console: { warn: () => {} }
  });
  return {
    send: (message, sender = { id: 'ecoguard', url: 'chrome-extension://ecoguard/popup.html' }) =>
      new Promise(resolve => {
        if (!listener(message, sender, response => resolve(structuredClone(response)))) resolve(undefined);
      })
  };
}
