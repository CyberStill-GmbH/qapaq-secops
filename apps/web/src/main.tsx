import { bootstrap } from './bootstrap/bootstrap.js';
import './app/styles.css';
import './app/soc-shell.css';
import './app/soc-data.css';
import './app/soc-overlays.css';
import './app/soc-responsive.css';

const element = document.getElementById('root');
if (element) {
  bootstrap(element, __QAPAQ_PUBLIC_CONFIG__);
} else {
  const fallback = document.createElement('main');
  fallback.setAttribute('role', 'alert');
  fallback.textContent = 'No se pudo iniciar la interfaz. Recarga la página.';
  document.body.append(fallback);
}
