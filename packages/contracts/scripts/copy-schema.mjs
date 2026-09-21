import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../src/security-event/security-event.schema.json', import.meta.url);
const destinationDirectory = new URL('../dist/security-event/', import.meta.url);
const destination = new URL('security-event.schema.json', destinationDirectory);

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
