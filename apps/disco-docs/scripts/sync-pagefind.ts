import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('out/_pagefind');
const destination = resolve('public/_pagefind');

await rm(destination, { force: true, recursive: true });
await mkdir(resolve('public'), { recursive: true });
await cp(source, destination, { recursive: true });
