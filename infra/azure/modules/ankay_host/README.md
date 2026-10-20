# Ankay Qapaq host (Azure, isolated module)

This module is a **preparation artifact**, not part of the Azure root yet. It creates one private
Ubuntu VM, an attached persistent data disk, a private IP, a narrowly scoped NSG, a managed identity
with `AcrPull` on one registry, and a route table that forces internet-bound traffic from a dedicated
subnet through an existing Azure Firewall. It writes the reviewed Compose document to the VM but
does not install Docker, retrieve secrets, start containers, install Wazuh Agent, publish a DNS name,
or change the QAPAQ login.

## Required gates before root wiring

- A dedicated subnet and non-overlapping static private IPs for the host, edge, QAPAQ API, and Azure
  Firewall. The subnet association is changed to this module's route table; never pass a subnet shared
  with PostgreSQL, Container Apps, or another workload.
- A working Azure Firewall and reviewed default-deny application/network policy. The route table
  forces `0.0.0.0/0` through it; the NSG permits only HTTP/S Internet destinations so the firewall
  can apply its FQDN allowlist. DNS to Azure platform DNS, the exact QAPAQ API endpoint, and optionally
  Wazuh Manager TCP/1514 have separate rules. Firewall policy itself is outside this module.
- An exact Ubuntu 24.04 Marketplace version, a cost-approved VM SKU, and the operator's SSH **public**
  key. No public IP or inbound SSH rule is created. Use Azure Run Command/serial console for bootstrap.
- A non-secret Compose file and its SHA-256. Terraform checks the SHA and that all six ACR references
  (frontend, backend, Orborus, worker image used by Orborus, OpenSearch, datastore) appear exactly.
  Every reference must end in a full OCI `@sha256:` digest. Do not put actual credentials in Compose;
  Terraform state and VM `custom_data` retain the Compose content.
- ACR repositories containing every image. The only current Ankay build workflow covers the frontend;
  the remaining images and datastore source/image digests have not been approved or verified.

## Data and trust boundaries

The data disk uses Standard SSD and `prevent_destroy`; the VM also uses `prevent_destroy` to prevent
an accidental teardown of the host. OpenSearch, workflow files, and app hotload directories should
be bind-mounted under `/mnt/ankay` in the eventual Compose. The cloud-init bootstrap formats the
newly created empty managed disk on first boot, mounts it and stages the digest-checked Compose.
The host or disk must not be replaced without a separate backup and recovery review.

Only the edge subnet reaches the frontend port, and only the QAPAQ API subnet reaches the backend
webhook port. Network rules cannot distinguish individual Container Apps sharing that subnet, so the
webhook still needs application authentication/HMAC and replay defense. `/ankay/*` remains behind
the existing QAPAQ `auth_request`; this module adds no public route and does not provide QAPAQ role
authorization. OpenSearch has no host port rule. Do not expose the Docker socket beyond the Shuffle
components that must launch workers: Docker socket access is effectively host-root authority.

The module only exposes TCP/80/443 internet destinations through the forced route. Azure Firewall
must deny by default and allow only the exact registry, package, provider/API, and approved threat
intelligence destinations required by the final Compose. If that firewall, its allowlist, or the UDR
is unavailable, the service must remain offline rather than use direct internet egress.

## Validation

`.github/workflows/ankay-azure-iac.yml` checks HCL formatting and provider schema without Azure
credentials. It does not run a cloud plan. The module is not wired into `infra/azure/main.tf`; no
resources or DNS changes have been made. After the upstream runtime images, Compose contract, secret
references and application callback are verified, integrate it into the root, run the protected
remote plan, inspect cost and every resource action, and only then consider deployment.
