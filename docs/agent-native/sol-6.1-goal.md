# SOL 6.1 execution handoff

Paste the following into a SOL 6.1 session opened in this repository. The first goal is bounded
to G1. This planning session has not implemented or tested the planned behavior.

---

Implement CommonForge G1: durable project understanding across agent handoffs.

Read these documents, in order:

1. `docs/agent-native/README.md`
2. `docs/agent-native/architecture.md`
3. `docs/agent-native/implementation-plan.md`

Use them as the implementation baseline. Follow applicable repository instructions. Revalidate
the working tree and current code; the plan was grounded at commit `d5ab4eb`. Preserve unrelated
work. Treat proposed filenames and type names as adjustable, while preserving the stated product
behavior and invariants. Record material deviations and their evidence.

Create a goal for G1 and pursue it through milestones M0–M5 (W00–W10). Do not add a token budget
unless I specify one. Use subagents for independent implementation and review, with bounded
work packages and clear file ownership. You are the integrating lead. Freeze shared contracts
before parallel consumers; serialize migrations and shared-schema edits. Follow the dependency
graph and completion dependencies, not merely the numeric ordering.

The required result is a working public reference product where:

- A person records and confirms domain rules and behavioral scenarios.
- A task-scoped agent receives pinned project context without broad user credentials.
- Its submitted change has independently verified behavior tied to exact revisions.
- A human correction persists, invalidates obsolete verification, and informs subsequent work.
- Atomic acceptance binds source, knowledge, authority, decisions, and evidence.
- Release, observation, and recovery reference the accepted project state accurately.
- A fresh agent session preserves the correction without the original chat or a human restating it.
- The workflow runs locally with real Git, runner execution, and previews; public operation has
  no dependency on a private repository. Export/import preserves history without importing trust.

Use CommonForge managing its own development as the engineering proving ground, a small synthetic
business fixture for deterministic behavior tests, and a synthetic agency consumer contract for
the private product boundary. Keep the controlling instance isolated from the candidate instance.
Preserve GitHub/external CI/bootstrap as a recovery and distribution bridge during this phase.

Keep existing legacy projects functional. Preserve current v1 hashes, approval/evidence semantics,
and append-only migrations. New-mode projects must reject legacy acceptance bypasses. Keep Git
as an implementation provider and Cloudflare as the first deployment target. Do not build a new
VCS, hosted agent fleet, generalized workflow engine, marketplace, or federation system in G1.

Maintain `docs/agent-native/execution-status.md` with the baseline, work-package state, decisions,
test commands/results, acceptance-matrix evidence, and next action. Update it before context
handoffs so another session can continue without the original conversation. Do not invent results.

Exercise AN-01 through AN-24 in the implementation plan. Use targeted tests while implementing,
then relevant integrated build/typecheck, unit, security, fault, browser, real-local, and live
checks. Review UI screenshots and the owner journey. Fix findings and continue. Tests using
fakes cannot substantiate real provider behavior. A deterministic protocol test does not replace
the fresh-agent rehearsal. Record actual agent/client identity when performing that rehearsal.

Proceed autonomously on reversible local implementation and reasonable design choices. Ask only
when missing information blocks progress or a choice materially changes the approved direction.
Do not change repository visibility/license, access a private repository, publish packages, deploy
to production, or spend on new infrastructure without authorization for that action. Existing
authorized isolated test infrastructure may be used within its established scope; otherwise
document exact live-test prerequisites and keep the unperformed gate visible.

If a required environmental gate cannot run, finish all independent local work and document the
precise remaining requirement. Describe the result as a locally validated release candidate;
do not mark the full goal achieved until required live and fresh-agent gates actually pass.

At completion, provide the delivered behavior, relevant changes, acceptance results, known
limitations, and the next recommended goal. Stop at G1; M6–M8 are follow-on goals.

---

## Reusable subagent assignment

```text
Work package: Wxx — <name>
Read: docs/agent-native/{README,architecture,implementation-plan}.md
Dependencies already integrated: <work packages and commit>
Allowed files: <exclusive files/directories; list shared files you must not edit>
Required behavior and invariants: <specific items>
Acceptance criteria: <AN IDs plus work-package gate>
Validation: <targeted commands and execution mode>
Coordinate contract changes with the lead before editing shared schemas or migrations.
Return: changed paths, implemented behavior, commands/results, unresolved risks, and next action.
Do not claim a fake or skipped test proves real integration.
```
