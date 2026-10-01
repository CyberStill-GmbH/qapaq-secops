/**
 * C-25 — origen de red confiable.
 *
 * La IP del cliente solo es un dato de seguridad si se deriva de una cadena de proxies
 * conocida. `X-Forwarded-For` lo escribe cualquiera: si se lee de izquierda a derecha,
 * basta con enviar `X-Forwarded-For: 10.20.0.1` para aparecer dentro de la red QAPAQ.
 *
 * Por eso la cadena se recorre de derecha a izquierda —del salto más cercano al más
 * lejano— y se detiene en el primer salto que no sea un proxy confiable. Ese es el
 * cliente. Lo que haya escrito antes es texto sin autoridad.
 */

export const NETWORK_DECISIONS = ['inside', 'outside', 'untrusted_chain'] as const;
export type NetworkDecisionCode = (typeof NETWORK_DECISIONS)[number];

export interface NetworkPolicy {
  /** CIDR de la red QAPAQ aprobada (oficinas y VPN). */
  readonly allowedCidrs: readonly string[];
  /** Proxies e ingress cuya cabecera sí tiene autoridad. */
  readonly trustedProxyCidrs: readonly string[];
}

export interface NetworkEvaluation {
  readonly decision: NetworkDecisionCode;
  readonly clientIp: string | null;
  readonly detail: string;
}

interface ParsedAddress {
  readonly value: bigint;
  readonly bits: 32 | 128;
}

function parseIpv4(address: string): ParsedAddress | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return { value, bits: 32 };
}

function parseIpv6(address: string): ParsedAddress | undefined {
  // Forma mapeada (::ffff:10.0.0.1): se normaliza a IPv4 para no tener dos políticas.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (mapped?.[1]) return parseIpv4(mapped[1]);
  if (!address.includes(':')) return undefined;
  const [head = '', tail = '', ...rest] = address.split('::');
  if (rest.length > 0) return undefined;
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const explicit = address.includes('::')
    ? [
        ...headGroups,
        ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
        ...tailGroups,
      ]
    : address.split(':');
  if (explicit.length !== 8) return undefined;
  let value = 0n;
  for (const group of explicit) {
    if (!/^[0-9a-f]{1,4}$/iu.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { value, bits: 128 };
}

export function parseAddress(address: string): ParsedAddress | undefined {
  const trimmed = address.trim().replace(/^\[|\]$/gu, '');
  return trimmed.includes(':') ? parseIpv6(trimmed) : parseIpv4(trimmed);
}

export function matchesCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  if (!network || prefixText === undefined) return false;
  const parsedNetwork = parseAddress(network);
  const parsedAddress = parseAddress(address);
  if (!parsedNetwork || !parsedAddress) return false;
  if (parsedNetwork.bits !== parsedAddress.bits) return false;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsedNetwork.bits) return false;
  const mask =
    prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(parsedNetwork.bits - prefix);
  return (parsedNetwork.value & mask) === (parsedAddress.value & mask);
}

function inAny(address: string, cidrs: readonly string[]): boolean {
  return cidrs.some((cidr) => matchesCidr(address, cidr));
}

export interface RequestOrigin {
  /** IP de la conexión TCP. Es el único dato que el cliente no puede falsificar. */
  readonly remoteAddress: string;
  readonly forwardedFor?: string | readonly string[];
}

export function resolveClientIp(
  origin: RequestOrigin,
  policy: NetworkPolicy,
): { readonly clientIp: string | null; readonly chainTrusted: boolean } {
  if (!inAny(origin.remoteAddress, policy.trustedProxyCidrs)) {
    // La conexión no viene de un proxy conocido: la cabecera no tiene autoridad alguna.
    return { clientIp: origin.remoteAddress, chainTrusted: true };
  }
  const forwarded = origin.forwardedFor;
  const header: string =
    forwarded === undefined ? '' : typeof forwarded === 'string' ? forwarded : forwarded.join(',');
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  if (hops.length === 0) return { clientIp: origin.remoteAddress, chainTrusted: true };
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!;
    if (!parseAddress(hop)) return { clientIp: null, chainTrusted: false };
    if (!inAny(hop, policy.trustedProxyCidrs)) return { clientIp: hop, chainTrusted: true };
  }
  // Todos los saltos declarados son proxies confiables: no hay cliente identificable.
  return { clientIp: null, chainTrusted: false };
}

export function evaluateNetwork(origin: RequestOrigin, policy: NetworkPolicy): NetworkEvaluation {
  const { clientIp, chainTrusted } = resolveClientIp(origin, policy);
  if (!chainTrusted || !clientIp) {
    return {
      decision: 'untrusted_chain',
      clientIp,
      detail: 'La cadena de reenvío no permite determinar el cliente.',
    };
  }
  return inAny(clientIp, policy.allowedCidrs)
    ? { decision: 'inside', clientIp, detail: 'Origen dentro de la red QAPAQ.' }
    : { decision: 'outside', clientIp, detail: 'Origen fuera de la red QAPAQ.' };
}
