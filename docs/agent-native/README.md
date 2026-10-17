# CommonForge: software ownership for the agent era

Status: original implementation baseline, following the owner’s direction on 2026-10-17.
The thesis and later milestones below remain planning context. For implemented G1 behavior,
verified gates and bounded limitations, read [execution status](execution-status.md) and
[the operating workflow](local-workflow.md). Baseline repository revision: `d5ab4eb`.

CommonForge should be an open platform where people and AI agents turn expertise into
working software, preserve what they learn, and keep that software working.

The owner has endorsed this direction and requested an executable implementation plan.
Specific defaults below are planning decisions, not individually approved product requirements.
Change them when evidence warrants it; record the reason instead of silently changing scope.

## Read this package

1. This document: product thesis, experience, boundaries, and long-term direction.
2. [Architecture](architecture.md): records, authority, compatibility, and extension contracts.
3. [Implementation plan](implementation-plan.md): milestones, work packages, and acceptance gates.
4. [SOL 6.1 handoff](sol-6.1-goal.md): a paste-ready execution goal and delegation instructions.

These documents define the new initiative. Existing documentation remains authoritative for
current behavior. This initiative supersedes agency-only positioning as a future public-product
direction; it does not silently supersede existing security or acceptance invariants.

## The product thesis

When agents produce most implementation work, project ownership requires durable intent,
domain knowledge, evidence, authority, and continuity across agents. CommonForge should make
these first-class project assets.

The initial user is a domain expert accountable for a working software system. They can explain
business rules and judge experiences; they should not have to understand branches, resolve Git
conflicts, or reconstruct an agent's conversation to understand their project.

Technical contributors remain essential users. Every human-friendly claim must lead to the
underlying source, rule revision, execution record, or observation. The product must support
inspection without making that inspection the default workflow for every owner.

The core promise: **your project's understanding survives the agent that did the work.**

## The first complete experience

The owner accepted a two-stage proving ground: CommonForge manages its own development first,
then the private agency product tests the same engine with domain experts. A small synthetic
scheduling fixture supplies deterministic behavioral tests; it is not a separate product we
intend to launch. Existing agency fixtures continue to prove backward compatibility.

For self-development, create a CommonForge project backed by an isolated copy of this public
repository. The owner sets outcomes and confirms scenarios; agents implement changes, submit
evidence, and inherit decisions across sessions. Keep GitHub as the source/distribution bridge
during this phase. Do not make CommonForge's recovery depend on a functioning CommonForge
instance: preserve Git exports, backup procedures, and an external CI/bootstrap path. A test
instance must never update its own running control plane while validating its candidate.

The agency phase consumes public contracts from a separate private product. This package plans
that integration boundary, but implementation in the private repository requires that repository
and its instructions to be available in a subsequent task. Initially demonstrate the boundary
with synthetic agency data and contract tests in this public repository.

An owner asks: “Let customers reschedule, except within 24 hours or after a technician starts
traveling.” CommonForge captures the outcome, explicit examples, and unresolved questions.
An agent may suggest rules; only an authorized person confirms them as project knowledge.

1. The owner confirms the examples and assigns a bounded task to their preferred agent.
2. The agent gets an isolated workspace and a versioned context packet containing the relevant
   confirmed rules, open assumptions, scenario definitions, and authority limits.
3. The agent submits an implementation and a concise explanation. Platform verification runs
   the required scenarios against the exact implementation proposed for acceptance.
4. The owner sees a working preview, observed behavior, unmet requirements, and the decision
   needed. A green status always has inspectable evidence.
5. The owner corrects an assumption: managers may override the cutoff, with a reason recorded.
   That correction becomes a new confirmed rule revision and scenario. Existing verification
   becomes stale; it cannot be reused as proof of the corrected requirement.
6. The agent revises the implementation. The owner reviews the new evidence and approves the
   exact change. Acceptance and release remain distinct recorded operations.
7. A fresh agent session implements a related change using persisted project context alone.
   It preserves the manager exception without a human repeating it.
8. After release, a bounded health observation is attached to the actual release. An overdue
   or failed observation appears as unknown or unhealthy, never as an evergreen green badge.

The scheduling fixture uses synthetic data and an explicit clock and timezone. Include exact
24-hour boundary cases, travel state, authorized versus unauthorized overrides, and retained
override reasons. The first milestone needs no payments, real customer communications, or
production scheduling data.

## Product vocabulary

| Concept | Meaning |
|---|---|
| Project | Durable ownership boundary for a software system and its understanding |
| Outcome | Desired improvement, with an owner and observable success criteria |
| Rule | A versioned statement of how this domain works; confirmation is explicit |
| Scenario | Concrete inputs, action, and expected behavior; manual or executable |
| Task | Bounded work assigned toward an outcome |
| Attempt | One agent execution against a pinned starting context |
| Proposal | Exact implementation and knowledge changes offered for acceptance |
| Evidence | A recorded observation with subject, provenance, and limitations |
| Decision | Who accepted, rejected, corrected, or deferred something and why |
| Release | Deployment of an accepted implementation into a named environment |
| Obligation | Ongoing responsibility, with an evaluation method and escalation policy |

Outcomes need not be considered achieved merely because a proposal was accepted or deployed.
An owner can record that success is unknown or requires observation over time.

## Human experience

The project's landing page answers “What needs my judgment?”, “What changed?”, and “Is the
system working?”. Start with five destinations: Overview, Outcomes, Knowledge, Changes, and
History. Preserve technical Files, Settings, and Activity views as accessible tools.

The change review shows the request, current rule/scenario versions, preview, evidence and
gaps, correction input, and acceptance/release controls. Use ordinary language such as
“This check ran before you changed the rule; run it again.” Never imply confidence through
an unexplained percentage score. Clearly distinguish agent-written explanations, automated
results, and human observations.

Use existing visual tokens and components for the first slice. Design new layouts around
domain-expert decisions. Do not spend the first milestone on branding or a total UI rewrite.

Chat is an entry point and explanation surface. Structured, inspectable project records are
the durable result. The first slice works without a built-in chat model or hosted agent fleet:
owners can enter information directly and use an external coding agent through CLI/MCP.

## Public framework and private agency product

Recommendation: keep this repository public. The owner asked about visibility; this is the
recommended strategy, not an instruction to change repository settings. Public reuse is a
deliberate tradeoff: adoption, interoperability, and trust in project portability are more
important to this initiative than exclusive ownership of the general engine's implementation.
The private agency product captures differentiated service and domain expertise.

The public repository must ship a usable reference product, not only engine packages.
Keep the MIT license for this initiative; a licensing or business-model change is a separate
owner decision. Self-hosting and full project export are product requirements.

| Public CommonForge | Private agency implementation |
|---|---|
| Project knowledge, scenarios, proposals, evidence, history | Client-specific workflows and domain packs |
| General authority and agent execution interfaces | Agency operating procedures and contractual approvals |
| Complete reference UI, API, CLI, and MCP tools | Branded client portal and service packaging |
| Provider contracts and conformance tests | Agency billing, account management, and integrations |
| Documented extension points and synthetic examples | Private client information and proprietary assets |

The private app consumes versioned public packages/APIs. It must not copy and patch ledger
invariants. Keep agency compatibility in the public code during the first slice; move or
extract agency-specific UI only after its replacement contract is demonstrated. This plan
does not authorize touching a private repository or moving private data into the public one.

## Strategic choices

- Begin with software projects across domains. General-purpose AI work can follow demonstrated
  common abstractions; it is not the initial scope.
- Keep Git-compatible source providers. Version knowledge, decisions, and evidence independently
  of repository commits. A new storage engine is a later response to measured limitations.
- Keep Cloudflare as the first deployment target. Preserve provider interfaces and a real local
  verification path; do not attempt a second cloud control plane in this milestone.
- Accept multiple agent clients through an explicit protocol. First prove cross-session
  continuity; cross-vendor compatibility is a separate empirical test.
- Treat permission to implement, permission to confirm rules, permission to accept, and permission
  to deploy as distinct capabilities. More autonomous policies come after this is reliable.
- Explicit dependencies and scenario checks detect a useful subset of semantic conflicts.
  No claim of general semantic merge or complete behavioral correctness is justified.

## Beyond the first slice

These are later product bets, not additional requirements for the initial execution goal.

1. **Continuous stewardship:** bounded recurring evaluations of obligations, maintenance proposals,
   measured operating costs, and progressively delegated release authority.
2. **Parallel exploration:** several attempts against one outcome, comparable evidence, and a
   decision record explaining which approach was selected and why.
3. **Reusable capabilities:** share implementation with assumptions, scenarios, integration
   contracts, provenance, and maintenance history. Adaptation evaluates local domain differences.
4. **Public collaboration:** credit useful rules, scenarios, discoveries, and maintenance work;
   permit a domain expert to contribute without making a code patch.
5. **Interoperability:** portable project bundles, stable extension contracts, additional storage
   and execution providers, and eventually federation if real adoption requires it.

A catalog or marketplace must wait until at least two independently built capabilities can be
exported, imported, adapted, and maintained. A reputation system must wait for meaningful usage
data; commit counts or agent activity volume are poor substitutes for demonstrated value.

## How we evaluate the thesis

Instrument timestamps and events for task assignment, requests for clarification, correction,
evidence readiness, acceptance, release, and failure. Measure repeated explanations, human
interventions per accepted change, escaped regressions, and recovery effort. Record agent and
runner costs when available; unknown costs remain unknown. Do not equate browser dwell time
with human work time or claim an arbitrary improvement percentage without a baseline.

The first technical gate is a fresh agent preserving a corrected rule using only exported
project context. The first product learning exercise is an observed domain-expert walkthrough,
plus one non-scheduling use case exercising the same model. Lack of available participants
does not prevent shipping the technical slice, but prevents claiming user validation.

## Research context

Cloudflare describes Artifacts as versioned storage with a Git-compatible interface:
[Artifacts documentation](https://developers.cloudflare.com/artifacts/).
GitHub describes Agent HQ as a unified workflow for orchestrating agents:
[Agent HQ announcement](https://github.blog/news-insights/company-news/welcome-home-agents/).
Both were consulted on 2026-10-17. Our strategic inference is that durable domain understanding,
behavioral review, and ownership continuity offer a more distinctive starting point than agent
orchestration alone. This is a product hypothesis, not a comprehensive competitor assessment.
