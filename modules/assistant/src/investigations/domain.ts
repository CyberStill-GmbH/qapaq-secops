/**
 * Analista IA — explicación por dominio (sin modelo).
 *
 * Cada alerta se explica en lenguaje llano según su dominio: qué pasó, por qué importa y qué
 * hacer, con señales propias del dominio (KEV/EPSS de una vulnerabilidad, el disco que se llena,
 * la ruta de FIM que cambió…). Pura: solo lee `bundle.subject` (lista blanca de campos) y la
 * regla del conocimiento SOC.
 */

import type { AssessmentSignal } from './assessment.js';
import type { EvidenceBundle, EvidenceDomain } from './types.js';

export interface DomainExplanation {
  readonly domain: EvidenceDomain;
  /** Qué pasó, en una o dos frases. */
  readonly whatHappened: string;
  /** Por qué importa (impacto si es real). */
  readonly whyItMatters: string;
  /** Pasos concretos, en orden. */
  readonly actions: readonly string[];
  readonly risk: readonly AssessmentSignal[];
  readonly benign: readonly AssessmentSignal[];
  /**
   * El dominio confirma por sí mismo que el problema es real (hallazgo de vulnerabilidad,
   * falla operativa vigente): no es una sospecha a validar sino algo a resolver.
   */
  readonly confirmedIssue: boolean;
  /** Etiqueta del dominio para el resumen. */
  readonly label: string;
}

type Details = Readonly<Record<string, string | number | boolean>>;

const text = (details: Details, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = details[key];
    if (value !== undefined && value !== '' && value !== null) return String(value);
  }
  return null;
};
const truthy = (value: string | null): boolean => value !== null && /^(true|yes|si|sí|1)$/iu.test(value);
const number = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const PLATFORM_GUIDE: Readonly<Record<string, { why: string; actions: readonly string[] }>> = {
  host_disk: {
    why: 'Si el disco se llena, el Indexer deja de escribir (bloqueo por watermark) y se pierden alertas y eventos nuevos.',
    actions: [
      'Liberar espacio: borrar imágenes y capas de Docker sin uso (docker image prune) y releases antiguos de /opt/qapaq/releases.',
      'Revisar los índices de alertas más antiguos y aplicar o acortar la retención.',
      'Si el crecimiento es sostenido, ampliar el volumen EBS.',
    ],
  },
  indexer_disk: {
    why: 'Por encima del watermark alto el Indexer deja de asignar shards y, en el de inundación, bloquea las escrituras: se pierde la ingesta.',
    actions: [
      'Borrar o cerrar índices antiguos y revisar la política de retención del Indexer.',
      'Ampliar el volumen del Indexer si el uso es legítimo.',
    ],
  },
  edge_unreachable: {
    why: 'El portal del SOC no responde: las personas no pueden trabajar las alertas y los enlaces de los avisos fallan.',
    actions: [
      'Comprobar el contenedor edge (nginx) y la API: estado, reinicios y logs.',
      'Revisar el ALB y el certificado; si coincidió con un despliegue, verificar que terminó bien.',
    ],
  },
  service_down: {
    why: 'Un servicio esencial caído detiene parte del SOC (ingesta, API, notificaciones o el dashboard).',
    actions: [
      'Ver por qué se detuvo: docker ps y docker logs del contenedor.',
      'Reiniciarlo si es seguro; si reincide, revisar memoria, disco o la última configuración aplicada.',
    ],
  },
  ingestion_delayed: {
    why: 'QAPAQ va detrás de la fuente de alertas: las alertas nuevas llegan tarde y los avisos se retrasan.',
    actions: ['Revisar el cursor y los errores de la ingesta en la salud de operaciones; comprobar la carga del Indexer.'],
  },
  ingestion_stalled: {
    why: 'La ingesta está detenida: nada nuevo llega a QAPAQ y no salen avisos.',
    actions: ['Revisar la API (ingesta) y el Indexer; reiniciar la ingesta y vigilar que el cursor avance.'],
  },
  canary_missing: {
    why: 'Un evento sintético de prueba no completó el recorrido: ese canal podría no estar entregando datos reales.',
    actions: ['Revisar el agente o colector de ese canal y la regla que lo recibe; repetir el canario tras corregir.'],
  },
  indexer_status: {
    why: 'Shards sin asignar: si cae un nodo, parte de los datos queda inaccesible.',
    actions: ['Revisar _cluster/allocation/explain y el espacio en disco del Indexer.'],
  },
  source_silent: {
    why: 'Una fuente dejó de enviar datos: hay un punto ciego hasta que vuelva.',
    actions: ['Revisar credenciales y la última ejecución del colector de esa fuente.'],
  },
  collector_failing: {
    why: 'Un colector falla al leer su fuente: sus eventos no están llegando.',
    actions: ['Ver el error del colector (credencial vencida, permiso o cuota de la API) y corregirlo.'],
  },
};

const SENSITIVE_PATH = /(^|\/)(etc\/(ssh|sudoers|passwd|shadow|group|gshadow|crontab|cron\.|pam\.d|systemd|audit)|root\/\.ssh|home\/[^/]+\/\.ssh|authorized_keys|usr\/(s?bin)|^\/(s?bin)\/|boot\/)/u;
const EXPECTED_PATH = /^\/(opt\/qapaq\/releases|var\/lib\/(docker|containerd)|var\/cache|var\/log|tmp)\//u;

function vulnerability(details: Details): Omit<DomainExplanation, 'domain' | 'label'> {
  const risk: AssessmentSignal[] = [];
  const benign: AssessmentSignal[] = [];
  const cve = text(details, 'cve', 'title');
  const asset = text(details, 'asset', 'project_name');
  const kev = text(details, 'kev');
  const epss = number(text(details, 'epss'));
  const reason = text(details, 'reason') ?? '';
  const exploit = text(details, 'exploitMaturity', 'exploit') ?? '';
  const fixable = truthy(text(details, 'isFixable', 'isUpgradable', 'fix_available', 'fixable'));
  if (truthy(kev)) {
    risk.push({ code: 'KEV_EXPLOITED', text: 'CISA la incluye en su catálogo KEV: se está explotando activamente.' });
  }
  if (epss !== null && epss >= 0.1) {
    risk.push({ code: 'HIGH_EPSS', text: `Probabilidad de explotación (EPSS) alta: ${(epss * 100).toFixed(1)} % en 30 días.` });
  }
  if (/expuest|exposed|internet/iu.test(reason) && !/no_expuest|no expuest|not.exposed/iu.test(reason)) {
    risk.push({ code: 'EXPOSED_ASSET', text: 'El activo afectado está expuesto (accesible desde fuera).' });
  }
  if (/mature|maduro|attacked|weaponized/iu.test(exploit)) {
    risk.push({ code: 'MATURE_EXPLOIT', text: `Hay exploit público maduro (${exploit}).` });
  }
  if (!truthy(kev) && epss !== null && epss < 0.01) {
    benign.push({ code: 'LOW_EXPLOITABILITY', text: `Explotación poco probable (EPSS ${(epss * 100).toFixed(2)} %, fuera de KEV).` });
  }
  if (/no_expuest|no expuest|not.exposed/iu.test(reason)) {
    benign.push({ code: 'NOT_EXPOSED', text: 'El activo no está expuesto a Internet.' });
  }
  const where = asset ? ` en ${asset}` : '';
  const urgent = risk.some((signal) => signal.code === 'KEV_EXPLOITED' || signal.code === 'EXPOSED_ASSET');
  return {
    whatHappened: `Se detectó la vulnerabilidad ${cve ?? '(sin identificador)'}${where}.${reason ? ` Motivo de la prioridad: ${reason}.` : ''}`,
    whyItMatters: urgent
      ? 'Un atacante puede aprovecharla ya: hay explotación conocida o el activo está expuesto.'
      : 'Es un hallazgo real del inventario de dependencias; el riesgo depende de si se puede alcanzar y explotar.',
    actions: [
      fixable
        ? `Actualizar la dependencia o imagen afectada${where} a la versión corregida y redesplegar.`
        : `Buscar versión corregida o mitigación${where} (no se informó corrección disponible).`,
      urgent
        ? 'Plazo corto: tratarla como urgente (explotación activa o exposición); si no se puede parchear ya, mitigar (WAF, aislar o desactivar la función).'
        : 'Planificarla en el ciclo normal de parches según su prioridad.',
      'Cerrar la alerta solo cuando el escaneo siguiente ya no la reporte.',
    ],
    risk,
    benign,
    confirmedIssue: true,
  };
}

function platform(details: Details): Omit<DomainExplanation, 'domain' | 'label'> {
  const check = text(details, 'check') ?? '';
  const guide = PLATFORM_GUIDE[check];
  const status = text(details, 'status');
  const component = text(details, 'component');
  const summary = text(details, 'summary');
  const recovered = status !== null && /^(ok|recovered|resolved)$/iu.test(status);
  return {
    whatHappened: summary
      ? `${summary}${component ? ` (componente: ${component})` : ''}`
      : `Problema de plataforma${check ? ` «${check}»` : ''}${component ? ` en ${component}` : ''}.`,
    whyItMatters:
      guide?.why ??
      'Es un problema operativo de la plataforma QAPAQ (no un ataque): puede dejar al SOC sin visibilidad o sin avisos.',
    actions: recovered
      ? ['El chequeo ya informa recuperación: confirmar que se mantiene estable y cerrar.']
      : (guide?.actions ?? ['Revisar el componente afectado en la salud de operaciones y corregir la causa.']),
    risk: recovered
      ? []
      : [{ code: 'PLATFORM_PROBLEM', text: 'La plataforma informa el problema como vigente.' }],
    benign: recovered
      ? [{ code: 'PLATFORM_RECOVERED', text: 'El chequeo informa que el problema ya se recuperó.' }]
      : [],
    confirmedIssue: !recovered,
  };
}

function fileIntegrity(details: Details): Omit<DomainExplanation, 'domain' | 'label'> {
  const path = text(details, 'path') ?? '';
  const event = text(details, 'event') ?? 'modified';
  const process = text(details, 'process_name');
  const risk: AssessmentSignal[] = [];
  const benign: AssessmentSignal[] = [];
  if (SENSITIVE_PATH.test(path)) {
    risk.push({ code: 'SENSITIVE_PATH', text: `Cambió una ruta sensible (${path}): acceso, privilegios, persistencia o binarios del sistema.` });
  }
  if (EXPECTED_PATH.test(path)) {
    benign.push({ code: 'EXPECTED_PATH', text: `La ruta (${path}) cambia en operación normal (despliegues, contenedores, caché o logs).` });
  }
  if (process && /^(dpkg|apt|apt-get|unattended-upgr|yum|dnf|rpm)$/u.test(process)) {
    benign.push({ code: 'PACKAGE_MANAGER', text: `El cambio lo hizo el gestor de paquetes (${process}).` });
  }
  const verb = event === 'added' ? 'se creó' : event === 'deleted' ? 'se borró' : 'se modificó';
  return {
    whatHappened: `En el servidor ${verb} ${path || 'un archivo vigilado'}${process ? ` (proceso ${process})` : ''}.`,
    whyItMatters: risk.length > 0
      ? 'Un cambio no planificado en esta ruta es una técnica típica de persistencia o de escalada de privilegios.'
      : 'Es un cambio de archivo vigilado; casi siempre lo explican actualizaciones o despliegues.',
    actions: [
      'Confirmar si coincide con una actualización de paquetes, un despliegue o un cambio planificado a la misma hora.',
      risk.length > 0
        ? 'Si nadie lo explica: revisar el contenido del archivo, quién inició sesión en el host y abrir incidente.'
        : 'Si es habitual, proponer excluir la ruta del FIM para reducir ruido.',
    ],
    risk,
    benign,
    confirmedIssue: false,
  };
}

function rootcheck(details: Details): Omit<DomainExplanation, 'domain' | 'label'> {
  const file = text(details, 'file', 'full_log') ?? '';
  const docker = /\/var\/lib\/(docker|containerd)\//u.test(file);
  return {
    whatHappened: `Rootcheck marcó una anomalía en el host${text(details, 'title') ? `: ${text(details, 'title')}` : ''}${file ? ` (${file.slice(0, 120)})` : ''}.`,
    whyItMatters: docker
      ? 'Es el falso positivo conocido de las capas de Docker: cambian mientras rootcheck las recorre.'
      : 'Fuera de Docker, una anomalía de rootcheck puede indicar un rootkit o un archivo oculto: hay que comprobarla.',
    actions: docker
      ? ['Verificar que el agente tenga la política linux-servers al día (ignora /var/lib/docker) y cerrar.']
      : ['Comprobar el archivo o proceso señalado en el host (ls -la, ps, ss) y comparar con el estado conocido.', 'Si no se explica, aislar el host y abrir incidente.'],
    risk: docker ? [] : [{ code: 'ROOTCHECK_OUTSIDE_DOCKER', text: 'La anomalía está fuera de las capas de Docker.' }],
    benign: docker ? [{ code: 'DOCKER_OVERLAY', text: 'Coincide con el falso positivo conocido de las capas overlay de Docker.' }] : [],
    confirmedIssue: false,
  };
}

const LABEL: Readonly<Record<EvidenceDomain, string>> = {
  vulnerability: 'Vulnerabilidad',
  platform: 'Salud de la plataforma',
  file_integrity: 'Integridad de archivos',
  rootcheck: 'Anomalía del host',
  identity: 'Identidad y accesos',
  generic: 'Alerta',
};

/** Explicación por dominio; `null` si la evidencia no trae detalles del evento de la alerta. */
export function explainDomain(bundle: EvidenceBundle): DomainExplanation | null {
  const subject = bundle.subject;
  if (!subject) return null;
  const details = subject.details;
  const base =
    subject.domain === 'vulnerability'
      ? vulnerability(details)
      : subject.domain === 'platform'
        ? platform(details)
        : subject.domain === 'file_integrity'
          ? fileIntegrity(details)
          : subject.domain === 'rootcheck'
            ? rootcheck(details)
            : null;
  if (!base) return null;
  return { domain: subject.domain, label: LABEL[subject.domain], ...base };
}
