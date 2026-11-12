const form = document.getElementById('settings');
const idle = document.getElementById('idle');
const save = document.getElementById('save');
const feedback = document.getElementById('feedback');
const pause = document.getElementById('pause');
let paused = false;
const closeUnloaded = document.getElementById('close-unloaded');
const unloadedFeedback = document.getElementById('unloaded-feedback');
let unloadedTabIds = [];

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'EcoGuard did not respond. Reload the extension.');
  if (response.settings) idle.value = response.settings.idleMinutes;
  if (response.version) document.getElementById('version').textContent = response.version;
  return response;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  save.disabled = true;
  try {
    await request({ type: 'saveSettings', idleMinutes: Number(idle.value) });
    feedback.textContent = 'Preference saved on this device.';
  } catch (error) { feedback.textContent = error.message; }
  finally { save.disabled = false; }
});

function showPauseState(value) {
  paused = value;
  pause.textContent = paused ? 'Resume automatic unloading' : 'Pause automatic unloading';
  feedback.textContent = paused ? 'Automatic unloading is paused for this browser session.'
    : 'Automatic unloading is on. Safety checks run about once a minute.';
}

pause.addEventListener('click', async () => {
  if (pause.disabled) return;
  pause.disabled = true;
  try { showPauseState((await request({ type: 'setPaused', paused: !paused })).paused); }
  catch (error) { feedback.textContent = error.message; }
  finally { pause.disabled = false; }
});

request({ type: 'status' }).then(response => {
  idle.disabled = false; save.disabled = false;
  showPauseState(response.paused === true);
  pause.disabled = false;
  if (response.lastError) feedback.textContent += ` Last worker error: ${response.lastError}`;
}).catch(error => { feedback.textContent = error.message; });

async function refreshUnloadedTabs() {
  closeUnloaded.disabled = true;
  unloadedTabIds = [];
  closeUnloaded.textContent = 'Close unloaded tabs (0)';
  const response = await request({ type: 'unloadedTabsStatus' });
  unloadedTabIds = response.tabIds;
  closeUnloaded.textContent = `Close unloaded tabs (${unloadedTabIds.length})`;
  closeUnloaded.disabled = unloadedTabIds.length === 0;
  return unloadedTabIds.length;
}

closeUnloaded.addEventListener('click', async () => {
  if (closeUnloaded.disabled || unloadedTabIds.length === 0) return;
  closeUnloaded.disabled = true;
  unloadedFeedback.textContent = 'Closing unloaded tabs…';
  let summary;
  try {
    const result = await request({ type: 'closeUnloadedTabs', tabIds: unloadedTabIds });
    summary = `Closed ${result.closed} unloaded tab${result.closed === 1 ? '' : 's'}.`;
    if (result.skipped) summary += ` Skipped ${result.skipped} changed or unavailable tab${result.skipped === 1 ? '' : 's'}.`;
    if (result.failed) summary += ` Could not close ${result.failed} tab${result.failed === 1 ? '' : 's'}; try again.`;
  } catch (error) { summary = error.message; }
  unloadedFeedback.textContent = summary;
  try { await refreshUnloadedTabs(); }
  catch (error) { unloadedFeedback.textContent = `${summary} Could not refresh the count: ${error.message}`; }
});

refreshUnloadedTabs().then(count => {
  unloadedFeedback.textContent = count === 0
    ? 'No unloaded tabs available to close.'
    : `${count} unloaded tab${count === 1 ? '' : 's'} available to close.`;
}).catch(error => { unloadedFeedback.textContent = error.message; });
