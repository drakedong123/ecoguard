const form = document.getElementById('settings');
const idle = document.getElementById('idle');
const save = document.getElementById('save');
const feedback = document.getElementById('feedback');
const pause = document.getElementById('pause');
let paused = false;
const closeUnloaded = document.getElementById('close-unloaded');
const unloadedFeedback = document.getElementById('unloaded-feedback');
const unloadedSummary = document.getElementById('unloaded-summary');
const unloadedList = document.getElementById('unloaded-tabs');
const selectAllUnloaded = document.getElementById('select-all-unloaded');
let unloadedTabs = [];
let selectedUnloadedIds = new Set();
let unloadedChecks = new Map();
let unloadedLoading = true;
let unloadedClosing = false;
let unloadedRefreshPromise;
let unloadedRefreshAgain = false;
const protectTab = document.getElementById('protect-tab');
const protectSite = document.getElementById('protect-site');
const protectedSites = document.getElementById('protected-sites');
const protectionFeedback = document.getElementById('protection-feedback');
const restoreLast = document.getElementById('restore-last');
const restoreFeedback = document.getElementById('restore-feedback');
let management;
let managementBusy = true;
let siteRemoveButtons = [];
const resetEdits = document.getElementById('reset-edits');
const exportHistory = document.getElementById('export-history');
const clearHistory = document.getElementById('clear-history');
const resetLearning = document.getElementById('reset-learning');
const resetLocal = document.getElementById('reset-local');
const dataFeedback = document.getElementById('data-feedback');
const confirmation = document.getElementById('confirmation');
let statusReady = false;
let dataBusy = false;
let writesInFlight = 0;
let pendingConfirmation = null;
const readRequests = new Set(['status', 'managementStatus', 'unloadedTabsStatus']);

async function request(message) {
  const mutation = !readRequests.has(message.type);
  if (mutation) { writesInFlight++; updateDataButtons(); }
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error ?? 'EcoGuard did not respond. Reload the extension.');
    if (response.settings) idle.value = response.settings.idleMinutes;
    if (response.version) document.getElementById('version').textContent = response.version;
    return response;
  } finally {
    if (mutation) { writesInFlight--; updateDataButtons(); }
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled || dataBusy || pendingConfirmation) return;
  if (!form.reportValidity()) return;
  save.disabled = true;
  try {
    await request({ type: 'saveSettings', idleMinutes: Number(idle.value) });
    feedback.textContent = 'Preference saved on this device.';
  } catch (error) { feedback.textContent = error.message; }
  finally { save.disabled = dataBusy || !!pendingConfirmation || !statusReady; }
});

function showPauseState(value) {
  paused = value;
  pause.textContent = paused ? 'Resume automatic unloading' : 'Pause automatic unloading';
  feedback.textContent = paused ? 'Automatic unloading is paused for this browser session.'
    : '';
}

pause.addEventListener('click', async () => {
  if (pause.disabled || dataBusy || pendingConfirmation) return;
  pause.disabled = true;
  try { showPauseState((await request({ type: 'setPaused', paused: !paused })).paused); }
  catch (error) { feedback.textContent = error.message; }
  finally { pause.disabled = dataBusy || !!pendingConfirmation || !statusReady; }
});

async function refreshStatus() {
  statusReady = false;
  const response = await request({ type: 'status' });
  statusReady = true;
  showPauseState(response.paused === true);
  if (response.lastError) feedback.textContent += ` Last worker error: ${response.lastError}`;
  const count = response.historyCount ?? 0;
  const learned = response.settings.learnedHostDelays?.length ?? 0;
  document.getElementById('data-summary').textContent = `${count} history events · ${learned} learned site delays`;
  updateAllButtons();
}

refreshStatus().catch(error => { feedback.textContent = error.message; });

function unloadedBusy() {
  return unloadedLoading || unloadedClosing || dataBusy || !!pendingConfirmation;
}

function updateUnloadedControls() {
  const busy = unloadedBusy();
  closeUnloaded.textContent = `Close selected (${selectedUnloadedIds.size})`;
  closeUnloaded.disabled = busy || selectedUnloadedIds.size === 0;
  selectAllUnloaded.disabled = busy || unloadedTabs.length === 0;
  selectAllUnloaded.checked = unloadedTabs.length > 0 && selectedUnloadedIds.size === unloadedTabs.length;
  selectAllUnloaded.indeterminate = selectedUnloadedIds.size > 0 && selectedUnloadedIds.size < unloadedTabs.length;
  for (const [id, checkbox] of unloadedChecks) {
    checkbox.disabled = busy;
    checkbox.checked = selectedUnloadedIds.has(id);
  }
}

function renderUnloadedTabs() {
  unloadedSummary.textContent = `Unloaded tabs (${unloadedTabs.length})`;
  unloadedList.replaceChildren();
  unloadedChecks = new Map();
  for (const tab of unloadedTabs) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'unloaded-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(tab.id);
    checkbox.setAttribute('aria-label', `Close ${tab.title}`);
    const text = document.createElement('span');
    text.className = 'tab-description';
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    title.title = tab.title;
    const url = document.createElement('span');
    url.className = 'tab-url';
    url.textContent = tab.url;
    url.title = tab.url;
    text.append(title, url);
    label.append(checkbox, text);
    row.append(label);
    unloadedList.append(row);
    unloadedChecks.set(tab.id, checkbox);
    checkbox.addEventListener('change', () => {
      if (unloadedBusy() || unloadedChecks.get(tab.id) !== checkbox) return;
      if (checkbox.checked) selectedUnloadedIds.add(tab.id);
      else selectedUnloadedIds.delete(tab.id);
      updateUnloadedControls();
    });
  }
  if (!unloadedTabs.length) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'No unloaded tabs.';
    unloadedList.append(empty);
  }
  updateUnloadedControls();
}

selectAllUnloaded.addEventListener('change', () => {
  if (unloadedBusy()) return;
  selectedUnloadedIds = new Set(selectAllUnloaded.checked ? unloadedTabs.map(tab => tab.id) : []);
  updateUnloadedControls();
});

async function refreshUnloadedTabs() {
  if (unloadedRefreshPromise) { unloadedRefreshAgain = true; return unloadedRefreshPromise; }
  unloadedLoading = true;
  updateUnloadedControls();
  unloadedRefreshPromise = (async () => {
    do {
      unloadedRefreshAgain = false;
      const response = await request({ type: 'unloadedTabsStatus' });
      if (!Array.isArray(response.tabs)) throw new Error('Could not load unloaded tabs. Reopen the popup.');
      unloadedTabs = response.tabs;
      const available = new Set(unloadedTabs.map(tab => tab.id));
      selectedUnloadedIds = new Set([...selectedUnloadedIds].filter(id => available.has(id)));
      renderUnloadedTabs();
    } while (unloadedRefreshAgain);
    return unloadedTabs.length;
  })();
  try { return await unloadedRefreshPromise; }
  catch (error) {
    unloadedTabs = [];
    selectedUnloadedIds.clear();
    renderUnloadedTabs();
    throw error;
  } finally {
    unloadedLoading = false;
    unloadedRefreshPromise = undefined;
    updateUnloadedControls();
  }
}

closeUnloaded.addEventListener('click', async () => {
  if (closeUnloaded.disabled || unloadedBusy() || selectedUnloadedIds.size === 0) return;
  const tabIds = [...selectedUnloadedIds];
  unloadedClosing = true;
  updateUnloadedControls();
  unloadedFeedback.textContent = 'Closing unloaded tabs…';
  let summary;
  try {
    const result = await request({ type: 'closeUnloadedTabs', tabIds });
    summary = `Closed ${result.closed} unloaded tab${result.closed === 1 ? '' : 's'}.`;
    if (result.skipped) summary += ` Skipped ${result.skipped} changed or unavailable tab${result.skipped === 1 ? '' : 's'}.`;
    if (result.failed) summary += ` Could not close ${result.failed} tab${result.failed === 1 ? '' : 's'}; try again.`;
  } catch (error) { summary = error.message; }
  unloadedFeedback.textContent = summary;
  try { await refreshUnloadedTabs(); }
  catch (error) { unloadedFeedback.textContent = `${summary} Could not refresh the count: ${error.message}`; }
  unloadedClosing = false;
  updateUnloadedControls();
  try { await refreshManagement(); }
  catch (error) { protectionFeedback.textContent = error.message; }
});

refreshUnloadedTabs().then(() => { unloadedFeedback.textContent = ''; })
  .catch(error => { unloadedFeedback.textContent = error.message; });

function unloadedTabsChanged() {
  if (unloadedClosing) return; // The close handler refreshes after the whole batch.
  refreshUnloadedTabs().catch(error => { unloadedFeedback.textContent = error.message; });
}
chrome.tabs?.onUpdated?.addListener((id, change) => {
  if (['discarded', 'pinned', 'url', 'title'].some(key => Object.hasOwn(change, key))) unloadedTabsChanged();
});
for (const event of ['onCreated', 'onRemoved', 'onActivated', 'onReplaced']) {
  chrome.tabs?.[event]?.addListener(unloadedTabsChanged);
}

function updateManagementButtons() {
  const busy = managementBusy || dataBusy || !!pendingConfirmation;
  protectTab.disabled = busy || !management?.currentTab;
  protectSite.disabled = busy || !management?.currentTab ||
    management.protectedHosts.includes(management.currentTab.hostname);
  restoreLast.disabled = busy || !management?.restoreTarget;
  for (const button of siteRemoveButtons) button.disabled = busy;
  updateDataButtons();
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
    (tab ? '' : 'Protection controls are unavailable for this page.');
  const safety = tab?.safety;
  const pageStates = [];
  if (safety?.inspected === true) {
    if (safety.edited) pageStates.push('Edited page protection is active.');
    if (safety.playingMedia) pageStates.push('Playing media is protected.');
    if (safety.hasEmbeddedFrame) pageStates.push('Embedded content is protected.');
    if (safety.capturing || safety.sharing) pageStates.push('Detected capture/sharing is protected.');
  } else pageStates.push('Page safety is unavailable. Refresh the page and reopen EcoGuard; uncertain pages stay protected.');
  document.getElementById('edit-state').textContent = pageStates.join(' ');
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
  if (button.disabled || managementBusy || dataBusy || pendingConfirmation) return;
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

refreshManagement().then(() => { protectionFeedback.textContent = ''; })
  .catch(error => { protectionFeedback.textContent = error.message; });

function updateDataButtons() {
  const blocked = !statusReady || dataBusy || writesInFlight > 0 || !!pendingConfirmation || managementBusy;
  for (const button of [exportHistory, clearHistory, resetLearning, resetLocal]) button.disabled = blocked;
  const safety = management?.currentTab?.safety;
  resetEdits.disabled = blocked || safety?.inspected !== true || safety.edited !== true;
}

function updateAllButtons() {
  const blocked = dataBusy || !!pendingConfirmation || !statusReady;
  idle.disabled = blocked;
  save.disabled = blocked;
  pause.disabled = blocked;
  updateUnloadedControls();
  updateManagementButtons();
}

function confirmReset(button, message, description, success, output = dataFeedback) {
  if (button.disabled || dataBusy || writesInFlight > 0 || pendingConfirmation) return;
  pendingConfirmation = { message: { ...message, confirmed: true }, success, output };
  document.getElementById('confirmation-text').textContent = description;
  try { confirmation.showModal(); }
  catch (error) { pendingConfirmation = null; output.textContent = error.message; }
  updateAllButtons();
}

async function dataAction(message, success, output = dataFeedback) {
  if (dataBusy) return;
  dataBusy = true;
  updateAllButtons();
  output.textContent = 'Working…';
  try {
    const result = await request(message);
    output.textContent = message.type === 'exportHistory'
      ? `History export started (${result.eventCount} events). Check Chrome's downloads for completion.` : success;
  } catch (error) { output.textContent = error.message; }
  // Refresh even after errors: a reset or browser action may have partly completed.
  for (const refresh of [refreshStatus, refreshManagement, refreshUnloadedTabs]) {
    try { await refresh(); }
    catch (error) { output.textContent += ` Could not refresh: ${error.message}`; }
  }
  dataBusy = false;
  updateAllButtons();
}

document.getElementById('confirm-reset').addEventListener('click', async () => {
  if (!pendingConfirmation || dataBusy) return;
  const action = pendingConfirmation;
  pendingConfirmation = null;
  confirmation.close();
  await dataAction(action.message, action.success, action.output);
});

function cancelReset() {
  pendingConfirmation = null;
  updateAllButtons();
}
document.getElementById('cancel-reset').addEventListener('click', () => { confirmation.close(); cancelReset(); });
confirmation.addEventListener('cancel', cancelReset);
confirmation.addEventListener('close', cancelReset);

exportHistory.addEventListener('click', () => {
  if (exportHistory.disabled || pendingConfirmation) return;
  return dataAction({ type: 'exportHistory' });
});
clearHistory.addEventListener('click', () => confirmReset(clearHistory, { type: 'clearHistory' },
  'Delete EcoGuard history on this device? Settings, protections, learned delays and available restore records stay unchanged. Export history first if you want a copy.',
  'History cleared. Other settings and protections were preserved.'));
resetLearning.addEventListener('click', () => confirmReset(resetLearning, { type: 'resetLearning' },
  'Clear all learned site delays? Your inactivity setting, protections and history stay unchanged. Future rapid restores can teach EcoGuard new delays.',
  'Learned delays reset. Other settings and history were preserved.'));
resetLocal.addEventListener('click', () => confirmReset(resetLocal, { type: 'resetLocalData' },
  'Reset all EcoGuard data? This clears history, learned delays, tab protections and restore records, restores the 30-minute threshold and default protected sites, and pauses automatic unloading. Existing tabs and page edit flags stay unchanged. Export history first if you want a copy.',
  'EcoGuard data reset to defaults. Automatic unloading is paused; resume when ready.'));
resetEdits.addEventListener('click', () => confirmReset(resetEdits,
  { type: 'resetPageEdits', tabId: management?.currentTab?.tabId, expectedUrl: management?.currentTab?.url },
  `Clear edit protection for ${management?.currentTab?.hostname}? Save your work first. This does not save or erase page content. Further edits protect the page again. The five-minute interaction grace and all other safety checks still apply.`,
  'Edit protection cleared. Interaction grace and all other protections still apply.', protectionFeedback));
