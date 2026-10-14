/**
 * Sprint 5 — respaldo por correo cuando Teams no confirma la entrega.
 *
 * Fija la cadena correo → consola y que el despachador entregue al respaldo los mismos
 * destinatarios por rol que eligió para Teams. Correos sintéticos.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryAuditStore } from '@qapaq/audit';
import {
  ConsoleFallbackChannel,
  dispatchMessage,
  InMemoryAttemptStore,
  InMemoryOutbox,
  type NotificationTransport,
} from '@qapaq/soar';

import { GraphMailFallbackChannel } from '../src/runtime/email-fallback.js';

const RECIPIENTS = [
  { upn: 'analista@qapaq-lab.example', displayName: 'Analista' },
  { upn: 'lider@qapaq-lab.example', displayName: 'Líder' },
];
const NOTIFICATION = {
  tenantId: 't',
  aggregateType: 'alert' as const,
  aggregateId: 'a-1',
  title: 'Regla de reenvío externa',
  severity: 'P1',
  reason: 'TEAMS_PERMANENT',
  at: new Date('2026-10-13T01:00:00.000Z'),
  recipients: RECIPIENTS,
  link: 'https://qapaq-secops.jappi.net.pe/alerts/a-1',
};

function channel(status: number | 'throw') {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const console = new ConsoleFallbackChannel();
  const mail = new GraphMailFallbackChannel({
    sender: 'soc-alertas@qapaq-lab.example',
    accessToken: async () => 'token-sintetico',
    next: console,
    fetch: (async (url: URL, init: RequestInit) => {
      requests.push({ url: url.toString(), body: JSON.parse(String(init.body)) });
      if (status === 'throw') throw new Error('red');
      return new Response(null, { status });
    }) as unknown as typeof fetch,
  });
  return { mail, console, requests };
}

describe('respaldo por correo', () => {
  it('Graph acepta (202): el aviso queda como fallback_email a los destinatarios por rol', async () => {
    const { mail, console, requests } = channel(202);
    expect(await mail.notify(NOTIFICATION)).toMatchObject({ channel: 'fallback_email' });
    expect(console.delivered).toHaveLength(0);
    expect(requests[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/users/soc-alertas%40qapaq-lab.example/sendMail',
    );
    const message = requests[0]!.body['message'] as {
      toRecipients: { emailAddress: { address: string } }[];
      body: { content: string };
    };
    expect(message.toRecipients.map((item) => item.emailAddress.address)).toEqual([
      'analista@qapaq-lab.example',
      'lider@qapaq-lab.example',
    ]);
    expect(message.body.content).toContain('https://qapaq-secops.jappi.net.pe/alerts/a-1');
  });

  it.each([403, 'throw'] as const)(
    'si el correo no sale (%s) cae en la consola',
    async (status) => {
      const { mail, console } = channel(status);
      expect(await mail.notify(NOTIFICATION)).toMatchObject({ channel: 'manual_console' });
      expect(console.delivered).toHaveLength(1);
    },
  );

  it('sin destinatarios no intenta correo: va directo a la consola', async () => {
    const { mail, console, requests } = channel(202);
    await mail.notify({ ...NOTIFICATION, recipients: [] });
    expect(requests).toHaveLength(0);
    expect(console.delivered).toHaveLength(1);
  });

  it('Teams con error permanente → el despachador envía el correo a los destinatarios por rol', async () => {
    const { mail, requests } = channel(202);
    const outbox = new InMemoryOutbox();
    const message = {
      messageId: '0190f47a-0000-7000-8000-000000000001',
      tenantId: 't',
      aggregateType: 'alert' as const,
      aggregateId: 'a-1',
      messageType: 'soc.alert.created' as const,
      schemaVersion: '1.0.0',
      idempotencyKey: 'k-1',
      payload: { priority: 'P1', title: 'Regla de reenvío externa' },
      availableAt: new Date('2026-10-13T01:00:00.000Z'),
    };
    outbox.enqueue(message);
    const failing: NotificationTransport = {
      destinationRef: 'teams:canal-soc',
      send: async () => ({
        delivered: false,
        failure: { class: 'permanent', code: 'TEAMS_HTTP_400', detail: 'rechazado' },
      }),
    };
    const result = await dispatchMessage(
      {
        outbox,
        attempts: new InMemoryAttemptStore(),
        transport: failing,
        fallback: mail,
        audit: new InMemoryAuditStore(),
        clock: { now: () => new Date('2026-10-13T01:00:00.000Z') },
        ids: { next: () => '0190f47a-0000-7000-8000-0000000000ff' },
        consoleBaseUrl: 'https://qapaq-secops.jappi.net.pe',
        recipients: { recipientsFor: async () => RECIPIENTS },
      },
      message,
    );
    expect(result).toMatchObject({ code: 'fallback_used', attempt: { channel: 'fallback_email' } });
    expect(requests).toHaveLength(1);
  });
});
