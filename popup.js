function setStatus(text) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, 1200);
  }
}

function getSelectedMode() {
  const checked = document.querySelector('input[name="volumeMode"]:checked');
  return checked?.value || 'global';
}

function applySettings(settings) {
  const mode = settings?.volumeMode === 'per-platform' ? 'per-platform' : 'global';
  const debug = !!settings?.debugOwner;
  const modeInput = document.querySelector(`input[name="volumeMode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  const debugInput = document.getElementById('debugOwner');
  if (debugInput) debugInput.checked = debug;
}

function saveSettings() {
  const settings = {
    volumeMode: getSelectedMode(),
    debugOwner: !!document.getElementById('debugOwner')?.checked
  };
  chrome.runtime.sendMessage({ type: 'SETTINGS_SET', settings }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      setStatus('Failed to save');
      return;
    }
    setStatus('Saved');
  });
}

chrome.runtime.sendMessage({ type: 'SETTINGS_GET' }, (res) => {
  applySettings(res?.settings || {});
});

document.querySelectorAll('input[name="volumeMode"]').forEach((el) => {
  el.addEventListener('change', saveSettings);
});
document.getElementById('debugOwner')?.addEventListener('change', saveSettings);
