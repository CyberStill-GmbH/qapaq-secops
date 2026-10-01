# Platform audit

Capacidad transversal de AuditEvent append-only, cadena de hash, archivo y
reconciliación.

Implementado en C-19:

- sellado con cadena de hash por tenant sobre serialización canónica, de modo que el
  hash sea reproducible por cualquier verificador;
- verificación que distingue manipulación, bifurcación, hueco y desorden;
- consulta autorizada con redacción por defecto de sesión, IP y metadata sensible;
- archivo JSONL inmutable con manifiesto y digest, escrito por rename atómico;
- reconciliación entre la cadena viva y el archivo, que clasifica hallazgos y no repara
  nada por su cuenta.

La base refuerza el contrato: la migración `20261008120000_c17_c19_c20_soc_operations`
instala triggers que rechazan `UPDATE`, `DELETE` y `TRUNCATE` sobre `audit_events`.

C-24 conserva su journal acotado `secret_lifecycle_audit`, metadata-only, como parte
atómica de cada mutación de lifecycle; no sustituye a este AuditEvent transversal.

Specs: `platform/audit/test`; integración PostgreSQL en
`platform/database/test/postgres-c19.integration.spec.ts`.
