import React from 'react';

type Props = Record<string, unknown> & { children?: React.ReactNode };

function domProps(props: Props): Record<string, unknown> {
  const allowed = new Set(['id', 'className', 'title', 'role', 'onClick', 'disabled']);
  return Object.fromEntries(
    Object.entries(props).filter(
      ([key]) => allowed.has(key) || key.startsWith('aria-') || key.startsWith('data-'),
    ),
  );
}

function container(tag = 'div') {
  return function TestOuiContainer(props: Props) {
    return React.createElement(tag, domProps(props), props.children);
  };
}

function button(props: Props) {
  const attributes = domProps(props);
  if (props['isDisabled'] === true || props['isLoading'] === true) attributes['disabled'] = true;
  return React.createElement('button', attributes, props.children);
}

export const EuiButton = button;
export const EuiButtonEmpty = button;
export const EuiCallOut = container('aside');
export const EuiDescriptionList = container('dl');
export const EuiFlexGrid = container('div');
export const EuiFlexGroup = container('div');
export const EuiFlexItem = container('div');
export const EuiHealth = container('span');
export const EuiHorizontalRule = container('hr');
export const EuiIcon = container('span');
export const EuiLoadingContent = container('div');
export const EuiLoadingSpinner = container('span');
export const EuiPanel = container('section');
export const EuiProgress = container('progress');
export const EuiSpacer = () => null;
export const EuiText = container('div');
export const EuiTitle = container('div');
export const EuiToolTip = container('span');

// Controles de formulario: solo lo que una prueba de marcado estático necesita ver
// (rótulo, valor, marcado y deshabilitado).
function choice(type: 'checkbox' | 'radio') {
  return function TestOuiChoice(props: Props) {
    return React.createElement(
      'label',
      null,
      React.createElement('input', {
        ...domProps(props),
        type,
        checked: props['checked'] === true,
        disabled: props['disabled'] === true,
        readOnly: true,
      }),
      props['label'] as React.ReactNode,
    );
  };
}

function field(tag: 'input' | 'textarea') {
  return function TestOuiField(props: Props) {
    return React.createElement(tag, {
      ...domProps(props),
      value: String(props['value'] ?? ''),
      disabled: props['disabled'] === true,
      readOnly: true,
    });
  };
}

export const EuiCheckbox = choice('checkbox');
export const EuiRadio = choice('radio');
export const EuiSwitch = choice('checkbox');
export const EuiFieldText = field('input');
export const EuiTextArea = field('textarea');

export function EuiSelect(props: Props) {
  const options = (props['options'] ?? []) as readonly { value: string; text: React.ReactNode }[];
  return React.createElement(
    'select',
    {
      ...domProps(props),
      defaultValue: String(props['value'] ?? ''),
      disabled: props['disabled'] === true,
    },
    ...options.map((option) =>
      React.createElement('option', { key: option.value, value: option.value }, option.text),
    ),
  );
}

export function EuiFormRow(props: Props) {
  return React.createElement(
    'div',
    domProps(props),
    React.createElement('span', null, props['label'] as React.ReactNode),
    props.children,
    props['helpText'] as React.ReactNode,
    props['isInvalid'] === true ? (props['error'] as React.ReactNode) : null,
  );
}

export function EuiBasicTable<T extends Record<string, unknown>>(
  props: Props & {
    readonly items?: readonly T[];
    readonly columns?: readonly {
      readonly field?: keyof T;
      readonly name?: React.ReactNode;
      readonly render?: (value: T[keyof T], item: T) => React.ReactNode;
    }[];
  },
) {
  const columns = props.columns ?? [];
  const rows = (props.items ?? []).map((item, rowIndex) =>
    React.createElement(
      'tr',
      { key: rowIndex },
      ...columns.map((column, columnIndex) => {
        const value = column.field === undefined ? undefined : item[column.field];
        return React.createElement(
          'td',
          { key: columnIndex },
          column.render ? column.render(value as T[keyof T], item) : String(value ?? ''),
        );
      }),
    ),
  );
  return React.createElement(
    'table',
    domProps(props),
    React.createElement(
      'thead',
      null,
      React.createElement(
        'tr',
        null,
        ...columns.map((column, index) => React.createElement('th', { key: index }, column.name)),
      ),
    ),
    React.createElement('tbody', null, ...rows),
  );
}
