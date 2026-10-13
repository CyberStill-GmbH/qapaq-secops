---
name: qapaq-soc-engineering
description: Use for QAPAQ SecOps product, SOC workflow, UI, backend integration, release-readiness, or cloud test work in this repository.
---

# QAPAQ SOC engineering

Before changing code or plans, read `COORDINACION-CLAUDE-CODEX.md`, inspect `git status`,
check file locks there, and read the applicable ADR, component delivery note, API/design
contract and `docs/project-management/definition-of-done.md`. Follow the latest user
instruction if it updates an older coordination entry.

## Codex ownership

- Own frontend, web API client, UX states, accessibility, design references and
  documentation unless the coordination file assigns a different task.
- Ask Claude to review backend-dependent contracts in the coordination Markdown. Do not
  edit files locked by Claude or infer consent from a UI request.
- Keep pages truthful to deployed endpoints and session capabilities. Hide unsupported
  actions; distinguish empty, unknown, degraded and failed. Do not add mock product data,
  fake health, unmeasured KPIs, filler copy, no-op controls or an implied remediation.
- Preserve the existing QAPAQ dark/graphite system and restrained amber selection. Avoid
  `react-icons` and uncurated icon dumps. Use the maintained `@phosphor-icons/react`
  library for interface/channel marks where it improves recognition, importing only the
  named icons used by the screen; keep QAPAQ's own mark project-owned and avoid implying
  a provider integration unless the backend contract reports it.
- Learn workflows from open source SOC/SOAR projects, but do not copy their code/UI
  wholesale. Check license and attribution before reusing code or assets.

## Integration and release

- In Entra Admin, expose only members of the configured SOC admission group. Entra is
  identity/admission; QAPAQ grants capabilities. No Graph calls from React, tenant-wide
  directory search, self-approval, or unauthorized changes to Entra membership.
- Wazuh owns agent/manager/rule operations. QAPAQ owns analyst ownership, investigation,
  cases, evidence, approved actions and cross-pipeline audit. Never call the Indexer from
  the browser or accept user-supplied OpenSearch DSL.
- Real provider acceptance needs the authorized provider and synthetic test activity;
  fake/stub results are not release evidence. Record command, SHA, environment, versions,
  redacted results and remaining blockers.
- Use AWS only for the explicitly requested demo/integration scope. Reconcile remote
  Terraform state and inspect the exact plan before apply; stop for unexpected destroys,
  public exposure or cost outside the documented budget. Never use production Entra/M365
  without its authorized test boundary.

## Source of truth

- Sprint owners and gates: `docs/project-management/plan-operativo-sprints-post-mvp.md`.
- Screen/capability status and anti-patterns: `docs/frontend-design/10-vistas-por-rol-y-referencias.md`.
- Frontend behavior: `docs/frontend-design/README.md` and its screen contracts.
- Coordination/locks: `COORDINACION-CLAUDE-CODEX.md`.
