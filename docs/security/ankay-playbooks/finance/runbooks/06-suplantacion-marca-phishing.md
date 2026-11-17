# RB-FIN-06 · Suplantación de marca y phishing a clientes

| Campo | Valor |
|---|---|
| Playbook | `finance.brand-impersonation-phishing` v1.0.0 (`design-only`) |
| Prioridad / SLA | P2 · reconocer 30 min · triage 4 h · decisión de contención 8 h · evaluación regulatoria 24 h |
| **Dueño** | Jefe del SOC QAPAQ, con legal |
| Última verificación | 2026-10-28 (revisión documental; sin ejercicio con datos reales) |
| Disparadores | 101436, 101437 · contexto 101435, 101100 · ingreso manual por reporte de cliente |
| Workflow | `infra/wazuh/launch-detections/ankay/finance/finance.brand-impersonation-phishing.json` |
| Normativa | `SBS-504-INC`, `LPDP-SEG` ([matriz](../matriz-cumplimiento-sbs-anpd.md)) |

## Objetivo y alcance

Detectar dominios y sitios que imitan a QAPAQ para robar credenciales o datos de clientes,
pedir su baja y advertir a clientes y colaboradores por canales oficiales. Ankay trata el
dominio como texto: **nunca visita la URL ni descarga contenido**. Las capturas del sitio
las toma un analista en un entorno aislado. El monitoreo de marca (CT logs, dnstwist u
otro proveedor) es `TO_BE_PROVIDED`; mientras no exista, el ingreso principal es el
reporte de clientes o del contact center.

## Detección

| Señal | Regla | Fuente |
|---|---|---|
| Dominio parecido con MX, certificado o web activa | 101436 | Monitoreo de marca normalizado |
| Colaborador accede a un dominio parecido registrado | 101437 | Cato + lista `qapaq-lookalike-domains` |
| Dominio parecido nuevo (sin capacidad activa) | 101435 | Monitoreo de marca (solo seguimiento) |
| Reporte de cliente o del contact center | Caso manual | QAPAQ |

## Triage

### Paso 1: Registrar y clasificar (20 min)

- [ ] Reconocer en QAPAQ; si viene de un cliente, registrar canal y hora sin datos del
  cliente más allá de un identificador de reclamo.
- [ ] Clasificar el dominio: parecido tipográfico, subdominio engañoso, homógrafo o abuso
  de servicio legítimo (formularios, acortadores).

VERIFICAR: el caso tiene el dominio, la clasificación y la fuente del reporte.

### Paso 2: Inteligencia del dominio sin visitarlo (30 min)

```bash
dominio='qapaq-pe.example'
whois "$dominio" | grep -Ei 'creation|registrar|abuse'
dig +short MX "$dominio"; dig +short A "$dominio"; dig +short NS "$dominio"
curl -s "https://crt.sh/?q=${dominio}&output=json" | head -c 2000
```

VERIFICAR: el caso registra fecha de creación, registrador y su contacto de abuso,
hosting, MX y certificados.

### Paso 3: Medir exposición interna y de clientes (30 min)

```text
rule.id:(101435 or 101436 or 101437 or 101100) and (data.qapaq_domain:"qapaq-pe.example" or data.qapaq_destination:"qapaq-pe.example")
```

- [ ] ¿Hubo clics internos (101437) o correos recibidos que enlacen al dominio?
- [ ] ¿Cuántos reportes de clientes hay y desde cuándo?

VERIFICAR: el caso indica si hay víctimas internas (pasar a RB-FIN-02) o clientes que
entregaron datos (pasar a RB-FIN-08).

## Contención

Decisión humana: **¿se pide la baja del dominio y se avisa a clientes por los canales
oficiales?** Deciden el jefe del SOC y legal, consultando a comunicaciones y atención al
cliente.

| Acción | Aprobador | Ejecutor | Restricción |
|---|---|---|---|
| Solicitar baja (takedown) | Legal | Legal/marca (manual) | Al registrador y hosting con evidencia; sin contacto con el atacante |
| Bloquear el dominio para colaboradores | Jefe del SOC | `containment.cato-block-indicator` | Dominio exacto con expiración de 30 días |

### Paso 4: Ejecutar lo aprobado (30 min)

- [ ] Enviar la solicitud de baja al contacto de abuso del registrador y del hosting con
  capturas (entorno aislado), certificado y registros DNS.
- [ ] Reportar la URL a los servicios de reputación de navegadores y del proveedor de
  correo.
- [ ] Agregar el dominio a `qapaq-lookalike-domains` (cambio aprobado) para que 101437 lo
  vigile.

VERIFICAR: el caso guarda la constancia de envío y el número de ticket del registrador;
Cato muestra el bloqueo con expiración.

### Reversión

Retirar el bloqueo y la entrada de la lista si se confirma que el dominio es legítimo (por
ejemplo, de un aliado). La solicitud de baja no se revierte; se informa al registrador.

## Erradicación

- [ ] Seguimiento diario hasta que el dominio deje de resolver o de servir contenido.
- [ ] Revisar si el sitio copia recursos desde dominios de QAPAQ y bloquear el hotlinking.

## Recuperación

- [ ] Atención al cliente ayuda a los clientes afectados a cambiar credenciales y revisar
  operaciones por canales oficiales.
- [ ] Si hay clientes que entregaron datos o sufrieron fraude, abrir RB-FIN-08.

## Lecciones aprendidas

En 5 días hábiles: tiempo hasta la baja, cuántos clientes reportaron antes que el
monitoreo, si conviene registrar preventivamente variantes del dominio y reforzar DMARC.

## RACI

| Actividad | Analista N1 | Analista N2 | Jefe SOC | Legal | Comunicaciones | Atención al cliente |
|---|---|---|---|---|---|---|
| Registro y clasificación | R | A | I | – | – | C |
| Inteligencia del dominio | C | R | A | – | – | – |
| Decisión de baja y aviso | – | C | R | A | C | C |
| Solicitud de baja | – | C | I | R/A | – | – |
| Aviso a clientes | – | – | C | A | R | R |

## Comunicación

- **Interna:** aviso P2 por outbox; alerta a colaboradores si hubo clics internos.
- **Clientes:** solo por canales oficiales (web, app, redes verificadas), con texto
  aprobado por legal y comunicaciones. Nunca incluir el enlace malicioso activo.
- **Regulador:** si hubo fraude o datos expuestos, según RB-FIN-08.

## Escalamiento

| Nivel | Cuándo | Quién |
|---|---|---|
| L1 | Dominio sin capacidad activa | Analista N1 (seguimiento) |
| L2 | Sitio activo o reportes de clientes | Jefe del SOC + legal |
| L3 | Clientes con fraude o datos entregados, o campaña masiva | Oficial de seguridad + comunicaciones + gerencia (RB-FIN-08) |

## Evidencias

Registros RDAP/WHOIS y DNS, certificados, capturas en entorno aislado con hash, reportes
de clientes (identificador de reclamo), clics internos, constancias de baja.

## Métricas

MTTD (hasta el primer registro del dominio activo), MTTA, MTTT y tiempo hasta la baja
(MTTC). Dashboard: FILL IN.

## Ejercicio

Tabletop semestral con un dominio ficticio `qapaq-pe.example` y un reporte simulado de
cliente (casos 101435–101437).
