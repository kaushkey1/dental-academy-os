import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const target = resolve('public/pdfjs');
await mkdir(target, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm'])
  await cp(resolve('node_modules/pdfjs-dist', directory), resolve(target, directory), {
    recursive: true,
  });
