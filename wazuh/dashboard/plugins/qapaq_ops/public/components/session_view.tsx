/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  EuiButton,
  EuiDescriptionList,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { ATTRIBUTION, LOGOUT_PATH, ROLE_LABEL } from '../../common';
import { QapaqPage, useConsole } from './console_context';
import { EmptyLine, Mono } from './primitives';

const AMR_LABEL: Record<string, string> = {
  mfa: 'Multifactor',
  pwd: 'Contraseña',
  fido: 'Passkey (FIDO2)',
  hwk: 'Llave de hardware',
  rsa: 'Certificado',
  wia: 'Windows integrado',
  ngcmfa: 'Windows Hello',
};

/** «Mi sesión» (doc 11): quién soy para QAPAQ, con qué método entré y qué puedo hacer. */
export function SessionView({ basePath }: { basePath: string }) {
  const { session } = useConsole();
  const capabilities = [...session.capabilities].sort();

  return (
    <QapaqPage
      title="Mi sesión"
      description="Identidad admitida por Entra ID y autorización asignada por QAPAQ."
      actions={
        <EuiButton size="s" href={`${basePath}${LOGOUT_PATH}`}>
          Cerrar sesión
        </EuiButton>
      }
    >
      <div className="qapaqReadable">
        <EuiPanel hasBorder paddingSize="m">
          <EuiDescriptionList
            type="responsiveColumn"
            compressed
            className="qapaqFacts"
            listItems={[
              { title: 'Nombre', description: session.displayName ?? 'Sin dato' },
              { title: 'Correo', description: session.email ?? 'Sin dato' },
              { title: 'Identificador', description: <Mono>{session.subjectId}</Mono> },
              { title: 'Tenant', description: <Mono>{session.tenantId}</Mono> },
              {
                title: 'Roles',
                description:
                  session.roles.length === 0
                    ? 'Sin rol'
                    : session.roles.map((role) => ROLE_LABEL[role] ?? role).join(', '),
              },
              {
                title: 'Método de acceso',
                description:
                  session.amr.length === 0
                    ? 'Sin dato'
                    : session.amr.map((method) => AMR_LABEL[method] ?? method).join(' + '),
              },
            ]}
          />
        </EuiPanel>
        <EuiSpacer size="l" />
        <EuiTitle size="xs">
          <h2>Capacidades</h2>
        </EuiTitle>
        <EuiText size="xs" color="subdued">
          <p>
            Lo que el backend te permite hacer. Cada acción se vuelve a autorizar en el servidor.
          </p>
        </EuiText>
        <EuiSpacer size="s" />
        {capabilities.length === 0 ? (
          <EmptyLine>Sin capacidades asignadas.</EmptyLine>
        ) : (
          <ul className="qapaqCapabilities">
            {capabilities.map((capability) => (
              <li key={capability}>
                <Mono>{capability}</Mono>
              </li>
            ))}
          </ul>
        )}
        <EuiSpacer size="xl" />
        <EuiTitle size="xs">
          <h2>Acerca de QAPAQ SecOps</h2>
        </EuiTitle>
        <EuiSpacer size="s" />
        {/* Aviso de licencias: no se traduce ni se rebrandea (NOTICE). */}
        <EuiText size="xs" color="subdued" data-qapaq-no-translate="">
          <p>{ATTRIBUTION}</p>
          <p>
            Los avisos y licencias originales se conservan en el paquete instalado (LICENSE.txt y
            NOTICE.txt).
          </p>
        </EuiText>
      </div>
    </QapaqPage>
  );
}
