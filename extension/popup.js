const form = document.getElementById('settings');
const idle = document.getElementById('idle');
const save = document.getElementById('save');
const feedback = document.getElementById('feedback');

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'EcoGuard did not respond. Reload the extension.');
  idle.value = response.settings.idleMinutes;
  document.getElementById('version').textContent = response.version;
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

request({ type: 'status' }).then(() => {
  idle.disabled = false; save.disabled = false;
  feedback.textContent = 'Ready. Automatic cleanup is not enabled in this build.';
}).catch(error => { feedback.textContent = error.message; });
