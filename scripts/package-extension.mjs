import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './check-extension.mjs';

const source = path.join(root, 'build', 'extension');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error('Invalid release version.');
const filename = `EcoGuard-extension-${manifest.version}.zip`;
const archive = path.join(root, 'build', filename);
// Fixed timestamps, ordering and modes make identical source produce identical ZIPs.
const result = spawnSync('python3', ['-c', `
from pathlib import Path
import sys, zipfile
source, target = map(Path, sys.argv[1:])
files = sorted(p for p in source.iterdir() if p.is_file())
assert any(p.name == 'manifest.json' for p in files)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        assert file.suffix in {'.js', '.json', '.html', '.css'}
        entry = zipfile.ZipInfo(file.name, (2020, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, file.read_bytes())
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert 'manifest.json' in archive.namelist()
    assert all('/' not in name for name in archive.namelist())
`, source, archive], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'Could not package extension. Python 3 is required.');
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive + '.sha256', `${hash}  ${filename}\n`);
console.log(`Packaged ${archive}\nSHA-256: ${hash}`);
