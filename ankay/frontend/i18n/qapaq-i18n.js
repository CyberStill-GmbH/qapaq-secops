/*
 * Copyright QAPAQ. Ankay — capa de presentación en español y marca (overlay sobre Shuffle 2.3.0).
 *
 * Traduce en el DOM, ya renderizado, SOLO textos de interfaz que coinciden exactamente con el
 * diccionario (más unos pocos patrones). No toca el código de Shuffle ni sus datos: React sigue
 * comparando sus propios literales en inglés, el backend recibe lo mismo y los nombres de apps
 * (Shuffle Tools, Shuffle AI…) no cambian. Por eso se hace aquí y no en el código fuente: muchas
 * etiquetas de Shuffle también se usan como claves (`item.label.toLowerCase()`).
 *
 * Además: «Shuffle» visible → «Ankay», y se ocultan los elementos de marketing y el «Logout»
 * propio de Shuffle (la sesión la gobierna QAPAQ SecOps; decisión B11).
 *
 * Se sirve desde public/ (CSP script-src 'self') y lo carga index.html (sso-overlay.mjs).
 */
(function (root) {
  'use strict';

  var DICT = {
    // Navegación principal
    Automate: 'Automatizar',
    Usecases: 'Casos de uso',
    'Use Cases': 'Casos de uso',
    Workflows: 'Flujos',
    Apps: 'Apps',
    Agents: 'Agentes',
    Content: 'Contenido',
    Documentation: 'Documentación',
    Docs: 'Documentación',
    Admin: 'Administración',
    Forms: 'Formularios',
    Datastore: 'Almacén de datos',
    Files: 'Archivos',
    Notifications: 'Notificaciones',
    'Runtime Locations': 'Ubicaciones de ejecución',
    Partners: 'Socios',
    Search: 'Buscar',
    Dashboard: 'Panel',
    'Getting Started': 'Primeros pasos',
    'Tenant Admin': 'Administración del tenant',
    'User Account': 'Mi cuenta',
    About: 'Acerca de',
    'Version:': 'Versión:',
    Overview: 'Resumen',
    // Lista de flujos
    Discover: 'Descubrir',
    'Discover Workflows': 'Descubrir flujos',
    'Tenant Workflows': 'Flujos del tenant',
    'My Workflows': 'Mis flujos',
    'Community Workflows': 'Flujos de la comunidad',
    'Org Forms': 'Formularios de la organización',
    'All Usecases': 'Todos los casos de uso',
    'Create Workflow': 'Crear flujo',
    'Create workflow': 'Crear flujo',
    'New Workflow': 'Nuevo flujo',
    'Search Workflows': 'Buscar flujos',
    'No workflows found in this org. Feel free to look into our public workflows!':
      'No hay flujos en esta organización. Puedes revisar los flujos públicos.',
    'Explore Workflow Runs': 'Explorar ejecuciones',
    'Show/Hide Workflow Runs for top workflows': 'Mostrar u ocultar ejecuciones de los flujos principales',
    'Show/Hide Workflow image': 'Mostrar u ocultar la imagen del flujo',
    'List view (Org Workflows only)': 'Vista de lista (solo flujos de la organización)',
    'Import workflows': 'Importar flujos',
    'Import workflows from URL': 'Importar flujos desde una URL',
    'Import Workflow': 'Importar flujo',
    'Edit Workflow': 'Editar flujo',
    'Edit workflow': 'Editar flujo',
    'Delete Workflow': 'Eliminar flujo',
    'Duplicate Workflow': 'Duplicar flujo',
    'Export Workflow': 'Exportar flujo',
    'Publish Workflow': 'Publicar flujo',
    Name: 'Nombre',
    Description: 'Descripción',
    Tags: 'Etiquetas',
    Usecase: 'Caso de uso',
    Status: 'Estado',
    Owner: 'Propietario',
    Created: 'Creado',
    Updated: 'Actualizado',
    Edited: 'Editado',
    // Editor de flujos
    Save: 'Guardar',
    'Save Changes': 'Guardar cambios',
    'Save changes': 'Guardar cambios',
    Saved: 'Guardado',
    'Workflow saved': 'Flujo guardado',
    Run: 'Ejecutar',
    'Run Workflow': 'Ejecutar flujo',
    'Test Workflow': 'Probar flujo',
    'Test Execution': 'Ejecución de prueba',
    'Execute workflow': 'Ejecutar flujo',
    'Explore executions': 'Explorar ejecuciones',
    'Explore Executions': 'Explorar ejecuciones',
    Executions: 'Ejecuciones',
    Execution: 'Ejecución',
    'Execution Argument': 'Argumento de ejecución',
    'Provide an execution argument': 'Indica un argumento de ejecución',
    'Runtime Argument': 'Argumento de ejecución',
    Triggers: 'Disparadores',
    Trigger: 'Disparador',
    Conditions: 'Condiciones',
    Condition: 'Condición',
    Parameters: 'Parámetros',
    Result: 'Resultado',
    Results: 'Resultados',
    Environment: 'Entorno',
    Details: 'Detalles',
    Information: 'Información',
    Warning: 'Advertencia',
    Delay: 'Espera',
    Comment: 'Comentario',
    'Action Logs': 'Registro de acciones',
    'Learn more': 'Más información',
    'Find out here': 'Más información',
    'Select the Startnode': 'Elige el nodo inicial',
    'Select a workflow to run': 'Elige un flujo para ejecutar',
    'Wait for results': 'Esperar resultados',
    'Exit on Error': 'Detener ante error',
    'Skip Notifications': 'Omitir notificaciones',
    'Start from top': 'Empezar desde arriba',
    'Workflow Variable': 'Variable del flujo',
    'Runtime Variable': 'Variable de ejecución',
    'Apps need to be activated': 'Hay que activar las apps',
    'What would you like to do?': '¿Qué quieres hacer?',
    'This menu is used to control the workflow itself.': 'Este menú controla el propio flujo.',
    Authentication: 'Autenticación',
    'Authentication headers': 'Cabeceras de autenticación',
    'Change Active Organization': 'Cambiar de organización',
    Yes: 'Sí',
    No: 'No',
    Cancel: 'Cancelar',
    Close: 'Cerrar',
    Delete: 'Eliminar',
    Edit: 'Editar',
    Update: 'Actualizar',
    Remove: 'Quitar',
    Submit: 'Enviar',
    Confirm: 'Confirmar',
    Continue: 'Continuar',
    Back: 'Atrás',
    Next: 'Siguiente',
    Add: 'Añadir',
    Create: 'Crear',
    Upload: 'Subir',
    Download: 'Descargar',
    Import: 'Importar',
    Export: 'Exportar',
    Activate: 'Activar',
    Deactivate: 'Desactivar',
    Enable: 'Activar',
    Disable: 'Desactivar',
    Select: 'Seleccionar',
    'Clear All': 'Limpiar todo',
    Clear: 'Limpiar',
    Open: 'Abrir',
    Preferences: 'Preferencias',
    Settings: 'Ajustes',
    Loading: 'Cargando',
    'Loading...': 'Cargando…',
    // Apps
    'Organization Apps': 'Apps de la organización',
    'My Apps': 'Mis apps',
    'All Apps': 'Todas las apps',
    'Discover Public Apps': 'Descubrir apps públicas',
    'All Categories': 'Todas las categorías',
    'All Labels': 'Todas las etiquetas',
    'Create an App': 'Crear una app',
    'Search org apps': 'Buscar apps de la organización',
    'Reload apps locally': 'Recargar apps',
    'View app details': 'Ver detalles de la app',
    'No Apps Found': 'No se encontraron apps',
    "Can't find what you're looking for?": '¿No encuentras lo que buscas?',
    'Filter By': 'Filtrar por',
    Category: 'Categoría',
    Labels: 'Etiquetas',
    'Created With': 'Creado con',
    'Created By': 'Creado por',
    Workflow: 'Flujo',
    App: 'App',
    Creators: 'Creadores',
    // Casos de uso
    'Selected apps': 'Apps seleccionadas',
    'No apps selected': 'Ninguna app seleccionada',
    'Find apps': 'Buscar apps',
    'Ingest & Tool Setup': 'Ingesta y configuración de herramientas',
    'Connect your tools and get data flowing in. Start here.':
      'Conecta tus herramientas y empieza a recibir datos. Empieza aquí.',
    'Context & Correlation': 'Contexto y correlación',
    'Enrich alerts with intelligence, assets, and identity data.':
      'Enriquece las alertas con inteligencia, activos e identidad.',
    'Agents & Response Actions': 'Agentes y acciones de respuesta',
    'Automate containment, notifications, and remediation.':
      'Automatiza la contención, las notificaciones y la remediación.',
    'Email reports': 'Reportes por correo',
    'SIEM alerts': 'Alertas del SIEM',
    'EDR alerts': 'Alertas del EDR',
    'Vulnerability Ingestion': 'Ingesta de vulnerabilidades',
    'Configure Vulnerabilities': 'Configurar vulnerabilidades',
    'IOC feeds': 'Fuentes de IOC',
    'Threat Intel': 'Inteligencia de amenazas',
    Enrichment: 'Enriquecimiento',
    'Vulnerability Correlation': 'Correlación de vulnerabilidades',
    'Incident Routing Rules': 'Reglas de enrutamiento de incidentes',
    'Communication & Cases': 'Comunicación y casos',
    'Forward Incidents': 'Reenviar incidentes',
    'Assign & Escalate': 'Asignar y escalar',
    'Schedules & Phone Notifications': 'Turnos y avisos telefónicos',
    Communication: 'Comunicación',
    'Host Monitoring': 'Monitoreo de hosts',
    'Deploy Host Monitor': 'Desplegar monitor de host',
    'AI Incident Handling': 'Gestión de incidentes con IA',
    Cases: 'Casos',
    Assets: 'Activos',
    // Primeros pasos / estados vacíos
    'Find relevant apps': 'Busca las apps que necesitas',
    'and start your automation journey': 'y empieza a automatizar',
    'Use-Case ideas': 'ideas de casos de uso',
    'workflows made by other creators': 'flujos de otras personas',
    'creating your first workflow': 'creando tu primer flujo',
    'reading the docs.': 'leyendo la documentación.',
    'Configure your organization name': 'Configura el nombre de tu organización',
    'in the admin panel': 'en el panel de administración',
    'Invite your team': 'Invita a tu equipo',
    'Invite Users': 'Invitar usuarios',
    'Need help?': '¿Necesitas ayuda?',
    // Panel (dashboard)
    Daily: 'Diario',
    Monthly: 'Mensual',
    Last: 'Últimos',
    '30 days': '30 días',
    '7 days': '7 días',
    Successful: 'Correctas',
    Failed: 'Fallidas',
    'Build a workflow': 'Crear un flujo',
    'Successful Workflow Runs': 'Ejecuciones correctas',
    'Failed Workflow Runs': 'Ejecuciones fallidas',
    'Workflow Activity': 'Actividad de los flujos',
    'Custom Stats': 'Estadísticas personalizadas',
    'Find your stat': 'Busca una estadística',
    'Add custom stats': 'Añadir estadística',
    'Not enough workflow runs in this range to chart trends yet':
      'Aún no hay suficientes ejecuciones en este periodo para mostrar tendencias',
    // Administración
    'App auth': 'Credenciales de apps',
    Tenants: 'Tenants',
    'Tenant Configuration': 'Configuración del tenant',
    'Tenant overview': 'Resumen del tenant',
    'Billing & Stats': 'Uso y estadísticas',
    'Credentials are encrypted.': 'Las credenciales se guardan cifradas.',
    'Backup workflows': 'Respaldar flujos',
    'Backup apps': 'Respaldar apps',
    Users: 'Usuarios',
    Role: 'Rol',
    Username: 'Usuario',
    Password: 'Contraseña',
  };

  /** Patrones con partes variables (números, nombres). */
  var PATTERNS = [
    [/^Download ALL workflows \((\d+)\)$/u, 'Descargar todos los flujos ($1)'],
    [/^Notifications \($/u, 'Notificaciones ('],
    [/^Welcome to Ankay!?$/u, 'Te damos la bienvenida a Ankay'],
    [/^Getting Started with Ankay$/u, 'Primeros pasos con Ankay'],
    [/^Learn to use Ankay by$/u, 'Aprende a usar Ankay'],
  ];

  /** Marketing de Shuffle y su propio logout: se ocultan (la sesión la gobierna QAPAQ SecOps). */
  var HIDE = { 'Book a Demo': 1, 'Join Discord community': 1, 'Discord Chat': 1, Logout: 1, 'Log out': 1 };

  // «Shuffle» como marca visible; los nombres de apps del backend se conservan.
  var BRAND = /(^|[^A-Za-z0-9_./-])Shuffle(?![A-Za-z0-9_-])(?! (?:Tools|DB|AI|Subflow)\b)/gu;
  // Texto que no se toca (código, editores, valores). Los atributos (placeholder…) sí se traducen
  // también en INPUT y TEXTAREA; solo se saltan SCRIPT y STYLE.
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|INPUT|SVG)$/iu;
  var SKIP_ATTRS = /^(SCRIPT|STYLE|NOSCRIPT)$/iu;
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function translate(text) {
    var trimmed = text.trim();
    if (!trimmed) return null;
    var out = Object.prototype.hasOwnProperty.call(DICT, trimmed) ? DICT[trimmed] : null;
    if (out === null) {
      var branded = trimmed.replace(BRAND, '$1Ankay');
      for (var i = 0; i < PATTERNS.length; i += 1) {
        if (PATTERNS[i][0].test(branded)) {
          out = branded.replace(PATTERNS[i][0], PATTERNS[i][1]);
          break;
        }
      }
      if (out === null && branded !== trimmed) out = branded;
    }
    if (out === null || out === trimmed) return null;
    var start = text.indexOf(trimmed);
    return text.slice(0, start) + out + text.slice(start + trimmed.length);
  }

  function inEditor(el) {
    return !!(el && el.closest && el.closest('[contenteditable="true"],.cm-editor,.monaco-editor,.ace_editor,.CodeMirror'));
  }

  function hideIfMarketing(el, text) {
    if (!el || !HIDE[text.trim()]) return;
    var target = el.closest('li,button,a,[role="menuitem"]') || el;
    if (target.id === 'qapaq-back-to-siem') return;
    // Atributo + regla CSS (no estilo inline): React reescribe `style` al volver a renderizar.
    target.setAttribute('data-qapaq-hidden', '');
  }

  function fixText(node) {
    var parent = node.parentElement;
    if (!parent || SKIP.test(parent.tagName) || inEditor(parent)) return;
    hideIfMarketing(parent, node.nodeValue);
    var next = translate(node.nodeValue);
    if (next !== null) node.nodeValue = next;
  }

  function fixAttrs(el) {
    if (inEditor(el)) return;
    for (var i = 0; i < ATTRS.length; i += 1) {
      var value = el.getAttribute(ATTRS[i]);
      if (!value) continue;
      var next = translate(value);
      if (next !== null) el.setAttribute(ATTRS[i], next);
    }
  }

  function walk(rootNode) {
    if (rootNode.nodeType === 3) return fixText(rootNode);
    if (rootNode.nodeType !== 1 || SKIP_ATTRS.test(rootNode.tagName)) return;
    fixAttrs(rootNode);
    var doc = rootNode.ownerDocument;
    var walker = doc.createTreeWalker(rootNode, 5 /* ELEMENT | TEXT */);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) fixText(node);
      else if (!SKIP_ATTRS.test(node.tagName)) fixAttrs(node);
    }
  }

  function start(doc) {
    doc.documentElement.setAttribute('lang', 'es');
    var style = doc.createElement('style');
    style.textContent = '[data-qapaq-hidden]{display:none!important}';
    doc.head.appendChild(style);
    walk(doc.body);
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i += 1) {
        var m = mutations[i];
        if (m.type === 'characterData') fixText(m.target);
        else if (m.type === 'attributes') fixAttrs(m.target);
        else for (var j = 0; j < m.addedNodes.length; j += 1) walk(m.addedNodes[j]);
      }
    });
    observer.observe(doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
    // Título de la pestaña
    var fixTitle = function () {
      var t = translate(doc.title);
      if (t !== null) doc.title = t;
    };
    fixTitle();
    var head = doc.querySelector('title');
    if (head) new MutationObserver(fixTitle).observe(head, { childList: true, characterData: true, subtree: true });
  }

  var api = { translate: translate, DICT: DICT, HIDE: HIDE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () {
        start(root.document);
      });
    } else start(root.document);
  }
})(typeof window !== 'undefined' ? window : null);
