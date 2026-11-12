import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../popup.js', import.meta.url), 'utf8');

function node(disabled = false) {
  return {
    disabled, textContent: '', value: '', listeners: {}, children: [], attributes: {},
    reportValidity: () => true,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    showModal() { this.open = true; },
    close() { this.open = false; this.listeners.close?.(); }
  };
}

export async function popup(sendMessage, { status = async () => ({
  ok: true, settings: { idleMinutes: 30 }, version: '0.1.0', paused: false
}), managementStatus = async () => ({
  ok: true, currentTab: null, protectedHosts: [], restoreTarget: null
}) } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, node(true));
    return elements.get(id);
  };
  const requests = [];
  vm.runInNewContext(source, {
    document: { getElementById: element, createElement: () => node() },
    chrome: { runtime: { sendMessage: async message => {
      requests.push(structuredClone(message));
      if (message.type === 'status') return status();
      if (message.type === 'managementStatus') return managementStatus();
      return sendMessage(message);
    } } }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { element, requests };
}
