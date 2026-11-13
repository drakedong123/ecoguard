import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchChrome, delay } from './chrome.mjs';
import { startFixtures } from './fixtures.mjs';
import { median, sampledCpuSeconds, summarizeRuns, validateRun } from './summary.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const options = process.argv.slice(2);
if (options.some(option => !['--smoke', '--idle'].includes(option))) throw new Error('Usage: npm run benchmark:browser -- [--smoke] [--idle]');
const smoke = options.includes('--smoke');
const config = { pages: options.includes('--idle') ? 0 : 4, warmupSeconds: smoke ? 2 : 120, durationSeconds: smoke ? 20 : 600 };
const output = path.join(root, 'build', `browser-${smoke ? 'smoke' : 'evaluation'}${config.pages === 0 ? '-idle' : ''}`);
await mkdir(output, { recursive: true });
const runs = [];

function rssBytes(processes) {
  try {
    const rows = execFileSync('ps', ['-o', 'rss=', '-p', processes.map(process => process.id).join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/).map(Number);
    return rows.length && rows.every(Number.isFinite) ? rows.reduce((a, b) => a + b, 0) * 1024 : null;
  } catch { return null; }
}

for (let pair = 1; pair <= 3; pair++) {
  for (const mode of pair % 2 ? ['baseline', 'treatment'] : ['treatment', 'baseline']) {
    const fixtures = await startFixtures();
    let browser;
    try {
      console.log(`Pair ${pair}/3 ${mode}: ${config.warmupSeconds}s warmup, ${config.durationSeconds}s observation.`);
      browser = await launchChrome();
      const version = await browser.version();
      let extensionId;
      if (mode === 'treatment') {
        const { id } = await browser.send('Extensions.loadUnpacked', { path: path.join(root, 'build/extension') });
        extensionId = id;
        const control = await browser.page(fixtures.origin, { background: false });
        const popup = await browser.popup(id, control);
        const response = await popup.evaluate('chrome.runtime.sendMessage({type:"saveSettings",idleMinutes:5})');
        if (!response?.ok) throw new Error(response?.error ?? 'Could not configure extension.');
        await popup.close();
        await control.detach();
      } else {
        const control = await browser.page(fixtures.origin, { background: false });
        await control.detach();
      }
      for (let index = 0; index < config.pages; index++) {
        const page = await browser.page(`${fixtures.origin}/workload?tab=${index}`);
        await page.detach();
      }
      await delay(config.warmupSeconds * 1000);
      const samples = [];
      const started = performance.now();
      const bytesBefore = fixtures.bytesSent();
      async function sample() {
        const { processInfo: processes } = await browser.send('SystemInfo.getProcessInfo');
        samples.push({ elapsedSeconds: (performance.now() - started) / 1000, processes, rssBytes: rssBytes(processes) });
      }
      await sample();
      while (performance.now() - started < config.durationSeconds * 1000) {
        await delay(Math.min(5000, Math.max(1, config.durationSeconds * 1000 - (performance.now() - started))));
        await sample();
      }
      const cpuSeconds = sampledCpuSeconds(samples);
      const bytesAfter = fixtures.bytesSent();
      // Open the measurement reader only after the last resource sample, so
      // treatment does not carry an extra instrumentation tab during the run.
      const reader = extensionId ? await browser.page(`chrome-extension://${extensionId}/popup.html`) : null;
      const discardedTabs = reader ? await reader.evaluate(`chrome.tabs.query({discarded:true}).then(t=>t.filter(t=>t.url.startsWith(${JSON.stringify(fixtures.origin + '/workload')})).length)`) : 0;
      const run = validateRun({ schemaVersion: 1, pair, mode, kind: smoke ? 'smoke' : 'evaluation',
        browser: version.product, platform: `${process.platform}/${process.arch}`, config,
        startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
        elapsedSeconds: samples.at(-1).elapsedSeconds, samples, discardedTabs,
        metrics: { cpuSeconds, rssMedianBytes: median(samples.map(sample => sample.rssBytes)),
          loopbackBytes: bytesAfter - bytesBefore, batteryPercentagePoints: null } });
      runs.push(run);
      // Preserve every completed raw run even if a later run fails.
      await writeFile(path.join(output, 'runs.json'), JSON.stringify(runs, null, 2) + '\n');
    } finally {
      if (browser) await browser.close();
      await fixtures.close();
    }
  }
}
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summarizeRuns(runs), null, 2) + '\n');
console.log(`Raw observations and paired summary: ${output}`);
