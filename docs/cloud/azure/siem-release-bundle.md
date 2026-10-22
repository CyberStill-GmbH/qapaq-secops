# QAPAQ SIEM Azure release bundle

Status: **candidate builder implemented; not published and not runtime-certified**.

## What the workflow produces

`.github/workflows/azure-siem-release-bundle.yml` combines four successful CI outputs for
the same `main` SHA:

1. `azure-siem-prerequisites-experimental.yml`: Wazuh Manager and Indexer 4.14.8, plus
   Filebeat 7.10.2-2, module 0.5 and the template.
2. `qapaq-dashboard-azure.yml`: Dashboard Debian package `4.14.8-1qapaq1` for OSD 2.19.6.
3. `qapaq-core-azure.yml`: QAPAQ core archive built for Node 24.21.0 and the runner's CA store.
4. Official `wazuh-installation-assistant` v4.14.8 at immutable commit
   `33d2069715e8500b676d13cefe7ddaea8eb79019` (signature verified by GitHub API).

The workflow validates successful run IDs, expected workflow paths, branch and exact source SHA;
checks artifact hashes/provenance; builds the official offline package tree; and uploads a
seven-day review artifact. It has read-only repository/artifact permissions. It has no Azure
OIDC permission and does not publish, deploy, run Terraform, or edit DNS.

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
by the owner before applying. The release requires complete `core_environment`/`core_secret_names`
for the selected production configuration; it does not invent app registrations, database
credentials, redis references or policy values.

## Install behavior and boundaries

The installer runs the official assistant in all-in-one offline mode, verifies the exact package
versions, installs the QAPAQ core through its atomic release installer, then waits for active
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

This bundle does **not** currently install/validate the QAPAQ access and role overlay, `qapaq_ops`
edge route, TLS/DNS, Microsoft 365 collector, Ankay/Shuffle, Teams webhook, Sophos or Cato. The
Dashboard package contains QAPAQ branding/plugin code, but without edge/auth configuration it is
not an externally usable QAPAQ SOC. The existing Office 365 script still contains AWS-specific
secret-provider branches, so it must not be copied into this Azure bundle until a separately tested
Azure adapter exists.

## Remaining evidence before deployment

- CI creates the combined candidate from three successful source workflows on a single main SHA.
- The candidate must be tested on an isolated Ubuntu 24.04 VM with the real package artifacts and
  pre-provisioned Key Vault refs. This Windows workstation has no working Docker daemon, and no VM
  installation test has run.
- The candidate must be promoted to a private Blob, then its URL and SHA-256 supplied to Terraform.
- Key Vault refs, private endpoints, firewall allowlist, subnet routes and core database/identity
  configuration must be verified without displaying secret values.
- Complete access, edge TLS/DNS, M365, Teams, Ankay and vendor connectors in their own reviewed
  steps before describing the deployment as an operational SOC.
