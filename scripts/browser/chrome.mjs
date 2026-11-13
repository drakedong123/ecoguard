import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, { timeout = 15_000, interval = 100, label = 'browser state' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

// CDP over inherited pipes: no debug port, package dependency or personal profile.
export async function launchChrome({ profile, headed = false } = {}) {
  const ownedProfile = !profile;
  profile ??= await mkdtemp(path.join(tmpdir(), 'ecoguard-browser-'));
  const executable = process.env.CHROME_BIN ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32' ? 'chrome.exe' : 'google-chrome');
  const child = spawn(executable, [
    ...(headed ? [] : ['--headless=new']), `--user-data-dir=${profile}`,
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const pending = new Map();
  const events = new EventEmitter();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  function rejectPending(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  child.on('error', rejectPending);
  child.on('exit', code => rejectPending(new Error(`Test Chrome exited (${code}). ${stderr}`)));
  const onInterrupt = () => { close({ removeProfile: true }).finally(() => process.exit(130)); };
  const onTerminate = () => { close({ removeProfile: true }).finally(() => process.exit(143)); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  child.once('exit', () => {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  });
  child.stdio[3].on('error', rejectPending);
  child.stdio[4].on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else events.emit(message.method, message.params, message.sessionId);
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out. ${stderr.slice(-500)}`));
      }, 20_000);
      pending.set(id, { method, resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async function close({ removeProfile = ownedProfile } = {}) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { await send('Browser.close'); } catch { child.kill('SIGTERM'); }
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (const stream of [child.stderr, child.stdio[3], child.stdio[4]]) stream.destroy();
    if (removeProfile) await rm(profile, { recursive: true, force: true });
  }
  try { await send('Browser.getVersion'); }
  catch (error) { await close(); throw error; }
  async function attach(targetId) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return {
        targetId, sessionId,
        send: (method, params) => send(method, params, sessionId),
        async evaluate(expression) {
          const result = await send('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, userGesture: true
          }, sessionId);
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
          return result.result.value;
        },
        close: () => send('Target.closeTarget', { targetId }),
        detach: () => send('Target.detachFromTarget', { sessionId })
      };
  }
  return {
    send, events, profile, close,
    attach,
    version: () => send('Browser.getVersion'),
    async page(url, { background = true } = {}) {
      const { targetId } = await send('Target.createTarget', { url, background });
      const page = await attach(targetId);
      const expectedUrl = new URL(url).href;
      await until(() => page.evaluate(`location.href === ${JSON.stringify(expectedUrl)} && document.readyState === "complete"`),
        { label: url });
      return page;
    },
    async popup(extensionId, page) {
      const previous = new Set((await send('Target.getTargets')).targetInfos.map(target => target.targetId));
      const tabs = (await send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos;
      const url = await page.evaluate('location.href');
      const tab = tabs.find(tab => tab.url === url);
      if (!tab) throw new Error(`No tab target for ${url}`);
      await send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
      const target = await until(async () => (await send('Target.getTargets')).targetInfos.find(target =>
        target.url === `chrome-extension://${extensionId}/popup.html` && !previous.has(target.targetId)), { label: 'EcoGuard popup' });
      const popup = await attach(target.targetId);
      await until(() => popup.evaluate('document.readyState === "complete" && document.getElementById("save")?.disabled === false'),
        { label: 'popup connection' });
      return popup;
    }
  };
}
