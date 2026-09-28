export interface PublicConfig {
  readonly appName: 'QAPAQ SecOps';
  readonly basePath: '/' | '/secops/';
}

/** Valores públicos de un conjunto aprobado; sin configuración del backend ni URLs arbitrarias. */
export function parsePublicConfig(input: unknown): PublicConfig {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('appName' in input) ||
    input.appName !== 'QAPAQ SecOps' ||
    !('basePath' in input) ||
    (input.basePath !== '/' && input.basePath !== '/secops/')
  ) {
    throw new Error('PUBLIC_CONFIG_INVALID');
  }
  return Object.freeze({ appName: input.appName, basePath: input.basePath });
}
