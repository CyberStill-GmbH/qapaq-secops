/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiButton } from '@elastic/eui';
import { InvestigationPagination } from './investigation_pagination';

function findElementByType(element: React.ReactNode, type: React.ElementType): React.ReactElement {
  if (!React.isValidElement(element)) throw new Error('No se encontró el elemento esperado.');
  if (element.type === type) return element;
  const children = React.Children.toArray(element.props.children);
  for (const child of children) {
    try {
      return findElementByType(child, type);
    } catch {
      // Continue traversing the element tree.
    }
  }
  throw new Error('No se encontró el elemento esperado.');
}

describe('paginación de investigación', () => {
  it('invoca la carga al activar el botón React de continuar', () => {
    let calls = 0;
    const loadMore = async () => {
      calls += 1;
    };
    const button = findElementByType(
      InvestigationPagination({
        loading: false,
        error: false,
        remaining: 20,
        onLoadMore: loadMore,
        onReset: () => undefined,
      }),
      // EuiButton is the actual rendered element; its onClick is what the user activates.
      EuiButton,
    );

    button.props.onClick?.();

    expect(calls).toBe(1);
  });

  it('invoca la misma carga al reintentar una página fallida', () => {
    let calls = 0;
    const loadMore = async () => {
      calls += 1;
    };
    const retry = findElementByType(
      InvestigationPagination({
        loading: false,
        error: true,
        remaining: 20,
        onLoadMore: loadMore,
        onReset: () => undefined,
      }),
      EuiButton,
    );

    retry.props.onClick?.();

    expect(calls).toBe(1);
  });
});
