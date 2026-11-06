import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkExtension, extension, root } from './check-extension.mjs';

await checkExtension();
const destination = path.join(root, 'build', 'extension');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of await readdir(extension, { withFileTypes: true })) {
  if (file.isFile() && /\.(json|js|html|css)$/.test(file.name)) {
    await cp(path.join(extension, file.name), path.join(destination, file.name));
  }
}
console.log(`Load the unpacked extension from ${destination}`);
