import { readFile, writeFile } from 'node:fs/promises';

import { compile } from 'json-schema-to-typescript';

const schemaUrl = new URL('../src/security-event/security-event.schema.json', import.meta.url);
const outputUrl = new URL('../src/security-event/generated.ts', import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const output = await compile(schema, schema.title, {
  bannerComment:
    '/* Este archivo se genera desde security-event.schema.json. No editar manualmente. */',
  enableConstEnums: false,
  unknownAny: false,
  maxItems: 0,
  style: { singleQuote: true, semi: true, trailingComma: 'all', printWidth: 100 },
});

await writeFile(outputUrl, output, 'utf8');
