# SOC

Ownership: Alert, triaje, Incident/Case, estados, concurrencia y evidencia. Consume
autorización y auditoría mediante fronteras explícitas.

Implementado en C-17:

- transiciones declaradas en tabla; cualquier movimiento fuera de ella es un error de
  dominio con código, no un no-op;
- triaje con veredicto y nota sustentada, reservado a la persona asignada;
- incidente con cierre que exige motivo y que no admite alertas sin triar;
- compare-and-set por revisión: dos escrituras simultáneas dejan una ganadora y un
  conflicto explícito;
- unidad de trabajo que escribe estado, AuditEvent y mensaje de outbox en una sola
  transacción, y que no deja rastro si el commit falla.

Specs: `modules/soc/test`. Persistencia: `platform/database/src/soc-stores.ts`.
