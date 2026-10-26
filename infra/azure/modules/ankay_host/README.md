# Ankay Qapaq host (Azure, isolated module)

This module is wired into `infra/azure/main.tf` as an optional host, disabled while `ankay_host` is
`null`. When enabled, it creates one private Ubuntu VM, an attached persistent data disk, a private
IP, a narrowly scoped NSG, a managed identity with `AcrPull` on one registry, per-secret Key Vault
read grants, and a route table that forces internet-bound traffic from a dedicated subnet through an
existing Azure Firewall. On first boot cloud-init installs exact package versions, prepares the
persistent disk without formatting anything except a positively verified blank disk, fetches named
Key Vault secrets into a root-only env file, logs in to ACR with managed identity, pulls digest-pinned
Compose images and starts them with health and restart policies. A systemd timer refreshes the short-lived ACR
login for Orborus worker pulls. Terraform records that startup is configured; it cannot prove that
the VM booted or passed runtime health checks. The module does not install Wazuh Agent, publish DNS,
expose a public endpoint, or change the QAPAQ login.

## Required gates before enabling the module

- A dedicated subnet and non-overlapping static private IPs for the host, edge, QAPAQ API, and Azure
  Firewall. The subnet association is changed to this module's route table; never pass a subnet shared
  with PostgreSQL, Container Apps, or another workload.
- A working Azure Firewall and reviewed default-deny application/network policy. The route table
  forces `0.0.0.0/0` through it; the NSG permits only HTTP/S Internet destinations so the firewall
  can apply its FQDN allowlist. DNS to Azure platform DNS, the exact QAPAQ API endpoint, and optionally
  Wazuh Manager TCP/1514 have separate rules. Firewall policy itself is outside this module.
- An exact Ubuntu 24.04 Marketplace version, a cost-approved VM SKU, and the operator's SSH **public**
  key. No public IP or inbound SSH rule is created. Use Azure Run Command/serial console for bootstrap.
- A non-secret Compose file and its SHA-256, a map of environment variable names to already-created
  Key Vault secret names, and exact apt versions for Docker Engine/Compose and Azure CLI. Secret
  values must never appear in Compose, Terraform inputs/state, or VM `custom_data`; the host identity
  can read only the explicitly named Key Vault secrets. The contract is exactly five services:
  `shuffle-security`, `frontend`, `backend`, `orborus`, and `opensearch`. The separate worker image
  is launched dynamically by Orborus through `SHUFFLE_WORKER_IMAGE`; it is not a persistent service.
  Terraform validates the five service image references, the worker reference, and the Compose SHA.
  Every image must use a full OCI `@sha256:` digest from the configured ACR. `shuffle-security` and
  OpenSearch must not publish host ports; OpenSearch stays on the Compose network. Do not put actual
  credentials in Compose; Terraform state and VM `custom_data` retain the Compose content.
- ACR repositories containing all six images. The current Ankay build workflow covers only the
  frontend. Backend, Orborus, worker, `shuffle-security`, and OpenSearch digests have not been
  approved or verified. Upstream Compose uses floating `latest` for Shuffle services; do not use
  those mutable tags in an Azure deployment.
- A reachable Key Vault Private Endpoint and private DNS, plus exact Docker/ACR FQDN policy entries.
  The current ACR has no dedicated data endpoint, so image layers require `*.blob.core.windows.net`
  through Azure Firewall and the exact ACR login hostname. This wildcard is a documented constraint;
  prefer dedicated ACR data endpoints before production.

## Data and trust boundaries

The data disk uses Standard SSD and `prevent_destroy`; the VM also uses `prevent_destroy` to prevent
an accidental teardown of the host. OpenSearch, workflow files, and app hotload directories should
be bind-mounted under `/mnt/ankay` in the eventual Compose. The bootstrap checks that Azure LUN 0 is
the expected block device and exact configured size, has no partition/mount conflict, and has no
filesystem/signature before considering initialization. It reads the full disk and runs `mkfs.ext4`
only when every byte is zero; unknown signatures, nonzero data, probe errors, or size/identity
mismatches stop the bootstrap without formatting. Existing ext4 is mounted without reformatting;
other filesystems are rejected. The first-boot empty-disk scan adds startup time. The host or disk
must not be replaced without a separate backup and recovery review.

Throughput has not been measured on the target Azure SKU/host. As a sizing example only, scanning
64 GiB at 100–500 MiB/s takes roughly 11–2 minutes; 128 GiB takes roughly 22–4 minutes. This is
before the remaining bootstrap work, and actual duration depends on the VM, disk SKU and host.

Only the edge subnet reaches the frontend port, and only the QAPAQ API subnet reaches the backend
webhook port. Network rules cannot distinguish individual Container Apps sharing that subnet, so the
webhook still needs application authentication/HMAC and replay defense. `/ankay/*` remains behind
the existing QAPAQ `auth_request`; this module adds no public route and does not provide QAPAQ role
authorization. `shuffle-security` and OpenSearch have no host port mappings or NSG ingress.

At boot, systemd runs Compose only after Docker, network-online and `/mnt/ankay` are ready. Startup
waits for health checks and restores the last-known-good manifest on a failed upgrade, without
removing volumes. This does not roll back application data migrations. Missing image digests, secret
names, firewall/DNS connectivity or service health leaves Ankay unhealthy and not ready for edge
routing.

**High-risk Docker boundary:** upstream Compose mounts `/var/run/docker.sock` into both backend and
Orborus. A process with socket access can control the host Docker daemon, create privileged
containers, mount host paths, and read host data; this is effectively root authority. Orborus needs
Docker access to start ephemeral workers. The upstream Compose also sets `seccomp:unconfined` on
Orborus, weakening syscall isolation. Do not copy that setting automatically. Before runtime approval,
review whether backend needs direct socket access, evaluate a narrowly filtered socket proxy and
test Orborus compatibility, remove `seccomp:unconfined` if supported, and keep Ankay on a dedicated
VM isolated from the SIEM with minimal outbound access. These changes require runtime verification;
the Terraform module does not implement them.

The module only exposes TCP/80/443 internet destinations through the forced route. Azure Firewall
must deny by default and allow only the exact registry, package, provider/API, and approved threat
intelligence destinations required by the final Compose. If that firewall, its allowlist, or the UDR
is unavailable, the service must remain offline rather than use direct internet egress.

## Validation

`.github/workflows/ankay-azure-iac.yml` checks HCL formatting and provider schema without Azure
credentials. It does not run a cloud plan. The root wiring is optional and disabled by default. The
feature branch's boot automation is not deployment evidence; verify the protected remote plan, inspect
cost and every resource action, and then verify VM systemd/Compose health and the protected edge route
after deployment. Do not call Ankay operational from Terraform output alone.
