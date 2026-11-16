# SOAR (Ankay)

Ownership MVP: outbox y notificación CRITICAL a Microsoft Teams con reintentos,
fallback y acuse en QAPAQ. El consumer se compone en el runtime; el dominio no se
duplica allí.

Implementado en C-20:

- clasificación de fallos en transitorio, permanente y **ambiguo**; un timeout no se
  trata como "no llegó";
- reenvío con el mismo `client-request-id` para que el destino deduplique;
- espera exponencial acotada y caída a fallback sin perder el crítico;
- la espera del reintento comienza al terminar el envío fallido, incluso si tarda
  más que el propio backoff; el identificador de cliente se conserva;
- aislamiento de fallos por mensaje: una excepción no abandona los demás avisos
  de una tanda ya reclamada, tanto con un consumidor como con varios. Al terminar
  se propaga el primer error; el mensaje fallido conserva su lease para recuperarse;
- carga mínima para el canal: sin crudo, identidades ni material sensible;
- `SENT` no es acuse: el acuse humano es un estado aparte registrado en QAPAQ.

Specs: `modules/soar/test`, incluido transporte HTTP real contra un servidor local.
Las pruebas de dispatcher cubren fallos parciales de tanda y respuestas lentas;
son evidencia local y no acreditan aceptación del Workflow ni lectura humana.
