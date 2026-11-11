// Declarative, isolated-world content script. Keep state in this document's
// closure, never in the page, storage, or a long-lived worker connection.
(() => {
  if (window.top !== window) return;

  let edited = false;
  let hidden = false;
  let lastInteractionAt = Date.now();
  // Late injection cannot establish whether edits occurred before observation.
  let observationFailed = document.readyState !== 'loading' ||
    !Number.isFinite(lastInteractionAt) || lastInteractionAt < 0;

  function recordInteraction() {
    const at = Date.now();
    if (!Number.isFinite(at) || at < lastInteractionAt) observationFailed = true;
    else lastInteractionAt = at;
  }

  for (const type of ['beforeinput', 'input', 'change', 'compositionstart']) {
    document.addEventListener(type, () => {
      // Synthetic edits also protect. Never inspect the target, value, or text.
      edited = true;
      recordInteraction();
    }, { capture: true, passive: true });
  }
  for (const type of ['keydown', 'pointerdown', 'touchstart', 'wheel', 'scroll']) {
    document.addEventListener(type, event => {
      if (event.isTrusted) recordInteraction();
    }, { capture: true, passive: true });
  }
  window.addEventListener('pagehide', () => { hidden = true; });
  window.addEventListener('pageshow', () => {
    hidden = false;
    recordInteraction(); // BFCache restores get fresh grace, retaining edits.
  });

  function inspect() {
    try {
      const checkedAt = Date.now();
      const url = location.href;
      if (observationFailed || hidden || document.readyState !== 'complete' ||
          !document.documentElement || !/^https?:\/\//.test(url) ||
          !Number.isFinite(checkedAt) || checkedAt < lastInteractionAt) {
        return { inspected: false, reason: 'uninspectable-page' };
      }
      let playingMedia = false;
      let hasEmbeddedFrame = false;
      let capturing = false;
      let sharing = false;
      const roots = [document];
      let nodeCount = 0;
      let rootCount = 0;
      // Traverse open shadow trees too, with a bound on inspection work. Closed
      // trees and unattached capture streams remain documented blind spots.
      while (roots.length) {
        if (++rootCount > 100) throw new Error('Inspection limit');
        for (const node of roots.pop().querySelectorAll('*')) {
          if (++nodeCount > 20_000) throw new Error('Inspection limit');
          if (node.shadowRoot) roots.push(node.shadowRoot);
          if (['iframe', 'frame', 'object', 'embed'].includes(node.localName)) {
            hasEmbeddedFrame = true; // Do not enter or read embedded documents.
          }
          if (node.localName !== 'audio' && node.localName !== 'video') continue;
          if (typeof node.paused !== 'boolean' || typeof node.ended !== 'boolean') {
            throw new Error('Unknown media state');
          }
          if (!node.paused && !node.ended) playingMedia = true;
          // Any attached stream/provider protects, even paused or muted. This
          // conservatively covers observable capture without reading track data.
          if (node.srcObject !== null) {
            capturing = true;
            sharing = true;
          }
        }
      }
      return {
        inspected: true, url, checkedAt, lastInteractionAt, edited,
        playingMedia, hasEmbeddedFrame, capturing, sharing
      };
    } catch {
      return { inspected: false, reason: 'inspection-failed' };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab ||
        !['inspectPageSafety', 'resetPageEdits'].includes(message?.type)) return false;
    if (message.expectedUrl !== location.href) {
      reply({ inspected: false, reason: 'navigation-mismatch' });
      return false;
    }
    if (message.type === 'resetPageEdits') {
      if (message.confirmed !== true) {
        reply({ inspected: false, reason: 'reset-not-confirmed' });
        return false;
      }
      const before = inspect();
      if (!before.inspected) { reply(before); return false; }
      edited = false;
      recordInteraction(); // Reset never bypasses the interaction grace period.
      reply({ ...inspect(), reset: true });
    } else reply(inspect());
    return false; // All responses are synchronous; no keepalive or polling.
  });
})();
