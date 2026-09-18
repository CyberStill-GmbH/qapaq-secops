# Resultados de capacidad

U-002 y ADR-016 fijan metodología, perfiles y gates; no fijan una cifra de EPS.
Este directorio contendrá resultados ejecutados con el formato:

`baseline-YYYY-MM-DD.md`

Cada resultado debe registrar commit, fecha, versiones y lockfiles, hardware y
límites, configuración de contenedores, dataset/distribución/tamaño, reglas,
volumen indexado, concurrencia, duración, warm-up, repeticiones, p50/p95/p99,
CPU/memoria/I/O/GC, queue depth, errores, contadores reconciliados y recuperación.

Una prueba fallida se conserva como evidencia. No ajustar gates después de ver el
resultado solo para convertirlo en éxito. La capacidad oficial será el mayor perfil
aprobado bajo esa configuración, reducido por el margen operacional acordado.

Estado actual: **PENDING MEASUREMENT**. No existen resultados de aplicación.
