# EUS2 SIEM profile: readiness and operator inputs

**State: preparation only.** This document records the first SIEM deployment gate for
`demo-eus2`. It does not change Azure, GitHub, DNS, Terraform inputs, secrets, or the
Terraform state. The JSON-shaped block below is intentionally **not valid JSON** and is
not a value to paste into `AZURE_EUS2_SIEM_HOST_JSON`; required operator values are
identified outside the block so a placeholder cannot accidentally become a deployment.

## Architecture and deployment order

The current system design keeps Wazuh as the SIEM, with the QAPAQ overlay and Core as
the workflow/application layer. The Azure EUS2 design places Wazuh Dashboard and Core
on a private SIEM VM behind Azure Firewall DNAT and an internal Load Balancer. PostgreSQL,
Key Vault, release Blob, and platform logs remain separate. The single VM is a demo
single point of failure, not a resilient production topology. Ankay/Shuffle is a later
scope and must not be implied by a successful `siem` deployment.

Use this sequence:

1. Reconcile the EUS2 Terraform-managed seeder RBAC before another foundation apply.
2. Confirm the foundation resources and private endpoints through the approved read-only
   operational checks; do not infer that state is correct from the resources existing.
3. Seed only rotated, required Key Vault secrets through the protected create-only
   workflow. It uses a GitHub-hosted runner, protected `azure-demo-eus2` environment,
   the dedicated seeder OIDC identity, and an ARM `secureString` deployment. It verifies
   the private vault settings and approved Private Endpoint, and never reads a secret
   value. It does not need a runner in the VNet because the write is via ARM control
   plane; the VM's Key Vault access is separately through its Managed Identity and
   private endpoint.
4. Use the latest EUS2 SIEM artifact recorded in
   [`siem-release-bundle.md`](siem-release-bundle.md): source SHA
   `c96e35fc4618ad10db575e110b26625315fece20`, private Blob URL
   `https://qapaqdemoeus2rel3a2405f3.blob.core.windows.net/siem-release/releases/c96e35fc4618ad10db575e110b26625315fece20/qapaq-siem-c96e35fc4618.tar.gz`,
   SHA-256 `89040cb69535da6b7b6b763b77fa0bdb3e15c2089481d139fa9cd2f23c7e5472`.
   The publish workflow verifies the object digest and size. This is an install candidate;
   no Azure VM has installed it and no service health is established by publication.
5. Complete the operator-input matrix below, then run `Terraform Azure demo East US 2
   plan and apply` with scope `siem`, first as plan-only. Keep generic Container Apps
   runtime disabled, leave `ankay_host` absent, inspect all resource actions and costs,
   and use the protected apply gate only after the SIEM profile is complete.
6. Verify bootstrap and Wazuh service health, then test M365 permissions and event
   arrival, alert delivery, and agent enrollment using synthetic events. DNS at Punto.pe
   stays unchanged until endpoint, TLS, auth, ingestion, rollback, and owner acceptance
   are evidenced. The Terraform root does not manage public DNS.

## `AZURE_EUS2_SIEM_HOST_JSON` field matrix

Values marked **known** come from the committed EUS2 architecture/profile and module
contracts. **Operator input** means a real value must be supplied and verified. Do not
substitute an example CIDR, user key, credential, or identifier.

| JSON field | Known value / contract | Operator input or gate |
| --- | --- | --- |
| `address_prefix` | Must be a subnet inside VNet `10.80.0.0/16`; subnet length `/27` or larger (numerically, prefix length ≤27); SIEM IP is derived as host 10. | Select an unused subnet and prove no overlap with Container Apps `10.80.0.0/27`, PostgreSQL `10.80.16.0/28`, Private Endpoints `10.80.16.16/28`, Firewall `10.80.64.0/26`, or future Ankay `10.80.0.32/27`. Confirm it also leaves Azure-required addresses available. **No exact SIEM subnet is approved in the design.** |
| `vm_size` | `Standard_F4s_v2` only; module validates exact SKU. | Confirm quota and availability for the target subscription/region immediately before plan. |
| `admin_ssh_public_key` | OpenSSH **public** key only; no public SSH NSG rule. | Provide the public half tied to the recovery path (for example, approved private access/Bastion); retain private half outside GitHub/Terraform. |
| `ubuntu_image_version` | Canonical Ubuntu 24.04 LTS; `latest` is rejected. | Select and verify an exact currently available `24.04.x` Marketplace version in East US 2. |
| `data_disk_size_gb` | Minimum is `128`; disk has `prevent_destroy` and is security-sensitive persistent Wazuh data. | Confirm size against event volume, retention, and growth. `128` is a floor, not a retention guarantee. |
| `dashboard_ingress_cidrs` | Empty means HTTPS stays closed; `/0` is rejected. Firewall DNAT → internal LB → Nginx is the intended path. | Supply approved operator/VPN source CIDRs. Do not use `0.0.0.0/0` or `::/0`. |
| `agent_ingress_cidrs` | Empty means agent ports 1514/1515 stay closed; `/0` is rejected. | Supply actual managed endpoint/domain-controller private egress ranges or VPN ranges. Without them, no agent enrollment is enabled. |
| `core_secret_names` | Map is non-secret `ENV_NAME` → existing Key Vault **name**. The approved seed allowlist names include `qapaq-entra-client-secret` and `qapaq-teams-workflow-url`. | Confirm a rotated QAPAQ Entra secret, Teams Workflow URL, least-privilege PostgreSQL application credential, and the additional Core secret-provider/storage/gateway keys listed below exist. The PostgreSQL admin password in GitHub is not an application account. |
| `wazuh_secret_names` | Must include exactly these required keys: `office365-client-secret` and `wazuh-install-files.tar.b64`; these are Key Vault names, not values. | Confirm the Office 365 app secret corresponds to the selected Graph app. Generate the separate official Wazuh installer tar with passwords/certificates and load its one-line base64 as `wazuh-install-files.tar.b64` (decoded tar ≤18 KB). The release Blob is not this credential tar. |
| `core_environment` | Non-secret Core configuration map. Production defaults exist for some timeouts and TLS settings, but required endpoints/identity/storage/gateway configuration has no EUS2 profile yet. | Complete from the current Core config contract, including app database role/FQDN, identity/redirects, secrets provider, object storage, and Wazuh gateway. Current Terraform validation rejects several legitimate `*_REF` entries; see Core blockers. **This map is not currently satisfiable for the production Core contract.** |
| `office365.tenant_id` | GUID required. | Supply/confirm the Microsoft 365 tenant that owns the Graph app. |
| `office365.client_id` | GUID required. Do not assume QAPAQ dashboard login client ID is also the Graph collector app. | Confirm the app registration, Graph application permissions/admin consent, and secret pairing. |
| `office365.api_type` | `commercial`, `gcc`, or `gcc-high`. | Confirm tenant cloud. |
| `office365.enable_dlp` | Explicit boolean required. | Choose only after deciding whether the Graph app has the DLP/audit permissions required. `false` is the conservative initial choice; it does not enable DLP. |
| `provider_ingestion` | Optional map of strings. Accepted keys: `sophos_enabled`, `sophos_tenant_id`, `sophos_data_region`, `cato_enabled`, `cato_account_id`. For first M365 vertical, both connectors may remain off. | Only set `sophos_enabled="true"` after tenant GUID, region, client ID/secret, API scopes, Key Vault refs, and egress are verified. Only set `cato_enabled="true"` after numeric account ID, API key, permissions, Key Vault ref, and egress are verified. |
| `bootstrap_bundle_blob_url` | Latest current EUS2 release URL is shown above (no SAS). | Reconfirm it still matches the approved source SHA before the plan. |
| `bootstrap_bundle_sha256` | `89040cb69535da6b7b6b763b77fa0bdb3e15c2089481d139fa9cd2f23c7e5472` for the current EUS2 artifact. | Must match the immutable Blob byte-for-byte; do not use a GitHub ZIP digest. |

### JSON shape (intentionally incomplete and not pasteable)

The shape below names every top-level field required by the Terraform object. `REQUIRED`
comments are deliberately non-JSON markers; remove the markers only after every operator
input is approved and the Core schema blocker is resolved. It must not be stored as a
GitHub Environment variable in this form.

```text
{
  "address_prefix": REQUIRED_OPERATOR_SUBNET_CIDR,
  "vm_size": "Standard_F4s_v2",
  "admin_ssh_public_key": REQUIRED_OPERATOR_OPENSSH_PUBLIC_KEY,
  "ubuntu_image_version": REQUIRED_EXACT_AVAILABLE_24_04_X,
  "data_disk_size_gb": REQUIRED_REVIEWED_INTEGER_AT_LEAST_128,
  "dashboard_ingress_cidrs": [REQUIRED_OPERATOR_CIDR],
  "agent_ingress_cidrs": [REQUIRED_PRIVATE_AGENT_CIDR],
  "core_secret_names": REQUIRED_COMPLETE_ENV_TO_EXISTING_KEY_VAULT_NAME_MAP,
  "wazuh_secret_names": {
    "office365-client-secret": REQUIRED_EXISTING_KEY_VAULT_SECRET_NAME,
    "wazuh-install-files.tar.b64": REQUIRED_EXISTING_KEY_VAULT_SECRET_NAME
  },
  "core_environment": REQUIRED_COMPLETE_NONSECRET_CORE_CONFIGURATION,
  "office365": {
    "tenant_id": REQUIRED_M365_TENANT_GUID,
    "client_id": REQUIRED_M365_GRAPH_APP_GUID,
    "api_type": REQUIRED_COMMERCIAL_GCC_OR_GCC_HIGH,
    "enable_dlp": REQUIRED_EXPLICIT_BOOLEAN
  },
  "provider_ingestion": {
    "sophos_enabled": "false",
    "cato_enabled": "false"
  },
  "bootstrap_bundle_blob_url": "https://qapaqdemoeus2rel3a2405f3.blob.core.windows.net/siem-release/releases/c96e35fc4618ad10db575e110b26625315fece20/qapaq-siem-c96e35fc4618.tar.gz",
  "bootstrap_bundle_sha256": "89040cb69535da6b7b6b763b77fa0bdb3e15c2089481d139fa9cd2f23c7e5472"
}
```

## Missing inputs and Key Vault sources

The EUS2 secret-seed workflow allowlists one secret per run and is create-only. The
previous read-only environment inventory found these source secrets absent; re-check
their **names/status only** before relying on that inventory:

- `QAPAQ_EUS2_ENTRA_CLIENT_SECRET` → `qapaq-entra-client-secret`
- `QAPAQ_EUS2_OFFICE365_CLIENT_SECRET` → `office365-client-secret`
- `QAPAQ_EUS2_SOPHOS_CLIENT_ID` → `sophos-client-id`
- `QAPAQ_EUS2_SOPHOS_CLIENT_SECRET` → `sophos-client-secret`
- `QAPAQ_EUS2_CATO_API_KEY` → `cato-api-key`
- `QAPAQ_EUS2_TEAMS_WORKFLOW_URL` → `qapaq-teams-workflow-url`
- `QAPAQ_EUS2_WAZUH_INSTALL_FILES_TAR_B64` → `wazuh-install-files.tar.b64`

The release bundle is already published as a private Blob and is fetched by the SIEM
VM's own Managed Identity. Do not put the several-gigabyte release into Key Vault. The
small official Wazuh install tar is a separate input that contains credentials and
certificates and must be generated for this cluster; it cannot be derived from the
release Blob.

The seed workflow targets private EUS2 Key Vault from a GitHub-hosted runner through
ARM control plane. It does not require a self-hosted/VNet runner or relax the vault's
private-network policy. Each execution requires the protected environment approval,
checks the exact subscription/vault/private-endpoint metadata, checks the target name
does not already exist, and writes a single `secureString`; it does not read secret
values. Use it only with freshly rotated values. The workflow cannot overwrite; rotation
is a different reviewed procedure.

## Terraform seeder RBAC created outside Terraform

Terraform code declares the two deterministic custom role definitions and two role
assignments in `module.key_vault_seed_identity[0]`:

- `azurerm_role_definition.group_deployment`
- `azurerm_role_definition.vault_secret_metadata`
- `azurerm_role_assignment.group_deployment`
- `azurerm_role_assignment.vault_secret_metadata`

The role definition IDs in the module are stable UUIDv5 values. The Cloud Shell
assignments described for this deployment were created out-of-band. Terraform does
not automatically adopt Azure resources merely because they match the configured
name/scope. The state membership has not been inspected here. Before another apply,
compare the exact ARM resource IDs with Terraform's state inventory. If a configured
address is absent from state but the Azure role/assignment exists, import that exact
resource ID to its module address; do not blindly recreate an assignment that Azure
already has. Role-assignment ARM IDs must be obtained from metadata because their GUIDs
cannot be inferred from the Terraform configuration. If definitions are already in
state, do not import them again.

## Core and end-to-end blockers (separate from Wazuh host readiness)

### Wazuh-only host gates

- Approved unused SIEM subnet, exact Ubuntu Marketplace version, recovery public key,
  dashboard source CIDRs, and private agent source CIDRs.
- Wazuh installer credential/certificate tar in Key Vault and a matched M365 Graph app
  secret plus tenant/app GUIDs and consented permissions.
- Successful plan review, quota/price check, private Blob/Key Vault access, and clean
  host bootstrap. The Wazuh bundle was published, but no EUS2 SIEM VM has installed it.

### QAPAQ Dashboard/Core gates

- `core_environment` validation in `infra/azure/variables.tf` uses a deny regex for
  names such as `PASSWORD`, `SECRET`, and `TOKEN`, with only
  `QAPAQ_ENTRA_CLIENT_SECRET_REF` exempted. Core's production parser also requires
  references such as `QAPAQ_POSTGRES_PASSWORD_REF`,
  `QAPAQ_MINIO_SECRET_KEY_REF`, `QAPAQ_WAZUH_GATEWAY_ACCESS_TOKEN_REF`,
  `QAPAQ_WAZUH_CURSOR_SECRET_REF`, and `QAPAQ_SECRET_FINGERPRINT_KEY_REF`. Therefore,
  a complete production `core_environment` cannot currently pass the Terraform
  validation. The safe code correction is to allowlist only the supported `*_REF`
  keys, validate the `secret://keyvault/<name>` form, and assert each reference matches
  the corresponding `core_secret_names` entry. No code change is made in this branch.
- Core's production configuration requires a PostgreSQL runtime principal/password.
  Azure `modules/data` creates the databases but does not provision/validate the
  least-privilege application role or its secret for this VM path. The Terraform
  PostgreSQL administrator credential is not a substitute for the app role.
- Core's current object storage contract is MinIO/S3 (`QAPAQ_MINIO_ENDPOINT`, raw
  bucket, access-key and secret-key refs). Azure Blob Storage is not a drop-in MinIO
  or S3 API endpoint. A small, explicit Azure Blob adapter is required behind the
  existing object-storage port; it should use Managed Identity/Blob Data RBAC and
  preserve retention, idempotency, and AWS's current adapter. Do not repoint MinIO
  variables to a Blob hostname.
- Core requires a Wazuh gateway URL and a workload token. The EUS2 SIEM module does
  not provision KrakenD/API Gateway. The gateway must be implemented/deployed on an
  approved private path and its token/scope validated before enabling Core's Wazuh
  ingestion.
- No Redis-compatible cache/queue is provisioned by EUS2 Terraform. The current app
  has no verified BullMQ producer/worker E2E for this Azure path; the Azure parity
  review says the worker is lifecycle-only and ADR-AZ-001 remains proposed. A managed
  Redis-compatible service cannot be called the queue until the actual queue contract
  is exercised.
- `QAPAQ_SECRET_PROVIDER_TYPE` is required for the Core control plane, and the local
  configuration README still marks the production backend `TO_BE_PROVIDED`. The SIEM
  bootstrap can read Key Vault secrets with VM Managed Identity and write a root-owned
  environment file, but that is not the same as a working Core secret-provider adapter
  for references at runtime.
- Keep the existing QAPAQ/Entra auth contract unchanged. Configure redirect URI,
  allowed redirects, proxy trust, role bindings and user authorization only after the
  service configuration above is deployable; this document proposes no auth change.
- Ankay/Shuffle remains a later deployment gate: six image digests, Compose/runtime
  hardening, private routes/auth, and E2E playbook tests are separate from this SIEM
  profile. DNS stays at Punto.pe until the whole path is accepted.

### Architecture decision for Azure adapters

Azure Blob + a private Redis-compatible service + Key Vault can be target services, but
they do not satisfy the current Core contracts by configuration alone:

- Use Azure Blob only after implementing/testing the Core storage adapter. Key Vault
  can hold named values; implement an Azure Key Vault provider if the Core will resolve
  references dynamically. The existing VM bootstrap read/materialization path alone
  does not prove that interface.
- Azure Managed Redis is a candidate only after the repository's queue code is enabled,
  EUS2 private endpoint/DNS and NSG/firewall paths are added, the selected cluster
  policy/auth mode is compatible with the actual Node client, and enqueue/worker/retry/
  idempotency/failover tests pass. The current SIEM NSG allows TCP/443 to the private
  endpoint subnet, not Redis TCP/10000 or discovered shard ports; no Redis private DNS
  zone/endpoint is wired in the SIEM path. Do not infer compatibility from protocol
  resemblance alone.
- These storage, queue, and secret adapters do not require changing the existing QAPAQ
  login flow. Keep OIDC/auth code untouched while validating them behind service ports.

Microsoft currently documents Azure Managed Redis as Redis 7.4.x with TLS and managed
high availability; its cluster policy affects client behavior and network ports. BullMQ
documents compatibility with Redis 6.2+ but notes that not every Redis alternative works;
the current BullMQ page does not list Azure Managed Redis as a vendor it regularly tests.
Treat it as an unverified candidate until the version-pinned client passes E2E tests.
Sources: [Azure Managed Redis overview](https://learn.microsoft.com/en-us/azure/redis/overview),
[Azure Managed Redis clustering choices](https://learn.microsoft.com/en-us/azure/redis/choose-clustering-policy),
[BullMQ Redis compatibility](https://docs.bullmq.io/guide/redis-tm-compatibility/).

## Acceptance evidence required after deployment

Do not label the SOC operational until evidence shows:

1. VM, Firewall DNAT, internal Load Balancer, private route, and TLS are healthy.
2. Wazuh Manager, Indexer, Filebeat, Dashboard, and QAPAQ Core services report ready;
   host bootstrap logs were reviewed without exposing values.
3. A synthetic M365 audit event is pulled through Microsoft Graph, parsed, indexed in
   the expected Wazuh index, and visible in the branded Dashboard.
4. A synthetic Wazuh alert produces a successful QAPAQ/Teams path, and an authorized
   agent can enroll over only the approved private source range.
5. Database/object-store/secret-provider/queue checks pass their defined contracts;
   no source is marked green from static config or a successful Terraform apply alone.
6. Rollback and data-preservation steps are exercised; public DNS is changed only after
   these checks and approval.

Ankay playbooks, Sophos/Cato ingestion, DNS cutover, and production resilience are not
certified by a successful first SIEM apply.
