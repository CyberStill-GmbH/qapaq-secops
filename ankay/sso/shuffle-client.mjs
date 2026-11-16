/*
 * Cliente mínimo de la API de Shuffle v2.3.0 (backend Go + shuffle-shared v1.3.22) para el puente.
 * Endpoints verificados en el código del tag:
 *   GET  /api/v1/getusers                 (admin)  → lista de usuarios de la org
 *   POST /api/v1/register                 (admin)  → crea usuario con rol «user» en la org del admin
 *   PUT  /api/v1/users/updateuser         (admin)  → { user_id, role ∈ admin|user|org-reader }
 *   POST /api/v1/users/passwordchange     (admin)  → fija la contraseña de otro usuario y BORRA su sesión
 *   POST /api/v1/login                             → { cookies: [{ key: "session_token", value }] }
 *   POST /api/v1/logout                   (sesión) → invalida la sesión
 *   GET  /api/v1/users/getinfo                     → usuario dueño de la credencial
 *   GET  /api/v1/users/generateapikey     (sesión) → apikey nueva de la propia cuenta
 */

export class ShuffleError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createShuffleClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 15000 }) {
  async function call(method, path, { body, bearer = apiKey, cookie, forwardedFor } = {}) {
    const headers = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Shuffle limita /login a 4 por minuto e IP (X-Forwarded-For): se pasa la IP del navegador
    // para que el límite sea por persona y no global para el puente.
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  function ensureOk(result, code) {
    if (result.status === 429) throw new ShuffleError('SHUFFLE_RATE_LIMITED', 429);
    if (result.status !== 200 || (result.json && result.json.success === false)) {
      throw new ShuffleError(code, result.status);
    }
    return result.json;
  }

  return {
    async whoami(bearer = apiKey) {
      return ensureOk(await call('GET', '/api/v1/users/getinfo', { bearer }), 'SHUFFLE_GETINFO_FAILED');
    },
    async findUser(username, bearer = apiKey) {
      const json = ensureOk(await call('GET', '/api/v1/getusers', { bearer }), 'SHUFFLE_GETUSERS_FAILED');
      const users = Array.isArray(json) ? json : [];
      return users.find((user) => String(user.username ?? '').toLowerCase() === username) ?? null;
    },
    async register(username, password, bearer = apiKey) {
      ensureOk(await call('POST', '/api/v1/register', { bearer, body: { username, password } }), 'SHUFFLE_REGISTER_FAILED');
    },
    async setRole(userId, role, bearer = apiKey) {
      ensureOk(
        await call('PUT', '/api/v1/users/updateuser', { bearer, body: { user_id: userId, role } }),
        'SHUFFLE_SET_ROLE_FAILED',
      );
    },
    async setPassword(username, password, bearer = apiKey) {
      ensureOk(
        await call('POST', '/api/v1/users/passwordchange', {
          bearer,
          body: { username, newpassword: password, newpassword2: password, currentpassword: '' },
        }),
        'SHUFFLE_SET_PASSWORD_FAILED',
      );
    },
    /** GET: genera la API key de la PROPIA credencial (Shuffle no deja generarla para otro usuario). */
    async generateOwnApiKey(bearer = apiKey) {
      const json = ensureOk(await call('GET', '/api/v1/users/generateapikey', { bearer }), 'SHUFFLE_APIKEY_FAILED');
      return json.apikey;
    },
    /** Devuelve el token de sesión o null si la contraseña no vale. */
    async login(username, password, forwardedFor) {
      const result = await call('POST', '/api/v1/login', { bearer: null, body: { username, password }, forwardedFor });
      if (result.status === 429) throw new ShuffleError('SHUFFLE_RATE_LIMITED', 429);
      if (result.status === 401) return null;
      if (result.status === 409 || result.json?.reason === 'MFA_SETUP' || result.json?.reason === 'MFA_REDIRECT') {
        throw new ShuffleError('SHUFFLE_MFA_REQUIRED', result.status);
      }
      if (result.status !== 200 || result.json?.success !== true) throw new ShuffleError('SHUFFLE_LOGIN_FAILED', result.status);
      const cookies = Array.isArray(result.json.cookies) ? result.json.cookies : [];
      const token = cookies.find((item) => item?.key === 'session_token')?.value;
      if (typeof token !== 'string' || token.length === 0) throw new ShuffleError('SHUFFLE_LOGIN_NO_SESSION', 200);
      return token;
    },
    async logout(sessionToken) {
      const result = await call('POST', '/api/v1/logout', { bearer: null, cookie: `session_token=${sessionToken}` });
      return result.status;
    },
  };
}
