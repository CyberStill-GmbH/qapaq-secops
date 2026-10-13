import { useState } from 'react';
import { CookieIcon } from '@phosphor-icons/react/dist/csr/Cookie';

const ACKNOWLEDGEMENT_KEY = 'qapaq.cookie-notice.technical.v1';

export function CookieNotice(): React.JSX.Element | null {
  const [visible, setVisible] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(ACKNOWLEDGEMENT_KEY) !== 'accepted';
    } catch {
      return true;
    }
  });

  if (!visible) return null;

  function accept(): void {
    try {
      window.localStorage.setItem(ACKNOWLEDGEMENT_KEY, 'accepted');
    } catch {
      // Keep the notice dismissible if browser storage is restricted.
    }
    setVisible(false);
  }

  return (
    <aside className="qapaq-cookie-notice" aria-labelledby="cookie-notice-title">
      <div className="qapaq-cookie-notice__mark" aria-hidden="true">
        <CookieIcon weight="duotone" />
      </div>
      <div className="qapaq-cookie-notice__content">
        <h2 id="cookie-notice-title">Cookies necesarias</h2>
        <p>
          QAPAQ usa cookies técnicas para mantener tu sesión institucional y proteger el inicio de
          sesión.
        </p>
        <details>
          <summary>Ver para qué se usan</summary>
          <ul>
            <li>
              <code>qapaq_session</code>: mantiene la sesión autenticada.
            </li>
            <li>
              <code>qapaq_oidc_flow_…</code>: vincula temporalmente el inicio de sesión con este
              navegador.
            </li>
          </ul>
        </details>
        <button type="button" onClick={accept}>
          Aceptar cookies necesarias
        </button>
      </div>
    </aside>
  );
}
