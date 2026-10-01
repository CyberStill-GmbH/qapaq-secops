/**
 * Pantalla de autenticación del emisor local. Existe solo cuando la identidad es
 * `local-development`; en el perfil de producción el runtime ni siquiera construye el
 * emisor, de modo que estas rutas no tienen nada detrás.
 *
 * Reemplaza a la pantalla de Microsoft en el entorno local y en el E2E: recibe el
 * `state` del handshake y devuelve el `code` por el mismo redirect que usaría Entra.
 */

import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { OutgoingReply } from '../http/http-contracts.js';

import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { LOCAL_PRINCIPALS } from '../access/local-issuer.js';

/**
 * El retorno del emisor local es relativo: la consola y la API comparten origen a
 * través del ingress, y una URL absoluta ataría el E2E a un puerto fijo.
 */
const LOCAL_CALLBACK_PATH = '/api/auth/callback';

@Controller('api/auth/local')
export class LocalAuthController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  @Get('principals')
  public principals() {
    return Object.values(LOCAL_PRINCIPALS).map((principal) => ({
      username: principal.username,
      displayName: principal.displayName,
      roles: principal.roles,
      amr: principal.amr,
    }));
  }

  /** Sustituto mínimo de la pantalla de Entra: una lista de personas sintéticas. */
  @Get('login')
  public async login(@Query() query: { state?: string }, @Res() reply: OutgoingReply) {
    if (!this.runtime.isLocalIdentity) {
      await reply.status(404).send();
      return;
    }
    const state = encodeURIComponent(query.state ?? '');
    const rows = Object.values(LOCAL_PRINCIPALS)
      .map(
        (principal) =>
          `<li><a id="signin-${principal.username.split('@')[0]}" href="/api/auth/local/authorize?state=${state}&username=${encodeURIComponent(principal.username)}">${principal.displayName} — ${principal.roles.join(', ') || 'sin rol'}</a></li>`,
      )
      .join('');
    await reply
      .status(200)
      .header('content-type', 'text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Acceso local QAPAQ</title></head><body><h1>Emisor local de desarrollo</h1><p>Perfil no productivo. Seleccione una identidad sintética.</p><ul>${rows}</ul></body></html>`,
      );
  }

  @Get('authorize')
  public async authorize(
    @Query() query: { state?: string; username?: string },
    @Res() reply: OutgoingReply,
  ) {
    const state = query.state ?? '';
    const username = query.username ?? '';
    if (!this.runtime.isLocalIdentity) {
      await reply.status(404).send();
      return;
    }
    let code: string;
    try {
      code = this.runtime.localAuthorize(username, state);
    } catch {
      // El emisor local se comporta como Entra ante un error: vuelve por el redirect.
      await reply
        .status(302)
        .header(
          'location',
          `${LOCAL_CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(state)}`,
        )
        .send();
      return;
    }
    await reply
      .status(302)
      .header(
        'location',
        `${LOCAL_CALLBACK_PATH}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      )
      .send();
  }
}
