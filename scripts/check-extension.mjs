import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const extension = path.join(root, 'extension');

export async function checkExtension() {
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.permissions, ['storage'], 'Worker permissions belong to chunk 05');
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['http://*/*', 'https://*/*'], js: ['page-safety.js'],
    run_at: 'document_start', all_frames: false, world: 'ISOLATED'
  }], 'Safety observation must begin in the isolated top-level document at load');
  for (const file of [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(script => script.js)]) {
    const full = path.resolve(extension, file);
    assert.ok(full.startsWith(extension + path.sep), 'Manifest path must remain inside extension');
    assert.ok((await stat(full)).isFile(), `Missing manifest asset: ${file}`);
  }
  const popup = await readFile(path.join(extension, manifest.action.default_popup), 'utf8');
  for (const match of popup.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const full = path.resolve(extension, match[1]);
    assert.ok(full.startsWith(extension + path.sep), 'Popup assets must be local');
    assert.ok((await stat(full)).isFile(), `Missing popup asset: ${match[1]}`);
  }
  for (const file of await readdir(extension)) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(extension, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  console.log('Extension manifest, local assets and JavaScript syntax verified.');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkExtension();
}
