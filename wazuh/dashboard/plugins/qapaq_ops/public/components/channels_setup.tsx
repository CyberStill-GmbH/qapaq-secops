/* Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import { EuiButton, EuiButtonEmpty, EuiSpacer, EuiText } from '@elastic/eui';
import type { NotificationChannelView } from '../../common';

export type TeamsSetupStep = 'configure' | 'enable' | 'test' | 'verify';

export function teamsSetupStep(channel: NotificationChannelView): TeamsSetupStep {
  if (!channel.configured) return 'configure';
  if (!channel.enabled) return 'enable';
  if (channel.state === 'failing' || channel.lastDelivery?.ok !== true) return 'test';
  return 'verify';
}

/** Uses only reported configuration and HTTP acceptance; human delivery is never inferred. */
export function TeamsSetupGuide({
  channel,
  canManage,
  busy,
  onConfigure,
  onEnable,
  onTest,
  onRefresh,
}: {
  channel: NotificationChannelView;
  canManage: boolean;
  busy: boolean;
  onConfigure: () => void;
  onEnable: () => void;
  onTest: () => void;
  onRefresh: () => void;
}) {
  const step = teamsSetupStep(channel);
  const actions = {
    configure: { label: 'Configurar Microsoft Teams', run: onConfigure },
    enable: { label: 'Activar Microsoft Teams', run: onEnable },
    test: { label: 'Enviar prueba a Teams', run: onTest },
    verify: { label: 'Enviar otra prueba a Teams', run: onTest },
  };
  const action = actions[step];
  return (
    <section className="qapaqChannel" aria-labelledby="qapaqTeamsSetupTitle" lang="es-PE" translate="no">
      <div className="qapaqChannel__head">
        <h3 id="qapaqTeamsSetupTitle">Puesta en marcha de Microsoft Teams</h3>
      </div>
      <EuiText size="s">
        <p>Conecta el canal del SOC y comprueba cada paso antes de confiarle los avisos.</p>
        <ol>
          <li aria-current={step === 'configure' ? 'step' : undefined}>
            <strong>Configurar el destino.</strong>{' '}
            {channel.configured
              ? 'Webhook guardado y protegido.'
              : 'Crea un flujo de Workflows en Teams y guarda su URL en QAPAQ.'}
          </li>
          <li aria-current={step === 'enable' ? 'step' : undefined}>
            <strong>Activar el canal.</strong>{' '}
            {channel.configured && channel.enabled
              ? 'Activado para los avisos del SOC.'
              : 'Guardar la URL no reactiva un canal desactivado.'}
          </li>
          <li aria-current={step === 'test' ? 'step' : undefined}>
            <strong>Comprobar la conexión.</strong>{' '}
            {step === 'verify'
              ? 'Microsoft aceptó la última solicitud registrada.'
              : channel.lastDelivery?.ok === false
                ? 'El último intento falló. Revisa el detalle del canal y vuelve a probar.'
                : 'Envía una prueba explícita cuando el canal esté configurado y activo.'}
          </li>
          <li aria-current={step === 'verify' ? 'step' : undefined}>
            <strong>Verificar en Teams.</strong> Abre el canal y comprueba que aparece la tarjeta.
            La aceptación de Microsoft no confirma la publicación ni la lectura de una persona.
            Si no aparece, revisa el historial de ejecuciones del Workflow.
          </li>
        </ol>
        {!canManage && <p>Un administrador de la plataforma debe configurar, activar y probar el canal.</p>}
      </EuiText>
      <EuiSpacer size="m" />
      <div className="qapaqChannel__actions">
        {canManage && <EuiButton fill size="s" isDisabled={busy} onClick={action.run}>{action.label}</EuiButton>}
        <EuiButtonEmpty size="s" isDisabled={busy} onClick={onRefresh}>Actualizar estado</EuiButtonEmpty>
      </div>
    </section>
  );
}
