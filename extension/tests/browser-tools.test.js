import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtures } from '../../scripts/browser/fixtures.mjs';
import { median, summarizeRuns, validateRun } from '../../scripts/browser/summary.mjs';

test('offline fixtures serve only fixed local resources and bound workload allocations', async () => {
  const fixtures = await startFixtures();
  try {
    const page = await fetch(fixtures.origin + '/workload');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /32 \* 1024 \* 1024/);
    assert.equal((await fetch(fixtures.origin + '/payload')).headers.get('content-type'), 'application/octet-stream');
    assert.equal((await fetch(fixtures.origin + '/tone.wav')).headers.get('content-type'), 'audio/wav');
    assert.equal((await fetch(fixtures.origin + '/../../package.json')).status, 404);
    assert.equal((await fetch(fixtures.origin + '/editable', { method: 'POST' })).status, 405);
    assert.ok(fixtures.bytesSent() >= 65536);
  } finally { await fixtures.close(); }
});

function run(pair, mode, metrics = {}) {
  return { schemaVersion: 1, pair, mode, kind: 'smoke', browser: 'Chrome/test', platform: 'test/test',
    startedAt: '2026-11-13T05:00:00.000Z',
    config: { pages: 4, durationSeconds: 20, warmupSeconds: 2 }, elapsedSeconds: 20, discardedTabs: 0,
    samples: [0, 20].map(elapsedSeconds => ({ elapsedSeconds, rssBytes: null, processes: [{ id: 1, type: 'browser', cpuTime: elapsedSeconds / (mode === 'treatment' ? 20 : 10) }] })),
    metrics: { cpuSeconds: mode === 'treatment' ? 1 : 2, rssMedianBytes: null, loopbackBytes: 100, batteryPercentagePoints: null, ...metrics } };
}
const pairs = () => [1, 2, 3].flatMap(pair => ['baseline', 'treatment'].map(mode => run(pair, mode)));

test('paired summary reports treatment-minus-baseline and preserves unavailable measurements', () => {
  const summary = summarizeRuns(pairs());
  assert.equal(summary.pairCount, 3);
  assert.equal(summary.medianDifference.cpuSeconds, -1);
  assert.equal(summary.medianDifference.rssMedianBytes, null);
  assert.equal(summary.medianDifference.batteryPercentagePoints, null);
  assert.equal(summary.availablePairs.cpuSeconds, 3);
  assert.equal(summary.availablePairs.rssMedianBytes, 0);
  assert.match(summary.limitations[0], /do not establish resource savings/);
  assert.equal(median([2, 4, null]), 3);
});

test('summary rejects mismatched metadata, incomplete/duplicate pairs and invalid metrics', () => {
  for (const mutate of [
    runs => { runs[1].browser = 'other'; },
    runs => { runs[1].platform = 'other'; },
    runs => { runs[1].config.durationSeconds = 30; runs[1].elapsedSeconds = 30; },
    runs => { runs[1].mode = 'baseline'; },
    runs => { runs[1].pair = 4; },
    runs => { runs[1].metrics.cpuSeconds = NaN; },
    runs => { runs[1].samples[1].elapsedSeconds = 0; },
    runs => { runs[1].metrics.batteryPercentagePoints = 0; },
    runs => { runs[1].kind = 'evaluation'; },
    runs => { runs[1].metrics.cpuSeconds = 3; },
    runs => { runs[1].samples[1].processes[0].cpuTime = -1; },
    runs => { runs[1].samples[1].processes.push({ ...runs[1].samples[1].processes[0] }); }
  ]) {
    const runs = pairs(); mutate(runs);
    assert.throws(() => summarizeRuns(runs));
  }
  assert.throws(() => summarizeRuns(pairs().slice(0, 4)));
  assert.throws(() => validateRun({}));
});
