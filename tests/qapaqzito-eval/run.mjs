#!/usr/bin/env node
/**
 * Evaluación de Qapaqzito contra una API desplegada.
 *
 *   QAPAQ_EVAL_BASE=https://dev.security.qapaq.pe \
 *   QAPAQ_EVAL_USER=lider@qapaq.pe QAPAQ_EVAL_PASSWORD=... \
 *   node tests/qapaqzito-eval/run.mjs --label before [--out <dir>] [--only id1,id2]
 *
 * Inicia sesión con usuario y contraseña (formulario /qapaq/login), toma una alerta real para las
 * preguntas que la necesitan, envía cada pregunta en una conversación nueva y puntúa la respuesta
 * con las comprobaciones de `questions.mjs`. Escribe `<out>/<label>.json` con las respuestas
 * completas (contienen datos del SOC: no se versionan) e imprime la tabla de puntuaciones.
 *
 * Respeta el límite de tasa: ante 429 espera y reintenta. Nunca uses la cuenta admin.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKS, QUESTIONS } from './questions.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const BASE = (process.env.QAPAQ_EVAL_BASE ?? 'https://dev.security.qapaq.pe').replace(/\/$/u, '');
const USER = process.env.QAPAQ_EVAL_USER;
const PASSWORD = process.env.QAPAQ_EVAL_PASSWORD;
const LABEL = flag('label', 'run');
const OUT = flag('out', 'output/qapaqzito-eval');
const ONLY = flag('only', '')?.split(',').filter(Boolean) ?? [];
const TIMEOUT_MS = Number(flag('timeout', '90000'));

if (!USER || !PASSWORD) {
  console.error('Faltan QAPAQ_EVAL_USER y QAPAQ_EVAL_PASSWORD.');
  process.exit(2);
}
if (/^admin@/iu.test(USER)) {
  console.error('No evalúes con la cuenta admin: usa una cuenta de rol (p. ej. lider@).');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  const page = await fetch(`${BASE}/qapaq/login`, { headers: { accept: 'text/html' } });
  const html = await page.text();
  const formTag = html.match(/<form[^>]*id="qapaq-password-form"[^>]*>/u)?.[0];
  if (!formTag) throw new Error('No encontré el formulario de contraseña en /qapaq/login');
  const action = formTag.match(/action="([^"]*)"/u)?.[1] ?? '/api/auth/password';
  const formBody = html.slice(html.indexOf(formTag)).split('</form>')[0];
  const params = new URLSearchParams();
  for (const [input] of formBody.matchAll(/<input[^>]*>/gu)) {
    const name = input.match(/name="([^"]*)"/u)?.[1];
    if (!name) continue;
    const type = input.match(/type="([^"]*)"/u)?.[1] ?? 'text';
    if (name === 'username') params.set(name, USER);
    else if (type === 'password') params.set(name, PASSWORD);
    else params.set(name, (input.match(/value="([^"]*)"/u)?.[1] ?? '').replace(/&amp;/gu, '&'));
  }
  const response = await fetch(new URL(action, BASE), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      origin: BASE,
      referer: `${BASE}/qapaq/login`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    body: params.toString(),
  });
  const session = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .find((cookie) => cookie.startsWith('qapaq_session='));
  if (!session) throw new Error(`Login falló (${response.status})`);
  const info = await fetch(`${BASE}/api/auth/session`, {
    headers: { cookie: session, accept: 'application/json' },
  }).then((r) => r.json());
  if (!info?.csrfToken) throw new Error('Sesión sin token CSRF');
  return { cookie: session, csrf: info.csrfToken, roles: info.roles ?? info.session?.roles };
}

async function getJson(auth, path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie: auth.cookie, accept: 'application/json' },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ask(auth, message) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const started = Date.now();
    let response;
    try {
      response = await fetch(`${BASE}/api/assistant/chat`, {
        method: 'POST',
        headers: {
          cookie: auth.cookie,
          accept: 'application/json',
          'content-type': 'application/json',
          origin: BASE,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': auth.csrf,
        },
        body: JSON.stringify({ message, page: '/app/qapaq-alerts' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { status: 0, ms: Date.now() - started, body: null, error: String(error) };
    }
    const ms = Date.now() - started;
    const body = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      // Sesión única por cuenta: otro inicio de sesión con la misma cuenta expulsa esta.
      console.error(`  ${response.status}: sesión expirada; vuelvo a iniciar sesión…`);
      Object.assign(auth, await login());
      continue;
    }
    if (response.status === 429) {
      console.error('  429: límite de tasa; espero 120 s…');
      await sleep(120_000);
      continue;
    }
    return { status: response.status, ms, body };
  }
  return { status: 429, ms: 0, body: null };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** UUID mencionados en la respuesta que no existen como alerta ni incidente visibles. */
async function unknownIdsIn(auth, reply, body) {
  const cited = new Set((body?.citations ?? []).map((citation) => citation.id));
  const unknown = [];
  for (const id of new Set(reply.match(UUID) ?? [])) {
    if (cited.has(id)) continue;
    const alert = await getJson(auth, `/api/alerts/${id}`);
    if (alert.status === 200) continue;
    const incident = await getJson(auth, `/api/incidents/${id}`);
    if (incident.status !== 200) unknown.push(id);
  }
  return unknown;
}

async function main() {
  const auth = await login();
  const config = await getJson(auth, '/api/assistant/config');
  if (!config.body?.enabled) throw new Error(`Qapaqzito no está habilitado: ${JSON.stringify(config.body)}`);

  const alerts = await getJson(auth, '/api/alerts?status=open&pageSize=25');
  const items = alerts.body?.items ?? [];
  const alert = items.find((item) => item.priority === 'P1') ?? items[0];
  const alertId = alert?.id;

  const results = [];
  for (const question of QUESTIONS) {
    if (ONLY.length > 0 && !ONLY.includes(question.id)) continue;
    if (question.needs === 'alert' && !alertId) {
      results.push({ id: question.id, skipped: 'sin alertas abiertas' });
      continue;
    }
    const prompt = question.prompt.replaceAll('{ALERT_ID}', alertId ?? '');
    process.stderr.write(`· ${question.id}… `);
    const answer = await ask(auth, prompt);
    const reply = typeof answer.body?.reply === 'string' ? answer.body.reply : '';
    const unknownIds = await unknownIdsIn(auth, reply, answer.body);
    const ctx = { reply, body: answer.body, question, unknownIds };
    const checks = Object.fromEntries(
      question.checks.map((name) => [name, answer.status === 200 && Boolean(CHECKS[name](ctx))]),
    );
    const passed = Object.values(checks).filter(Boolean).length;
    process.stderr.write(`${answer.status} ${answer.ms} ms ${passed}/${question.checks.length}\n`);
    results.push({
      id: question.id,
      prompt,
      status: answer.status,
      ms: answer.ms,
      outcome: answer.body?.outcome ?? null,
      checks,
      passed,
      total: question.checks.length,
      reply,
      ...(unknownIds.length ? { unknownIds } : {}),
      steps: answer.body?.steps ?? [],
      citations: answer.body?.citations ?? [],
      usage: answer.body?.usage ?? null,
      messageId: answer.body?.messageId ?? null,
      responseKeys: answer.body ? Object.keys(answer.body) : [],
      ...(answer.error ? { error: answer.error } : {}),
    });
  }

  const scored = results.filter((result) => !result.skipped);
  const passed = scored.reduce((sum, result) => sum + result.passed, 0);
  const total = scored.reduce((sum, result) => sum + result.total, 0);
  const byCheck = {};
  for (const result of scored) {
    for (const [name, ok] of Object.entries(result.checks)) {
      byCheck[name] ??= { passed: 0, total: 0 };
      byCheck[name].total += 1;
      if (ok) byCheck[name].passed += 1;
    }
  }
  const summary = {
    label: LABEL,
    base: BASE,
    at: new Date().toISOString(),
    alertId: alertId ?? null,
    score: total ? Number(((passed / total) * 100).toFixed(1)) : 0,
    passed,
    total,
    perfectQuestions: scored.filter((r) => r.passed === r.total).length,
    questions: scored.length,
    medianMs: scored.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(scored.length / 2)] ?? 0,
    byCheck,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ summary, results }, null, 2));

  console.log(`\nQapaqzito eval «${LABEL}» — ${summary.score}% (${passed}/${total} comprobaciones, ${summary.perfectQuestions}/${summary.questions} preguntas perfectas, mediana ${summary.medianMs} ms)`);
  for (const result of results) {
    if (result.skipped) {
      console.log(`  ${result.id.padEnd(22)} omitida (${result.skipped})`);
      continue;
    }
    const failed = Object.entries(result.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    console.log(
      `  ${result.id.padEnd(22)} ${String(result.passed).padStart(2)}/${result.total} ${String(result.ms).padStart(6)} ms ${failed.length ? `✗ ${failed.join(', ')}` : '✓'}`,
    );
  }
  console.log('\nPor comprobación:');
  for (const [name, { passed: ok, total: n }] of Object.entries(byCheck)) {
    console.log(`  ${name.padEnd(20)} ${ok}/${n}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
