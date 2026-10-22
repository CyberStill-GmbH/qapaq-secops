# Azure deployment readiness — 2026-10-22

## Execution evidence — 2026-10-22

- Repository: `CyberStill-GmbH/qapaq-secops`, `main` at `bdef10fc331b5d7b4e89c38111375f71771f5194`.
- The earlier protected run [39756609451](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39756609451) reported 0 additions, 0 updates and 0 deletions; its apply job was skipped.
- PR [#96](https://github.com/CyberStill-GmbH/qapaq-secops/pull/96) merged as `bdef10f`. CI Security passed in runs [39763925719](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763925719) and [39763931163](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763931163); Azure Terraform format/init/validate passed in [39763931208](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39763931208).
- Terraform workflow [39764311183](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39764311183) was dispatched with `apply=true`. Its preflight passed, but the plan job is waiting for the `azure-demo` environment reviewer `CesarGuevaraQapaq`. The authenticated CLI actor is `CyberStill-GmbH`, so it cannot approve that reviewer gate. No remote plan or apply step has run in this workflow; it has not changed Azure or DNS.
- Prior builds for Manager/Indexer/Filebeat, QAPAQ Dashboard, QAPAQ Core and Ankay completed successfully in runs [39731386944](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731386944), [39731390092](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731390092), [39731393165](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731393165) and [39731396102](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39731396102). These are expiring build artifacts, not a composed SIEM release bundle, ACR publication of the complete runtime, or an Azure deployment. The newer Dashboard package build [39758795551](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39758795551) also passed but did not publish to ACR.

## Release artifact network path — merged, not applied

The existing SIEM release container is inside the evidence Storage account, whose public network access is disabled. GitHub-hosted runners cannot publish the Wazuh installation bundle there. A candidate Terraform change is prepared on `codex/azure-siem-runtime-readiness`: a separate, versioned release Storage account with a private container, OAuth/RBAC only, no shared keys, no anonymous access, and a private endpoint for the SIEM VM. The existing evidence account, raw event container, prior release container and its publisher grant are retained; a Terraform `moved` block preserves the old grant while a new container-scoped grant is added.

The Terraform source is merged in PR #96, but it has not been applied. No Azure plan, apply, account creation, data migration, or DNS change has occurred for it. The workflow 39764311183 must first pass the `azure-demo` approval gate and produce the exact remote plan. Review it for expected storage/RBAC actions and zero data destruction before permitting its apply job.

The release account/container uses OAuth/RBAC only, disables shared keys and anonymous access, keeps the container private, and provides a private endpoint for the SIEM VM. The existing evidence account, raw event container, prior release container and publisher grant are retained; a Terraform `moved` block preserves the old grant while adding a container-scoped grant on the dedicated artifact account. A time-bounded `AZU-0012` exception expires 2026-11-20 because GitHub-hosted runners require a public authenticated endpoint. The exception does not make the release container public; migrate publication to a private runner before expiry.

## Live Azure inventory

Read-only portal inspection on 2026-10-22 showed 18 resources across the subscription. The demo resource group `rg-qapaqsecopsdemo-66f8c73b` has 15: two user-assigned identities, Key Vault, Log Analytics workspace, two private endpoints and their NICs, three private DNS zones, PostgreSQL Flexible Server, ACR, Storage Account, and VNet. The separate Terraform-state resource group has the state Storage Account and its GitHub OIDC identity; Azure Network Watcher is in `NetworkWatcherRG`. No Azure Firewall, SIEM VM, Ankay VM, public IP, or load balancer appears anywhere in the subscription inventory. Therefore the SIEM module's required firewall dependency is absent and the current state cannot provide a public HTTPS endpoint.

The PostgreSQL server `psql-qapaqsecopsdemo-66f8c73b` is Ready in Chile Central, PostgreSQL 16.15, Burstable B2s (2 vCPU / 4 GiB), 32 GiB storage, zone 1, with high availability disabled. The Azure portal explicitly recommends General Purpose or Memory Optimized for production. This is a resilience and capacity gap for the intended SOC workload; no database setting was changed.

ACR `qapaqsecopsdemo66f8c73b` is Basic. Its repository listing has two entries: `qapaq-dashboard` with one OCI artifact tag `git-b7ff341a2e249e69dbcd190c0619c098d4d2eec6-sha256-e678df149679a5d564f2d3b7d56988c1e2533b7654a1aec0df0975dd7c0b39d8` and manifest digest `sha256:63277d6e56942a2ebe0f2c511d7ee90851160b0caca948eef4a8cc288eb05e2b`; and `ankay-qapaq-frontend` with tag `git-4ee8dd660377f17923e4e18a4bf88452eadcc6a7` and manifest digest `sha256:40ee82ef93148df955f01f9d1faa3f38cc3547d42a92e044c3d23abac2c278fa`. The dashboard OCI artifact transports a `.deb`; it is not a runnable image. No Ankay backend, worker, Orborus, security service, or OpenSearch repositories were present, so the current registry contents cannot start Ankay/Shuffle.

The Key Vault is private and has private endpoints. The portal denied listing secret metadata from the current Cloud Shell session because it was neither on a trusted service path nor using the approved private link. No secret names or values were read. This proves only that the vault is not reachable from that session, not whether particular secrets exist. DNS and Key Vault contents were not changed.

Public DNS lookup showed `jappi.net.pe` delegated to four Route 53 name servers. The queried public resolver returned no A or CNAME answer for `app.jappi.net.pe` (only the zone's negative SOA response). No DNS record was modified. A cutover remains premature until Azure has a healthy TLS edge and a stable public address.

## What this proves

The existing Terraform state matches the currently enabled root configuration. It does not prove that the QAPAQ SecOps runtime is installed or healthy. The root keeps `siem_host` and `ankay_host` unset unless complete configuration is provided; both modules are wired but disabled. The current apply workflow is waiting before plan creation. A no-op plan must not be reported as a successful application deployment.

## Remaining deployment gates

1. Build and publish the immutable Azure SIEM release bundle accepted by `modules/siem_host` (Wazuh 4.14.8, OpenSearch Dashboards 2.19.6, the QAPAQ dashboard package, and QAPAQ Core), then verify its manifest and digest.
2. Provide and audit the required egress firewall and policy, approved ingress/agent CIDRs, static addressing, and host configuration. The current SIEM module depends on an existing firewall; it does not create one.
3. Complete the Azure runtime/Key Vault adapter and verify the required secret *names and references* without copying secret values into Git, Terraform variables, or logs.
4. Complete and validate the Ankay release: backend, frontend, Orborus, worker, Shuffle security service, OpenSearch, pinned image digests, Compose, and protected `/ankay/*` integration.
5. Add and test Valkey/BullMQ only after a real consumer, retry/idempotency behavior, and failure handling are verified. The current Terraform plan does not include it.
6. Recalculate the full monthly cost and review a new exact plan before applying. Existing cost analysis puts Wazuh + PostgreSQL + Azure Firewall Basic above USD 530/month before Ankay and other services; the USD 200 budget is an alert threshold, not an automatic spending cap.
7. Validate TLS, dashboard authentication, M365/Sophos/Cato/Teams integration, agents, and rollback before any DNS cutover for `app.jappi.net.pe`.

## Credential handling

The GitHub repository secret *names* include Azure OIDC inputs, the PostgreSQL bootstrap password, and `ENTRA_CLIENT_SECRET`. This audit did not read secret values. No repository-level secret names for Sophos, Cato, Teams, or VirusTotal were present at the time of inspection. Key Vault secret names and values remain unverified because private networking denied the portal listing.

## Next safe sequence

Complete the release and network gates, populate only approved non-secret references/configuration, then run a new protected Terraform plan. Review every resource action and cost from that exact plan; only then run the protected apply job. Keep DNS unchanged until the deployed endpoint passes the operational checks above.
