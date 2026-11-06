export const VERSION = '0.1.0';
export const DEFAULT_SETTINGS = Object.freeze({ schemaVersion: 1, idleMinutes: 30 });

export function normalizeSettings(value) {
  const minutes = value?.idleMinutes;
  return {
    schemaVersion: 1,
    idleMinutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440
      ? minutes : DEFAULT_SETTINGS.idleMinutes
  };
}

export function createSettingsService(storage) {
  let tail = Promise.resolve();
  const serial = fn => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  return {
    read: () => serial(async () => {
      const saved = await storage.get('settings');
      return normalizeSettings(saved.settings);
    }),
    save: idleMinutes => serial(async () => {
      if (!Number.isInteger(idleMinutes) || idleMinutes < 5 || idleMinutes > 1440) {
        throw new Error('Choose a whole number from 5 to 1440 minutes.');
      }
      const settings = normalizeSettings({ idleMinutes });
      await storage.set({ settings });
      return settings;
    })
  };
}
