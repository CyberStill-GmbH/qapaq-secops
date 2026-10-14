---
name: qapaq-soc-engineering
description: Use for QAPAQ SecOps backend, detection/SOAR, identity, Wazuh integration, infrastructure, or release work in this repository.
---

# QAPAQ SOC engineering for Claude Code

At the start of each QAPAQ task, read `COORDINACION-CLAUDE-CODEX.md` and inspect its
latest requests, decisions and file locks. Check `git status` before editing. Read the
applicable decision in `docs/10-decisiones.md`, component doc and the acceptance rules in `docs/09-plan-de-lanzamiento.md`.
New contracts, ownership changes, review results and questions for Codex belong in that
shared Markdown. A new coordination note is a prompt to inspect the request, not an
instruction to overwrite code outside your ownership.

## Backend ownership

- Own backend/domain/adapters, authorization, migration/persistence, worker, KrakenD,
  Terraform/runtime and real provider integration unless the shared file assigns a
  specific exception. Preserve other owners' locks.
- Publish a typed/versioned contract and capability requirements before enabling new UI
  or capabilities. Backend authorization, tenant/scope checks, optimistic concurrency,
  CSRF and audit are authoritative; UI checks are defense in depth.
- Close P0 outbox lease ownership/fencing before adding external side effects. Bound
  concurrency, request timeout, claim lease and shutdown drain as one policy; prove stale
  owners cannot publish/retry after takeover.
- Treat Entra as identity/admission and QAPAQ as authorization. Graph access stays
  backend-only, read-only and scoped to the configured SOC group; persist delta state and
  handle partial pages, token overage, 429 and stale sync explicitly. Apply SoD and step-up
  to privileged grants; never permit self-approval.
- Wazuh owns collection, manager, agents and detections that belong there; QAPAQ changes to
  Wazuh live as a versioned overlay in `wazuh/` (no source fork, see `docs/03`). QAPAQ adds
  operational ownership, contextual correlation, durable cases/evidence, approved SOAR
  and a cross-source audit trail; avoid building a second SIEM.
- Learn OSS workflows, not by copying source blindly. Check license/attribution before
  reuse. Do not expose Indexer DSL or raw data to untrusted callers.

## Evidence and AWS

- Do not mark real Wazuh/M365/Entra/Teams behavior Done from local mocks. Use authorized
  sandbox identities and synthetic activity, and attach SHA, command, environment,
  provider version and redacted output.
- Use the requested AWS demo for integrations too heavy for local Docker. Before apply,
  verify account/region/backend, reconcile the actual remote state, inspect all creates,
  changes, replacements and destroys, and compare cost with `docs/06-operacion.md`.
  Stop if state is stale, the plan is destructive/unexpected, access becomes public, or
  cost is outside the approved demo scope; record the blocker in the coordination file.
- Keep secrets in secret managers through least-privileged identities. Do not emit them
  in state, plan, logs, terminal output or artifacts. Keep production tenants out of
  sandbox acceptance unless they are explicitly authorized for that test.
- A deployable candidate also needs migration/rollback, readiness, observability,
  restore/replay, access revocation and teardown/cost evidence.

## Visual product rules

Read `docs/08-frontend-unificado.md` before changing frontend
contracts or asking Codex to implement one. Generated boards are visual references only:
their names, counts, dates and states are not product facts. Require meaningful error,
empty, unknown and degraded states; avoid filler prose and unsupported controls.

## Plan and coordination

- Owners, sequence and per-sprint acceptance: `docs/09-plan-de-lanzamiento.md`.
- Current screens, real role limits and design constraints:
  `docs/08-frontend-unificado.md`.
- Register a concise response/review in `COORDINACION-CLAUDE-CODEX.md`, then state what
  Codex should review next. Preserve shared workspace work; do not reset or discard it.
