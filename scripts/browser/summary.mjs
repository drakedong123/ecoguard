import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const median = values => {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableMetric = value => value === null || finite(value);

export function sampledCpuSeconds(samples) {
  let total = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = new Map(samples[index - 1].processes.map(process => [process.id, process.cpuTime]));
    for (const process of samples[index].processes) {
      const delta = process.cpuTime - (previous.get(process.id) ?? 0);
      if (delta < 0) throw new Error('Browser process CPU counter moved backwards.');
      total += delta;
    }
  }
  return total;
}

export function validateRun(run) {
  if (run?.schemaVersion !== 1 || !['baseline', 'treatment'].includes(run.mode) ||
      !['smoke', 'evaluation'].includes(run.kind) || !Number.isInteger(run.pair) || run.pair < 1 ||
      typeof run.browser !== 'string' || !run.browser || typeof run.platform !== 'string' || !run.platform ||
      !Number.isInteger(run.config?.pages) || run.config.pages < 0 || run.config.pages > 20 ||
      !finite(run.config.durationSeconds) || run.config.durationSeconds < 1 || !finite(run.config.warmupSeconds) ||
      !finite(Date.parse(run.startedAt)) ||
      !finite(run.elapsedSeconds) || Math.abs(run.elapsedSeconds - run.config.durationSeconds) > Math.max(2, run.config.durationSeconds * 0.05) ||
      !Array.isArray(run.samples) || run.samples.length < 2 ||
      !finite(run.metrics?.cpuSeconds) || !nullableMetric(run.metrics.rssMedianBytes) ||
      !nullableMetric(run.metrics.loopbackBytes) || run.metrics.batteryPercentagePoints !== null ||
      !Number.isInteger(run.discardedTabs) || run.discardedTabs < 0 || run.discardedTabs > run.config.pages) {
    throw new Error('Invalid or incomplete browser benchmark run.');
  }
  if (run.kind === 'evaluation' && (run.config.durationSeconds < 600 || run.config.warmupSeconds < 120)) {
    throw new Error('Evaluation requires at least 120 seconds of warmup and 600 seconds of observation.');
  }
  let previous = -1;
  for (const sample of run.samples) {
    if (!finite(sample.elapsedSeconds) || sample.elapsedSeconds <= previous ||
        !nullableMetric(sample.rssBytes) || !Array.isArray(sample.processes) || !sample.processes.length ||
        new Set(sample.processes.map(process => process?.id)).size !== sample.processes.length ||
        sample.processes.some(process => !Number.isInteger(process?.id) || process.id < 0 ||
          !finite(process.cpuTime) || typeof process.type !== 'string')) {
      throw new Error('Invalid or nonmonotonic raw browser sample.');
    }
    previous = sample.elapsedSeconds;
  }
  if (Math.abs(previous - run.elapsedSeconds) > 0.01 ||
      Math.abs(sampledCpuSeconds(run.samples) - run.metrics.cpuSeconds) > 1e-6 ||
      median(run.samples.map(sample => sample.rssBytes)) !== run.metrics.rssMedianBytes) {
    throw new Error('Reported metrics do not match the raw samples.');
  }
  return run;
}

export function summarizeRuns(runs) {
  if (!Array.isArray(runs) || runs.length < 6) throw new Error('At least three complete baseline/treatment pairs are required.');
  const pairs = new Map();
  const reference = validateRun(runs[0]);
  for (const raw of runs) {
    const run = validateRun(raw);
    if (run.browser !== reference.browser || run.platform !== reference.platform || run.kind !== reference.kind ||
        ['pages', 'durationSeconds', 'warmupSeconds'].some(key => run.config[key] !== reference.config[key])) {
      throw new Error('Incompatible browser, platform, workload or duration metadata.');
    }
    const pair = pairs.get(run.pair) ?? {};
    if (pair[run.mode]) throw new Error('Duplicate mode within a benchmark pair.');
    pair[run.mode] = run;
    pairs.set(run.pair, pair);
  }
  const deltas = [...pairs].sort(([a], [b]) => a - b).map(([pair, { baseline, treatment }]) => {
    if (!baseline || !treatment) throw new Error('Incomplete baseline/treatment pair.');
    const difference = key => baseline.metrics[key] === null || treatment.metrics[key] === null
      ? null : treatment.metrics[key] - baseline.metrics[key];
    return { pair, cpuSeconds: difference('cpuSeconds'), rssMedianBytes: difference('rssMedianBytes'),
      loopbackBytes: difference('loopbackBytes'), batteryPercentagePoints: null,
      baselineDiscardedTabs: baseline.discardedTabs, treatmentDiscardedTabs: treatment.discardedTabs };
  });
  return {
    schemaVersion: 1, kind: reference.kind, browser: reference.browser, platform: reference.platform,
    config: reference.config, pairCount: deltas.length, direction: 'treatment minus baseline', pairs: deltas,
    availablePairs: Object.fromEntries(['cpuSeconds', 'rssMedianBytes', 'loopbackBytes', 'batteryPercentagePoints']
      .map(key => [key, deltas.filter(pair => pair[key] !== null).length])),
    medianDifference: Object.fromEntries(['cpuSeconds', 'rssMedianBytes', 'loopbackBytes', 'batteryPercentagePoints']
      .map(key => [key, median(deltas.map(pair => pair[key]))])),
    limitations: [
      ...(reference.kind === 'smoke' ? ['Short smoke runs verify collection only; they do not establish resource savings or idle unload behavior.'] : []),
      'CPU covers sampled Chrome processes, including browser helpers, and can miss the final CPU interval of a process that exits.',
      'RSS sums process resident sets and can double-count shared pages; it is not physical memory freed.',
      'Network bytes are fixture-server loopback response bodies, not physical-interface traffic or per-tab attribution.',
      'Battery discharge is unavailable; no energy or battery-life benefit is inferred.',
      'Browser-total differences do not isolate extension-only CPU/RSS overhead.'
    ]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('Usage: node scripts/browser/summary.mjs runs.json [summary.json]');
  const summary = summarizeRuns(JSON.parse(await readFile(input, 'utf8')));
  if (output) await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
