/* QAPAQ Web Push: push payloads carry no SOC content; this worker reads authorized pending items. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const endpoint = new URL('/api/me/push/pending', self.location.origin);
      let response;
      try {
        response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      } catch {
        return;
      }

      if (response.status === 401) {
        await self.registration.showNotification('Aviso del SOC', {
          body: 'Abre QAPAQ e inicia sesión para consultar los avisos.',
          icon: new URL('qapaq-notification-icon.png', self.registration.scope).href,
          badge: new URL('qapaq-notification-icon.png', self.registration.scope).href,
          tag: 'qapaq-session-required',
          data: { itemUrl: new URL('./', self.registration.scope).href },
        });
        return;
      }
      if (!response.ok) return;

      let payload;
      try {
        payload = await response.json();
      } catch {
        return;
      }
      const items = Array.isArray(payload?.items) ? payload.items : [];
      if (items.length === 0) return;
      const first = items[0];
      const severity = String(first.severity ?? '').slice(0, 24);
      const title =
        items.length > 1
          ? `${items.length} avisos críticos nuevos`
          : String(first.title ?? 'Aviso crítico del SOC').slice(0, 120);
      const body =
        items.length > 1
          ? 'Abre QAPAQ para revisar las alertas e investigaciones recientes.'
          : `${severity ? `${severity} · ` : ''}Abre QAPAQ para investigar.`;
      const itemUrl = safeItemUrl(first.url);

      await self.registration.showNotification(title, {
        body,
        icon: new URL('qapaq-notification-icon.png', self.registration.scope).href,
        badge: new URL('qapaq-notification-icon.png', self.registration.scope).href,
        tag: 'qapaq-soc-critical',
        renotify: true,
        timestamp: Date.parse(first.at) || Date.now(),
        data: { itemUrl },
      });
    })(),
  );
});

function safeItemUrl(value) {
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin !== self.location.origin) return new URL('./', self.registration.scope).href;
    if (!/\/(alerts|incidents)\/[^/]+\/?$/u.test(target.pathname))
      return new URL('./', self.registration.scope).href;
    return target.href;
  } catch {
    return new URL('./', self.registration.scope).href;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeItemUrl(event.notification.data?.itemUrl);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
