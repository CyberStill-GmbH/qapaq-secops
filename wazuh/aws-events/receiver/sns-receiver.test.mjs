// node --test wazuh/aws-events/receiver/
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  checkSigningCertUrl,
  checkSubscribeUrl,
  createHandler,
  Dedupe,
  fit,
  guardDutyLabel,
  JsonlSink,
  makeCertLoader,
  normalize,
  parseTopics,
  stringToSign,
  TokenBucket,
  verifySignature,
} from './sns-receiver.mjs';

const TOPIC = 'arn:aws:sns:us-east-1:061098277310:qapaq-soc-dev-aws-events';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function sign(msg) {
  const s = crypto.sign('sha256', Buffer.from(stringToSign(msg)), privateKey).toString('base64');
  return { ...msg, Signature: s };
}

function notification(event, overrides = {}) {
  return sign({
    Type: 'Notification',
    MessageId: crypto.randomUUID(),
    TopicArn: TOPIC,
    Message: JSON.stringify(event),
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    ...overrides,
  });
}

const sgEvent = {
  version: '0',
  id: 'evt-1',
  'detail-type': 'AWS API Call via CloudTrail',
  source: 'aws.ec2',
  account: '061098277310',
  time: '2026-11-04T10:00:00Z',
  region: 'us-east-1',
  resources: [],
  detail: {
    eventName: 'AuthorizeSecurityGroupIngress',
    eventSource: 'ec2.amazonaws.com',
    eventType: 'AwsApiCall',
    readOnly: false,
    sourceIPAddress: '198.51.100.7',
    userAgent: 'aws-cli/2',
    userIdentity: {
      type: 'AssumedRole',
      arn: 'arn:aws:sts::061098277310:assumed-role/AWSReservedSSO_SOC-PowerUser_x/soc@qapaq.pe',
      accountId: '061098277310',
      sessionContext: { sessionIssuer: { userName: 'AWSReservedSSO_SOC-PowerUser_x' } },
    },
    requestParameters: { groupId: 'sg-1', ipPermissions: { items: [{ ipRanges: { items: [{ cidrIp: '0.0.0.0/0' }] } }] } },
  },
};

function tmpSink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapaq-sns-'));
  return new JsonlSink(path.join(dir, 'aws-events.jsonl'));
}

async function call(handler, { method = 'POST', url = '/hooks/aws-sns', headers = {}, body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method, url, headers });
  const res = {
    code: 0,
    body: '',
    headersSent: false,
    writeHead(code) {
      this.code = code;
      this.headersSent = true;
    },
    end(b = '') {
      this.body += b;
    },
  };
  await handler.handle(req, res);
  return res;
}

function post(handler, msg, extraHeaders = {}) {
  return call(handler, {
    headers: { 'x-amz-sns-message-type': msg.Type, 'x-amz-sns-topic-arn': msg.TopicArn, ...extraHeaders },
    body: JSON.stringify(msg),
  });
}

function makeHandler(opts = {}) {
  const sink = opts.sink ?? tmpSink();
  const confirmed = [];
  const handler = createHandler({
    topics: new Set([TOPIC]),
    sink,
    loadCert: async (url, host) => {
      assert.equal(url, CERT_URL);
      assert.equal(host, 'sns.us-east-1.amazonaws.com');
      return publicKey;
    },
    confirm: async (url) => {
      confirmed.push(url);
      return 200;
    },
    ...opts,
  });
  return { handler, sink, confirmed };
}

const lines = (sink) =>
  fs.existsSync(sink.file) ? fs.readFileSync(sink.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('URL del certificado: solo https://sns.<región del tema>.amazonaws.com/*.pem', () => {
  assert.ok(checkSigningCertUrl(CERT_URL, TOPIC));
  assert.ok(!checkSigningCertUrl('http://sns.us-east-1.amazonaws.com/x.pem', TOPIC));
  assert.ok(!checkSigningCertUrl('https://sns.us-west-2.amazonaws.com/x.pem', TOPIC));
  assert.ok(!checkSigningCertUrl('https://sns.us-east-1.amazonaws.com.evil.io/x.pem', TOPIC));
  assert.ok(!checkSigningCertUrl('https://evil.io/sns.us-east-1.amazonaws.com/x.pem', TOPIC));
  assert.ok(!checkSigningCertUrl('https://sns.us-east-1.amazonaws.com:8443/x.pem', TOPIC));
  assert.ok(!checkSigningCertUrl('https://sns.us-east-1.amazonaws.com/x.txt', TOPIC));
});

test('SubscribeURL: mismo host SNS, ConfirmSubscription y el mismo TopicArn', () => {
  const ok = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=abc`;
  assert.ok(checkSubscribeUrl(ok, TOPIC));
  assert.ok(!checkSubscribeUrl(ok.replace('ConfirmSubscription', 'Unsubscribe'), TOPIC));
  assert.ok(!checkSubscribeUrl(ok.replace('qapaq-soc-dev-aws-events', 'otro'), TOPIC));
  assert.ok(!checkSubscribeUrl(ok.replace('sns.us-east-1', 'sns.eu-west-1'), TOPIC));
  assert.ok(!checkSubscribeUrl(ok.replace('&Token=abc', ''), TOPIC));
});

test('firma SignatureVersion 2 (SHA256); v1 y firma alterada se rechazan', () => {
  const msg = notification(sgEvent);
  assert.ok(verifySignature(msg, publicKey));
  assert.ok(!verifySignature({ ...msg, Message: '{}' }, publicKey));
  assert.ok(!verifySignature({ ...msg, SignatureVersion: '1' }, publicKey));
  const withSubject = notification(sgEvent, { Subject: 'hola' });
  assert.ok(verifySignature(withSubject, publicKey));
  assert.ok(!verifySignature({ ...withSubject, Subject: 'otro' }, publicKey));
});

test('Notification válida → una línea JSONL normalizada; duplicado no se reescribe', async () => {
  const { handler, sink } = makeHandler();
  const msg = notification(sgEvent);
  assert.equal((await post(handler, msg)).code, 200);
  assert.equal((await post(handler, msg)).code, 200);
  const out = lines(sink);
  assert.equal(out.length, 1);
  assert.equal(out[0].qapaq.vendor, 'aws');
  assert.equal(out[0].qapaq.event_type, 'cloudtrail_api');
  assert.equal(out[0].qapaq.sns_message_id, msg.MessageId);
  assert.equal(out[0].aws.event_name, 'AuthorizeSecurityGroupIngress');
  assert.equal(out[0].aws.principal, 'AWSReservedSSO_SOC-PowerUser_x/soc@qapaq.pe');
  assert.equal(out[0].aws.open_to_world, 'true');
  assert.equal(typeof out[0].aws.request_parameters, 'string');
  assert.equal(handler.stats.duplicates, 1);
  // Mismo evento EventBridge por otra regla (otro MessageId): tampoco se duplica.
  assert.equal((await post(handler, notification(sgEvent))).code, 200);
  assert.equal(lines(sink).length, 1);
  assert.equal(handler.stats.duplicates, 2);
});

test('rechaza tema no esperado, firma inválida, cabecera distinta, v1 y Timestamp viejo', async () => {
  const { handler, sink } = makeHandler();
  const other = 'arn:aws:sns:us-east-1:111111111111:otro';
  assert.equal((await post(handler, notification(sgEvent, { TopicArn: other }))).code, 403);
  const tampered = { ...notification(sgEvent), Message: JSON.stringify({ ...sgEvent, id: 'x' }) };
  assert.equal((await post(handler, tampered)).code, 403);
  assert.equal((await post(handler, notification(sgEvent), { 'x-amz-sns-topic-arn': other })).code, 403);
  assert.equal((await post(handler, notification(sgEvent, { SignatureVersion: '1' }))).code, 403);
  const old = notification(sgEvent, { Timestamp: new Date(Date.now() - 2 * 3600e3).toISOString() });
  assert.equal((await post(handler, old)).code, 403);
  const badCert = notification(sgEvent, { SigningCertURL: 'https://evil.example/cert.pem' });
  assert.equal((await post(handler, badCert)).code, 403);
  assert.equal(lines(sink).length, 0);
});

test('método, ruta, tipo y tamaño', async () => {
  const { handler } = makeHandler({ maxBody: 1000 });
  assert.equal((await call(handler, { method: 'GET' })).code, 405);
  assert.equal((await call(handler, { url: '/otra' })).code, 404);
  assert.equal((await call(handler, { headers: { 'x-amz-sns-message-type': 'Raro' } })).code, 400);
  const big = notification({ ...sgEvent, detail: { ...sgEvent.detail, x: 'a'.repeat(5000) } });
  assert.equal((await post(handler, big)).code, 413);
});

test('límite de tasa → 503 (SNS reintenta)', async () => {
  const { handler } = makeHandler({ bucket: new TokenBucket(0, 1) });
  assert.equal((await post(handler, notification(sgEvent))).code, 200);
  assert.equal((await post(handler, notification(sgEvent))).code, 503);
});

test('SubscriptionConfirmation: confirma solo con firma y URL válidas', async () => {
  const { handler, confirmed } = makeHandler();
  const subUrl = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=tok`;
  const sub = sign({
    Type: 'SubscriptionConfirmation',
    MessageId: 'm-1',
    Token: 'tok',
    TopicArn: TOPIC,
    Message: 'You have chosen to subscribe',
    SubscribeURL: subUrl,
    Timestamp: new Date().toISOString(),
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
  });
  assert.equal((await post(handler, sub)).code, 200);
  assert.deepEqual(confirmed, [subUrl]);
  const evil = sign({ ...sub, SubscribeURL: 'https://evil.example/?Action=ConfirmSubscription' });
  assert.equal((await post(handler, evil)).code, 403);
  assert.equal((await post(handler, { ...sub, Token: 'otro' })).code, 403);
  assert.equal(confirmed.length, 1);
});

test('normaliza consola, root, GuardDuty y Security Hub', () => {
  const [login] = normalize({
    'detail-type': 'AWS Console Sign In via CloudTrail',
    source: 'aws.signin',
    region: 'us-east-1',
    account: '061098277310',
    detail: {
      eventName: 'ConsoleLogin',
      eventSource: 'signin.amazonaws.com',
      sourceIPAddress: '203.0.113.9',
      userIdentity: { type: 'Root', arn: 'arn:aws:iam::061098277310:root' },
      responseElements: { ConsoleLogin: 'Failure' },
      additionalEventData: { MFAUsed: 'No' },
    },
  });
  assert.equal(login.qapaq.event_type, 'console_signin');
  assert.equal(login.aws.principal, 'root');
  assert.equal(login.aws.console_login, 'Failure');
  assert.equal(login.aws.mfa_used, 'No');

  const [gd] = normalize({
    'detail-type': 'GuardDuty Finding',
    source: 'aws.guardduty',
    detail: { id: 'f1', type: 'UnauthorizedAccess:EC2/SSHBruteForce', severity: 8, title: 't', resource: { resourceType: 'Instance' } },
  });
  assert.equal(gd.qapaq.event_type, 'guardduty_finding');
  assert.equal(gd.aws.finding.severity_label, 'HIGH');
  assert.deepEqual([1, 4, 6.9, 7, 8.9, 9].map(guardDutyLabel), ['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL']);

  const sh = normalize({
    'detail-type': 'Security Hub Findings - Imported',
    source: 'aws.securityhub',
    detail: { findings: [{ Id: 'a', Title: 'x', Severity: { Label: 'CRITICAL' } }, { Id: 'b', Severity: { Label: 'MEDIUM' } }] },
  });
  assert.equal(sh.length, 2);
  assert.equal(sh[0].aws.finding.severity_label, 'CRITICAL');
});

test('líneas grandes se recortan bajo el límite de Wazuh', () => {
  const rec = fit({ qapaq: {}, aws: { request_parameters: 'x'.repeat(70000), response_elements: 'y'.repeat(9000) } });
  assert.ok(Buffer.byteLength(JSON.stringify(rec)) < 60000);
  assert.equal(rec.aws.truncated, 'true');
});

test('Dedupe acotado, rotación del JSONL y lista de temas', () => {
  const d = new Dedupe(2);
  d.add('a');
  d.add('b');
  d.add('c');
  assert.ok(!d.has('a') && d.has('c'));
  const sink = tmpSink();
  sink.maxBytes = 10;
  sink.write([{ a: 'x'.repeat(20) }]);
  sink.write([{ b: 1 }]);
  assert.ok(fs.existsSync(`${sink.file}.1`));
  assert.equal(lines(sink).length, 1);
  assert.equal(parseTopics(`${TOPIC}, ${TOPIC.replace('us-east-1', 'eu-west-1')}`).size, 2);
  assert.throws(() => parseTopics('arn:aws:sqs:us-east-1:061098277310:x'));
});

// Certificado autofirmado con openssl (si está disponible) para probar makeCertLoader sin red.
function selfSigned(san, days = 30) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapaq-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', String(days), '-subj', '/CN=sns.amazonaws.com', '-addext', `subjectAltName=DNS:${san}`]);
  return r.status === 0 ? fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') : null;
}
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

test('makeCertLoader: acepta SAN global o regional de SNS y rechaza otros', { skip: !hasOpenssl && 'sin openssl' }, async () => {
  const fake = (pem) => async () => ({ ok: true, status: 200, text: async () => pem });
  const host = 'sns.us-east-1.amazonaws.com';
  for (const san of ['sns.amazonaws.com', host]) {
    const load = makeCertLoader({ fetchImpl: fake(selfSigned(san)) });
    assert.ok(await load(CERT_URL, host));
  }
  const bad = makeCertLoader({ fetchImpl: fake(selfSigned('evil.example')) });
  await assert.rejects(bad(CERT_URL, host), /SAN/);
  const html = makeCertLoader({ fetchImpl: fake('<html>') });
  await assert.rejects(html(CERT_URL, host), /inválido/);
});
