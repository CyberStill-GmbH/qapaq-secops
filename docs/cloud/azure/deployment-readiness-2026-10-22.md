# Azure deployment readiness — 2026-10-22

## Execution evidence

- Repository: `CyberStill-GmbH/qapaq-secops`, branch `main`, commit `f2fb3d52c77f055d204f5e096950048fdd0bc6d5`.
- Workflow: [Terraform Azure plan and apply, run 39756609451](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39756609451).
- The `azure-demo` deployment gate was approved by the configured reviewer.
- OIDC validation, backend initialization, formatting, Terraform validation, saved plan creation, and the destructive-action guard all passed.
- Terraform reported **no changes**. The plan summary found 0 additions, 0 updates, and 0 deletions. The apply job was skipped, so this run did not deploy resources or alter DNS.

## Live Azure inventory

Read-only portal inspection on 2026-10-22 showed 18 resources across the subscription. The demo resource group `rg-qapaqsecopsdemo-66f8c73b` has 15: two user-assigned identities, Key Vault, Log Analytics workspace, two private endpoints and their NICs, three private DNS zones, PostgreSQL Flexible Server, ACR, Storage Account, and VNet. The separate Terraform-state resource group has the state Storage Account and its GitHub OIDC identity; Azure Network Watcher is in `NetworkWatcherRG`. No Azure Firewall, SIEM VM, Ankay VM, public IP, or load balancer appears anywhere in the subscription inventory. Therefore the SIEM module's required firewall dependency is absent and the current state cannot provide a public HTTPS endpoint.

The PostgreSQL server `psql-qapaqsecopsdemo-66f8c73b` is Ready in Chile Central, PostgreSQL 16.15, Burstable B2s (2 vCPU / 4 GiB), 32 GiB storage, zone 1, with high availability disabled. The Azure portal explicitly recommends General Purpose or Memory Optimized for production. This is a resilience and capacity gap for the intended SOC workload; no database setting was changed.

The Key Vault is private and has private endpoints. The portal denied listing secret metadata from the current Cloud Shell session because it was neither on a trusted service path nor using the approved private link. No secret names or values were read. This proves only that the vault is not reachable from that session, not whether particular secrets exist. DNS and Key Vault contents were not changed.

## What this proves

The existing Terraform state matches the currently enabled root configuration. It does not prove that the QAPAQ SecOps runtime is installed or healthy. The root keeps `siem_host` and `ankay_host` unset unless complete configuration is provided; the current plan therefore cannot create either host. A no-op plan must not be reported as a successful application deployment.

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
