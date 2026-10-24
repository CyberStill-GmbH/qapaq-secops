# QAPAQ SIEM Azure release bundle

Status: **the current-main candidate was built and published to private Azure Blob; no SIEM VM has been provisioned or installed yet**.

## What the workflow produces

`.github/workflows/azure-siem-release-bundle.yml` combines four successful CI outputs for
the same `main` SHA:

1. `azure-siem-prerequisites-experimental.yml`: Wazuh Manager and Indexer 4.14.8, plus
   Filebeat 7.10.2-2, module 0.5 and the template.
2. `qapaq-dashboard-azure.yml`: Dashboard Debian package `4.14.8-1qapaq1` for OSD 2.19.6.
3. `qapaq-core-azure.yml`: QAPAQ core archive built for Node 24.21.0 and the runner's CA store.
4. Official `wazuh-installation-assistant` v4.14.8 at immutable commit
   `33d2069715e8500b676d13cefe7ddaea8eb79019` (signature verified by GitHub API).

The workflow runs from `main` and takes `release_sha` plus the three successful build run IDs.
`release_sha` must be a full commit already merged into the current `main`. Each source run must
be successful on `main` at that exact SHA, and the install/bootstrap inputs must not have changed
between that commit and the workflow run. The workflow checks the Wazuh pins, artifact hashes and
provenance; assembles the official offline package tree; records the full `qapaqCommit` in its
manifest; and uploads a seven-day review artifact. This permits the release assembler to reuse
verified, unexpired artifacts after unrelated commits advance `main`, while refusing candidates
whose package sources or pins have changed. It has read-only repository/artifact permissions. It
has no Azure OIDC permission and does not publish, deploy, run Terraform, or edit DNS.

The separate `.github/workflows/azure-siem-release-publish.yml` accepts a successful bundle-run ID
and its 40-character candidate source SHA. It verifies the bundle run is the expected successful
`main` workflow, the candidate commit is an ancestor of that run, the matching artifact has not
expired, and the embedded manifest records the same full `qapaqCommit`. It downloads only that
artifact, verifies `SHA256SUMS`, then signs into Azure with the existing `azure-demo` OIDC identity. It uploads
to `releases/<source-sha>/` in the private `siem-release` container using Entra RBAC, shared keys
disabled, anonymous access disabled, and `--overwrite false`. A retry is accepted only if the
existing blob's SHA metadata and content length match. The workflow requires the non-secret GitHub
repository variable `AZURE_SIEM_RELEASE_STORAGE_ACCOUNT`; it prints the Blob URI and digest, never
a SAS URL or secret value. Publishing does not apply Terraform, configure runtime inputs, or change
DNS.

The next candidate assembled after the detection-pack change also contains the 30-case catalog,
the QAPAQ provider rules, the Outlook/Sysmon endpoint rule and an idempotent installer. The
installer registers `/var/ossec/etc/rules` with the Wazuh ruleset, validates `wazuh-analysisd`,
and restarts the Manager with rollback if validation or restart fails. This does not enable
Sophos/Cato collectors: those remain opt-in and need their Key Vault references, provider
configuration, approved egress and real acceptance. The 2026-10-24 candidate includes the versioned
provider and endpoint rule files, but does not prove those collectors are enabled or events are arriving.

### Latest published candidate evidence — 2026-10-24

- Prerequisite build: [40080125109](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40080125109)
- Dashboard build: [40080125315](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40080125315)
- Core build: [40080124975](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40080124975)
- Bundle run: [40084337528](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40084337528)
- Publisher run: [40086863260](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40086863260)
- Source SHA: `afdfbaa61f558ab30c307aa4cf6d0fd8a783b15c`
- Private Blob URI (no SAS): `https://qapaqsecdemorel66f8c73b.blob.core.windows.net/siem-release/releases/afdfbaa61f558ab30c307aa4cf6d0fd8a783b15c/qapaq-siem-afdfbaa61f55.tar.gz`
- SHA-256: `954d284674442645dc4c1a7bf9a991ae7712888a842bff262083dfa66806dbcd`
- Size: `6959200149` bytes. The publisher verified the Blob content length and SHA metadata after upload. The source-run GitHub artifact was `13921808870` bytes.
- The exact source artifacts succeeded on the same SHA. The bundle run verified installer, provenance, package hashes and bootstrap contract; the publisher authenticated through Azure OIDC and verified the private Blob. It remains an install candidate, not evidence of a provisioned VM or operational SIEM.

### Previous published candidate evidence — 2026-10-23

- Prerequisite build: [39883868793](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39883868793)
- Dashboard build: [39883868545](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39883868545)
- Core build: [39883868998](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39883868998)
- Bundle run: [39890065716](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39890065716)
- Publisher run: [39891503496](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39891503496)
- Source SHA: `6c3c2b498a8a9dc43f6a0da45c07244fdf132f2f`
- Private Blob URI (no SAS): `https://qapaqsecdemorel66f8c73b.blob.core.windows.net/siem-release/releases/6c3c2b498a8a9dc43f6a0da45c07244fdf132f2f/qapaq-siem-6c3c2b498a8a.tar.gz`
- SHA-256: `9cfcd1acd6c5c1c78ec10024d6a4b7c3bbd43932ad8931ce3a9d63d126a4ccac`
- Size: `5083594839` bytes. The publisher verified the Blob content length and SHA metadata after upload.
- This is a build and publication result only. It does not prove VM provisioning, installation, service health, DNS, or data ingestion.
### Superseded candidate evidence — 2026-10-22

- Publisher run: [39823003732](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39823003732)
- Source bundle run/SHA: [39819291113](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/39819291113) / `f599adf7591cc0adab34d5f43a355073d23f909d`
- Private Blob URI (no SAS): `https://qapaqsecdemorel66f8c73b.blob.core.windows.net/siem-release/releases/f599adf7591cc0adab34d5f43a355073d23f909d/qapaq-siem-f599adf7591c.tar.gz`
- SHA-256: `3045155b53ff736bdcb157cdea6022b2931b1d4781d89c74ed1a497f38dc8f4e`
- Size: `5083241196` bytes. The workflow verified the Blob metadata digest and content length after upload.
- This is an install candidate only. It has not been installed on an Azure VM and does not certify the SOC as operational.

### Azure Terraform state at publication

- Latest plan run: [40085138833](https://github.com/CyberStill-GmbH/qapaq-secops/actions/runs/40085138833); it succeeded with `0 add, 0 change, 0 destroy`, so the apply step was skipped.
- The workflow inputs were `siem_host=null`, `ankay_host=null`, and `enable_runtime=false`; no SIEM or Ankay VM was created.
- Terraform is independent of AWS. The Azure root creates its own Azure Firewall when `siem_host` is provided; the AWS-era firewall is not a prerequisite.

## First-boot inputs

The VM bootstrap downloads one private Blob by Managed Identity and verifies its Terraform-pinned
SHA-256. The release installer requires the VM's `wazuh_secret_names` map to include:

```hcl
wazuh_secret_names = {
  "wazuh-install-files.tar.b64" = "<existing-key-vault-secret-name>"
}
```

That Key Vault secret must be one-line base64 of the official assistant's
`wazuh-install-files.tar`, with `wazuh-passwords.txt` and the generated certificates under
`wazuh-install-files/`. The runtime verifier rejects malformed base64, multiline input, unsafe tar
paths, missing password/certificate files, and inputs exceeding the bounded secret size. It writes
the decoded archive only to `/run` first, then the installer copies it with mode `0600` to the
durable SIEM data volume and the root-only assistant path. The secret value is never read by build,
plan, or local tooling and is not printed by the installer.

The Key Vault secret name, current version, value, certificate validity and matching node names have
not been inspected here. The module references a secret by name (latest version), so a secret-value
rotation affects the next bootstrap. The Key Vault reference and `core_secret_names` must be verified
by the owner before applying. Azure preflight requires both the Entra client secret and
`QAPAQ_TEAMS_WORKFLOW_URL` to be mapped by name in `core_secret_names`; the signed Workflow URL
must never be placed in `core_environment`, GitHub variables, Terraform state, or logs. The release
requires complete `core_environment`/`core_secret_names`
for the selected production configuration; it does not invent app registrations, database
credentials, redis references or policy values.

## Install behavior and boundaries

The installer runs the official assistant in all-in-one offline mode, verifies the exact package
versions, validates the Office 365 configuration and client secret file materialized from Key Vault,
installs the QAPAQ core through its atomic release installer, applies the M365 rules/configuration,
then waits for active
Manager, Indexer, Filebeat, Dashboard and QAPAQ core services, Indexer TLS health and `/health/ready`.
Before the first package operation it also requires the official assistant's Ubuntu prerequisites
(`curl`, `tar`, `gnupg`, `openssl`, `lsof`, `apt-transport-https`, `libcap2-bin`, `debconf`,
`adduser`, `procps`) to already be installed. If any are missing it stops before installing Wazuh;
the reviewed Azure Firewall/APT route must provision them beforehand.
Bootstrap records the release only after these checks. A repeat of the exact installed release is
health-only; an existing unregistered installation or a different release is refused. The Core
installer can roll back a failed Core activation. Wazuh package installation is destructive to a
pre-existing install and is only allowed on a clean host; if its first install fails mid-way, the
installer intentionally stops without purging packages or deleting state. Operator diagnosis is
required before retry.

This bundle does **not** install/validate the QAPAQ access and role overlay, `qapaq_ops`
edge route, TLS/DNS, Ankay/Shuffle or Teams webhook. It installs M365 plus the versioned
QAPAQ detection rules, but does not prove Graph permissions or event ingestion/indexing. Sophos/Cato
rules are present while their collectors remain disabled unless explicitly configured. The Azure installer
passes a Key Vault-materialized `file:` secret source; the shared M365 script retains an AWS
Secrets Manager branch for AWS deployments, which the Azure path does not invoke. The Dashboard
package contains QAPAQ branding/plugin code, but without edge/auth configuration it is not an
externally usable QAPAQ SOC.

## Remaining evidence before deployment

- CI creates the combined candidate from three successful source workflows on a single main SHA.
- The candidate must be tested on an isolated Ubuntu 24.04 VM with the real package artifacts and
  pre-provisioned Key Vault refs. This Windows workstation has no working Docker daemon, and no VM
  installation test has run.
- The published Blob URI and digest must be pinned in the reviewed `siem_host` Terraform input.
- The Azure host input must include valid M365 tenant/app IDs and the Key Vault name mapped to
  `office365-client-secret`; the secret itself must exist before first boot.
- The Key Vault secret `wazuh-install-files.tar.b64` and the Core/Entra secret references must be provisioned and verified by metadata without reading values. The current Terraform input objects have not been supplied.
- The bootstrap must install or verify Ubuntu's required packages before invoking the offline installer; no clean-VM installation test has run yet.
- Key Vault refs, private endpoints, firewall allowlist, subnet routes and core database/identity
  configuration must be verified without displaying secret values.
- Complete access, edge TLS/DNS, M365, Teams, Ankay and vendor connectors in their own reviewed
  steps before describing the deployment as an operational SOC.
