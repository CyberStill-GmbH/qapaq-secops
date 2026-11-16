#!/usr/bin/env node
// QAPAQ SecOps · receptor SNS → JSONL para Wazuh (monitoreo de la cuenta AWS sin IAM).
//
// EventBridge (bus default) → SNS (política del tema, sin rol) → HTTPS → edge nginx → este servicio.
// Cada evento queda como UNA línea JSON en el volumen de logs del manager
// (/var/ossec/logs/qapaq-collectors/aws/aws-events.jsonl), declarado como <localfile log_format="json">.
//
// Controles:
//   - Solo POST /hooks/aws-sns; cuerpo acotado; límite de tasa (token bucket) → 503 (SNS reintenta).
//   - TopicArn en la lista permitida (QAPAQ_AWS_SNS_TOPIC_ARNS) y coincide con la cabecera.
//   - Firma SNS verificada: SignatureVersion 2 (SHA256withRSA); certificado descargado por HTTPS
//     solo desde https://sns.<región-del-tema>.amazonaws.com/*.pem, vigente y con SAN DNS de ese host.
//   - SubscriptionConfirmation: confirma (GET SubscribeURL) solo si la firma es válida, el tema es
//     esperado y la URL es https://sns.<región>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=<el mismo>.
//   - Dedupe por MessageId (memoria, LRU) y antigüedad máxima del Timestamp.
//   - Sin secretos: no hay credenciales; nunca se registra el contenido de los mensajes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOOK_PATH = '/hooks/aws-sns';
const MESSAGE_TYPES = new Set(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']);
const TOPIC_ARN_RE = /^arn:aws:sns:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;
const MAX_LINE_BYTES = 60000; // OS_MAXSTR de Wazuh es 65536: margen para la etiqueta y el prefijo.

export function log(level, msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })}\n`);
}

// ------------------------------------------------------------------ validación SNS

export function topicRegion(topicArn) {
  const m = TOPIC_ARN_RE.exec(topicArn ?? '');
  return m ? m[1] : null;
}

export function expectedSnsHost(topicArn) {
  const region = topicRegion(topicArn);
  return region ? `sns.${region}.amazonaws.com` : null;
}

export function checkSigningCertUrl(raw, topicArn) {
  const host = expectedSnsHost(topicArn);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    host !== null &&
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.endsWith('.pem')
  );
}

export function checkSubscribeUrl(raw, topicArn) {
  const host = expectedSnsHost(topicArn);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    host !== null &&
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.port === '' &&
    url.username === '' &&
    url.searchParams.get('Action') === 'ConfirmSubscription' &&
    url.searchParams.get('TopicArn') === topicArn &&
    Boolean(url.searchParams.get('Token'))
  );
}

export function stringToSign(msg) {
  const keys =
    msg.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let out = '';
  for (const key of keys) {
    if (key === 'Subject' && (msg.Subject === undefined || msg.Subject === null)) continue;
    if (typeof msg[key] !== 'string') throw new Error(`campo ${key} ausente`);
    out += `${key}\n${msg[key]}\n`;
  }
  return out;
}

export function verifySignature(msg, publicKey) {
  if (msg.SignatureVersion !== '2') return false;
  if (typeof msg.Signature !== 'string') return false;
  let data;
  try {
    data = stringToSign(msg);
  } catch {
    return false;
  }
  return crypto.verify('sha256', Buffer.from(data, 'utf8'), publicKey, Buffer.from(msg.Signature, 'base64'));
}

// Descarga y valida el certificado de firma (cacheado por URL).
export function makeCertLoader({ fetchImpl = fetch, now = () => Date.now(), max = 32 } = {}) {
  const cache = new Map();
  return async function loadCert(url, host) {
    const hit = cache.get(url);
    if (hit && hit.validTo > now()) return hit.publicKey;
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`certificado HTTP ${res.status}`);
    const pem = await res.text();
    if (pem.length > 16384 || !pem.includes('BEGIN CERTIFICATE')) throw new Error('certificado inválido');
    const cert = new crypto.X509Certificate(pem);
    const validFrom = Date.parse(cert.validFrom);
    const validTo = Date.parse(cert.validTo);
    if (!(validFrom <= now() && now() <= validTo)) throw new Error('certificado fuera de vigencia');
    // SNS firma con certificados cuyo SAN es el host regional o el global (p. ej. DNS:sns.amazonaws.com).
    const sans = (cert.subjectAltName ?? '').split(',').map((s) => s.trim());
    if (!sans.includes(`DNS:${host}`) && !sans.includes('DNS:sns.amazonaws.com')) {
      throw new Error(`SAN del certificado no corresponde a SNS (${sans.join(' ').slice(0, 200)})`);
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value);
    cache.set(url, { publicKey: cert.publicKey, validTo });
    return cert.publicKey;
  };
}

// ------------------------------------------------------------------ normalización

const trunc = (value, max) => {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…[truncado ${s.length - max}]` : s;
};

const compact = (obj) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') delete obj[k];
    else if (typeof v === 'object' && !Array.isArray(v)) {
      compact(v);
      if (Object.keys(v).length === 0) delete obj[k];
    }
  }
  return obj;
};

const API_TYPES = new Set(['AWS API Call via CloudTrail']);
const SIGNIN_TYPES = new Set(['AWS Console Sign In via CloudTrail', 'AWS Console Signin via CloudTrail']);
const OPEN_WORLD_RE = /0\.0\.0\.0\/0|::\/0/;

export function guardDutyLabel(sev) {
  const n = Number(sev);
  if (!Number.isFinite(n)) return 'UNKNOWN';
  if (n >= 9) return 'CRITICAL';
  if (n >= 7) return 'HIGH';
  if (n >= 4) return 'MEDIUM';
  return 'LOW';
}

function principalOf(ui = {}) {
  if (ui.type === 'Root') return 'root';
  if (ui.userName) return ui.userName;
  const issuer = ui.sessionContext?.sessionIssuer?.userName;
  const session = typeof ui.arn === 'string' ? ui.arn.split('/').at(-1) : undefined;
  if (issuer && session) return `${issuer}/${session}`;
  return ui.principalId ?? ui.invokedBy ?? ui.type;
}

function cloudTrailFields(d) {
  const ui = d.userIdentity ?? {};
  const rp = d.requestParameters;
  return {
    event_name: d.eventName,
    event_source: d.eventSource,
    event_type: d.eventType,
    event_category: d.eventCategory,
    read_only: d.readOnly === undefined ? undefined : String(d.readOnly),
    user_type: ui.type,
    principal: principalOf(ui),
    principal_arn: ui.arn,
    principal_account: ui.accountId,
    access_key_id: ui.accessKeyId,
    invoked_by: ui.invokedBy,
    session_mfa: ui.sessionContext?.attributes?.mfaAuthenticated,
    source_ip: d.sourceIPAddress,
    user_agent: trunc(d.userAgent, 256),
    error_code: d.errorCode,
    error_message: trunc(d.errorMessage, 512),
    console_login: d.responseElements?.ConsoleLogin,
    mfa_used: d.additionalEventData?.MFAUsed,
    recipient_account: d.recipientAccountId,
    open_to_world: rp && OPEN_WORLD_RE.test(JSON.stringify(rp)) ? 'true' : undefined,
    request_parameters: trunc(rp, 8192),
    response_elements: trunc(d.responseElements, 4096),
    additional_event_data: trunc(d.additionalEventData, 2048),
  };
}

function guardDutyFinding(d) {
  return {
    id: d.id,
    type: d.type,
    title: trunc(d.title, 512),
    description: trunc(d.description, 1024),
    severity: d.severity === undefined ? undefined : String(d.severity),
    severity_label: guardDutyLabel(d.severity),
    resource_type: d.resource?.resourceType,
    instance_id: d.resource?.instanceDetails?.instanceId,
    access_key_user: d.resource?.accessKeyDetails?.userName,
    action_type: d.service?.action?.actionType,
    count: d.service?.count === undefined ? undefined : String(d.service.count),
    product: 'GuardDuty',
  };
}

function securityHubFinding(f) {
  const res = Array.isArray(f.Resources) ? f.Resources[0] : undefined;
  return {
    id: f.Id,
    title: trunc(f.Title, 512),
    description: trunc(f.Description, 1024),
    severity_label: f.Severity?.Label ?? 'UNKNOWN',
    severity: f.Severity?.Normalized === undefined ? undefined : String(f.Severity.Normalized),
    product: f.ProductName,
    generator: trunc(f.GeneratorId, 256),
    type: Array.isArray(f.Types) ? f.Types.join(',') : undefined,
    resource_type: res?.Type,
    resource_id: trunc(res?.Id, 512),
    compliance_status: f.Compliance?.Status,
    workflow_status: f.Workflow?.Status,
  };
}

// Devuelve una o más líneas (objetos) por evento EventBridge.
export function normalize(event, meta = {}) {
  const base = (eventType) => ({
    qapaq: {
      vendor: 'aws',
      source: 'eventbridge',
      event_type: eventType,
      collected_at: meta.receivedAt ?? new Date().toISOString(),
      sns_message_id: meta.messageId,
      sns_topic_arn: meta.topicArn,
    },
    aws: {
      account: event?.account,
      region: event?.region,
      detail_type: event?.['detail-type'],
      source: event?.source,
      event_id: event?.id,
      time: event?.time,
    },
  });
  if (!event || typeof event !== 'object') {
    const rec = base('other');
    rec.aws.raw = trunc(String(event), 8192);
    return [compact(rec)];
  }
  const d = event.detail ?? {};
  const dt = event['detail-type'];
  if (API_TYPES.has(dt) || SIGNIN_TYPES.has(dt)) {
    const rec = base(SIGNIN_TYPES.has(dt) ? 'console_signin' : 'cloudtrail_api');
    Object.assign(rec.aws, cloudTrailFields(d));
    if (Array.isArray(event.resources) && event.resources.length) rec.aws.resources = event.resources.slice(0, 20);
    return [fit(compact(rec))];
  }
  if (event.source === 'aws.guardduty' && dt === 'GuardDuty Finding') {
    const rec = base('guardduty_finding');
    rec.aws.finding = guardDutyFinding(d);
    return [fit(compact(rec))];
  }
  if (event.source === 'aws.securityhub' && Array.isArray(d.findings)) {
    return d.findings.slice(0, 100).map((f) => {
      const rec = base('securityhub_finding');
      rec.aws.finding = securityHubFinding(f ?? {});
      return fit(compact(rec));
    });
  }
  const rec = base('other');
  rec.aws.detail = trunc(d, 8192);
  return [fit(compact(rec))];
}

// Garantiza que la línea entra en el límite de Wazuh recortando los campos voluminosos.
export function fit(rec) {
  if (Buffer.byteLength(JSON.stringify(rec)) <= MAX_LINE_BYTES) return rec;
  for (const key of ['request_parameters', 'response_elements', 'additional_event_data', 'detail', 'raw']) {
    if (rec.aws[key] !== undefined) rec.aws[key] = trunc(rec.aws[key], 1024);
  }
  rec.aws.truncated = 'true';
  if (Buffer.byteLength(JSON.stringify(rec)) > MAX_LINE_BYTES && rec.aws.finding) {
    rec.aws.finding.description = trunc(rec.aws.finding.description, 256);
  }
  return rec;
}

// ------------------------------------------------------------------ salida, dedupe, tasa

export class JsonlSink {
  constructor(file, maxBytes = 100 * 1024 * 1024) {
    this.file = file;
    this.maxBytes = maxBytes;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(records) {
    try {
      if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.appendFileSync(this.file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o640 });
  }
}

export class Dedupe {
  constructor(max = 50000) {
    this.max = max;
    this.seen = new Set();
  }
  has(id) {
    return this.seen.has(id);
  }
  add(id) {
    this.seen.add(id);
    if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value);
  }
}

export class TokenBucket {
  constructor(ratePerSec, burst, now = () => Date.now()) {
    Object.assign(this, { ratePerSec, burst, now, tokens: burst, last: now() });
  }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ------------------------------------------------------------------ manejo HTTP

export function createHandler({
  topics,
  sink,
  loadCert,
  confirm = async (url) => {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    return res.status;
  },
  dedupe = new Dedupe(),
  bucket = new TokenBucket(50, 500),
  maxBody = 300 * 1024,
  maxAgeMs = 60 * 60 * 1000,
  now = () => Date.now(),
}) {
  const stats = { notifications: 0, records: 0, duplicates: 0, rejected: 0, confirmed: 0 };
  async function handle(req, res) {
    const reply = (code, body = '') => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    const reject = (code, reason, extra = {}) => {
      stats.rejected += 1;
      log('warn', 'rechazado', { reason, code, ...extra });
      reply(code, `${reason}\n`);
    };
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && url.pathname === '/healthz') return reply(200, JSON.stringify(stats));
    if (url.pathname !== HOOK_PATH) return reply(404);
    if (req.method !== 'POST') return reply(405);
    if (!bucket.take()) return reject(503, 'rate-limited');
    const type = req.headers['x-amz-sns-message-type'];
    if (!MESSAGE_TYPES.has(type)) return reject(400, 'tipo de mensaje no admitido');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) return reject(413, 'cuerpo demasiado grande');
      chunks.push(chunk);
    }
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reject(400, 'JSON inválido');
    }
    if (!msg || msg.Type !== type) return reject(400, 'Type no coincide con la cabecera');
    if (!topics.has(msg.TopicArn)) return reject(403, 'TopicArn no esperado', { topic: String(msg.TopicArn).slice(0, 200) });
    if (req.headers['x-amz-sns-topic-arn'] && req.headers['x-amz-sns-topic-arn'] !== msg.TopicArn) {
      return reject(403, 'TopicArn no coincide con la cabecera');
    }
    if (msg.SignatureVersion !== '2') return reject(403, 'SignatureVersion no admitida');
    if (!checkSigningCertUrl(msg.SigningCertURL, msg.TopicArn)) return reject(403, 'SigningCertURL no es de SNS');
    let publicKey;
    try {
      publicKey = await loadCert(msg.SigningCertURL, expectedSnsHost(msg.TopicArn));
    } catch (err) {
      log('error', 'no se pudo validar el certificado SNS', { error: err.message });
      return reply(503, 'certificado no disponible\n');
    }
    if (!verifySignature(msg, publicKey)) return reject(403, 'firma inválida');
    const ts = Date.parse(msg.Timestamp);
    if (!Number.isFinite(ts) || now() - ts > maxAgeMs || ts - now() > 5 * 60 * 1000) {
      return reject(403, 'Timestamp fuera de ventana');
    }

    if (type === 'SubscriptionConfirmation') {
      if (!checkSubscribeUrl(msg.SubscribeURL, msg.TopicArn)) return reject(403, 'SubscribeURL no válida');
      try {
        const status = await confirm(msg.SubscribeURL);
        if (status !== 200) throw new Error(`HTTP ${status}`);
      } catch (err) {
        log('error', 'confirmación de suscripción fallida', { topic: msg.TopicArn, error: err.message });
        return reply(502, 'confirmación fallida\n');
      }
      stats.confirmed += 1;
      log('info', 'suscripción confirmada', { topic: msg.TopicArn });
      return reply(200, 'confirmado\n');
    }
    if (type === 'UnsubscribeConfirmation') {
      log('warn', 'baja de suscripción recibida (no se re-suscribe)', { topic: msg.TopicArn });
      return reply(200, 'ok\n');
    }

    if (typeof msg.MessageId !== 'string' || !msg.MessageId) return reject(400, 'MessageId ausente');
    if (dedupe.has(msg.MessageId)) {
      stats.duplicates += 1;
      return reply(200, 'duplicado\n');
    }
    let event;
    try {
      event = JSON.parse(msg.Message);
    } catch {
      event = msg.Message;
    }
    // Un mismo evento puede coincidir con varias reglas de EventBridge (p. ej. root + IAM): cada
    // regla genera otro MessageId, pero el id del evento EventBridge es el mismo.
    const eventKey = typeof event === 'object' && typeof event?.id === 'string' ? `evt:${event.id}` : null;
    if (eventKey && dedupe.has(eventKey)) {
      dedupe.add(msg.MessageId);
      stats.duplicates += 1;
      return reply(200, 'duplicado\n');
    }
    const records = normalize(event, {
      messageId: msg.MessageId,
      topicArn: msg.TopicArn,
      receivedAt: new Date(now()).toISOString(),
    });
    try {
      sink.write(records);
    } catch (err) {
      log('error', 'no se pudo escribir el JSONL', { error: err.message });
      return reply(500, 'error de escritura\n');
    }
    dedupe.add(msg.MessageId);
    if (eventKey) dedupe.add(eventKey);
    stats.notifications += 1;
    stats.records += records.length;
    log('info', 'evento', {
      topic_region: topicRegion(msg.TopicArn),
      detail_type: typeof event === 'object' ? event?.['detail-type'] : undefined,
      event_name: records[0]?.aws?.event_name,
      records: records.length,
    });
    return reply(200, 'ok\n');
  }
  return { handle, stats };
}

// ------------------------------------------------------------------ arranque

export function parseTopics(raw) {
  const list = String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const arn of list) if (!TOPIC_ARN_RE.test(arn)) throw new Error(`TopicArn inválido: ${arn}`);
  return new Set(list);
}

function main() {
  const topics = parseTopics(process.env.QAPAQ_AWS_SNS_TOPIC_ARNS);
  if (topics.size === 0) throw new Error('QAPAQ_AWS_SNS_TOPIC_ARNS vacío: no se acepta ningún tema');
  const sink = new JsonlSink(
    process.env.QAPAQ_AWS_EVENTS_FILE ?? '/out/aws-events.jsonl',
    Number(process.env.QAPAQ_AWS_EVENTS_MAX_BYTES ?? 100 * 1024 * 1024),
  );
  const { handle } = createHandler({
    topics,
    sink,
    loadCert: makeCertLoader(),
    bucket: new TokenBucket(Number(process.env.QAPAQ_RATE_PER_SEC ?? 50), Number(process.env.QAPAQ_RATE_BURST ?? 500)),
  });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('error', 'error no controlado', { error: err.message });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, '0.0.0.0', () => log('info', 'escuchando', { port, topics: topics.size }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
