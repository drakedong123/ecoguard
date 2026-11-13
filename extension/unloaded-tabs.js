function canClose(tab) {
  return Number.isInteger(tab?.id) && tab.id >= 0 && tab.discarded === true &&
    tab.active === false && tab.pinned === false && tab.incognito === false;
}

export function createUnloadedTabsService(tabs) {
  return {
    async list() {
      const unloaded = await tabs.query({ discarded: true });
      const unique = new Map();
      for (const tab of unloaded.filter(canClose)) {
        if (!unique.has(tab.id)) unique.set(tab.id, {
          id: tab.id,
          title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : 'Untitled tab',
          url: typeof tab.url === 'string' ? tab.url : ''
        });
      }
      return [...unique.values()];
    },
    async close(tabIds) {
      if (!Array.isArray(tabIds) || !tabIds.every(id => Number.isInteger(id) && id >= 0)) {
        throw new Error('Invalid unloaded-tab selection. Reopen the popup and try again.');
      }
      const result = { closed: 0, skipped: 0, failed: 0 };
      // Use only the selection displayed when the popup opened, never new arrivals.
      for (const id of new Set(tabIds)) {
        let tab;
        try { tab = await tabs.get(id); }
        catch { result.skipped++; continue; } // Already closed or no longer accessible.
        if (tab?.id !== id || !canClose(tab)) { result.skipped++; continue; }
        // Chrome has no atomic "remove only if still discarded" operation. Keep
        // this recheck adjacent to remove and do not await any other work between.
        try { await tabs.remove(id); result.closed++; }
        catch { result.failed++; }
      }
      return result;
    }
  };
}
