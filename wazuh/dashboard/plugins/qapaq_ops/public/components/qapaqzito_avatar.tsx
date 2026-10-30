/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Qapaqzito: robotcito chibi amarillo, SVG propio (sin activos externos ni licencias de
 * terceros). Cabeza grande, visor oscuro con ojos cian y antena; `thinking` hace latir la antena
 * mientras el asistente responde (se desactiva con `prefers-reduced-motion`).
 */
export function QapaqzitoAvatar({
  size = 32,
  thinking = false,
  title,
}: {
  size?: number;
  thinking?: boolean;
  /** Sin título el avatar es decorativo y los lectores de pantalla lo omiten. */
  title?: string;
}) {
  return (
    <svg
      className={`qapaqzito${thinking ? ' qapaqzito--thinking' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {/* Antena */}
      <line
        x1="32"
        y1="11"
        x2="32"
        y2="5"
        stroke="#3a2e00"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle
        className="qapaqzito__antenna"
        cx="32"
        cy="4.5"
        r="3.5"
        fill="#ff8a3d"
        stroke="#3a2e00"
        strokeWidth="1.5"
      />
      {/* Cuerpo y brazos (detrás de la cabeza) */}
      <ellipse cx="16.5" cy="51" rx="4" ry="5" fill="#f5b700" stroke="#3a2e00" strokeWidth="2" />
      <ellipse cx="47.5" cy="51" rx="4" ry="5" fill="#f5b700" stroke="#3a2e00" strokeWidth="2" />
      <rect
        x="19"
        y="42"
        width="26"
        height="18"
        rx="8"
        fill="#ffd23f"
        stroke="#3a2e00"
        strokeWidth="2.5"
      />
      <circle cx="32" cy="51.5" r="3" fill="#ff8a3d" stroke="#3a2e00" strokeWidth="1.2" />
      {/* Orejas */}
      <rect
        x="4.5"
        y="21"
        width="7"
        height="13"
        rx="3.5"
        fill="#f5b700"
        stroke="#3a2e00"
        strokeWidth="2"
      />
      <rect
        x="52.5"
        y="21"
        width="7"
        height="13"
        rx="3.5"
        fill="#f5b700"
        stroke="#3a2e00"
        strokeWidth="2"
      />
      {/* Cabeza */}
      <rect
        x="9"
        y="10"
        width="46"
        height="35"
        rx="15"
        fill="#ffd23f"
        stroke="#3a2e00"
        strokeWidth="2.5"
      />
      <path
        d="M15 17 Q20 12.5 27 12.5"
        fill="none"
        stroke="#fff4c2"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* Visor, ojos y sonrisa */}
      <rect x="15" y="17" width="34" height="21" rx="10" fill="#23263a" />
      <ellipse cx="25" cy="27" rx="3.6" ry="4.4" fill="#7cf3ff" />
      <ellipse cx="39" cy="27" rx="3.6" ry="4.4" fill="#7cf3ff" />
      <circle cx="26.2" cy="25.4" r="1.2" fill="#ffffff" />
      <circle cx="40.2" cy="25.4" r="1.2" fill="#ffffff" />
      <path
        d="M28.5 33 Q32 35.6 35.5 33"
        fill="none"
        stroke="#7cf3ff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {/* Mejillas */}
      <circle cx="16" cy="40.5" r="2.4" fill="#ff9f7a" opacity="0.85" />
      <circle cx="48" cy="40.5" r="2.4" fill="#ff9f7a" opacity="0.85" />
    </svg>
  );
}
