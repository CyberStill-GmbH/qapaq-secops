/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Módulos de OSD que el typecheck aislado no tiene instalados (tools/typecheck.mjs).
 */

declare module '@osd/config-schema' {
  export interface Type<T> {
    readonly __type?: T;
  }
  export type TypeOf<V> = V extends Type<infer T> ? T : never;
  type Props = Record<string, Type<unknown>>;
  type ObjectResult<P extends Props> = { [K in keyof P]: TypeOf<P[K]> };
  export const schema: {
    object<P extends Props>(
      props: P,
      options?: { unknowns?: 'allow' | 'ignore' | 'forbid' },
    ): Type<ObjectResult<P>>;
    boolean(options?: { defaultValue?: boolean }): Type<boolean>;
    string(options?: {
      defaultValue?: string;
      validate?: (value: string) => string | void | undefined;
    }): Type<string>;
  };
}

/** En OSD 2.19 `@elastic/eui` es un alias npm de `@opensearch-project/oui@1.19.0`. */
declare module '@elastic/eui' {
  export * from '@opensearch-project/oui';
}

declare module '*.scss';
