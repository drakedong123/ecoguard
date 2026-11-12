const form = document.getElementById('settings');
const idle = document.getElementById('idle');
const save = document.getElementById('save');
const feedback = document.getElementById('feedback');
const pause = document.getElementById('pause');
let paused = false;
const closeUnloaded = document.getElementById('close-unloaded');
const unloadedFeedback = document.getElementById('unloaded-feedback');
let unloadedTabIds = [];
const protectTab = document.getElementById('protect-tab');
const protectSite = document.getElementById('protect-site');
const protectedSites = document.getElementById('protected-sites');
const protectionFeedback = document.getElementById('protection-feedback');
const restoreLast = document.getElementById('restore-last');
const restoreFeedback = document.getElementById('restore-feedback');
let management;
let managementBusy = true;
let siteRemoveButtons = [];

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
  try { await refreshManagement(); }
  catch (error) { protectionFeedback.textContent = error.message; }
});

refreshUnloadedTabs().then(count => {
  unloadedFeedback.textContent = count === 0
    ? 'No unloaded tabs available to close.'
    : `${count} unloaded tab${count === 1 ? '' : 's'} available to close.`;
}).catch(error => { unloadedFeedback.textContent = error.message; });

function updateManagementButtons() {
  protectTab.disabled = managementBusy || !management?.currentTab;
  protectSite.disabled = managementBusy || !management?.currentTab ||
    management.protectedHosts.includes(management.currentTab.hostname);
  restoreLast.disabled = managementBusy || !management?.restoreTarget;
  for (const button of siteRemoveButtons) button.disabled = managementBusy;
}

function renderManagement() {
  const tab = management.currentTab;
  document.getElementById('current-site').textContent = tab?.hostname ?? 'Open an HTTP or HTTPS page to protect a tab or site.';
  protectTab.textContent = tab?.protected ? 'Unprotect this tab' : 'Protect this tab';
  protectSite.textContent = tab && management.protectedHosts.includes(tab.hostname)
    ? 'This site is protected' : 'Protect this site';
  const states = [];
  if (tab?.protected) states.push('This tab is protected for the browser session.');
  if (tab?.matchingHosts.length) states.push(`Site protection: ${tab.matchingHosts.join(', ')}.`);
  document.getElementById('protection-state').textContent = states.join(' ') ||
    (tab ? 'No tab or site exception. Other safety checks still apply.' : 'Protection controls are unavailable for this page.');
  protectedSites.replaceChildren();
  siteRemoveButtons = [];
  for (const hostname of management.protectedHosts) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = hostname;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove protection for ${hostname} and its subdomains`);
    remove.addEventListener('click', () => managementAction(remove, protectionFeedback,
      { type: 'setSiteProtection', hostname, protected: false },
      `Removed protection for ${hostname} and its subdomains.`));
    row.append(name, remove);
    protectedSites.append(row);
    siteRemoveButtons.push(remove);
  }
  if (!management.protectedHosts.length) {
    const row = document.createElement('li');
    row.textContent = 'No protected sites.';
    protectedSites.append(row);
  }
  document.getElementById('restore-target').textContent = management.restoreTarget
    ? `Last available: ${management.restoreTarget.hostname}. Selecting it reloads the existing tab.`
    : 'No tabs unloaded by EcoGuard are available to restore.';
}

async function refreshManagement() {
  managementBusy = true;
  updateManagementButtons();
  // If refresh fails, leave controls disabled rather than acting on stale state.
  management = await request({ type: 'managementStatus' });
  renderManagement();
  managementBusy = false;
  updateManagementButtons();
}

async function managementAction(button, output, message, success) {
  if (button.disabled || managementBusy) return;
  managementBusy = true;
  updateManagementButtons();
  output.textContent = 'Working…';
  try {
    const result = await request(message);
    output.textContent = result.focusFailed
      ? 'Tab selected, but its window could not be focused. Select its window to view it.' : success;
  } catch (error) { output.textContent = error.message; }
  try { await refreshManagement(); }
  catch (error) { output.textContent += ` Could not refresh controls: ${error.message}`; }
  if (message.type === 'restoreLastUnloaded') {
    try { await refreshUnloadedTabs(); }
    catch (error) { unloadedFeedback.textContent = error.message; }
  }
}

protectTab.addEventListener('click', () => managementAction(protectTab, protectionFeedback,
  { type: 'setTabProtection', tabId: management?.currentTab?.tabId,
    expectedUrl: management?.currentTab?.url, protected: !management?.currentTab?.protected },
  management?.currentTab?.protected ? 'Tab protection removed. Other protections still apply.'
    : 'Tab protected for this browser session.'));

protectSite.addEventListener('click', () => managementAction(protectSite, protectionFeedback,
  { type: 'setSiteProtection', hostname: management?.currentTab?.hostname, protected: true },
  'Site and subdomains protected on this device.'));

restoreLast.addEventListener('click', () => managementAction(restoreLast, restoreFeedback,
  { type: 'restoreLastUnloaded', target: management?.restoreTarget }, 'Selected the unloaded tab for reload.'));

refreshManagement().then(() => { protectionFeedback.textContent = 'Protection controls ready.'; })
  .catch(error => { protectionFeedback.textContent = error.message; });
