# Azure deployment readiness — 2026-10-22

## Revalidación de main y Actions — 2026-10-22

- SHA de `main` auditado: `6fef9139a019d66bed415a25c71190f3741b408e`.
- El workflow protegido [39778076475](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39778076475)
  completó `Check branch and apply review inputs` correctamente. El job
  `Create and summarize protected Terraform plan` sigue en `waiting`; por ello,
  **no hay un plan nuevo ni evidencia de apply para este SHA**.
- El run de validación [39778487520](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39778487520)
  terminó con el job `validate-dashboard` en verde: construyó y verificó el
  paquete `.deb` QAPAQ del Dashboard sin credenciales AWS. `build-dashboard`,
  `build-core` y `deploy` quedaron `skipped`; no se consideran builds ni un
  despliegue realizados.
- El run [39778486904](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39778486904)
  seguía `in_progress` al consultar GitHub; el paso activo era `Build QAPAQ
  Dashboard package`. La verificación y la publicación de su artefacto todavía
  estaban pendientes, así que no se cuenta como paquete terminado.
- La configuración Terraform conserva `enable_runtime = false`, `siem_host = null`
  y `ankay_host = null` por defecto. El runtime genérico, QAPAQ Wazuh y Ankay no
  están habilitados mediante esta configuración base; la cola Valkey/BullMQ,
  gateway KrakenD, DNS público/TLS, adaptadores M365/Sophos/Cato/Teams, agentes
  registrados y playbooks tampoco tienen un despliegue operativo demostrado.
- El cálculo documentado para Wazuh recomendado + PostgreSQL + Azure Firewall
  Basic supera USD 530/mes antes de Ankay y componentes adicionales. El budget
  de USD 200 emite avisos y **no** es un límite de facturación ni apaga recursos.

Esta actualización registra estados consultados de Actions y código Terraform;
no cambia infraestructura, secretos ni DNS.

## Execution evidence — 2026-10-22

- **Estado más reciente:** PR [#100](https://github.com/CyberStill-GmbH/qapaq-secops/pull/100)
  se integró en `main`, ahora en `048716ada8e3e5e077b044888b1291ec101506d4`. El PR
  solo añadió validación de la referencia de secreto en Key Vault y casos de
  `terraform test`; no cambió recursos de Azure.
- La validación Azure Terraform [39773533408](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533408)
  está verde. CI Security [39773533266](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39773533266)
  seguía en progreso al momento de esta actualización. Estos checks no ejecutan
  `terraform apply` ni demuestran un cambio de infraestructura.
- El run anterior [39771791770](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39771791770)
  corresponde al estado previo y no sustituye un plan validado para el nuevo SHA.
  El workflow [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034)
  aplicó únicamente cuatro recursos del canal de artefactos: Storage dedicado,
  contenedor Blob privado, private endpoint y permiso RBAC del publicador (**4 altas,
  0 cambios, 0 destrucciones**). No instaló el runtime ni cambió DNS.
- El workflow [39768505115](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39768505115)
  generó un plan de **0 altas, 1 cambio in-place y 0 destrucciones** para cambiar las
  reglas de red del Storage a `default_action=Allow` con `AzureServices` permitido.
  `apply` fue omitido; ese cambio no está aplicado.
- El workflow [39771791770](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39771791770)
  espera aprobación del environment protegido `azure-demo`. Terraform aún no ejecutó
  el plan de esa corrida; no existe resultado nuevo de plan ni apply que se pueda
  usar como evidencia.
- Por tanto, no se ha demostrado un runtime Wazuh/QAPAQ o Ankay en Azure, su salud,
  integraciones, ni un endpoint DNS operativo. Esta página no afirma que el sistema
  esté listo para uso.
- El apply de 39766635034 corresponde al commit `c32ed621af5fc4ba675e1153c26c4b7a7229254b`; `main` avanzó después al SHA indicado en el estado más reciente.
- The earlier protected run [39756609451](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39756609451) reported 0 additions, 0 updates and 0 deletions; its apply job was skipped.
- PR [#96](https://github.com/CyberStill-GmbH/qapaq-secops/pull/96) merged as `bdef10f`. CI Security passed in runs [39763925719](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763925719) and [39763931163](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763931163); Azure Terraform format/init/validate passed in [39763931208](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763931208).
- Terraform workflow [39764311183](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39764311183) passed its preflight and approval gate but failed during `terraform plan` because a `moved` block source address was still declared. It performed no apply.
- PR [#98](https://github.com/CyberStill-GmbH/qapaq-secops/pull/98) fixed the Terraform address collision and merged to `main` as `c32ed62`; CI, CodeQL, container and Terraform validation checks passed.
- Protected workflow [39766635034](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39766635034) completed plan and apply on that commit. The plan contained exactly **4 creates, 0 changes and 0 destroys**: the dedicated `siem-release` Storage account, its private endpoint, its private container, and the publisher `Storage Blob Data Contributor` assignment. Apply reported **4 added, 0 changed, 0 destroyed**. This established the release-artifact path only; it did not install Wazuh or Ankay and did not change DNS, existing evidence data, or secret values.
- Prior builds for Manager/Indexer/Filebeat, QAPAQ Dashboard, QAPAQ Core and Ankay completed successfully in runs [39731386944](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731386944), [39731390092](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731390092), [39731393165](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731393165) and [39731396102](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731396102). These are expiring build artifacts, not a composed SIEM release bundle, ACR publication of the complete runtime, or an Azure deployment. The newer Dashboard package build [39758795551](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758795551) also passed but did not publish to ACR.
- The experimental prerequisite build [39758248744](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758248744) has now completed successfully for the pinned Wazuh Manager 4.14.8, Indexer and Filebeat packages. Its assembly job emits only one-day provenance evidence, explicitly not an install bundle. QAPAQ Core archive [39758800010](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758800010) also built and verified successfully. Dashboard build [39758795551](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758795551) succeeded, but its ACR publication job was skipped. These outputs are not yet composed, published to the release Storage, or installed.

## Release artifact resources — applied; runner publication unverified

The existing SIEM release container is inside the evidence Storage account, whose public network access is disabled. GitHub-hosted runners cannot publish the Wazuh installation bundle there. Run 39766635034 created a separate Storage account, private container, private endpoint, and publisher RBAC assignment. The existing evidence account and raw event container were outside this apply. The publisher path is not yet verified end-to-end: no complete bundle has been published to the new account.

The Terraform source was applied after review of the exact plan in workflow 39766635034. Terraform reported four additions and no updates, deletes or replacements. Existing evidence data and secrets were not modified; no DNS change occurred.

The configuration specifies OAuth/RBAC, disabled shared keys and anonymous access, a private container, and a private endpoint for the SIEM VM. Run 39768505115 subsequently planned one in-place Storage network-rule change (0 creates, 1 change, 0 destroys), including `default_action=Allow` and `AzureServices`; its apply was skipped. Do not describe that planned change as applied. The repository documents a time-bounded `AZU-0012` exception through 2026-11-20 for authenticated publication from GitHub-hosted runners; reconcile the exact remote state and runner reachability before relying on that path. The exception does not enable anonymous Blob access. A private runner remains the intended way to remove the public-endpoint exception.

## Previous portal snapshot — not a current inventory

An earlier read-only portal inspection on 2026-10-22 recorded 18 resources across the subscription, including 15 in the demo resource group. Its exact time relative to the later apply is not recorded, so this is retained as a dated snapshot only: it must not be treated as a refreshed ARM inventory or as proof of today's exact resource count. The current Actions evidence confirms only the four resources created by run 39766635034. No current full-subscription inventory was established for this update.

The earlier portal snapshot recorded PostgreSQL `psql-qapaqsecopsdemo-66f8c73b` as Ready in Chile Central, PostgreSQL 16.15, Burstable B2s (2 vCPU / 4 GiB), 32 GiB storage, zone 1, with high availability disabled. This is historical evidence, not a fresh health check. No database setting was changed by the artifact-channel apply.

The earlier portal snapshot recorded ACR as Basic and contained dashboard/Ankay frontend artifacts. The dashboard OCI artifact transported a `.deb`, not a runnable image. This snapshot is not refreshed by the latest Terraform runs and does not evidence a complete Wazuh or Ankay release.

The Key Vault is private and has private endpoints. The portal denied listing secret metadata from the current Cloud Shell session because it was neither on a trusted service path nor using the approved private link. No secret names or values were read. This proves only that the vault is not reachable from that session, not whether particular secrets exist. DNS and Key Vault contents were not changed.

Public DNS lookup showed `jappi.net.pe` delegated to four Route 53 name servers. The queried public resolver returned no A or CNAME answer for `app.jappi.net.pe` (only the zone's negative SOA response). No DNS record was modified. A cutover remains premature until Azure has a healthy TLS edge and a stable public address.

## What this proves

Terraform state now includes the dedicated artifact channel, but it does not prove that the QAPAQ SecOps runtime is installed or healthy. The root keeps `siem_host` and `ankay_host` unset unless complete configuration is provided; both modules are wired but disabled. The apply was infrastructure preparation, not a successful application deployment.

## Remaining deployment gates

1. Build and publish the immutable Azure SIEM release bundle accepted by `modules/siem_host` (Wazuh 4.14.8, OpenSearch Dashboards 2.19.6, the QAPAQ dashboard package, and QAPAQ Core), then verify its manifest and digest.
2. Provide and audit the required egress firewall and policy, approved ingress/agent CIDRs, static addressing, and host configuration. The current SIEM module depends on an existing firewall; it does not create one.
3. Complete the Azure runtime/Key Vault adapter and verify the required secret *names and references* without copying secret values into Git, Terraform variables, or logs.
4. Complete and validate the Ankay release: backend, frontend, Orborus, worker, Shuffle security service, OpenSearch, pinned image digests, Compose, and protected `/ankay/*` integration.
5. Add and test Valkey/BullMQ only after a real consumer, retry/idempotency behavior, and failure handling are verified. The current Terraform plan does not include it.
6. Recalculate the full monthly cost and review a new exact plan before applying. The existing list-price estimate puts Wazuh + PostgreSQL + Azure Firewall Basic above USD 530/month before Ankay and other services; it is not a tenant quote. The USD 200 budget is an alert threshold, not an automatic spending cap.
7. Validate TLS, dashboard authentication, M365/Sophos/Cato/Teams integration, agents, and rollback before any DNS cutover for `app.jappi.net.pe`.

## Credential handling

The GitHub repository secret *names* include Azure OIDC inputs, the PostgreSQL bootstrap password, and `ENTRA_CLIENT_SECRET`. This audit did not read secret values. No repository-level secret names for Sophos, Cato, Teams, or VirusTotal were present at the time of inspection. Key Vault secret names and values remain unverified because private networking denied the portal listing.

## Next safe sequence

Complete the release and network gates, populate only approved non-secret references/configuration, then obtain a fresh protected `azure-demo` plan for the current `main` SHA. Review every resource action and an updated cost estimate from that exact plan before any apply. Do not treat run 39771791770 as a plan for the current SHA. Keep DNS unchanged until the deployed endpoint passes the operational checks above.
