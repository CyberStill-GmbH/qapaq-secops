/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/**
 * Disposición del panel de Qapaqzito: lateral derecho que EMPUJA la consola a la izquierda en
 * pantallas anchas y cajón superpuesto (con fondo) en las estrechas. Todo aquí es lógica pura
 * (sin React ni DOM real) para poder probarla; el CSS global está en `qapaqzito.scss`.
 */

export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_DEFAULT_WIDTH = 440;
export const PANEL_WIDE_WIDTH = 640;
/** Por debajo de este ancho de ventana el panel se superpone (cajón con fondo). */
export const DOCK_MIN_VIEWPORT = 1200;
/** Ancho mínimo que conserva la consola cuando el panel está acoplado. */
export const APP_MIN_WIDTH = 640;
export const KEYBOARD_STEP = 24;
export const WIDTH_STORAGE_KEY = 'qapaq.qapaqzito.panelWidth';
export const DOCK_CLASS = 'qapaq-qapaqzito-docked';
export const DOCK_VARIABLE = '--qapaq-qapaqzito-w';

export type LayoutMode = 'dock' | 'overlay';

export function layoutMode(viewportWidth: number): LayoutMode {
  return viewportWidth >= DOCK_MIN_VIEWPORT ? 'dock' : 'overlay';
}

/** Máximo permitido: 720 px, pero la consola siempre conserva `APP_MIN_WIDTH` al acoplar. */
export function maxPanelWidth(viewportWidth: number): number {
  if (layoutMode(viewportWidth) === 'overlay') return PANEL_MAX_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewportWidth - APP_MIN_WIDTH));
}

/** Acota el ancho pedido a [360, 720] (y al espacio real); un valor no numérico usa el valor por defecto. */
export function clampPanelWidth(value: number, viewportWidth: number = Infinity): number {
  const numeric = Number.isFinite(value) ? value : PANEL_DEFAULT_WIDTH;
  const max = Number.isFinite(viewportWidth) ? maxPanelWidth(viewportWidth) : PANEL_MAX_WIDTH;
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, numeric)));
}

/**
 * Ancho que se dibuja: en cajón nunca excede la ventana (queda un margen de 16 px para ver que es
 * un cajón y poder tocar el fondo).
 */
export function effectivePanelWidth(width: number, viewportWidth: number): number {
  const clamped = clampPanelWidth(width, viewportWidth);
  if (layoutMode(viewportWidth) === 'dock') return clamped;
  return Math.max(0, Math.min(clamped, viewportWidth - 16));
}

/** El tirador está en el borde izquierdo: el ancho es lo que queda a la derecha del puntero. */
export function widthFromPointer(clientX: number, viewportWidth: number): number {
  return clampPanelWidth(viewportWidth - clientX, viewportWidth);
}

/** Teclado en el tirador (role=separator): flechas ajustan, Inicio/Fin van a los extremos. */
export function widthFromKey(width: number, key: string, viewportWidth: number): number | null {
  if (key === 'ArrowLeft') return clampPanelWidth(width + KEYBOARD_STEP, viewportWidth);
  if (key === 'ArrowRight') return clampPanelWidth(width - KEYBOARD_STEP, viewportWidth);
  if (key === 'Home') return clampPanelWidth(PANEL_MIN_WIDTH, viewportWidth);
  if (key === 'End') return clampPanelWidth(PANEL_MAX_WIDTH, viewportWidth);
  return null;
}

/** Botón «ancho»: alterna entre el ancho por defecto y el ancho amplio. */
export function toggleWideWidth(width: number, viewportWidth: number = Infinity): number {
  return clampPanelWidth(
    width >= PANEL_WIDE_WIDTH ? PANEL_DEFAULT_WIDTH : PANEL_WIDE_WIDTH,
    viewportWidth,
  );
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Ancho guardado (o el de fábrica). Nunca lanza: el almacenamiento puede estar bloqueado. */
export function readStoredWidth(storage: StorageLike | null = defaultStorage()): number {
  try {
    const raw = storage?.getItem(WIDTH_STORAGE_KEY);
    if (raw === null || raw === undefined) return PANEL_DEFAULT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampPanelWidth(parsed) : PANEL_DEFAULT_WIDTH;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

export function writeStoredWidth(
  width: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(WIDTH_STORAGE_KEY, String(clampPanelWidth(width)));
  } catch {
    // Almacenamiento bloqueado o lleno: el ancho solo dura la sesión.
  }
}

/** Lo mínimo del elemento raíz que toca el acople (permite probarlo sin DOM). */
export interface DockRoot {
  readonly classList: { add(name: string): void; remove(name: string): void };
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
}

/**
 * Acopla (`widthPx` = ancho) o restaura (`null`) la disposición de la consola. Cerrar deja
 * `<html>` exactamente como estaba: sin clase ni variable.
 */
export function applyDock(root: DockRoot, widthPx: number | null): void {
  if (widthPx === null) {
    root.classList.remove(DOCK_CLASS);
    root.classList.remove('qapaq-qapaqzito-open'); // clase de versiones anteriores
    root.style.removeProperty(DOCK_VARIABLE);
    return;
  }
  root.style.setProperty(DOCK_VARIABLE, `${Math.round(widthPx)}px`);
  root.classList.add(DOCK_CLASS);
}

/** Ancho con el que debe acoplarse la consola, o `null` si el panel está cerrado o es un cajón. */
export function dockWidthFor(open: boolean, viewportWidth: number, width: number): number | null {
  if (!open || layoutMode(viewportWidth) !== 'dock') return null;
  return effectivePanelWidth(width, viewportWidth);
}
