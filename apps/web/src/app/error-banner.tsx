import type { ApiErrorBody } from '@qapaq/contracts';

/**
 * C-27 — presentación de un error del catálogo.
 *
 * Muestra el mensaje aprobado, la acción sugerida, el enlace de ayuda y el
 * `correlationId`. No se inventa texto a partir del código: si el catálogo cambia, la
 * consola cambia con él y no al revés.
 */

const ACTION_LABELS: Readonly<Record<string, string>> = {
  sign_in_again: 'Iniciar sesión',
  register_passkey: 'Registrar passkey',
  use_qapaq_network: 'Conectarse a la red QAPAQ',
  retry_later: 'Reintentar',
  reload_resource: 'Recargar el elemento',
  correct_input: 'Corregir los datos',
  contact_support: 'Contactar a soporte',
};

export function ErrorBanner({
  error,
  onAction,
}: {
  readonly error: ApiErrorBody;
  readonly onAction?: () => void;
}): React.JSX.Element {
  return (
    <section role="alert" className="qapaq-error" data-error-code={error.code}>
      <p className="qapaq-error__message">{error.message}</p>
      <p className="qapaq-error__meta">
        <a href={error.helpRef} rel="noreferrer noopener" target="_blank">
          Ver ayuda
        </a>
        <span data-testid="correlation-id"> · Referencia: {error.correlationId}</span>
      </p>
      {onAction ? (
        <button type="button" onClick={onAction}>
          {ACTION_LABELS[error.action] ?? 'Continuar'}
        </button>
      ) : null}
    </section>
  );
}
