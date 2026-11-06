import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsService } from '../settings.js';

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    get: async () => structuredClone(data),
    set: async values => { Object.assign(data, structuredClone(values)); }
  };
}

test('saved preference survives service-worker recreation', async () => {
  const storage = memoryStorage();
  const firstWorker = createSettingsService(storage);
  await firstWorker.save(45);
  const restartedWorker = createSettingsService(storage);
  assert.equal((await restartedWorker.read()).idleMinutes, 45);
});

test('invalid input leaves existing persisted preference intact', async () => {
  const service = createSettingsService(memoryStorage());
  await service.save(60);
  for (const value of [0, 4, 1441, 30.5, NaN, Infinity, '30', null]) {
    await assert.rejects(service.save(value), /whole number/);
    assert.equal((await service.read()).idleMinutes, 60);
  }
});

test('corrupt stored preference recovers to a safe default', async () => {
  for (const settings of [null, 'broken', { idleMinutes: -1 }, { idleMinutes: 1441 }]) {
    assert.equal((await createSettingsService(memoryStorage({ settings })).read()).idleMinutes, 30);
  }
});

test('queued reads observe the most recent preceding save', async () => {
  const service = createSettingsService(memoryStorage());
  const first = service.save(10);
  const read = service.read();
  const second = service.save(90);
  assert.equal((await read).idleMinutes, 10);
  await Promise.all([first, second]);
  assert.equal((await service.read()).idleMinutes, 90);
});

test('storage failure is reported and does not poison later requests', async () => {
  const storage = memoryStorage();
  const set = storage.set; let fail = true;
  storage.set = async value => { if (fail) throw new Error('Storage unavailable'); await set(value); };
  const service = createSettingsService(storage);
  await assert.rejects(service.save(15), /Storage unavailable/);
  fail = false;
  await service.save(20);
  assert.equal((await service.read()).idleMinutes, 20);
});
