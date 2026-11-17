/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  applyDock,
  clampPanelWidth,
  DOCK_CLASS,
  DOCK_MIN_VIEWPORT,
  DOCK_VARIABLE,
  dockWidthFor,
  effectivePanelWidth,
  layoutMode,
  maxPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDE_WIDTH,
  readStoredWidth,
  toggleWideWidth,
  widthFromKey,
  widthFromPointer,
  WIDTH_STORAGE_KEY,
  writeStoredWidth,
} from './qapaqzito_layout';

function fakeRoot(initialClasses: string[] = []) {
  const classes = new Set(initialClasses);
  const style = new Map<string, string>();
  return {
    classes,
    style,
    root: {
      classList: {
        add: (name: string) => void classes.add(name),
        remove: (name: string) => void classes.delete(name),
      },
      style: {
        setProperty: (name: string, value: string) => void style.set(name, value),
        removeProperty: (name: string) => void style.delete(name),
      },
    },
  };
}

describe('ancho del panel', () => {
  it('se acota a 360-720 px y un valor inválido usa 440', () => {
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(512.4)).toBe(512);
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('al acoplar, la consola conserva al menos 640 px', () => {
    expect(layoutMode(DOCK_MIN_VIEWPORT)).toBe('dock');
    expect(layoutMode(DOCK_MIN_VIEWPORT - 1)).toBe('overlay');
    expect(maxPanelWidth(1200)).toBe(560);
    expect(maxPanelWidth(1920)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(720, 1200)).toBe(560);
    expect(effectivePanelWidth(720, 1280)).toBe(640);
  });

  it('en cajón nunca excede la ventana', () => {
    expect(effectivePanelWidth(440, 390)).toBe(374);
    expect(effectivePanelWidth(440, 1000)).toBe(440);
  });

  it('el tirador del borde izquierdo y el teclado respetan los límites', () => {
    expect(widthFromPointer(1500, 1920)).toBe(420);
    expect(widthFromPointer(0, 1920)).toBe(PANEL_MAX_WIDTH);
    expect(widthFromPointer(1900, 1920)).toBe(PANEL_MIN_WIDTH);
    expect(widthFromKey(440, 'ArrowLeft', 1920)).toBe(464);
    expect(widthFromKey(440, 'ArrowRight', 1920)).toBe(416);
    expect(widthFromKey(PANEL_MIN_WIDTH, 'ArrowRight', 1920)).toBe(PANEL_MIN_WIDTH);
    expect(widthFromKey(440, 'Home', 1920)).toBe(PANEL_MIN_WIDTH);
    expect(widthFromKey(440, 'End', 1920)).toBe(PANEL_MAX_WIDTH);
    expect(widthFromKey(440, 'a', 1920)).toBeNull();
  });

  it('el botón de ancho alterna entre 440 y 640', () => {
    expect(toggleWideWidth(PANEL_DEFAULT_WIDTH)).toBe(PANEL_WIDE_WIDTH);
    expect(toggleWideWidth(PANEL_WIDE_WIDTH)).toBe(PANEL_DEFAULT_WIDTH);
    expect(toggleWideWidth(PANEL_DEFAULT_WIDTH, 1200)).toBe(560);
  });
});

describe('persistencia del ancho', () => {
  it('guarda y recupera el ancho acotado', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(readStoredWidth(storage)).toBe(PANEL_DEFAULT_WIDTH);
    writeStoredWidth(520, storage);
    expect(store.get(WIDTH_STORAGE_KEY)).toBe('520');
    expect(readStoredWidth(storage)).toBe(520);
    writeStoredWidth(9999, storage);
    expect(readStoredWidth(storage)).toBe(PANEL_MAX_WIDTH);
    store.set(WIDTH_STORAGE_KEY, 'basura');
    expect(readStoredWidth(storage)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('un almacenamiento bloqueado nunca lanza', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readStoredWidth(blocked)).toBe(PANEL_DEFAULT_WIDTH);
    expect(() => writeStoredWidth(500, blocked)).not.toThrow();
    expect(readStoredWidth(null)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe('acople de la consola', () => {
  it('solo acopla abierto y en pantalla ancha', () => {
    expect(dockWidthFor(true, 1600, 440)).toBe(440);
    expect(dockWidthFor(false, 1600, 440)).toBeNull();
    expect(dockWidthFor(true, 1000, 440)).toBeNull();
  });

  it('cerrar restaura <html> exactamente (sin clase ni variable)', () => {
    const { root, classes, style } = fakeRoot(['euiTheme--dark']);
    applyDock(root, 440);
    expect(classes.has(DOCK_CLASS)).toBe(true);
    expect(style.get(DOCK_VARIABLE)).toBe('440px');
    applyDock(root, 520);
    expect(style.get(DOCK_VARIABLE)).toBe('520px');
    applyDock(root, null);
    expect(Array.from(classes)).toEqual(['euiTheme--dark']);
    expect(style.size).toBe(0);
  });

  it('también limpia la clase de versiones anteriores', () => {
    const { root, classes } = fakeRoot(['qapaq-qapaqzito-open']);
    applyDock(root, null);
    expect(classes.size).toBe(0);
  });
});
