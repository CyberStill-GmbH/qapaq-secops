#!/usr/bin/env node
/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Verifica los activos migrados desde main (4095bd501753989b0a9e9f76eb39f69a538e5d71)
 * al overlay Wazuh. Los binarios ahora viven aquí;
 * el build del Dashboard no depende de apps/web ni copia arte desde una aplicación retirada.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '../assets/images');
const expected = new Map([
  ['qapaq_analyst.webp', 'f38743089c0f651c53454123857628ae514e16384e3302348cd96a36640a0972'],
  ['qapaq_q_mask.png', '3fed68c9f386bd98f04ef033dee56a9ca619c76beda55e3e7528e6af6b616ded'],
]);

for (const [filename, expectedSha256] of expected) {
  const actualSha256 = createHash('sha256')
    .update(readFileSync(join(assets, filename)))
    .digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error(`QAPAQ_LOGIN_ART_MISMATCH:${filename}`);
}

process.stdout.write('QAPAQ login artwork verified against the assets adopted from main.\n');
