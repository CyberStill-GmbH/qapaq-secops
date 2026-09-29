# Platform audit

Capacidad transversal para AuditEvent append-only, hash chain, archivo y
reconciliación. No se implementan tablas ni adapters hasta que PBI-019 defina su
migración, transacción, rol runtime y specs contra PostgreSQL/object storage reales.

C-24 incorpora únicamente su journal de seguridad acotado
`secret_lifecycle_audit`, append-only y metadata-only, como parte atómica de cada
mutación de lifecycle. No sustituye el AuditEvent transversal, hash chain, archivo
o custodia de PBI-019; el adapter futuro deberá proyectar estos registros sin
añadir material secreto.
