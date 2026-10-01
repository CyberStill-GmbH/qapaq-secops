# Detection

Ownership: priorización complementaria, reason codes y promoción idempotente sin
duplicar el ruleset base del proveedor.

Implementado en C-16:

- puntaje a partir de la severidad normalizada y del contexto QAPAQ —identidades
  privilegiadas, activos críticos, exposición, repetición— con un reason code por ajuste;
- supresión por regla declarada benigna y por ventana de mantenimiento;
- promoción con clave determinista `(tenant, evento, versión de ruleset)`: repetirla
  devuelve `duplicate` y nunca crea un segundo candidato.

Specs: `modules/detection/test`.
