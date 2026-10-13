import { useCallback, useEffect, useState } from 'react';
import { AppleLogoIcon } from '@phosphor-icons/react/dist/csr/AppleLogo';
import { BellSimpleIcon } from '@phosphor-icons/react/dist/csr/BellSimple';
import { DeviceMobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile';
import { EnvelopeSimpleIcon } from '@phosphor-icons/react/dist/csr/EnvelopeSimple';
import { GoogleChromeLogoIcon } from '@phosphor-icons/react/dist/csr/GoogleChromeLogo';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { LaptopIcon } from '@phosphor-icons/react/dist/csr/Laptop';
import { MicrosoftTeamsLogoIcon } from '@phosphor-icons/react/dist/csr/MicrosoftTeamsLogo';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { api, type PushConfigView, type PushDeviceView } from '../../api/client.js';
import { Button, StatusChip } from './soc-ui.js';

type BrowserPermission = NotificationPermission | 'unsupported';

const LOCAL_DEVICE_ID_KEY = 'qapaq.push.device-id.v1';

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = window.atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function deviceIcon(service: string): React.JSX.Element {
  const host = service.toLowerCase();
  if (host.includes('apple') || host.includes('push.apple.com'))
    return <AppleLogoIcon aria-hidden="true" weight="regular" />;
  if (host.includes('google') || host.includes('fcm'))
    return <GoogleChromeLogoIcon aria-hidden="true" weight="regular" />;
  if (host.includes('windows') || host.includes('mozilla'))
    return <LaptopIcon aria-hidden="true" weight="regular" />;
  return <DeviceMobileIcon aria-hidden="true" weight="regular" />;
}

function formatDate(value: string | null): string {
  if (!value) return 'Sin entrega confirmada';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
}

function permissionLabel(permission: BrowserPermission): string {
  return permission === 'granted'
    ? 'Permiso concedido'
    : permission === 'denied'
      ? 'Permiso bloqueado en el navegador'
      : permission === 'default'
        ? 'Aún no solicitado'
        : 'Este navegador no admite avisos push';
}

function hasPushSupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

function isIosDevice(): boolean {
  return typeof navigator !== 'undefined' && /iPad|iPhone|iPod/u.test(navigator.userAgent);
}

export function PushNotificationSettingsPage({
  basePath,
}: {
  readonly basePath: '/' | '/secops/';
}): React.JSX.Element {
  const [config, setConfig] = useState<PushConfigView | null>(null);
  const [devices, setDevices] = useState<readonly PushDeviceView[]>([]);
  const [permission, setPermission] = useState<BrowserPermission>('unsupported');
  const [label, setLabel] = useState('Este dispositivo');
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'activate' | 'test' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [configResult, devicesResult] = await Promise.all([api.pushConfig(), api.pushDevices()]);
    if (!configResult.ok) {
      setError(`${configResult.error.message} · Ref. ${configResult.error.correlationId}`);
      setLoading(false);
      return;
    }
    if (!devicesResult.ok) {
      setError(`${devicesResult.error.message} · Ref. ${devicesResult.error.correlationId}`);
      setLoading(false);
      return;
    }
    setConfig(configResult.data);
    setDevices(devicesResult.data.items);
    let savedDeviceId: string | null = null;
    try {
      savedDeviceId = window.localStorage.getItem(LOCAL_DEVICE_ID_KEY);
    } catch {
      // Device list remains usable when browser storage is unavailable.
    }
    setLocalDeviceId(savedDeviceId);
    const currentDevice = devicesResult.data.items.find((device) => device.id === savedDeviceId);
    if (currentDevice) setLabel(currentDevice.label);
    setLoading(false);
  }, []);

  useEffect(() => {
    if ('Notification' in window) setPermission(window.Notification.permission);
    void load();
  }, [basePath, load]);

  async function activate(): Promise<void> {
    setBusy('activate');
    setError(null);
    setNotice(null);
    try {
      if (!config?.enabled || !config.vapidPublicKey) {
        setNotice('Los avisos al dispositivo no están disponibles en este ambiente.');
        return;
      }
      if (
        !window.isSecureContext ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        setPermission('unsupported');
        return;
      }
      if (label.trim().length < 1 || label.length > 80) {
        setError('El nombre debe tener entre 1 y 80 caracteres.');
        return;
      }
      let currentPermission = window.Notification.permission;
      if (currentPermission === 'default') {
        currentPermission = await window.Notification.requestPermission();
      }
      setPermission(currentPermission);
      if (currentPermission !== 'granted') return;
      const registration = await navigator.serviceWorker.register(`${basePath}sw.js`, {
        scope: basePath,
        updateViaCache: 'none',
      });
      let subscription = await registration.pushManager.getSubscription();
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey(config.vapidPublicKey) as BufferSource,
      });
      const result = await api.registerPushDevice({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.getKey('p256dh')
            ? btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')!)))
                .replace(/\+/gu, '-')
                .replace(/\//gu, '_')
                .replace(/=+$/gu, '')
            : '',
          auth: subscription.getKey('auth')
            ? btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')!)))
                .replace(/\+/gu, '-')
                .replace(/\//gu, '_')
                .replace(/=+$/gu, '')
            : '',
        },
        label: label.trim(),
      });
      if (!result.ok) {
        setError(`${result.error.message} · Ref. ${result.error.correlationId}`);
        return;
      }
      try {
        window.localStorage.setItem(LOCAL_DEVICE_ID_KEY, result.data.subscription.id);
      } catch {
        // Device registration remains valid when browser storage is unavailable.
      }
      setLocalDeviceId(result.data.subscription.id);
      setNotice('Este dispositivo ya puede recibir avisos importantes del SOC.');
      await load();
    } catch {
      setError(
        'No se pudo activar este dispositivo. Revisa el permiso del navegador y vuelve a intentarlo.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeDevice(device: PushDeviceView): Promise<void> {
    setBusy(device.id);
    setError(null);
    setNotice(null);
    const result = await api.revokePushDevice(device.id);
    if (!result.ok) {
      setError(`${result.error.message} · Ref. ${result.error.correlationId}`);
      setBusy(null);
      return;
    }
    try {
      if (window.localStorage.getItem(LOCAL_DEVICE_ID_KEY) === device.id) {
        const registration = await navigator.serviceWorker.getRegistration(basePath);
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
        window.localStorage.removeItem(LOCAL_DEVICE_ID_KEY);
        setLocalDeviceId(null);
      }
    } catch {
      setNotice(
        'QAPAQ dejó de enviar avisos a este dispositivo; el navegador no confirmó la baja local.',
      );
    }
    setDevices((current) => current.filter((item) => item.id !== device.id));
    setBusy(null);
  }

  async function sendTest(): Promise<void> {
    setBusy('test');
    setError(null);
    setNotice(null);
    const result = await api.sendPushTest();
    if (!result.ok) {
      setError(`${result.error.message} · Ref. ${result.error.correlationId}`);
    } else {
      setNotice(
        result.data.delivered > 0
          ? `El servicio push aceptó el aviso de prueba para ${result.data.delivered} dispositivo${result.data.delivered === 1 ? '' : 's'}.`
          : 'No se confirmó la entrega. Revisa el permiso del navegador y el estado del dispositivo.',
      );
    }
    setBusy(null);
  }

  const supported = hasPushSupport() && permission !== 'unsupported';
  const canActivate =
    Boolean(config?.enabled && config.vapidPublicKey) &&
    supported &&
    permission !== 'denied' &&
    (devices.length < (config?.maximumDevices ?? 0) ||
      devices.some((device) => device.id === localDeviceId));

  return (
    <section className="soc-page soc-push-settings" aria-labelledby="push-settings-title">
      <header className="soc-page-heading">
        <div>
          <h1 id="push-settings-title">Avisos en tus dispositivos</h1>
          <p>Activa avisos push para alertas P1 e incidentes críticos que puedes consultar.</p>
        </div>
        <span className="soc-page-heading__meta">Preferencia personal</span>
      </header>

      {error ? (
        <div className="soc-push-feedback soc-push-feedback--error" role="alert">
          <WarningIcon aria-hidden="true" weight="bold" />
          <span>{error}</span>
          <Button variant="ghost" onClick={() => void load()}>
            Reintentar
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p className="soc-push-feedback" role="status">
          {notice}
        </p>
      ) : null}

      {!config?.enabled && !loading ? (
        <div className="soc-push-unavailable" role="status">
          <InfoIcon aria-hidden="true" />
          <span>Avisos al dispositivo no disponibles en este ambiente.</span>
        </div>
      ) : null}

      <div className="soc-push-grid">
        <section className="soc-push-card" aria-labelledby="push-device-title">
          <div className="soc-push-card__header">
            <div className="soc-push-card__mark">
              <BellSimpleIcon aria-hidden="true" weight="duotone" />
            </div>
            <div>
              <h2 id="push-device-title">Este dispositivo</h2>
              <p>El permiso se solicita al activar, nunca al abrir esta página.</p>
            </div>
            <StatusChip
              state={permission === 'granted' ? 'ok' : permission === 'denied' ? 'fail' : 'neutral'}
            >
              {permissionLabel(permission)}
            </StatusChip>
          </div>

          <label className="soc-push-label" htmlFor="push-device-label">
            Nombre del dispositivo
            <input
              id="push-device-label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.currentTarget.value)}
              autoComplete="off"
              disabled={busy !== null}
            />
          </label>
          <div className="soc-push-actions">
            <Button
              variant="primary"
              onClick={() => void activate()}
              disabled={!canActivate || busy !== null || loading}
            >
              <BellSimpleIcon aria-hidden="true" />
              {busy === 'activate'
                ? 'Guardando…'
                : devices.some((device) => device.id === localDeviceId)
                  ? 'Actualizar nombre del dispositivo'
                  : 'Activar en este dispositivo'}
            </Button>
            {permission === 'denied' ? (
              <span className="soc-push-help">
                Cambia el permiso de avisos desde la configuración del navegador.
              </span>
            ) : null}
            {config && devices.length >= config.maximumDevices ? (
              <span className="soc-push-help">
                Alcanzaste el límite de {config.maximumDevices} dispositivos.
              </span>
            ) : null}
            {isIosDevice() ? (
              <span className="soc-push-help">
                En iOS, la recepción puede requerir añadir QAPAQ a la pantalla de inicio.
              </span>
            ) : null}
          </div>
        </section>

        <section className="soc-push-card soc-push-preview" aria-labelledby="push-preview-title">
          <div className="soc-push-card__header">
            <div className="soc-push-card__mark soc-push-card__mark--severity">
              <WarningIcon aria-hidden="true" weight="fill" />
            </div>
            <div>
              <h2 id="push-preview-title">Vista previa</h2>
              <p>El contenido se obtiene con tu sesión vigente.</p>
            </div>
          </div>
          <article className="soc-push-preview__notice" aria-label="Ejemplo de aviso push">
            <span className="soc-push-preview__glyph" aria-hidden="true">
              ◆
            </span>
            <div>
              <strong>Aviso crítico del SOC</strong>
              <span>P1 o incidente crítico · Abrir QAPAQ para investigar</span>
            </div>
          </article>
          <p className="soc-push-privacy">
            <ShieldCheckIcon aria-hidden="true" /> El servicio de push recibe una señal vacía. QAPAQ
            entrega el detalle tras validar tu sesión.
          </p>
        </section>

        <section className="soc-push-card soc-push-card--wide" aria-labelledby="push-devices-title">
          <div className="soc-push-card__section-heading">
            <div>
              <h2 id="push-devices-title">Mis dispositivos</h2>
              <p>Solo tú puedes quitar los dispositivos registrados en tu cuenta.</p>
            </div>
            <Button
              onClick={() => void sendTest()}
              disabled={busy !== null || loading || devices.length === 0}
            >
              <PaperPlaneTiltIcon aria-hidden="true" />
              {busy === 'test' ? 'Enviando…' : 'Enviar aviso de prueba'}
            </Button>
          </div>
          {loading ? (
            <p className="soc-push-empty" role="status">
              Cargando tus dispositivos…
            </p>
          ) : null}
          {!loading && devices.length === 0 ? (
            <p className="soc-push-empty">Aún no has activado avisos en ningún dispositivo.</p>
          ) : null}
          {devices.length > 0 ? (
            <ul className="soc-push-devices">
              {devices.map((device) => (
                <li key={device.id}>
                  <span className="soc-push-device-icon">{deviceIcon(device.service)}</span>
                  <span className="soc-push-device-main">
                    <strong>{device.label}</strong>
                    <small>{device.service}</small>
                  </span>
                  <span className="soc-push-device-date">
                    <strong>Última aceptación del servicio push</strong>
                    <time>{formatDate(device.lastSuccessAt)}</time>
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => void removeDevice(device)}
                    disabled={busy !== null}
                    aria-label={`Quitar ${device.label}`}
                  >
                    <TrashIcon aria-hidden="true" />
                    Quitar
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="soc-push-card soc-push-card--wide" aria-labelledby="push-policy-title">
          <div className="soc-push-card__section-heading">
            <div>
              <h2 id="push-policy-title">Política de avisos del SOC</h2>
              <p>Consulta de solo lectura; los avisos no reemplazan el acuse dentro de QAPAQ.</p>
            </div>
          </div>
          <div className="soc-push-policy">
            <div className="soc-push-policy__head">
              <span>Evento</span>
              <span>Roles</span>
              <span>Entrega</span>
            </div>
            <div>
              <strong>Alerta P1 creada</strong>
              <span>Analista · Líder SOC</span>
              <span className="soc-push-channels">
                <MicrosoftTeamsLogoIcon aria-label="Microsoft Teams" weight="duotone" />
                <EnvelopeSimpleIcon aria-label="Correo" />{' '}
                <BellSimpleIcon aria-label="Push si lo activas" />
              </span>
            </div>
            <div>
              <strong>Alerta P1 escalada</strong>
              <span>Líder SOC · Administrador</span>
              <span className="soc-push-channels">
                <MicrosoftTeamsLogoIcon aria-label="Microsoft Teams" weight="duotone" />
                <EnvelopeSimpleIcon aria-label="Correo" />{' '}
                <BellSimpleIcon aria-label="Push si lo activas" />
              </span>
            </div>
            <div>
              <strong>Incidente crítico abierto</strong>
              <span>Líder SOC · Administrador</span>
              <span className="soc-push-channels">
                <MicrosoftTeamsLogoIcon aria-label="Microsoft Teams" weight="duotone" />
                <EnvelopeSimpleIcon aria-label="Correo" />{' '}
                <BellSimpleIcon aria-label="Push si lo activas" />
              </span>
            </div>
          </div>
          <p className="soc-push-policy-note">
            <MicrosoftTeamsLogoIcon aria-hidden="true" weight="duotone" /> Teams avisa por rol; si
            no confirma entrega, se intenta el correo de respaldo.{' '}
            <BellSimpleIcon aria-hidden="true" /> Push es opcional y consulta solo alertas e
            incidentes recientes autorizados para tu sesión.
          </p>
          <div className="soc-push-legend">
            <span>
              <MicrosoftTeamsLogoIcon aria-hidden="true" weight="duotone" /> Teams
            </span>
            <span>
              <EnvelopeSimpleIcon aria-hidden="true" /> Correo de respaldo
            </span>
            <span>
              <BellSimpleIcon aria-hidden="true" /> Dispositivo activado
            </span>
          </div>
        </section>
      </div>
    </section>
  );
}
