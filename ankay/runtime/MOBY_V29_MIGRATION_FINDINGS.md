# Moby v29 SDK migration findings

Status: backend and worker source overlays prepared on isolated branch `codex/ankay-moby-v29`;
runtime release remains blocked pending an Engine 29.5.1 integration test. No push, ACR
publication, Terraform, DNS or deployment was done.

## Backend migration

The overlay uses `github.com/moby/moby/client v0.2.1` and `github.com/moby/moby/api v1.53.0`,
adapts backend image build/pull/list/tag/save operations, and patches the pinned
`shuffle-shared v1.3.22` Docker helper. Image export streams Moby `ImageSave` into the HTTP
response. The backend module removes `go-dockerclient`; a stale `github.com/docker/docker`
indirect requirement in `shuffle/singul` is not imported by backend code and is excluded from
this module graph. The exact `shuffle-shared` source commit and overlays are recorded in the
component lock and build workflow.

- Scratch validation: `gofmt`, `go mod tidy`, and `go test ./...` pass for the backend with the
  checked-out patched shared module. `go mod why -m github.com/docker/docker` reports that the
  backend does not need the SDK; `go list -m all` contains the Moby client/API modules and no
  legacy Docker SDK or `go-archive`.
- Trivy 0.74.0 filesystem scan of the backend module and patched shared module passed the
  repository's `HIGH,CRITICAL` vulnerability gate. The separate nested `shuffle-shared/app_upload`
  module is omitted from the backend build context because the backend does not import or build it.
- The shared module builds and its tests pass with `go test -vet=off ./...`; default `go test ./...`
  is blocked by upstream vet finding a pre-existing redundant `or` in `cloudSync.go:3959`.
- No Docker Engine daemon is active, so no image scan or integration test against a live daemon is
  claimed. CI remains the final image-scan gate.

## Worker migration

The worker overlay ports container lifecycle, image, task, node, network, and Swarm operations to
`github.com/moby/moby/client` plus `github.com/moby/moby/api`. It moves Swarm network attachments
under `TaskTemplate.Networks` and parses hard-coded network ranges into `netip` values expected by
the new API. `shuffle-shared` is vendored as the same pinned overlay used by the backend and the
worker module excludes the unused legacy Docker module required by `shuffle/singul`.

- Scratch validation on the pinned Shuffle source: `gofmt`, `go mod tidy`, `go test ./...`, and
  `go build ./...` pass. `go list -m all` contains Moby client/API and excludes `github.com/docker/docker`
  and `github.com/moby/go-archive` after excluding the unused SDK requirement from `shuffle/singul`.
- Trivy 0.74.0 filesystem scan of the exact worker module and patched shared overlay reports zero
  HIGH/CRITICAL findings. The nested upstream `shuffle-shared/app_upload` module is not copied into
  the worker build context; it has separate findings and is not built by this runtime.
- The worker image has not been built or tested against a live Engine; Swarm semantics, API version
  negotiation and runtime image behavior still require the CI/integration gate before publication.

## Remaining blockers

- The local Docker CLI is 29.4.3, but no Engine daemon is active. Integration tests against Engine
  29.5.1+ are required for image and worker operations, cancellation and API negotiation.
- Orborus and shuffle-security remain blocked by the license/compatibility findings in
  `azure-components.lock.json`. The current host module still requires all six image digests;
  this backend patch does not make Ankay deployable.

## References

- [Docker Engine 29 release notes](https://docs.docker.com/engine/release-notes/29)
- [Moby README](https://github.com/moby/moby/blob/master/README.md)
