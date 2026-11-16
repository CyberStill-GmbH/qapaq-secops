/**
 * Wazuh Manager -> API durable push hint. The alert document remains in Indexer; this endpoint
 * commits only a minimal signed reference before acknowledging, and the worker fetches the
 * original document through the server-side connector.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import type { WazuhPushHint } from '@qapaq/soc';
import type { IncomingRequest } from '../http/http-contracts.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const FUTURE_SKEW_SECONDS = 30;
const RATE_WINDOW_MS = 1_000;
const RATE_BURST = 100;
const HINT_KEYS = ['alertId', 'managerName', 'occurredAt'] as const;
const ALERT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RFC3339_WITH_WAZUH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/u;

function isFlatHint(
  value: unknown,
): value is Pick<WazuhPushHint, 'alertId' | 'managerName' | 'occurredAt'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.length !== HINT_KEYS.length || !HINT_KEYS.every((key) => Object.hasOwn(payload, key))) {
    return false;
  }
  return (
    typeof payload['alertId'] === 'string' &&
    ALERT_ID_PATTERN.test(payload['alertId']) &&
    typeof payload['managerName'] === 'string' &&
    payload['managerName'].length >= 1 &&
    payload['managerName'].length <= 128 &&
    payload['managerName'].trim() === payload['managerName'] &&
    !/[\u0000-\u001f\u007f]/u.test(payload['managerName']) &&
    typeof payload['occurredAt'] === 'string' &&
    payload['occurredAt'].length <= 40 &&
    RFC3339_WITH_WAZUH_OFFSET.test(payload['occurredAt']) &&
    validTimestamp(payload['occurredAt'])
  );
}

function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]!) return false;
  const offset = /([+-])(\d{2}):?(\d{2})$/u.exec(value);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return false;
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2');
  return Number.isFinite(Date.parse(normalized));
}

function canonicalHint(
  hint: Pick<WazuhPushHint, 'alertId' | 'managerName' | 'occurredAt'>,
): string {
  // Fixed, shallow property order matches custom-qapaq.py's insertion-ordered JSON serialization.
  return JSON.stringify({
    alertId: hint.alertId,
    managerName: hint.managerName,
    occurredAt: hint.occurredAt,
  });
}

function header(request: IncomingRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('api/ingest')
export class WazuhPushController {
  private windowStartedAt = 0;
  private requestsInWindow = 0;

  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Post('wazuh')
  @HttpCode(202)
  public async wake(@Req() request: IncomingRequest, @Body() body: unknown) {
    if (!this.runtime.wazuhPushSecret || !this.runtime.canAcceptWazuhPush) {
      throw new HttpException('Not found', 404);
    }
    if (!isFlatHint(body)) throw new HttpException('Invalid request', 400);
    const hintFields = {
      alertId: body.alertId,
      managerName: body.managerName,
      occurredAt: body.occurredAt,
    };
    const canonicalBody = canonicalHint(hintFields);
    if (Buffer.byteLength(canonicalBody, 'utf8') > MAX_BODY_BYTES) {
      throw new HttpException('Payload too large', 413);
    }
    const contentLength = header(request, 'content-length');
    if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
      throw new HttpException('Payload too large', 413);
    }
    const timestamp = header(request, 'x-qapaq-timestamp');
    const supplied = header(request, 'x-qapaq-signature');
    if (
      !timestamp ||
      !/^\d{10}$/u.test(timestamp) ||
      !supplied ||
      !/^sha256=[a-f0-9]{64}$/u.test(supplied)
    ) {
      throw new HttpException('Unauthorized', 401);
    }
    const nowSeconds = Math.floor(this.runtime.now().getTime() / 1_000);
    const sentAt = Number(timestamp);
    if (sentAt > nowSeconds + FUTURE_SKEW_SECONDS || nowSeconds - sentAt > MAX_CLOCK_SKEW_SECONDS) {
      throw new HttpException('Unauthorized', 401);
    }
    const expected = createHmac('sha256', this.runtime.wazuhPushSecret)
      .update(`${timestamp}.${canonicalBody}`, 'utf8')
      .digest();
    const actual = Buffer.from(supplied.slice('sha256='.length), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException('Unauthorized', 401);
    }

    // This limiter is deliberately only local backpressure; PostgreSQL idempotency and leases
    // fence replicas. The regular Indexer pull remains the recovery path for rejected pushes.
    const now = Date.now();
    if (now - this.windowStartedAt >= RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.requestsInWindow = 0;
    }
    if (this.requestsInWindow >= RATE_BURST) throw new HttpException('Too many requests', 429);
    this.requestsInWindow += 1;
    const idempotencyKey = createHash('sha256')
      .update(
        JSON.stringify([hintFields.managerName, hintFields.alertId, hintFields.occurredAt]),
        'utf8',
      )
      .digest('hex');
    try {
      const accepted = await this.runtime.acceptWazuhPushHint({ ...hintFields, idempotencyKey });
      return {
        accepted: true,
        duplicate: accepted !== 'inserted',
        requeued: accepted === 'reopened-terminal',
        mode: 'durable-inbox',
      };
    } catch {
      // Do not acknowledge a hint the durable inbox did not commit; avoid exposing database details.
      throw new HttpException('Unavailable', 503);
    }
  }
}
