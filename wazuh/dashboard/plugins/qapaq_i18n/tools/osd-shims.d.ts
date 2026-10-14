// Tipos mínimos para typecheck fuera del árbol de OSD (solo tools/tsconfig.check.json).
declare module '@osd/config-schema' {
  interface Type<T> {
    readonly __t?: T;
  }
  export type TypeOf<V> = V extends Type<infer T> ? T : never;
  export const schema: {
    object<P extends Record<string, Type<unknown>>>(
      props: P,
    ): Type<{ [K in keyof P]: TypeOf<P[K]> }>;
    boolean(o?: { defaultValue?: boolean }): Type<boolean>;
  };
}
