/**
 * In-memory `CommonForgeApi` seeded with the "Demo Client / Customer Portal" story (plan §C.1).
 *
 * Used by the unit tests and by the app's **fixture mode** (`?fixture`), which is always labelled
 * on screen: it is sample data for testing and rehearsal, never evidence of a live run (PRD §14.4).
 * It mimics the Worker's rules that the UI depends on: role-shaped views (clients never get
 * coordinates, tasks or revision browsing), current-hash approvals, accept blockers, idempotency
 * keys, restore checks, client editions (Task 21), uploads and file changes (Folders phase 3: roles,
 * `canWrite`, limits, `file_changed`, R6 approval, file collections refusing edits; a change moves
 * one step per poll) and 501 for the routes owned by later tasks. Staging phase 3 (`staging: true`,
 * the fixture's `?staging`): the Customer Portal in staging mode with the demo tasks, landings,
 * captures and timed promotions, mirroring the Worker's staging and promotion rules and texts.
 * Everything returned is a copy.
 */
import { aloneSet, lintMigrations, MountNameSchema, promotionLevel, promotionSet, type PromotionRule } from "@commonforge-org/core";
import { firstCommitFiles, lfsEndpointUrl } from "../lib/first-commit.js";
import { writeDismissed } from "../lib/onboarding.js";
import { ApiError, EDIT_MAX_BYTES, type CommonForgeApi, type FileQuery } from "./client.js";
import type {
  AcceptResult,
  SessionView,
  AccessLevel,
  DeployResources,
  ApprovalView,
  Capture,
  ClearanceKind,
  CreateTaskInput,
  LandingState,
  PromoteResult,
  PromotionGate,
  PromotionLevel,
  PromotionMode,
  PromotionPreview,
  PromotionState,
  PromotionView,
  ProposalKind,
  RiskAnswer,
  RiskEvidence,
  RiskQuestionId,
  StagingLanding,
  StagingView,
  TaskView,
  TaskWorkspaceView,
  EditableFile,
  EditionPolicyInput,
  EditionReturn,
  EditionSession,
  EditionView,
  EventView,
  ExportStatus,
  FileChange,
  FileChangeOp,
  FileChangeRequest,
  IntakeConfirmInput,
  IntakeConfirmResult,
  IntakePlan,
  IntakeView,
  IntegrationAttempt,
  IntegrationView,
  InviteResult,
  Me,
  MemberView,
  Mount,
  Operation,
  PersonAccess,
  PolicyIssue,
  PreviewView,
  Project,
  ProjectFolder,
  ProjectPolicy,
  ProjectSnapshot,
  Proposal,
  ProposalSummary,
  ReleaseList,
  ReleaseView,
  Resource,
  ResourceDetail,
  Role,
  TaskSummary,
  TreeListing,
  UploadStart,
  UrlIntakeInput,
  VersionEntry,
} from "./types.js";
import { acceptBlockers } from "../lib/model.js";

/** Deterministic hex of `len` chars from a seed (FNV-1a, repeated). */
export function fakeHex(seed: string, len = 40): string {
  let out = "";
  let h = 0x811c9dc5;
  let round = 0;
  while (out.length < len) {
    for (const ch of `${seed}#${round++}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

type Files = Record<string, string | { size: number; mime: string; body?: string }>;

interface FakeResource {
  resourceId: string;
  name: string;
  provider: "artifacts" | "r2-assets";
  repoId: string;
  /** revisionId → files (first = initial import) */
  revisions: Map<string, Files>;
  /** "" while the resource has no accepted version (a new, empty intake resource) */
  head: string;
  /** Resource.state; seeded resources are active */
  state?: "empty" | "importing" | "active" | "failed";
  /** Resource.error (a failed folder setup) */
  error?: string;
  source?: Record<string, unknown>;
  headSeq: number;
  headVersionId: string | null;
  headAt: string;
}

interface FakeProposal {
  /** `promotion`: built by a promotion (approved and accepted only through it); absent: an ordinary proposal */
  kind?: ProposalKind;
  p: Omit<Proposal, "stale" | "approvals" | "integration" | "candidates" | "lastAttempt">;
  candidates: Proposal["candidates"];
  approvals: ApprovalView[];
  integration: IntegrationView | null;
  /** what the next integration run will report */
  nextIntegration: "pass" | "contract-fail";
  integratingSince: number | null;
  integratingJob: string | null;
  /** the latest run whatever its outcome (owner view; `present` strips it for clients) */
  lastAttempt: IntegrationAttempt | null;
}

interface FakeIntake {
  v: IntakeView;
  /** when the simulated inventory / import finishes */
  readyAt: number;
  /** ZIP: the archive's file list (null: not a ZIP); URL: null */
  listing: ZipListing | null;
}

/** A browser upload (Worker `lfs_objects` row of source `browser`). */
interface FakeUpload {
  uploadId: string;
  resourceId: string;
  userId: string;
  path: string;
  size: number;
  mime: string;
  parts: number;
  etags: Map<number, string>;
  /** small text uploads keep their parts' text (null: binary or large, only sizes are checked) */
  texts: Map<number, string> | null;
  state: "uploading" | "uploaded" | "verified";
  body: string | undefined;
  /** put by an added change: it cannot be put again */
  added: boolean;
}

interface FakeFileChange {
  v: FileChange;
  /** creation order (ties of `createdAt`) */
  seq: number;
  resourceId: string;
  userId: string;
  /** the uploader's role when the change was made (R6) */
  role: Role;
  ops: FileChangeOp[];
  /** the head the current attempt was applied on */
  base: string | null;
}

/** `APPLY_FILES_LIMITS` (runner-protocol), copied: the web app does not depend on that package. */
const FAKE_LIMITS = { maxOps: 1000, maxFileBytes: 5_000_000_000, maxChangeBytes: 20_000_000_000, maxEditBytes: 1_048_576, maxEditTotalBytes: 16_777_216 } as const;
/** `COMMONFORGE_UPLOAD_PART_BYTES`' default */
const UPLOAD_PART_BYTES = 52_428_800;
const PROTECTED_SEGMENTS = [".git", ".commonforge", ".vibecontrol"];
/** what the fake classifies as code (the Worker uses `classifyPath`) */
const FAKE_CODE_RE = /\.(m?[jt]sx?|cjs|json|jsonc|html?|css|scss|vue|svelte|py|rb|go|rs|toml|ya?ml|sh)$/i;

const isTextMime = (mime: string) => /^text\/|^application\/(json|javascript|xml|x-yaml|yaml|toml)\b|\+(xml|json)$/i.test(mime);
/** git folders store binary files, and files of 1 MiB or more, in LFS (`COMMONFORGE_LFS_THRESHOLD_BYTES`) */
/** an empty file is never binary (the hash step finds no NUL), so it is never stored in LFS */
const isLfsEntry = (f: Files[string]) => typeof f !== "string" && f.size > 0 && (f.size >= EDIT_MAX_BYTES || !isTextMime(f.mime));
/** a stable 40-hex "git blob id" of a file's content (`x-commonforge-blob`) */
const blobOf = (f: Files[string]) => fakeHex(`blob|${typeof f === "string" ? f : (f.body ?? `${f.mime}#${f.size}`)}`, 40);
const isOpenChange = (s: FileChange["state"]) => s === "applying" || s === "checking" || s === "waiting_approval" || s === "staged";
const stagingIds = (ops: readonly FileChangeOp[]) => [...new Set(ops.flatMap((op) => ("put" in op ? [op.stagingId] : [])))];

/** The Worker's `uploadPath`: normalized (NFC included), relative, at most 1,024 characters, no protected segment. */
function fakeUploadPath(raw: string): string {
  const segs = raw.split("/");
  const bad = raw.length === 0 || raw.length > 1024 || raw !== raw.normalize("NFC") || raw.includes("\\") || raw.includes("\0") || segs.some((s) => s === "" || s === "." || s === ".." || PROTECTED_SEGMENTS.includes(s.toLowerCase()));
  if (bad) throw new ApiError(400, "invalid_path", "invalid file path");
  return raw;
}

/** The Worker's default title: "Uploaded 30 files to videos/2026", "Edited config.json", "Changed 3 files". */
function fakeDefaultTitle(ops: readonly FileChangeOp[], mountName: string): string {
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const puts = ops.flatMap((op) => ("put" in op ? [op.put] : []));
  if (puts.length === ops.length) {
    let dir = parentOf(puts[0]!);
    for (const p of puts) while (dir !== "" && !p.startsWith(`${dir}/`)) dir = parentOf(dir);
    return `Uploaded ${puts.length} ${puts.length === 1 ? "file" : "files"} to ${dir || mountName}`.slice(0, 200);
  }
  if (ops.length === 1 && "edit" in ops[0]!) return `Edited ${ops[0].edit}`.slice(0, 200);
  return `Changed ${ops.length} ${ops.length === 1 ? "file" : "files"}`;
}

interface FakeEvent extends EventView {
  clientVisible: boolean;
  /** events of the empty "Agency handover" project; everything else belongs to Customer Portal */
  handover?: boolean;
  /** org-level events naming no resource (the Worker shows them to owners only) */
  ownerOnly?: boolean;
  clientDetail?: Record<string, unknown>;
}

export const FIXTURE_ORG = "o-0de0c11e0001";
export const FIXTURE_PROJECT = "p-c0570a1e0001";

/**
 * The fixture browser's seed: the demo project (Customer Portal) is a finished setup in the story,
 * so its Getting started checklist starts hidden, exactly as if the owner had pressed Hide (the
 * same per-browser flag). It stays out of the demo; projects created in fixture mode still show
 * it. The checklist itself has no special case: its "first task live" step reads real state.
 */
export function seedFixtureBrowser(): void {
  writeDismissed(FIXTURE_ORG, FIXTURE_PROJECT, true);
}
/**
 * A second, empty project ("Agency handover"): the starting point of DEMO-SCRIPT 0:00, where the
 * agency's archive is added with "Add files". Nothing else (changes, releases, editions) lives here.
 */
export const FIXTURE_EMPTY_PROJECT = "p-4a9e0c7d0002";
const PROJECT_NAMES: Record<string, string> = { [FIXTURE_PROJECT]: "Customer Portal", [FIXTURE_EMPTY_PROJECT]: "Agency handover" };
/** The fixture's proposals: A1 failed its contract and was superseded by A2; C is not validated yet. */
export const FIXTURE_PROPOSALS = {
  quoteFailed: "prop-a15e0000-0000-4000-8000-00000000a100",
  quoteRepaired: "prop-a25e0000-0000-4000-8000-00000000a200",
  brandRefresh: "prop-c15e0000-0000-4000-8000-00000000c100",
} as const;
/** The fixture's COMMONFORGE_PUBLIC_URL: what a new folder's `.lfsconfig` points at. */
export const FIXTURE_PUBLIC_URL = "https://commonforge.fixture.invalid";
export const FIXTURE_RESOURCES = { website: "res-00000000000000a1", api: "res-00000000000000a2", brand: "res-00000000000000a3", requirements: "res-00000000000000a4", concept: "res-00000000000000a5" } as const;

const { website: WEBSITE, api: API, brand: BRAND, requirements: REQS, concept: CONCEPT } = FIXTURE_RESOURCES;
/** what the fixture's release recipe builds from (git mounts only, like the Worker) */
const RELEASE_SOURCES: string[] = [WEBSITE, API];

const ART = (repo: string, seed: string) => `art:${repo}:${fakeHex(seed)}`;
const R2M = (seed: string) => `r2m:${fakeHex(seed, 64)}`;

const LOGO_OLD = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48"><rect width="160" height="48" rx="10" fill="#1f3a5f"/><text x="80" y="31" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">Demo Client</text></svg>`;
const LOGO_NEW = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48"><rect width="160" height="48" rx="24" fill="#2f6f5e"/><circle cx="26" cy="24" r="10" fill="#f2c14e"/><text x="90" y="31" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">Demo Client</text></svg>`;

const QUOTE_UI_BASE = `import { getQuote } from "./api";

export async function renderQuote(el: HTMLElement, items: string[]) {
  const quote = await getQuote(items);
  el.querySelector(".total")!.textContent = formatMoney(quote.total);
}

function formatMoney(cents: number) {
  return "$" + (cents / 100).toFixed(2);
}
`;
const QUOTE_UI_NEW = `import { getQuote } from "./api";

export async function renderQuote(el: HTMLElement, items: string[]) {
  const quote = await getQuote(items);
  el.querySelector(".total")!.textContent = formatMoney(quote.total);
  const list = el.querySelector(".breakdown")!;
  list.replaceChildren(
    ...quote.breakdown.map((line) => row(line.label, formatMoney(line.amount))),
  );
}

function row(label: string, amount: string) {
  const li = document.createElement("li");
  li.textContent = label + " — " + amount;
  return li;
}

function formatMoney(cents: number) {
  return "$" + (cents / 100).toFixed(2);
}
`;
const API_BASE = `import { Hono } from "hono";
import { priceItems } from "./pricing";

const app = new Hono();

app.post("/quote", async (c) => {
  const { items } = await c.req.json<{ items: string[] }>();
  const lines = priceItems(items);
  return c.json({ total: lines.reduce((s, l) => s + l.amount, 0) });
});

export default app;
`;
const API_NEW = `import { Hono } from "hono";
import { priceItems } from "./pricing";

const app = new Hono();

app.post("/quote", async (c) => {
  const { items } = await c.req.json<{ items: string[] }>();
  const lines = priceItems(items);
  return c.json({
    total: lines.reduce((s, l) => s + l.amount, 0),
    breakdown: lines.map((l) => ({ label: l.label, amount: l.amount })),
  });
});

export default app;
`;
const REQS_BASE = `# Customer Portal requirements

- Customers can request a quote for one or more items.
- The quote shows a total in US dollars.
- Brand: use the approved logo from Brand and media.
`;
const REQS_NEW = `# Customer Portal requirements

- Customers can request a quote for one or more items.
- The quote shows a total in US dollars, with a line-by-line breakdown.
- Brand: use the 2026 logo (rounded mark, green) from Brand and media.
`;

// ------------------------------------------------------------------- staging phase 3 (fixture)

/** The demo's staging tasks (spec 2026-10-07 §12), created by the client (`staging: true`). */
export const FIXTURE_STAGING_TASKS = {
  copy: "task-5c0e0000-0000-4000-8000-000000005c01",
  phone: "task-5c0e0000-0000-4000-8000-000000005c02",
  rename: "task-5c0e0000-0000-4000-8000-000000005c03",
  working: "task-5c0e0000-0000-4000-8000-000000005c04",
} as const;

/** Copied from the Worker, `apps/worker/src/services/promotions.ts` `PROMOTION_REASONS`: what clients read when a promotion stops. */
const PROMOTION_REASONS = {
  conflict: "Conflicts with production.",
  check: "A required check failed when combined with production.",
  build: "The promotion could not be built on production. A developer needs to check it.",
  stopped: "The promotion stopped before it finished. Try promoting again.",
  changed: "Staging changed while the promotion was requested. Try promoting again.",
  unstable: "Production kept changing; promote again.",
  landingFailed: "A task in this promotion left staging. Promote again.",
  revised: "A task in this promotion was revised. Promote again once the revision is live on staging.",
  off: "Staging was turned off for this project.",
  accept: "The promotion could not be accepted into production. A developer needs to check it.",
  releaseFailed: "The production update did not go live. Production still runs the previous version.",
  migrationFailed: "A database migration failed; production was not changed.",
  migrationUnknown: "A database update did not confirm; a developer is checking production.",
  needsPublishApproval: "Production has other changes waiting for an owner's approval.",
  productionBusy: "Waiting for another update to reach production.",
  withdrawn: "Withdrawn",
  checksChanged: "The project's checks changed while the promotion was built. Promote again.",
  travelWithLeft: "A task this one must travel with left staging. A developer needs to remove the link first.",
} as const;

/** Copied from the Worker, `apps/worker/src/services/promotion-gate.ts` `GATE_REASON_TEXT`: why a promotion waits for a developer. */
const GATE_REASON_TEXT = {
  developer_paths: "Changes files that need a developer's review.",
  migration_destructive: "Changes the database structure in a way that needs a developer.",
  classifier_unavailable: "Needs a developer's review.",
  gate_error: "Needs a developer's review.",
} as const;

/**
 * `classifier_declined`'s text, by the first question that did not clear (ruling P3-5 of the plan
 * 2026-10-11; staging phase 3 Task 3 adds them beside `GATE_REASON_TEXT` in
 * `apps/worker/src/services/promotion-gate.ts`).
 */
export const CLASSIFIER_DECLINED_TEXT: Record<RiskQuestionId, string> = {
  risk: "The automatic review could not confirm this change is low risk.",
  migration: "Changes the database structure in a way that needs a developer.",
  apiChange: "May change how the API works for existing callers.",
  authOrPayments: "Touches sign-in or payments.",
  addressedToReviewer: "Needs a developer's review.",
};

/** The core question set's options and safe answers (core `RISK_QUESTIONS`, rulings P3-2 and P3-3), in the order they are checked. */
const RISK_OPTIONS: Record<RiskQuestionId, { options: string[]; safe: string[] }> = {
  risk: { options: ["low", "medium", "high"], safe: ["low"] },
  migration: { options: ["none", "additive", "destructive"], safe: ["none", "additive"] },
  apiChange: { options: ["none", "backward_compatible", "breaking"], safe: ["none", "backward_compatible"] },
  authOrPayments: { options: ["yes", "no"], safe: ["no"] },
  addressedToReviewer: { options: ["yes", "no"], safe: ["no"] },
};

/**
 * What the real Jev (jev-1.13.0) answered for the phone field change in the staging phase 3 live
 * check (scripts/classifier-live-check.mjs, 2026-10-11, stable over 3 runs): risk medium (safe 0.40),
 * migration additive (1.00), apiChange breaking (safe 0.40), authOrPayments no (1.00),
 * addressedToReviewer no (0.97). At 0.9 it is declined on `risk`, so the demo's phone field goes to
 * a developer (owner decision 2026-10-11). The fixture's default outcome (`live`).
 */
const LIVE_ANSWERS: Record<RiskQuestionId, RiskAnswer> = {
  risk: { choice: "medium", probabilities: { low: 0.4, medium: 0.56, high: 0.04 }, confidence: 0.56 },
  migration: { choice: "additive", probabilities: { none: 0, additive: 1, destructive: 0 }, confidence: 1 },
  apiChange: { choice: "breaking", probabilities: { none: 0.05, backward_compatible: 0.35, breaking: 0.6 }, confidence: 0.6 },
  authOrPayments: { choice: "no", probabilities: { yes: 0, no: 1 }, confidence: 1 },
  addressedToReviewer: { choice: "no", probabilities: { yes: 0.03, no: 0.97 }, confidence: 0.97 },
};

/** The answers the fixture's classifier gives when it clears a change (all safe; outcome `clear`), and the unsafe answer per question when a test declines one. */
const SAFE_ANSWERS: Record<RiskQuestionId, RiskAnswer> = {
  risk: { choice: "low", probabilities: { low: 0.94, medium: 0.05, high: 0.01 }, confidence: 0.91 },
  migration: { choice: "additive", probabilities: { none: 0.03, additive: 0.96, destructive: 0.01 }, confidence: 0.95 },
  apiChange: { choice: "backward_compatible", probabilities: { none: 0.12, backward_compatible: 0.85, breaking: 0.03 }, confidence: 0.84 },
  authOrPayments: { choice: "no", probabilities: { yes: 0.02, no: 0.98 }, confidence: 0.97 },
  addressedToReviewer: { choice: "no", probabilities: { yes: 0.01, no: 0.99 }, confidence: 0.98 },
};
const UNSAFE_ANSWERS: Record<RiskQuestionId, RiskAnswer> = {
  risk: { choice: "low", probabilities: { low: 0.6, medium: 0.3, high: 0.1 }, confidence: 0.55 },
  migration: { choice: "destructive", probabilities: { none: 0.1, additive: 0.3, destructive: 0.6 }, confidence: 0.6 },
  apiChange: { choice: "breaking", probabilities: { none: 0.1, backward_compatible: 0.3, breaking: 0.6 }, confidence: 0.6 },
  authOrPayments: { choice: "yes", probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.7 },
  addressedToReviewer: { choice: "no", probabilities: { yes: 0.3, no: 0.7 }, confidence: 0.7 },
};

/** The staging-mode policy sections the fixture adds to the Customer Portal (shapes as in API.md "Staging" and "Releases"). */
const STAGING_RELEASE_SECTION = {
  recipe: { steps: [{ mountName: "website", command: "pnpm install --frozen-lockfile --ignore-scripts && pnpm run build", timeoutSeconds: 600 }] },
  targets: [
    { targetId: "api", mountName: "api", kind: "worker", workerName: "cfapp-o-fixture-api" },
    { targetId: "website", mountName: "website", kind: "assets", workerName: "cfapp-o-fixture-website" },
  ],
  healthCheck: { targetId: "website", path: "/" },
  migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }],
};
const STAGING_POLICY_SECTION = {
  environment: { api: { vars: { APP_VERSION: "1.0.0-staging" }, kv: [], d1: [{ binding: "DB", migrationsDir: "migrations", seed: ["seed/contacts.sql"] }] } },
  captureVars: ["EMAIL_WEBHOOK_URL", "PAYMENT_WEBHOOK_URL"],
  promotion: {
    rules: [
      { paths: ["website/**"], level: "self" },
      { paths: ["api/src/**", "api/migrations/**", "api/tests/**"], level: "classify" },
    ],
    classifier: { provider: "jev", threshold: 0.9 },
  },
};

/** Worker `services/promotions.ts`: in flight (its landings claimed), accepted into production, and before accepting starts. */
const IN_FLIGHT: PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared", "accepting", "releasing"];
const ACCEPTED: PromotionState[] = ["accepting", "releasing", "release_failed", "live"];
const BEFORE_ACCEPT: PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared"];

/** One file a staging task writes (`content: null` deletes it), relative to its folder. */
interface FakeEdit {
  mount: string;
  path: string;
  content: string | null;
}

const HOME_COPY = `<header class="banner">Autumn offer: free setup for new customers until 30 November.</header>
<main>
  <h1>Quotes in minutes, not days</h1>
  <p>Tell us what you need and get a clear, itemised price straight away.</p>
  <form id="quote"></form>
  <p class="total"></p>
</main>
`;
const FOOTER = `<footer>
  <p>Demo Client Ltd · 12 Harbour Street · Open Monday to Friday, 9:00-17:30</p>
  <p><a href="/contact">Contact us</a> · <a href="/privacy">Privacy</a></p>
</footer>
`;
const CONTACT_FORM = `<form id="contact" method="post" action="/contacts">
  <label>Name <input name="name" required></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Phone (optional) <input name="phone" type="tel" maxlength="40"></label>
  <button type="submit">Send</button>
</form>
`;
const CONTACTS_API = `
/** POST /contacts {name, email, phone?}: add a contact. */
app.post("/contacts", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; email?: unknown; phone?: unknown } | null;
  if (typeof body?.name !== "string" || typeof body?.email !== "string") return c.json({ error: "name and email are required" }, 400);
  if (body.phone !== undefined && (typeof body.phone !== "string" || body.phone.length > 40)) return c.json({ error: "invalid phone" }, 400);
  await c.env.DB.prepare("INSERT INTO contacts (name, email, phone) VALUES (?, ?, ?)").bind(body.name, body.email, body.phone ?? null).run();
  return c.json({ ok: true }, 201);
});
`;
const RENAMED_CONTACTS = `/** Contacts as the API returns them: \`name\` is stored as \`full_name\` from migration 0003. */
export async function listContacts(db: D1Database) {
  const { results } = await db.prepare("SELECT id, full_name AS name, email FROM contacts ORDER BY id").all();
  return results;
}
`;
const OPENING_HOURS = `<section id="opening-hours">
  <h2>Opening hours</h2>
  <p>Monday to Friday, 9:00-17:30. Closed on public holidays.</p>
</section>
`;

interface FakeTaskInfo {
  createdBy: string;
  request: string;
  writeMounts: string[];
  readMounts: string[];
  /** a client's staging task (or one made with New task): finishing it lands it on staging */
  staging: boolean;
  /** what the agent writes when it finishes */
  edits: FakeEdit[];
  /** provisioning → ready at this time */
  readyAt: number;
  updatedAt: string;
}

interface FakeLanding {
  landingId: string;
  taskId: string;
  seq: number;
  state: LandingState;
  reasonCode: string | null;
  reason: string | null;
  detail: string | null;
  createdBy: string;
  createdAt: string;
}

interface FakePromotion {
  promotionId: string;
  state: PromotionState;
  /** the set, in landing order */
  landingIds: string[];
  targetLandingId: string;
  /** B8: `alone` when alone-first applied (the set is the target and its travel-with links only) */
  mode: PromotionMode;
  /** alone: the closure's other landings, which stay in staging (landing ids, in `seq` order) */
  goingWithout: string[];
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  /** when the next machine step is due */
  stepAt: number;
  level: PromotionLevel | null;
  gate: PromotionGate | null;
  reasonCode: string | null;
  reason: string | null;
  detail: string | null;
  clearance: { kind: ClearanceKind; clearedBy: string; clearedAt: string } | null;
  proposalId: string | null;
  acceptedVersionId: string | null;
  releaseId: string | null;
  /** per resource the set changes: the `main` head it was built on and the result revision */
  resources: Array<{ resourceId: string; mountName: string; head: string; result: string }>;
  /** the integration receipt (from gating on) */
  checks: NonNullable<PromotionView["checks"]> | null;
  failRelease: boolean;
}

export interface FakeOptions {
  role?: Role;
  now?: () => number;
  /** ms an integration run takes in fixture mode */
  integrationMs?: number;
  /**
   * The quote change's repair (UX-4 review C-1). "done" (default, unit tests): the repaired
   * proposal A2 already exists. "running" (the browser fixture): Agent A is still repairing, A1 is
   * the latest proposal, and `completeRunningTasks()` ("Finish running agent") submits A2.
   */
  repair?: "done" | "running";
  /** more organizations the viewer belongs to (same role), without projects: tries the org switcher */
  extraOrgs?: Array<{ orgId: string; name: string }>;
  /** instance admin (default: the owner role, the agency's person) */
  canCreateOrgs?: boolean;
  /**
   * Staging phase 3: the Customer Portal in staging mode (its policy gets `staging` and `release`
   * sections) with the demo of spec 2026-10-07 §12: three client tasks live on staging, one still
   * being worked on, two captures in Sent from staging. Off by default, so every earlier story and
   * test sees the project as before; the fixture turns it on with `?staging` (main.tsx).
   */
  staging?: boolean;
  /** ms one promotion step takes in fixture mode (default 1500); staging builds take `integrationMs` */
  promotionStepMs?: number;
  /** the next new folder's setup fails once (its Try again then succeeds); the fixture's `?folderSetupFails` */
  folderSetupFails?: boolean;
}

export class FakeApi implements CommonForgeApi {
  role: Role;
  signedIn = true;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly now: () => number;
  private readonly integrationMs: number;
  private readonly extraOrgs: Array<{ orgId: string; name: string; role?: Role }>;
  private readonly canCreateOrgs: boolean | undefined;
  private readonly members = new Map<string, MemberView[]>();
  /** grants: "<userId>|<project|resource>|<id>" → operations (mirrors D1 grants) */
  private readonly grants = new Map<string, Operation[]>();
  private readonly t0: number;
  private readonly resources = new Map<string, FakeResource>();
  private readonly mounts: Mount[];
  /** the empty project's folders (added by intake only) */
  private readonly handoverMounts: Mount[] = [];
  /** projects created at runtime (the two fixture projects are fixed) */
  private readonly newProjects = new Map<string, { org: string; name: string; createdAt: string; mounts: Mount[]; mode?: "legacy" | "agent-native" }>();
  /**
   * the policy of every project but the Customer Portal (whose policy is `policy`): a new project
   * starts with none of the demo's checks, release or staging
   */
  private readonly otherPolicies = new Map<string, { policy: ProjectPolicy; revision: number; changed: { at: string; by: string | null } | null }>();
  private readonly tasks: TaskSummary[];
  private readonly proposals = new Map<string, FakeProposal>();
  private readonly events: FakeEvent[] = [];
  private readonly versions: Array<{ v: Omit<VersionEntry, "head">; heads: Array<{ resourceId: string; revisionId: string }> }> = [];
  private readonly idem = new Map<string, { req: string; result: unknown }>();
  private readonly exports = new Map<string, { startedAt: number }>();
  private readonly editions = new Map<string, EditionView & { grants: Set<string> }>();
  private readonly updates = new Map<string, EditionSession & { owner: string }>();
  private readonly updateReturns = new Map<string, { sessionId: string; at: number; mode: "partial" | "full" }>();
  /** Task 22 fixtures: previews per proposal, releases (simulated build/deploy times) */
  private readonly previews = new Map<string, Array<{ v: PreviewView; readyAt: number }>>();
  private readonly releases: Array<{ v: ReleaseView; builtAt: number; deployAt: number | null; approved: boolean; willFail?: boolean }> = [];
  /** tests: the next deploy fails before changing anything ("Approved, not live", previous release stays live) */
  failNextDeploy = false;
  private readonly deployKeys = new Map<string, { releaseId: string; attempt: number }>();
  private liveRelease: string | null = null;
  private readonly intakes = new Map<string, FakeIntake>();
  private readonly uploads = new Map<string, FakeUpload>();
  private readonly fileChanges = new Map<string, FakeFileChange>();
  /** POST …/changes idempotency keys: `${org}|${user}|${key}` → the change and its request (project, folder, ops) */
  private readonly changeKeys = new Map<string, { changeId: string; sig: string }>();
  private uploadSeq = 0;
  private seq = 0;
  private versionSeq = 0;
  /** the repaired quote proposal, submitted when the running repair task finishes */
  private pendingRepair: (() => void) | null = null;
  private policyRevision = 1;
  private policy: ProjectPolicy;
  private policyChanged: { at: string; by: string | null } | null = null;
  // ----- staging phase 3 (`staging: true`; see the "staging" section below)
  private readonly promotionStepMs: number;
  /** who created a task and what it writes (tasks without an entry are the developers' demo tasks) */
  private readonly taskInfo = new Map<string, FakeTaskInfo>();
  private readonly landings: FakeLanding[] = [];
  private readonly promotions: FakePromotion[] = [];
  private readonly captures: Capture[] = [];
  private stagingCurrent: { buildId: string; since: string } | null = null;
  /** the staging build in progress (a newer request supersedes it, carrying a reset) */
  private stagingBuild: { buildId: string; doneAt: number; reset: boolean } | null = null;
  private stagingSeq = 0;
  /**
   * tests and rehearsal: what the classifier answers for a `classify` promotion. `live` (the default):
   * the real Jev's answers for the phone field (declined on `risk`, see `LIVE_ANSWERS`); `clear`: all
   * safe; a question id: that question is answered unsafely, the rest safe.
   */
  classifierOutcome: "live" | "clear" | RiskQuestionId | "unavailable" | "incomplete" = "live";
  /** tests: the next promotion's production release fails (`release_failed`) */
  failNextPromotionRelease = false;
  /** tests and the fixture: the next new folder's setup fails (once) */
  failNextFolderSetup = false;
  /**
   * Phase 4: a new folder's setup (Worker `folder_inits`). The first folder-list read that shows it
   * pending marks it `seen`; the next read finishes it (binds the first version, or fails), so the
   * UI shows "Setting up…" for one poll before "Ready".
   */
  private readonly folderInits = new Map<string, { name: string; state: "pending" | "done" | "failed"; seen: boolean; fail: boolean }>();

  constructor(opts: FakeOptions = {}) {
    this.role = opts.role ?? "owner";
    this.now = opts.now ?? (() => Date.now());
    this.integrationMs = opts.integrationMs ?? 2500;
    this.promotionStepMs = opts.promotionStepMs ?? 1500;
    this.extraOrgs = opts.extraOrgs ?? [];
    this.canCreateOrgs = opts.canCreateOrgs;
    this.failNextFolderSetup = opts.folderSetupFails ?? false;
    this.t0 = this.now();
    this.policy = {
      checks: [{ checkId: "quote-contract", mountName: "website", command: "pnpm exec vitest run tests/quote-contract.test.ts", timeoutSeconds: 300, required: true }],
      contracts: [{ contractId: "quote", version: "1", producerResource: API, consumerResource: WEBSITE, schema: { resourceId: REQS, path: "contracts/quote.schema.json" }, producerOutput: { mountName: "api", command: "node scripts/quote-sample.ts" } }],
      rules: ["GET /quote responses must match requirements/contracts/quote.schema.json"],
      approvalRoles: ["owner", "client"],
      publishRoles: ["owner"],
    };
    const since = new Date(this.t0 - 30 * 86_400_000).toISOString();
    this.members.set(FIXTURE_ORG, [
      { userId: "u-owner", email: "owner@agency.example", role: "owner", since },
      { userId: "u-developer", email: "dev@agency.example", role: "developer", since },
      { userId: "u-client", email: "client@customer.example", role: "client", since },
    ]);
    const ago = (min: number) => new Date(this.t0 - min * 60_000).toISOString();

    // ----- resources and their revisions
    const website = this.addResource(WEBSITE, "Website", "artifacts", {
      [ART("website", "w0")]: {
        "README.md": "# Website\n\nThe customer-facing portal (Vite).\n",
        "package.json": '{\n  "name": "portal-website",\n  "private": true,\n  "scripts": { "build": "vite build", "test": "vitest run" }\n}\n',
        "src/index.html": '<main>\n  <h1>Get a quote</h1>\n  <form id="quote"></form>\n  <p class="total"></p>\n</main>\n',
        "src/quote.ts": QUOTE_UI_BASE,
        "src/api.ts": 'export async function getQuote(items: string[]) {\n  const r = await fetch("/quote", { method: "POST", body: JSON.stringify({ items }) });\n  return r.json();\n}\n',
        "tests/quote.contract.test.ts": 'import schema from "../../requirements/contracts/quote.json";\n// checks the API response against the declared contract\n',
      },
    });
    const api = this.addResource(API, "API", "artifacts", {
      [ART("api", "a0")]: {
        "README.md": "# API\n\nHono Worker exposing `/quote`.\n",
        "src/index.ts": API_BASE,
        "src/pricing.ts": 'export function priceItems(items: string[]) {\n  return items.map((label) => ({ label, amount: 1500 }));\n}\n',
        "wrangler.jsonc": '{ "name": "portal-api", "main": "src/index.ts" }\n',
      },
    });
    const brand = this.addResource(BRAND, "Brand and media", "r2-assets", {
      [R2M("b0")]: {
        "logos/logo.svg": { size: LOGO_OLD.length, mime: "image/svg+xml", body: LOGO_OLD },
        "logos/logo-dark.svg": { size: LOGO_OLD.length, mime: "image/svg+xml", body: LOGO_OLD.replace("#1f3a5f", "#111") },
        "videos/launch-film.mp4": { size: 52_428_800, mime: "video/mp4" },
      },
    });
    const reqs = this.addResource(REQS, "Requirements", "artifacts", {
      [ART("requirements", "r0")]: {
        "README.md": REQS_BASE,
        "contracts/quote.json": '{\n  "type": "object",\n  "required": ["total"],\n  "properties": { "total": { "type": "integer" } },\n  "additionalProperties": false\n}\n',
      },
    });
    this.addResource(CONCEPT, "Quote-builder concept", "artifacts", {
      [ART("concept", "c0")]: {
        "prototype/index.html": "<!-- imported from the agency's prototype repo -->\n<div id=quote-builder></div>\n",
        "notes.md": "# Quote builder concept\n\nEarlier experiment; reference only.\n",
      },
    });
    // the ledger records every genesis bind as an accepted version (kind accept, no proposal)
    for (const r of this.resources.values()) this.bindVersion(r);
    // UX-2: the imported version has been live for a while (the client Overview's "Live" hero)
    this.seedLiveRelease(this.versions[this.versions.length - 1]!.v.acceptedVersionId, ago(20 * 60));
    this.mounts = [
      { mountName: "website", resourceId: WEBSITE, provider: "artifacts", resourceName: "Website", mode: "must-match-accepted", operations: ["read", "write"] },
      { mountName: "api", resourceId: API, provider: "artifacts", resourceName: "API", mode: "must-match-accepted", operations: ["read", "write"] },
      { mountName: "brand-assets", resourceId: BRAND, provider: "r2-assets", resourceName: "Brand and media", mode: "must-match-accepted", operations: ["read", "write"] },
      { mountName: "requirements", resourceId: REQS, provider: "artifacts", resourceName: "Requirements", mode: "must-match-accepted", operations: ["read", "write"] },
      { mountName: "quote-builder-concept", resourceId: CONCEPT, provider: "artifacts", resourceName: "Quote-builder concept", mode: "pinned-reference", operations: ["read"] },
    ];

    // candidate revisions (prepared into canonical, so developers can diff them)
    const w1 = ART("website", "w1");
    website.revisions.set(w1, { ...website.revisions.get(website.head)!, "src/quote.ts": QUOTE_UI_NEW, "src/index.html": '<main>\n  <h1>Get a quote</h1>\n  <form id="quote"></form>\n  <p class="total"></p>\n  <ul class="breakdown"></ul>\n</main>\n' });
    const a1 = ART("api", "a1");
    api.revisions.set(a1, { ...api.revisions.get(api.head)!, "src/index.ts": API_NEW });
    const a2 = ART("api", "a2"); // repaired: contract updated alongside
    api.revisions.set(a2, { ...api.revisions.get(api.head)!, "src/index.ts": API_NEW });
    const r1 = ART("requirements", "r1");
    reqs.revisions.set(r1, {
      ...reqs.revisions.get(reqs.head)!,
      "README.md": REQS_NEW,
      "contracts/quote.json": '{\n  "type": "object",\n  "required": ["total", "breakdown"],\n  "properties": {\n    "total": { "type": "integer" },\n    "breakdown": { "type": "array" }\n  },\n  "additionalProperties": false\n}\n',
    });
    const b1 = R2M("b1");
    brand.revisions.set(b1, { ...brand.revisions.get(brand.head)!, "logos/logo.svg": { size: LOGO_NEW.length, mime: "image/svg+xml", body: LOGO_NEW } });
    const r2 = ART("requirements", "r2");
    reqs.revisions.set(r2, { ...reqs.revisions.get(reqs.head)!, "README.md": REQS_NEW });

    // ----- three concurrent agent tasks (plan §C.1 row 5)
    const chA = "chg-0a5e0000-0000-4000-8000-000000000a00";
    const chB = "chg-0b5e0000-0000-4000-8000-000000000b00";
    const chC = "chg-0c5e0000-0000-4000-8000-000000000c00";
    const tA = "task-a15e0000-0000-4000-8000-00000000a100";
    const tB = "task-b15e0000-0000-4000-8000-00000000b100";
    const tC = "task-c15e0000-0000-4000-8000-00000000c100";
    this.tasks = [
      { taskId: tA, title: "Add a quote breakdown (website + API)", state: "submitted", changeId: chA, createdAt: ago(10) },
      { taskId: tB, title: "Client update: Friendlier quote form copy", state: "running", changeId: chB, createdAt: ago(3.2), updatedAt: ago(3.2), leaseExpiresAt: new Date(this.now() + 3600_000).toISOString() },
      { taskId: tC, title: "Refresh the brand logo and requirements", state: "submitted", changeId: chC, createdAt: ago(9.9) },
    ];
    const agent = (task: string) => ({ kind: "agent", id: `${task}:u-developer` });
    this.event(ago(10), "task.created", "task", tA, { kind: "user", id: "u-developer" }, { title: this.tasks[0]!.title });
    this.event(ago(9.9), "task.created", "task", tC, { kind: "user", id: "u-developer" }, { title: this.tasks[2]!.title });
    this.event(ago(9), "task.started", "task", tA, agent(tA), { leaseGeneration: 1 });
    this.event(ago(8.8), "task.started", "task", tC, agent(tC), { leaseGeneration: 1 });
    // B is the client-edition path, as in the live rehearsal: not a developer task but an edition
    // session (UX-6). The client's tool edits the working copy and sends it back; the return opens
    // task B (created by the client, no lease, so no `task.started`), which the runner is still
    // turning into a candidate ("Finish running agent" freezes it).
    const sB = "eds-0b5e00000000b100";
    const sBTitle = "Friendlier quote form copy";
    this.event(ago(8.6), "edition.session_started", "edition", "edn-0f1c7a2e00000001", { kind: "user", id: "u-client" }, { sessionId: sB, title: sBTitle }, { sessionId: sB, title: sBTitle });
    this.event(ago(3.2), "edition.returned", "edition", "edn-0f1c7a2e00000001", { kind: "user", id: "u-client" }, { returnId: "edr-0b5e00000000b100", sessionId: sB, taskId: tB, mode: "partial", allowed: 1, blocked: 0, tool: "claude" }, { returnId: "edr-0b5e00000000b100", mode: "partial", changed: 1, blocked: 0 });
    this.event(ago(4.2), "task.candidate_frozen", "candidate", `cand:tw-c:${fakeHex("r1")}`, agent(tC), { taskId: tC, changedPaths: 1 });
    this.event(ago(4.1), "task.candidate_frozen", "workspace", "tw-brand", agent(tC), { taskId: tC });
    this.event(ago(5), "task.candidate_frozen", "candidate", `cand:tw-w:${fakeHex("w1")}`, agent(tA), { taskId: tA, changedPaths: 2 });
    this.event(ago(4.9), "task.candidate_frozen", "candidate", `cand:tw-a:${fakeHex("a1")}`, agent(tA), { taskId: tA, changedPaths: 1 });

    // ----- proposals
    const cand = (tw: string, rid: string, base: string, rev: string, paths: string[], at: string, task: string) => ({
      candidateId: `cand:${tw}:${rev.split(":").pop()}`,
      taskWorkspaceId: tw,
      resourceId: rid,
      baseRevision: base,
      sha: rev.split(":").pop()!,
      treeId: fakeHex(`${rev}-tree`),
      frozenAt: at,
      submitter: agent(task),
      tool: "claude",
      changedPaths: paths,
      state: "prepared",
      preparedReceiptId: `rcpt-${fakeHex(rev, 12)}`,
    });
    // A1: website + api; the API changed /quote but the contract did not → contract failure
    const a1Cands = [cand("tw-website-a", WEBSITE, website.head, w1, ["src/index.html", "src/quote.ts"], ago(5), tA), cand("tw-api-a", API, api.head, a1, ["src/index.ts"], ago(4.9), tA)];
    this.addProposal("prop-a15e0000-0000-4000-8000-00000000a100", chA, a1Cands, [], "prepared", ago(4.8), "contract-fail");
    const pa1 = this.proposals.get("prop-a15e0000-0000-4000-8000-00000000a100")!;
    this.proposalCreated(pa1, ago(4.8));
    this.finishRun(pa1, "contract-fail", ago(4.6), ago(4.4), `job-${fakeHex("a1-run", 24)}`);
    // A2: the repair also updates the contract in requirements → passes. UX-4 review C-1: in the
    // browser fixture (`repair: "running"`) Agent A is still repairing (a second lease), A1 is not
    // replaced yet (the 4:00 frame: "Needs your decision"), and "Finish running agent" submits A2.
    const submitRepair = (at: (min: number) => string) => {
      this.event(at(2), "task.candidate_frozen", "candidate", `cand:tw-api-a:${fakeHex("a2")}`, agent(tA), { taskId: tA, changedPaths: 1 });
      this.event(at(1.9), "task.candidate_frozen", "candidate", `cand:tw-reqs-a:${fakeHex("r1")}`, agent(tA), { taskId: tA, changedPaths: 1 });
      const a2Cands = [a1Cands[0]!, cand("tw-api-a", API, api.head, a2, ["src/index.ts"], at(2), tA), cand("tw-reqs-a", REQS, reqs.head, r1, ["README.md", "contracts/quote.json"], at(1.9), tA)];
      this.addProposal(FIXTURE_PROPOSALS.quoteRepaired, chA, a2Cands, [], "prepared", at(1.8), "pass");
      const pa2 = this.proposals.get(FIXTURE_PROPOSALS.quoteRepaired)!;
      this.proposalCreated(pa2, at(1.8));
      this.finishRun(pa2, "pass", at(1.5), at(1.2), `job-${fakeHex("a2-run", 24)}`);
      this.tasks.find((t) => t.taskId === tA)!.state = "submitted";
    };
    if (opts.repair === "running") {
      this.tasks.find((t) => t.taskId === tA)!.state = "running";
      this.event(ago(2.2), "task.started", "task", tA, agent(tA), { leaseGeneration: 2 });
      // submitted "now": the steps a few seconds apart, in order
      this.pendingRepair = () => submitRepair((min) => new Date(this.now() - min * 2000).toISOString());
    } else submitRepair(ago);
    // C: logo (assets) + requirements text; prepared, not yet validated
    const cCands = [cand("tw-reqs-c", REQS, reqs.head, r2, ["README.md"], ago(4.2), tC)];
    this.addProposal("prop-c15e0000-0000-4000-8000-00000000c100", chC, cCands, [{ resourceId: BRAND, baseManifestId: brand.head.slice(4), newManifestId: b1.slice(4) }], "prepared", ago(4), "pass");
    this.proposalCreated(this.proposals.get("prop-c15e0000-0000-4000-8000-00000000c100")!, ago(4));

    const seed = (userId: string, pid: string, ops: Operation[]) => {
      this.grants.set(`${userId}|project|${pid}`, ops);
      for (const m of this.mountsOf(pid)) this.grants.set(`${userId}|resource|${m.resourceId}`, ops);
    };
    seed("u-developer", FIXTURE_PROJECT, ["read", "write"]);
    seed("u-developer", FIXTURE_EMPTY_PROJECT, ["read", "write"]);
    // the client may change the project's folders through tasks ("Can change"; Worker canStageWrite)
    seed("u-client", FIXTURE_PROJECT, ["read", "write"]);
    if (opts.staging) this.seedStaging(ago);
  }

  // ------------------------------------------------------------------------------- seeding

  /** Genesis: binding an imported head records an accepted version, like `planBindHead`. */
  private bindVersion(r: FakeResource) {
    const acceptedVersionId = `av-${fakeHex(`bind-${r.resourceId}`, 16)}`;
    this.versions.push({ v: { acceptedVersionId, sequence: ++this.versionSeq, kind: "accept", proposalId: null, proposalHash: null, acceptedAt: r.headAt, actor: { kind: "user", id: "u-developer" } }, heads: [{ resourceId: r.resourceId, revisionId: r.head }] });
    r.headVersionId = acceptedVersionId;
  }

  /** A release of `acceptedVersionId` that is already live (built, publish-approved, deployed, healthy). */
  private seedLiveRelease(acceptedVersionId: string, at: string) {
    const releaseId = `rel-${fakeHex(`rel-seed-${acceptedVersionId}`, 24)}`;
    const v: ReleaseView = {
      releaseId,
      projectId: FIXTURE_PROJECT,
      acceptedVersionId,
      recipeRevision: 1,
      envDigest: fakeHex(`env-${FIXTURE_PROJECT}`, 64),
      outputDigest: fakeHex(`out-${releaseId}`, 64),
      state: "live",
      buildState: "built",
      status: "Live",
      live: true,
      publishApproved: true,
      deployAttempts: 1,
      createdAt: at,
      updatedAt: at,
      error: null,
      deployments: [
        { targetId: "api", workerName: "cfapp-o-fixture-api", url: "https://cfapp-o-fixture-api.fixture.invalid" },
        { targetId: "website", workerName: "cfapp-o-fixture-website", url: "https://cfapp-o-fixture-website.fixture.invalid" },
      ],
      health: { ok: true, checkedAt: at, targets: [{ targetId: "api", ok: true }, { targetId: "website", ok: true }] },
    };
    this.releases.push({ v, builtAt: 0, deployAt: 0, approved: true });
    this.liveRelease = releaseId;
  }

  private addResource(id: string, name: string, provider: FakeResource["provider"], revisions: Record<string, Files>): FakeResource {
    const [head] = Object.keys(revisions);
    const r: FakeResource = { resourceId: id, name, provider, repoId: name.toLowerCase(), revisions: new Map(Object.entries(revisions)), head: head ?? "", headSeq: 1, headVersionId: null, headAt: new Date(this.t0 - 86_400_000).toISOString() };
    this.resources.set(id, r);
    return r;
  }

  private addProposal(id: string, changeId: string, candidates: Proposal["candidates"], assets: Proposal["assetManifestChanges"], state: Proposal["state"], at: string, next: FakeProposal["nextIntegration"]) {
    const resourceChanges = candidates.map((c) => ({ resourceId: c.resourceId, baseRevision: c.baseRevision, candidateId: c.candidateId, candidateRevision: `art:${this.resources.get(c.resourceId)!.repoId}:${c.sha}` }));
    const hash = fakeHex(`${id}|${JSON.stringify(resourceChanges)}|${JSON.stringify(assets)}`, 64);
    this.proposals.set(id, {
      p: {
        proposalId: id,
        proposalHash: hash,
        projectId: FIXTURE_PROJECT,
        changeId,
        state,
        baseSnapshotId: fakeHex(`${id}-base`, 64),
        candidateSnapshotId: fakeHex(`${id}-cand`, 64),
        resourceChanges,
        assetManifestChanges: assets,
        readDependencies: [{ resourceId: CONCEPT, revisionId: this.resources.get(CONCEPT)!.head, mode: "pinned-reference" }],
        policyRevision: 1,
        preparedReceipts: candidates.map((c) => ({ resourceId: c.resourceId, receiptId: c.preparedReceiptId! })),
        createdAt: at,
        updatedAt: at,
      },
      candidates,
      approvals: [],
      integration: null,
      nextIntegration: next,
      integratingSince: null,
      integratingJob: null,
      lastAttempt: null,
    });
  }

  private proposalCreated(fp: FakeProposal, at: string) {
    this.event(at, "proposal.created", "proposal", fp.p.proposalId, { kind: "user", id: "u-developer" }, { proposalHash: fp.p.proposalHash, changeId: fp.p.changeId }, { proposalHash: fp.p.proposalHash });
  }

  /**
   * Record a finished integrate run like the Worker: a pass sets `integration` (the receipt) and
   * emits `proposal.integrated`; a failure leaves `integration` unchanged and emits
   * `proposal.integration_failed` (developers: code + detail; clients: code + conflict paths).
   */
  private finishRun(fp: FakeProposal, outcome: FakeProposal["nextIntegration"], requestedAt: string, at: string, jobId: string) {
    const r = this.integrationResult(fp, outcome, at);
    r.jobId = jobId;
    const runner = { kind: "runner", id: "integration-runner" };
    fp.lastAttempt = {
      state: outcome === "pass" ? "succeeded" : "failed",
      expired: false,
      forCurrentHash: true,
      requestedAt,
      completedAt: at,
      code: outcome === "pass" ? null : "contract_failed",
      checks: r.checks,
      contractChecks: r.contractChecks.map((c) => ({ ...c, producerResource: API, consumerResource: WEBSITE })),
      mergeOutcome: r.mergeOutcome,
      conflictPaths: [],
      signedEvidence: true,
      jobId,
      evidenceId: `ev-${jobId}`,
      ...(outcome === "pass" ? {} : { detail: "contract quote-schema: /quote response has property \"breakdown\" not allowed by requirements/contracts/quote.json (additionalProperties: false)" }),
    };
    if (outcome === "pass") {
      fp.integration = r;
      const checks = r.checks.map((c) => ({ checkId: c.checkId, result: c.result }));
      this.event(at, "proposal.integrated", "proposal", fp.p.proposalId, runner, { jobId, checks }, { checks });
    } else {
      this.event(at, "proposal.integration_failed", "proposal", fp.p.proposalId, runner, { jobId, code: "contract_failed", detail: fp.lastAttempt.detail }, { code: "contract_failed", conflictPaths: [] });
    }
  }

  private integrationResult(fp: FakeProposal, outcome: FakeProposal["nextIntegration"], at: string): IntegrationView {
    const jobId = `job-${fakeHex(`${fp.p.proposalId}-${at}`, 24)}`;
    const touches = new Set([...fp.p.resourceChanges.map((r) => r.resourceId), ...fp.p.assetManifestChanges.map((a) => a.resourceId)]);
    // an assets-only proposal runs every check against the code at the proposal's base (the real runner always runs them)
    const runs = (rid: string) => touches.has(rid) || fp.p.resourceChanges.length === 0;
    return {
      jobId,
      forCurrentHash: true,
      integratedAt: at,
      checks: [
        { checkId: "website-build", result: runs(WEBSITE) ? "pass" : "skipped" },
        { checkId: "website-tests", result: runs(WEBSITE) ? "pass" : "skipped" },
        { checkId: "api-tests", result: runs(API) ? "pass" : "skipped" },
      ],
      contractChecks: [{ contractId: "quote-schema", result: outcome === "contract-fail" ? "fail" : "pass" }],
      // like the runner: merge outcomes for git targets only (an assets-only run has none)
      mergeOutcome: fp.p.resourceChanges.map((rc) => ({ resourceId: rc.resourceId, result: "clean" as const })),
      results: fp.p.resourceChanges.map((rc) => ({ resourceId: rc.resourceId, integrationRef: `refs/commonforge/integrations/${fp.p.proposalId}/${jobId}`, sha: rc.candidateRevision.split(":").pop()!, revisionId: rc.candidateRevision, expectedHead: rc.baseRevision })),
    };
  }

  /** `clientDetail` given → the event is client-visible with that detail (API.md I-3). */
  private event(at: string, action: string, kind: string, id: string, actor: { kind: string; id?: string }, detail?: Record<string, unknown>, clientDetail?: Record<string, unknown>, clientVisible = clientDetail !== undefined) {
    this.events.push({ seq: ++this.seq, at, projectId: FIXTURE_PROJECT, action, subject: { kind, id }, actor, ...(detail ? { detail } : {}), clientVisible, ...(clientDetail ? { clientDetail } : {}) });
    // seeded events are written out of order: keep `seq` in time order, like the real log
    this.events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
    this.events.forEach((e, i) => (e.seq = i + 1));
  }

  // ------------------------------------------------------------------------------- helpers

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    if (!this.signedIn && method !== "requestMagicLink" && method !== "verify") throw new ApiError(401, "unauthenticated", "sign in first");
  }

  private isDev() {
    return this.role === "owner" || this.role === "developer";
  }

  private needDev() {
    if (!this.isDev()) throw new ApiError(403, "insufficient_role", "developers and owners only");
  }

  /** the demo organization, or another one the viewer belongs to (whose listings hold only what was made in it) */
  private org(org: string) {
    if (org !== FIXTURE_ORG && !this.extraOrgs.some((o) => o.orgId === org)) throw new ApiError(404, "not_found", "organization not found");
  }

  private project(org: string, pid: string) {
    // another organization holds only the projects created in it (none of the demo's)
    if (this.extraOrgs.some((o) => o.orgId === org)) {
      if (this.newProjects.get(pid)?.org !== org) throw new ApiError(404, "not_found", "project not found");
      return;
    }
    this.org(org);
    if (pid !== FIXTURE_PROJECT && pid !== FIXTURE_EMPTY_PROJECT && this.newProjects.get(pid)?.org !== org) throw new ApiError(404, "not_found", "project not found");
  }

  /** the project's policy entry (the Customer Portal's is `policy`; any other starts empty) */
  private otherPolicy(pid: string) {
    let e = this.otherPolicies.get(pid);
    if (!e) this.otherPolicies.set(pid, (e = { policy: { checks: [], contracts: [], rules: [] }, revision: 0, changed: null }));
    return e;
  }

  private mountsOf(pid: string): Mount[] {
    return this.newProjects.get(pid)?.mounts ?? (pid === FIXTURE_EMPTY_PROJECT ? this.handoverMounts : this.mounts);
  }

  private projectName(pid: string): string {
    return PROJECT_NAMES[pid] ?? this.newProjects.get(pid)!.name;
  }

  /** every project id: the two fixture projects, then those created at runtime */
  private allProjects(): string[] {
    return [FIXTURE_PROJECT, FIXTURE_EMPTY_PROJECT, ...this.newProjects.keys()];
  }

  private mount(name: string, pid: string = FIXTURE_PROJECT) {
    const m = this.mountsOf(pid).find((x) => x.mountName === name);
    if (!m) throw new ApiError(404, "not_found", "mount not found");
    return { m, r: this.resources.get(m.resourceId)! };
  }

  private nowIso() {
    return new Date(this.now()).toISOString();
  }

  /** Finish an integration whose simulated run time has elapsed. */
  private tick(fp: FakeProposal) {
    if (fp.integratingSince !== null && this.now() - fp.integratingSince >= this.integrationMs) {
      const requestedAt = new Date(fp.integratingSince).toISOString();
      fp.integratingSince = null;
      this.finishRun(fp, fp.nextIntegration, requestedAt, this.nowIso(), fp.integratingJob!);
    }
  }

  private present(fp: FakeProposal): Proposal {
    this.tick(fp);
    const stale: string[] = [];
    if (fp.p.state !== "accepted") {
      for (const rc of fp.p.resourceChanges) if (this.resources.get(rc.resourceId)!.head !== rc.baseRevision) stale.push(rc.resourceId);
      for (const ac of fp.p.assetManifestChanges) if (this.resources.get(ac.resourceId)!.head !== `r2m:${ac.baseManifestId}`) stale.push(ac.resourceId);
    }
    const dev = this.isDev();
    const integration = fp.integration ? { ...fp.integration, forCurrentHash: true } : null;
    if (integration && !dev) delete integration.results;
    let lastAttempt: IntegrationAttempt | null = fp.lastAttempt ? { ...fp.lastAttempt } : null;
    if (lastAttempt && !dev) {
      const { jobId: _j, detail: _d, evidenceId: _e, ...rest } = lastAttempt;
      lastAttempt = rest;
    }
    return structuredClone({
      lastAttempt,
      ...fp.p,
      stale,
      approvals: fp.approvals.map((a) => (dev ? a : { ...a, approver: { kind: a.approver.kind } })),
      integration,
      candidates: fp.candidates,
    });
  }

  private fp(org: string, id: string) {
    this.org(org);
    const fp = this.proposals.get(id);
    if (!fp) throw new ApiError(404, "not_found", "proposal not found");
    return fp;
  }

  // ---------------------------------------------------------------------------------- auth

  async requestMagicLink(email: string) {
    this.log("requestMagicLink", email);
    if (!email.includes("@")) throw new ApiError(400, "invalid_request", "email: invalid email address");
  }

  async verify(token: string) {
    this.log("verify", token);
    if (!token.startsWith("cfm_")) throw new ApiError(401, "invalid_token", "this sign-in link is invalid, used or expired");
    this.signedIn = true;
    return { user: (await this.me()).user, expiresAt: new Date(this.now() + 30 * 86_400_000).toISOString() };
  }

  /** the fixture's sessions: this browser, a cforge login and an agent hand-off (Worker GET /api/auth/sessions) */
  private sessions: SessionView[] | null = null;
  private sessionList(): SessionView[] {
    const at = (h: number) => new Date(this.t0 - h * 3600_000).toISOString();
    const until = (h: number, days: number) => new Date(this.t0 - h * 3600_000 + days * 86_400_000).toISOString();
    this.sessions ??= [
      { sessionId: "0a1b2c3d4e5f60718293", client: "web", createdAt: at(2), expiresAt: until(2, 30), current: true },
      { sessionId: "1b2c3d4e5f6071829304", client: "handoff", createdAt: at(26), expiresAt: until(26, 7), current: false },
      { sessionId: "2c3d4e5f607182930415", client: "cli", createdAt: at(72), expiresAt: until(72, 30), current: false },
    ];
    return this.sessions;
  }

  async listSessions() {
    this.log("listSessions");
    return structuredClone(this.sessionList());
  }

  async revokeSessions(which: { sessionId: string } | { others: true }) {
    this.log("revokeSessions", which);
    const before = this.sessionList().length;
    this.sessions = this.sessionList().filter((x) => ("sessionId" in which ? x.sessionId !== which.sessionId : x.current));
    return before - this.sessions.length;
  }

  async cliCode() {
    this.log("cliCode");
    return { code: `cfm_fake${fakeHex(`cli-${this.now()}`, 24)}`, expiresAt: new Date(this.now() + 15 * 60_000).toISOString() };
  }

  async logout() {
    this.log("logout");
    this.signedIn = false;
  }

  /** read on demand: fixture "View as Client" changes `role` after construction */
  private canCreate(): boolean {
    return this.canCreateOrgs ?? this.role === "owner";
  }

  async me(): Promise<Me> {
    this.log("me");
    const email = this.isDev() ? "dev@agency.example" : `${this.role}@customer.example`;
    return { user: { userId: `u-${this.role}`, email }, memberships: [{ orgId: FIXTURE_ORG, name: "Demo Client", role: this.role }, ...this.extraOrgs.map((o) => ({ orgId: o.orgId, name: o.name, role: o.role ?? this.role }))], canCreateOrgs: this.canCreate() };
  }

  // ------------------------------------------------------------------------------ projects

  async listProjects(org: string) {
    this.log("listProjects", org);
    const created = [...this.newProjects].filter(([, p]) => p.org === org).map(([projectId, p]) => ({ projectId, name: p.name, createdAt: p.createdAt }));
    if (this.extraOrgs.some((o) => o.orgId === org)) return this.isDev() ? created : [];
    this.org(org);
    return [
      { projectId: FIXTURE_PROJECT, name: "Customer Portal", createdAt: new Date(this.t0 - 86_400_000).toISOString() },
      { projectId: FIXTURE_EMPTY_PROJECT, name: "Agency handover", createdAt: new Date(this.t0 - 3_600_000).toISOString() },
      ...created,
    ];
  }

  async getProject(org: string, pid: string): Promise<Project> {
    this.log("getProject", org, pid);
    this.project(org, pid);
    return {
      projectId: pid,
      mode: this.newProjects.get(pid)?.mode ?? "legacy",
      name: this.projectName(pid),
      membershipRevision: 3,
      policyRevision: pid === FIXTURE_PROJECT ? this.policyRevision : this.otherPolicy(pid).revision,
      // copies: a caller changing a mount (or its operations) must not change the fake
      mounts: this.mountsOf(pid).map((m) => ({ ...structuredClone(m), operations: this.isDev() ? [...m.operations] : ["read"], canWrite: this.mountCanWrite(m), canStartTask: this.mountCanStartTask(pid, m) })),
      ...(this.isDev() ? this.projectPolicyView(pid) : {}),
    };
  }

  private projectPolicyView(pid: string): { policy: ProjectPolicy; policyChanged?: { at: string; by: string | null } } {
    if (pid === FIXTURE_PROJECT) return { policy: structuredClone(this.policy), ...(this.policyChanged ? { policyChanged: this.policyChanged } : {}) };
    const e = this.otherPolicy(pid);
    return { policy: structuredClone(e.policy), ...(e.changed ? { policyChanged: e.changed } : {}) };
  }

  private policyCheck(policy: ProjectPolicy): PolicyIssue[] {
    const issues: PolicyIssue[] = [];
    const roles = (k: "approvalRoles" | "publishRoles") => {
      const v = policy[k];
      if (v !== undefined && v.length === 0) issues.push({ path: k, message: "Array must contain at least 1 element(s)" });
    };
    roles("approvalRoles");
    roles("publishRoles");
    (policy.checks ?? []).forEach((c, i) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.checkId)) issues.push({ path: `checks.${i}.checkId`, message: "Invalid id" });
      if (!c.command) issues.push({ path: `checks.${i}.command`, message: "String must contain at least 1 character(s)" });
      const t = c.timeoutSeconds ?? 600;
      if (!Number.isInteger(t) || t < 1 || t > 3600) issues.push({ path: `checks.${i}.timeoutSeconds`, message: "Number must be between 1 and 3600" });
    });
    (policy.rules ?? []).forEach((r, i) => {
      if (r.length > 4096) issues.push({ path: `rules.${i}`, message: "String must contain at most 4096 character(s)" });
    });
    if (policy.contracts !== undefined && !Array.isArray(policy.contracts)) issues.push({ path: "contracts", message: "Expected array" });
    if (policy.staging !== undefined && policy.release === undefined) issues.push({ path: "staging", message: "staging needs a release section: staging deploys the release targets" });
    return issues;
  }

  async validatePolicy(org: string, pid: string, policy: ProjectPolicy) {
    this.log("validatePolicy", org, pid);
    this.project(org, pid);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
    const issues = this.policyCheck(policy);
    return { ok: issues.length === 0, issues };
  }

  async putPolicy(org: string, pid: string, policy: ProjectPolicy, expectedRevision?: number) {
    this.log("putPolicy", org, pid);
    this.project(org, pid);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
    // the worker's order: the body is parsed (schema) before the revision is compared
    const issues = this.policyCheck(policy);
    if (issues.length) throw new ApiError(400, "invalid_request", issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    const saved = { ...structuredClone(policy), checks: policy.checks ?? [], contracts: policy.contracts ?? [], rules: policy.rules ?? [] };
    if (pid !== FIXTURE_PROJECT) {
      const e = this.otherPolicy(pid);
      if (expectedRevision !== undefined && expectedRevision !== e.revision) throw new ApiError(409, "policy_changed", "the policy changed since you opened it", { policyRevision: e.revision });
      e.policy = saved;
      e.revision += 1;
      e.changed = { at: new Date(this.now()).toISOString(), by: "owner@agency.example" };
      return { policyRevision: e.revision, policy: structuredClone(e.policy) };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.policyRevision) throw new ApiError(409, "policy_changed", "the policy changed since you opened it", { policyRevision: this.policyRevision });
    this.policy = saved;
    this.policyRevision += 1;
    this.policyChanged = { at: new Date(this.now()).toISOString(), by: "owner@agency.example" };
    return { policyRevision: this.policyRevision, policy: structuredClone(this.policy) };
  }

  async createProject(org: string, name: string, mode?: "legacy" | "agent-native") {
    this.log("createProject", org, name);
    this.org(org);
    this.needDev();
    const projectId = `p-${(0xc0de0000 + this.newProjects.size + 10).toString(16)}`;
    this.newProjects.set(projectId, { org, name: name.trim(), createdAt: new Date(this.now()).toISOString(), mounts: [], ...(mode ? {mode} : {}) });
    // the worker gives a developer creator read + write on the new project
    if (this.role === "developer") this.grants.set(`u-developer|project|${projectId}`, ["read", "write"]);
    return { projectId, name: name.trim() };
  }

  async listResources(org: string): Promise<Resource[]> {
    this.log("listResources", org);
    this.org(org);
    // another organization's folders: only those made in its projects
    if (org !== FIXTURE_ORG) {
      const mine = new Set([...this.newProjects.values()].filter((p) => p.org === org).flatMap((p) => p.mounts.map((m) => m.resourceId)));
      return [...this.resources.values()].filter((r) => mine.has(r.resourceId)).map((r) => ({ resourceId: r.resourceId, name: r.name, provider: r.provider, state: r.state ?? "active", ...(r.error ? { error: r.error } : {}), branch: "main", createdAt: r.headAt, updatedAt: r.headAt }));
    }
    return [...this.resources.values()].map((r) => ({ resourceId: r.resourceId, name: r.name, provider: r.provider, state: r.state ?? "active", ...(r.error ? { error: r.error } : {}), branch: "main", createdAt: r.headAt, updatedAt: r.headAt }));
  }

  async listFolders(org: string, pid: string): Promise<ProjectFolder[]> {
    this.log("listFolders", org, pid);
    this.project(org, pid);
    this.needDev();
    // like the worker: non-owners see only folders they can read, and only the other projects they can read
    const me = `u-${this.role}`;
    for (const m of this.mountsOf(pid)) this.advanceFolderInit(org, m.resourceId);
    return structuredClone(
      this.mountsOf(pid)
        .filter((m) => this.role === "owner" || this.grants.get(`${me}|resource|${m.resourceId}`)?.includes("read"))
        .map((m) => {
          const r = this.resources.get(m.resourceId);
          return {
            mountName: m.mountName,
            resourceId: m.resourceId,
            resourceName: r?.name ?? m.resourceName,
            provider: m.provider,
            state: r?.state ?? "active",
            writable: m.operations.includes("write"),
            settingUp: this.folderInits.get(m.resourceId)?.state === "pending",
            setupFailed: this.folderInits.get(m.resourceId)?.state === "failed",
            ...(r?.error ? { error: r.error } : {}),
            alsoIn: this.allProjects()
              .filter((id) => id !== pid && this.mountsOf(id).some((x) => x.resourceId === m.resourceId))
              .filter((id) => this.role === "owner" || this.grants.has(`${me}|project|${id}`))
              .map((projectId) => ({ projectId, name: this.projectName(projectId) })),
          };
        }),
    );
  }

  /**
   * Like the Worker's `POST …/folders` (phase 4): one kind of folder, a git folder. `kind` is ignored
   * (`files` and `code` both accepted, anything else `400`). The resource starts `empty` with a
   * pending setup; `advanceFolderInit` makes its first commit (the three files) and binds it.
   */
  async createFolder(org: string, pid: string, body: { name: string; kind?: string }) {
    this.log("createFolder", org, pid, body);
    this.project(org, pid);
    this.needDev();
    if (!MountNameSchema.safeParse(body.name).success) throw new ApiError(400, "invalid_request", "name: expected a mount name: one NFC path segment, not starting with \".\"");
    if (body.kind !== undefined && body.kind !== "files" && body.kind !== "code") throw new ApiError(400, "invalid_request", 'kind: expected "files" or "code"');
    const mounts = this.mountsOf(pid);
    if (mounts.some((m) => m.mountName === body.name)) throw new ApiError(409, "mount_exists", `this project already has a folder named ${body.name}`);
    const resourceId = `res-${(0xf0000000 + this.resources.size).toString(16)}`;
    const r = this.addResource(resourceId, body.name, "artifacts", {});
    r.repoId = `folder-${resourceId}`;
    r.state = "empty";
    r.headAt = this.nowIso();
    this.folderInits.set(resourceId, { name: body.name, state: "pending", seen: false, fail: this.failNextFolderSetup });
    this.failNextFolderSetup = false;
    mounts.push({ mountName: body.name, resourceId, provider: "artifacts", resourceName: body.name, mode: "must-match-accepted", operations: ["read", "write"] });
    if (this.role === "developer") this.grants.set(`u-developer|resource|${resourceId}`, ["read", "write"]);
    this.grantFolderToProjectPeople(pid, resourceId);
    return { mountName: body.name, resourceId };
  }

  /** Worker `POST …/folders/:mount/setup/retry`: only a failed setup; owners, and developers with write on the folder. */
  async retryFolderSetup(org: string, pid: string, mount: string) {
    this.log("retryFolderSetup", org, pid, mount);
    this.project(org, pid);
    this.needDev();
    const { m, r } = this.mount(mount, pid);
    if (!this.mountCanWrite(m)) throw new ApiError(403, "forbidden", "you can't change this folder");
    const init = this.folderInits.get(r.resourceId);
    if (init?.state !== "failed") throw new ApiError(409, "setup_not_failed", "this folder's setup has not failed");
    Object.assign(init, { state: "pending", seen: false, fail: false });
    r.state = "empty";
    delete r.error;
    return { state: "empty" as const, settingUp: true as const };
  }

  /** One folder-list read moves a pending setup: the first read shows it, the next one finishes it. */
  private advanceFolderInit(org: string, resourceId: string) {
    const init = this.folderInits.get(resourceId);
    if (init?.state !== "pending") return;
    if (!init.seen) {
      init.seen = true;
      return;
    }
    const r = this.resources.get(resourceId)!;
    if (init.fail) {
      init.state = "failed";
      r.state = "failed";
      r.error = "Setting up this folder failed: the first version could not be written (fixture)";
      return;
    }
    // the same first commit the Worker's `init-folder` job writes (P4-5, P4-6): genesis, no proposal
    const rev = ART(r.repoId, `init-${resourceId}`);
    r.revisions.set(rev, Object.fromEntries(firstCommitFiles(init.name, lfsEndpointUrl(FIXTURE_PUBLIC_URL, org, resourceId)).map((f) => [f.path, f.content])));
    r.head = rev;
    r.headAt = this.nowIso();
    r.state = "active";
    init.state = "done";
    this.bindVersion(r);
  }

  async attachFolder(org: string, pid: string, body: { mountName: string; resourceId: string }) {
    this.log("attachFolder", org, pid, body);
    this.project(org, pid);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
    const r = this.resources.get(body.resourceId);
    if (!r) throw new ApiError(404, "not_found", "resource not found");
    const mounts = this.mountsOf(pid);
    if (mounts.some((m) => m.mountName === body.mountName)) throw new ApiError(409, "mount_exists", `mount ${body.mountName} already exists`);
    // like the Worker: one mount per folder per project
    if (mounts.some((m) => m.resourceId === r.resourceId)) throw new ApiError(409, "folder_already_attached", "this folder is already attached to this project");
    mounts.push({ mountName: body.mountName, resourceId: r.resourceId, provider: r.provider, resourceName: r.name, mode: "must-match-accepted", operations: ["read", "write"] });
    this.grantFolderToProjectPeople(pid, r.resourceId);
  }

  async detachFolder(org: string, pid: string, mountName: string) {
    this.log("detachFolder", org, pid, mountName);
    this.project(org, pid);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
    const mounts = this.mountsOf(pid);
    const i = mounts.findIndex((m) => m.mountName === mountName);
    if (i < 0) throw new ApiError(404, "not_found", "mount not found");
    // the floor is read after the mount is gone, so it counts every OTHER mount of the folder (this project's too)
    const [m] = mounts.splice(i, 1);
    return { changed: this.removeFolderFromProjectPeople(pid, m!.resourceId) };
  }

  /** Worker PATCH …/mounts/:mount: read-only takes a client's Can change unless another project still lets them change it */
  async setFolderWritable(org: string, pid: string, mountName: string, writable: boolean) {
    this.log("setFolderWritable", org, pid, mountName, writable);
    this.project(org, pid);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
    const m = this.mountsOf(pid).find((x) => x.mountName === mountName);
    if (!m) throw new ApiError(404, "not_found", "mount not found");
    const was = m.operations.includes("write");
    m.operations = writable ? ["read", "write"] : ["read"];
    const changed: string[] = [];
    if (was && !writable) {
      for (const mem of this.memberList(FIXTURE_ORG)) {
        if (mem.role !== "client") continue;
        const rk = `${mem.userId}|resource|${m.resourceId}`;
        if (!this.grants.get(rk)?.includes("write")) continue;
        const elsewhere = this.allProjects().some((other) => this.mountsOf(other).some((x) => x.resourceId === m.resourceId && x.operations.includes("write")) && this.grants.get(`${mem.userId}|project|${other}`)?.includes("write"));
        if (elsewhere) continue;
        this.grants.set(rk, ["read"]);
        changed.push(mem.userId);
      }
    }
    return { changed };
  }

  async getSnapshot(org: string, pid: string): Promise<ProjectSnapshot> {
    this.log("getSnapshot", org, pid);
    this.project(org, pid);
    const entries = this.mountsOf(pid).filter((m) => this.resources.get(m.resourceId)!.head).map((m) => ({ resourceId: m.resourceId, revisionId: this.resources.get(m.resourceId)!.head, mode: m.mode, mountName: m.mountName, operations: [...m.operations] }));
    return { snapshotId: fakeHex(JSON.stringify(entries), 64), projectId: pid, organizationId: org, membershipRevision: 3, policyRevision: 1, entries, createdAt: this.nowIso() };
  }

  async listTree(org: string, pid: string, q: FileQuery): Promise<TreeListing> {
    this.log("listTree", org, pid, q);
    this.project(org, pid);
    const { m, r } = this.mount(q.mount, pid);
    if (q.revision && !this.isDev()) throw new ApiError(403, "revision_not_allowed", "clients and viewers browse the accepted version only");
    const rev = q.revision ?? r.head;
    // like the Worker: a resource without an accepted version cannot be browsed
    if (!rev) throw new ApiError(409, "no_accepted_head", "the resource has no accepted version yet");
    const files = r.revisions.get(rev);
    if (!files) throw new ApiError(404, "not_found", "revision not found");
    const prefix = q.path ? `${q.path}/` : "";
    const seen = new Map<string, TreeListing["entries"][number]>();
    for (const [path, f] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const i = rest.indexOf("/");
      const child = prefix + (i < 0 ? rest : rest.slice(0, i));
      // a git folder's LFS file is listed with its real size and `lfs: true` (Worker `pointerObjects`)
      const lfs = r.provider === "artifacts" && isLfsEntry(f);
      if (!seen.has(child)) seen.set(child, i < 0 ? { path: child, type: "file", size: typeof f === "string" ? f.length : f.size, ...(lfs ? { lfs: true } : {}) } : { path: child, type: "dir" });
    }
    const entries = [...seen.values()].sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.path < b.path ? -1 : 1));
    return { mountName: m.mountName, resourceId: r.resourceId, provider: r.provider, revisionId: rev, path: q.path, entries };
  }

  fileUrl(org: string, pid: string, q: FileQuery) {
    // like the client's, building a link never throws (a render may hold a path a change just moved);
    // a missing file's link is what the server would answer: not found
    let f: Files[string];
    try {
      f = this.fileEntry(q, pid);
    } catch {
      return `data:text/plain;charset=utf-8,${encodeURIComponent("file not found")}`;
    }
    const body = typeof f === "string" ? f : (f.body ?? "");
    const mime = typeof f === "string" ? "text/plain" : f.mime;
    return `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;
  }

  private fileEntry(q: FileQuery, pid: string) {
    const { r } = this.mount(q.mount, pid);
    const files = r.revisions.get(q.revision ?? r.head);
    const f = files?.[q.path];
    if (f === undefined) throw new ApiError(404, "not_found", "file not found");
    return f;
  }

  async readFile(org: string, pid: string, q: FileQuery) {
    this.log("readFile", org, pid, q);
    this.project(org, pid);
    if (q.revision && !this.isDev()) throw new ApiError(403, "revision_not_allowed", "clients and viewers browse the accepted version only");
    const f = this.fileEntry(q, pid);
    return typeof f === "string" ? new Blob([f], { type: "text/plain" }) : new Blob([f.body ?? "(binary content not included in fixture mode)"], { type: f.mime });
  }

  // ----------------------------------------------------------------------------- resources

  async getResource(org: string, rid: string): Promise<ResourceDetail> {
    this.log("getResource", org, rid);
    this.org(org);
    const r = this.resources.get(rid);
    if (!r) throw new ApiError(404, "not_found", "resource not found");
    const mount = [...this.mounts, ...this.handoverMounts].find((m) => m.resourceId === rid);
    const base: ResourceDetail = {
      resourceId: rid,
      name: r.name,
      provider: r.provider,
      state: r.state ?? "active",
      ...(r.error ? { error: r.error } : {}),
      branch: "main",
      createdAt: new Date(this.t0 - 2 * 86_400_000).toISOString(),
      updatedAt: r.headAt,
      head: r.head ? { resourceId: rid, revisionId: r.head, versionSeq: r.headSeq, acceptedVersionId: r.headVersionId, acceptedAt: r.headAt, reconciliation: "synced" } : null,
      operations: this.isDev() ? (mount?.operations ?? ["read", "write"]) : ["read"],
    };
    if (!this.isDev()) return base;
    const coords =
      r.provider === "artifacts"
        ? { kind: "artifacts", namespace: `commonforge-dev-${FIXTURE_ORG}-canonical`, repoId: r.repoId, remoteUrl: `https://artifacts.example/commonforge-dev-${FIXTURE_ORG}-canonical/${r.repoId}.git`, branch: "main" }
        : { kind: "r2-assets", bucket: "commonforge-assets-dev", prefix: `org/${FIXTURE_ORG}/res/${rid}/` };
    const source = r.source ?? (rid === CONCEPT ? { kind: "git-import", url: "https://github.com/example-agency/quote-builder-concept", branch: "main", historyTruncated: true } : rid === BRAND ? { kind: "zip-upload", archive: "brand-kit-2026.zip" } : { kind: "git-import", url: `https://github.com/example-agency/portal-${r.repoId}`, branch: "main" });
    return { ...base, coords, source };
  }

  async listVersions(org: string, rid: string): Promise<VersionEntry[]> {
    this.log("listVersions", org, rid);
    this.org(org);
    const r = this.resources.get(rid);
    if (!r) throw new ApiError(404, "not_found", "resource not found");
    const out: VersionEntry[] = this.versions
      .filter((v) => v.heads.some((h) => h.resourceId === rid))
      .map((v) => {
        const { actor, ...rest } = v.v;
        return { ...rest, ...(this.isDev() && actor ? { actor } : {}), head: v.heads.find((h) => h.resourceId === rid) };
      })
      .reverse();
    return out;
  }

  async restore(org: string, rid: string, body: { expectedHead: string; targetRevision: string; idempotencyKey: string }) {
    this.log("restore", org, rid, body);
    this.org(org);
    this.needDev();
    const replay = this.replay(body.idempotencyKey, JSON.stringify({ rid, ...body, idempotencyKey: undefined }));
    if (replay) return { ...(replay as { resourceId: string; acceptedVersionId: string; headRevisionId: string }), replayed: true };
    const r = this.resources.get(rid);
    if (!r) throw new ApiError(404, "not_found", "resource not found");
    if (r.head !== body.expectedHead) throw new ApiError(409, "expected_head_stale", "the head moved", { resourceId: rid });
    if (!r.revisions.has(body.targetRevision)) throw new ApiError(409, "restore_target_unknown", "that revision was never accepted");
    if (body.targetRevision === r.head) throw new ApiError(409, "restore_noop", "that revision is already the head");
    const v = this.commitVersion("restore", null, null, [{ resourceId: rid, revisionId: body.targetRevision }]);
    this.event(this.nowIso(), "resource.restored", "resource", rid, { kind: "user", id: `u-${this.role}` }, { targetRevision: body.targetRevision, acceptedVersionId: v }, undefined, true);
    const result = { resourceId: rid, acceptedVersionId: v, headRevisionId: body.targetRevision };
    this.idem.set(body.idempotencyKey, { req: JSON.stringify({ rid, ...body, idempotencyKey: undefined }), result });
    return { ...result, replayed: false };
  }

  private replay(key: string, req: string): unknown {
    const hit = this.idem.get(key);
    if (!hit) return null;
    if (hit.req !== req) throw new ApiError(409, "idempotency_key_conflict", "this key was used for a different request");
    return hit.result;
  }

  private commitVersion(kind: "accept" | "restore", proposalId: string | null, proposalHash: string | null, heads: Array<{ resourceId: string; revisionId: string }>, actor: { kind: string; id: string } = { kind: "user", id: `u-${this.role}` }) {
    const acceptedVersionId = `av-${fakeHex(`${kind}-${++this.versionSeq}-${this.now()}`, 16)}`;
    const at = this.nowIso();
    for (const h of heads) {
      const r = this.resources.get(h.resourceId)!;
      r.head = h.revisionId;
      r.headSeq++;
      r.headVersionId = acceptedVersionId;
      r.headAt = at;
    }
    this.versions.push({ v: { acceptedVersionId, sequence: this.versionSeq, kind, proposalId, proposalHash, acceptedAt: at, actor }, heads });
    return acceptedVersionId;
  }

  // ------------------------------------------------------------------------- tasks, proposals

  async listTasks(org: string, pid: string) {
    this.log("listTasks", org, pid);
    this.project(org, pid);
    // staging mode: a client lists the tasks they created (Worker `routes/tasks.ts`)
    if (this.role === "client" && this.stagingMode(pid)) {
      this.stagingTick();
      return this.tasks.filter((t) => this.creatorOf(t.taskId) === this.actingUser()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).map((t) => ({ ...t }));
    }
    this.needDev();
    if (pid !== FIXTURE_PROJECT) return [];
    this.stagingTick();
    return this.tasks.map((t) => ({ ...t }));
  }

  async listProposals(org: string, pid: string): Promise<ProposalSummary[]> {
    this.log("listProposals", org, pid);
    this.project(org, pid);
    this.stagingTick();
    if (pid !== FIXTURE_PROJECT) return [];
    return [...this.proposals.values()]
      .map((fp) => {
        this.tick(fp);
        return { proposalId: fp.p.proposalId, proposalHash: fp.p.proposalHash, projectId: fp.p.projectId, changeId: fp.p.changeId, kind: fp.kind ?? null, state: fp.p.state, createdAt: fp.p.createdAt, updatedAt: fp.p.updatedAt };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getProposal(org: string, id: string) {
    this.log("getProposal", org, id);
    this.stagingTick();
    return this.present(this.fp(org, id));
  }

  async integrate(org: string, id: string) {
    this.log("integrate", org, id);
    this.needDev();
    const fp = this.fp(org, id);
    if (fp.p.state !== "prepared") throw new ApiError(409, "proposal_not_prepared", "every candidate must be prepared first");
    const stale = this.present(fp).stale;
    if (stale.length) throw new ApiError(409, "expected_head_stale", "a base is no longer the head", { resourceId: stale[0] });
    const jobId = `job-${fakeHex(`${id}-${this.now()}`, 24)}`;
    if (fp.p.resourceChanges.length === 0 && fp.p.assetManifestChanges.length === 0) throw new ApiError(409, "nothing_to_integrate", "the proposal changes nothing");
    fp.integratingSince = this.now();
    fp.integratingJob = jobId;
    fp.lastAttempt = { state: "queued", expired: false, forCurrentHash: true, requestedAt: this.nowIso(), completedAt: null, code: null, checks: [], contractChecks: [], mergeOutcome: [], conflictPaths: [], signedEvidence: false, jobId };
    this.event(this.nowIso(), "proposal.integration_requested", "proposal", id, { kind: "user", id: `u-${this.role}` }, { jobId });
    return { proposalId: id, jobId, state: "queued" };
  }

  /** Worker `assertUserAcceptable`: a promotion proposal is approved and accepted only through its promotion. */
  private userAcceptable(fp: FakeProposal) {
    if (fp.kind === "promotion") throw new ApiError(409, "promotion_proposal", "a promotion proposal is approved and accepted only through its promotion");
  }

  async approve(org: string, id: string, proposalHash: string): Promise<ApprovalView> {
    this.log("approve", org, id, proposalHash);
    const fp = this.fp(org, id);
    this.userAcceptable(fp);
    // as the worker: the project's policy names who may approve (unset: owner, developer, client)
    const allowed: Role[] = fp.p.projectId === FIXTURE_PROJECT ? (this.policy.approvalRoles ?? ["owner", "developer", "client"]) : ["owner", "developer", "client"];
    if (!allowed.includes(this.role)) throw new ApiError(403, "approval_role_not_allowed", `this project accepts approvals from: ${allowed.join(", ")}`);
    if (proposalHash !== fp.p.proposalHash) throw new ApiError(409, "proposal_hash_mismatch", "the proposal changed since you loaded it", { currentHash: fp.p.proposalHash });
    const a: ApprovalView = { approvalId: `apr-${fakeHex(`${id}-${fp.approvals.length}-${this.now()}`, 16)}`, role: this.role, approvedAt: this.nowIso(), proposalHash, approver: { kind: "user", id: `u-${this.role}` } };
    fp.approvals.push(a);
    this.event(a.approvedAt, "proposal.approved", "proposal", id, { kind: "user", id: `u-${this.role}` }, { role: this.role, proposalHash }, undefined, true);
    return a;
  }

  async accept(org: string, id: string, idempotencyKey: string): Promise<AcceptResult> {
    this.log("accept", org, id, idempotencyKey);
    this.needDev();
    const fp = this.fp(org, id);
    this.userAcceptable(fp);
    const replay = this.replay(idempotencyKey, id);
    if (replay) return { ...(replay as AcceptResult), replayed: true };
    const view = this.present(fp);
    const blockers = acceptBlockers(view);
    if (blockers.length) {
      const code = view.stale.length ? "expected_head_stale" : !view.integration ? "evidence_missing" : view.approvals.length === 0 ? "approval_invalid" : "evidence_missing";
      throw new ApiError(409, code, blockers.join("; "));
    }
    const heads = [
      ...fp.p.resourceChanges.map((rc) => ({ resourceId: rc.resourceId, revisionId: rc.candidateRevision })),
      ...fp.p.assetManifestChanges.map((ac) => ({ resourceId: ac.resourceId, revisionId: `r2m:${ac.newManifestId}` })),
    ];
    const acceptedVersionId = this.commitVersion("accept", id, fp.p.proposalHash, heads);
    fp.p.state = "accepted";
    this.event(this.nowIso(), "proposal.accepted", "proposal", id, { kind: "user", id: `u-${this.role}` }, { acceptedVersionId, proposalHash: fp.p.proposalHash }, undefined, true);
    // a file change waiting for approval lands with its proposal
    for (const fc of this.fileChanges.values()) if (fc.v.proposalId === id && fc.v.state === "waiting_approval") this.changeAdded(fc);
    const result = { proposalId: id, acceptedVersionId, replayed: false };
    this.idem.set(idempotencyKey, { req: id, result });
    return result;
  }

  // ---------------------------------------------------------------- previews, releases (Task 22)

  async listPreviews(org: string, proposalId: string): Promise<PreviewView[]> {
    this.log("listPreviews", org, proposalId);
    const fp = this.fp(org, proposalId);
    return (this.previews.get(proposalId) ?? [])
      .map(({ v, readyAt }) => {
        if (v.state === "queued" && this.now() >= readyAt) {
          v.state = "ready";
          v.expiresAt = new Date(readyAt + 3_600_000).toISOString();
          v.url = `https://preview.fixture.invalid/p/${org}/${v.previewId}/fixture-token/`;
        }
        return { ...v, forCurrentHash: v.proposalHash === fp.p.proposalHash };
      })
      .reverse();
  }

  async requestPreview(org: string, proposalId: string): Promise<PreviewView> {
    this.log("requestPreview", org, proposalId);
    this.needDev();
    const fp = this.present(this.fp(org, proposalId));
    if (!fp.integration) throw new ApiError(409, "integration_required", "preview the integrated result: run integration first");
    const list = this.previews.get(proposalId) ?? [];
    const v: PreviewView = { previewId: `pv-${fakeHex(`${proposalId}-${list.length}-${this.now()}`, 24)}`, proposalId, proposalHash: fp.proposalHash, state: "queued", createdAt: this.nowIso(), updatedAt: this.nowIso(), expiresAt: null, url: null, error: null };
    list.push({ v, readyAt: this.now() + this.integrationMs });
    this.previews.set(proposalId, list);
    this.event(this.nowIso(), "preview.requested", "proposal", proposalId, { kind: "user", id: `u-${this.role}` }, { previewId: v.previewId }, { previewId: v.previewId });
    return { ...v };
  }

  private releaseTick(r: (typeof this.releases)[number]) {
    const now = this.now();
    if (r.v.buildState === "building" && now >= r.builtAt) {
      r.v.buildState = "built";
      r.v.state = "prepared";
      r.v.outputDigest = fakeHex(`out-${r.v.releaseId}`, 64);
    }
    if (r.v.state === "deploying" && r.willFail && r.deployAt !== null && now >= r.deployAt) {
      r.willFail = false;
      r.v.state = "failed";
      r.v.error = { code: "deploy_failed" };
    }
    if ((r.v.state === "deploying" || r.v.state === "health_verification") && r.deployAt !== null && now >= r.deployAt) {
      r.v.state = "live";
      r.v.deployments = [
        { targetId: "api", workerName: "cfapp-o-fixture-api", url: "https://cfapp-o-fixture-api.fixture.invalid" },
        { targetId: "website", workerName: "cfapp-o-fixture-website", url: "https://cfapp-o-fixture-website.fixture.invalid" },
      ];
      r.v.health = { ok: true, checkedAt: new Date(now).toISOString(), targets: [{ targetId: "api", ok: true }, { targetId: "website", ok: true }] };
      this.liveRelease = r.v.releaseId;
    }
    r.v.live = this.liveRelease === r.v.releaseId;
    r.v.publishApproved = r.approved;
    r.v.status = r.v.live ? "Live" : r.v.buildState === "building" ? "Building" : r.v.state === "prepared" ? "Ready for publish approval" : r.v.state === "deploying" ? "Deploying" : r.approved ? "Approved, not live" : "Not live";
  }

  async listReleases(org: string, pid: string): Promise<ReleaseList> {
    this.log("listReleases", org, pid);
    this.project(org, pid);
    if (pid !== FIXTURE_PROJECT) return { releases: [], live: null };
    for (const r of this.releases) this.releaseTick(r);
    const live = this.releases.find((r) => r.v.releaseId === this.liveRelease);
    return {
      releases: this.releases.map((r) => ({ ...r.v })).reverse(),
      live: live ? { releaseId: live.v.releaseId, acceptedVersionId: live.v.acceptedVersionId, outputDigest: live.v.outputDigest!, since: live.v.updatedAt } : null,
    };
  }

  async prepareRelease(org: string, pid: string, wanted?: string): Promise<ReleaseView> {
    this.log("prepareRelease", org, pid, wanted);
    this.project(org, pid);
    this.needDev();
    if (pid !== FIXTURE_PROJECT) throw new ApiError(409, "release_not_configured", "this project has no release recipe");
    // like the Worker: the release names the latest accepted version touching its (git) sources
    const acceptedVersionId = [...this.versions].reverse().find((v) => v.heads.some((h) => RELEASE_SOURCES.includes(h.resourceId)))!.v.acceptedVersionId;
    if (wanted !== undefined && wanted !== acceptedVersionId) throw new ApiError(409, "accepted_version_stale", "a newer version was accepted; prepare a release of the current version", { currentAcceptedVersionId: acceptedVersionId });
    const existing = this.releases.find((r) => r.v.acceptedVersionId === acceptedVersionId && r.v.buildState !== "failed");
    if (existing) return { ...existing.v };
    const releaseId = `rel-${fakeHex(`rel-${acceptedVersionId}-${this.releases.length}`, 24)}`;
    const v: ReleaseView = { releaseId, projectId: pid, acceptedVersionId, recipeRevision: 1, envDigest: fakeHex(`env-${pid}`, 64), outputDigest: null, state: "not_requested", buildState: "building", status: "Building", live: false, publishApproved: false, deployAttempts: 0, createdAt: this.nowIso(), updatedAt: this.nowIso(), error: null, deployments: [], health: null };
    this.releases.push({ v, builtAt: this.now() + 1500, deployAt: null, approved: false });
    this.event(this.nowIso(), "release.prepare_requested", "release", releaseId, { kind: "user", id: `u-${this.role}` }, { acceptedVersionId, channel: "production" }, { channel: "production" });
    return { ...v };
  }

  private release(id: string) {
    const r = this.releases.find((x) => x.v.releaseId === id);
    if (!r) throw new ApiError(404, "not_found", "release not found");
    this.releaseTick(r);
    return r;
  }

  async approvePublish(org: string, releaseId: string, outputDigest: string) {
    this.log("approvePublish", org, releaseId, outputDigest);
    this.org(org);
    if (this.role !== "owner") throw new ApiError(403, "publish_role_not_allowed", "publishing needs approval from: owner");
    const r = this.release(releaseId);
    if (r.v.outputDigest !== outputDigest) throw new ApiError(409, "output_digest_mismatch", "the release output differs from what you reviewed");
    r.approved = true;
    if (r.v.state === "prepared") r.v.state = "publish_approved";
    this.releaseTick(r);
    this.event(this.nowIso(), "release.publish_approved", "release", releaseId, { kind: "user", id: `u-${this.role}` }, { outputDigest, channel: "production" }, { role: this.role, channel: "production" });
    return { approvalId: `pub-${fakeHex(releaseId, 20)}` };
  }

  async deployRelease(org: string, releaseId: string, idempotencyKey: string) {
    this.log("deployRelease", org, releaseId, idempotencyKey);
    this.org(org);
    this.needDev();
    const prior = this.deployKeys.get(idempotencyKey);
    if (prior) return { ...prior, replayed: true };
    const r = this.release(releaseId);
    if (!r.approved) throw new ApiError(409, "publish_approval_required", "publishing needs a publish approval for exactly this release output");
    r.v.state = "deploying";
    r.v.deployAttempts += 1;
    r.willFail = this.failNextDeploy;
    this.failNextDeploy = false;
    r.deployAt = this.now() + 1500;
    this.releaseTick(r);
    this.deployKeys.set(idempotencyKey, { releaseId, attempt: r.v.deployAttempts });
    this.event(this.nowIso(), "release.deploy_requested", "release", releaseId, { kind: "user", id: `u-${this.role}` }, { attempt: r.v.deployAttempts, channel: "production" }, { attempt: r.v.deployAttempts, channel: "production" });
    return { releaseId, attempt: r.v.deployAttempts, replayed: false };
  }

  async recoverRelease(org: string, releaseId: string, note: string): Promise<ReleaseView> {
    this.log("recoverRelease", org, releaseId, note);
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "owners only");
    const r = this.release(releaseId);
    if (r.v.state !== "recovery_required" && r.v.state !== "partial") throw new ApiError(409, "not_recoverable", "only a release needing recovery can be marked recovered");
    r.v.state = "failed";
    r.v.error = { code: "recovered_by_owner" };
    this.releaseTick(r);
    return { ...r.v };
  }

  // ------------------------------------------------------------------------- export, events

  async startExport(org: string, pid: string) {
    this.log("startExport", org, pid);
    this.project(org, pid);
    this.needDev();
    if (pid !== FIXTURE_PROJECT) throw new ApiError(409, "nothing_to_export", "there is nothing to export yet");
    const exportId = `exp-${fakeHex(`exp-${this.now()}-${this.exports.size}`, 16)}`;
    this.exports.set(exportId, { startedAt: this.now() });
    this.event(this.nowIso(), "export.requested", "export", exportId, { kind: "user", id: `u-${this.role}` });
    return { exportId, snapshotId: (await this.getSnapshot(org, pid)).snapshotId, jobId: `job-${fakeHex(exportId, 24)}`, state: "queued" };
  }

  async getExport(org: string, id: string): Promise<ExportStatus> {
    this.log("getExport", org, id);
    this.org(org);
    const e = this.exports.get(id);
    if (!e) throw new ApiError(404, "not_found", "export not found");
    const done = this.now() - e.startedAt >= 1500;
    const items = done ? this.mounts.map((m) => ({ r2Key: `org/${org}/exports/${id}/${m.mountName}.${m.provider === "artifacts" ? "bundle" : "manifest.json"}` })) : [];
    return {
      exportId: id,
      projectId: FIXTURE_PROJECT,
      state: done ? "succeeded" : "queued",
      snapshot: null,
      receipt: done ? { items } : null,
      downloads: items.map((i) => `data:text/plain;charset=utf-8,${encodeURIComponent(`fixture export item ${i.r2Key}`)}`),
    };
  }

  async listEvents(org: string, q: { projectId?: string; after?: number; limit?: number }) {
    this.log("listEvents", org, q);
    this.org(org);
    // projects created at runtime (and other organizations) have no recorded history
    if (org !== FIXTURE_ORG || (q.projectId !== undefined && this.newProjects.has(q.projectId))) return { events: [], next: q.after ?? 0 };
    for (const fp of this.proposals.values()) this.tick(fp);
    this.stagingTick();
    const after = q.after ?? 0;
    const limit = q.limit ?? 100;
    const dev = this.isDev();
    const handover = q.projectId === FIXTURE_EMPTY_PROJECT;
    const visible = this.events.filter((e) => e.seq > after && (dev || e.clientVisible) && (!e.ownerOnly || this.role === "owner") && (q.projectId === undefined || (e.projectId !== null && !!e.handover === handover)));
    const page = visible.slice(0, limit).map(({ clientVisible: _v, handover: _h, ownerOnly: _o, clientDetail, detail, ...e }): EventView => (dev ? { ...e, ...(detail ? { detail } : {}) } : { ...e, actor: { kind: e.actor.kind }, ...(clientDetail ? { detail: clientDetail } : {}) }));
    return { events: page, next: page.length ? page[page.length - 1]!.seq : after };
  }

  // ------------------------------------------------------------------------- client editions

  /** The fixture's published website edition, granted to the client (seeded on first use). */
  private seedEditions() {
    if (this.editions.size) return;
    const policy: EditionPolicyInput & { exclude: string[] } = {
      name: "Website pages",
      sources: [{ mountName: "website", include: ["src/**", "README.md", "package.json"], write: ["src"] }],
      exclude: ["**/.env*"],
      protectedPaths: ["package.json", "tests/quote.contract.test.ts"],
    };
    const at = new Date(this.t0 - 50 * 60_000).toISOString();
    this.editions.set("edn-0f1c7a2e00000001", {
      editionId: "edn-0f1c7a2e00000001",
      projectId: FIXTURE_PROJECT,
      name: policy.name,
      state: "ready",
      ready: true,
      policyRevision: 1,
      files: 5,
      editable: ["src"],
      protected: policy.protectedPaths,
      readOnly: false,
      builtAt: at,
      canStartUpdate: true,
      policy,
      canManage: true,
      builds: [{ buildId: "edb-0f1c7a2e00000001", state: "ready", policyRevision: 1, sourceReleaseId: null, canonicalBases: [{ resourceId: WEBSITE, revisionId: ART("website", "w0") }], files: 5, createdAt: at }],
      grants: new Set(["u-client"]),
    });
  }

  private edition(org: string, eid: string) {
    this.org(org);
    this.seedEditions();
    const e = this.editions.get(eid);
    if (!e || (!this.isDev() && !e.grants.has(`u-${this.role}`))) throw new ApiError(404, "not_found", "edition not found");
    return e;
  }

  private editionView(e: EditionView & { grants: Set<string> }): EditionView {
    const { grants: _g, policy, canManage, builds, ...rest } = e;
    return this.isDev() ? { ...rest, policy: policy!, canManage: canManage!, builds: builds! } : { ...rest, canStartUpdate: e.grants.has(`u-${this.role}`) && e.ready };
  }

  async listEditions(org: string, pid: string) {
    this.log("listEditions", org, pid);
    this.project(org, pid);
    if (pid !== FIXTURE_PROJECT) return [];
    this.seedEditions();
    return [...this.editions.values()].filter((e) => this.isDev() || e.grants.has(`u-${this.role}`)).map((e) => this.editionView(e));
  }

  async getEdition(org: string, eid: string) {
    this.log("getEdition", org, eid);
    return this.editionView(this.edition(org, eid));
  }

  async createEdition(org: string, pid: string, policy: EditionPolicyInput) {
    this.log("createEdition", org, pid, policy);
    this.project(org, pid);
    this.needDev();
    if (pid !== FIXTURE_PROJECT) throw new ApiError(409, "edition_unavailable", "this project has no published files yet");
    this.seedEditions();
    const editionId = `edn-${fakeHex(`${policy.name}-${this.now()}`, 16)}`;
    const writable = policy.sources.find((x) => x.write.length);
    this.editions.set(editionId, {
      editionId,
      projectId: pid,
      name: policy.name,
      state: "draft",
      ready: false,
      policyRevision: 1,
      files: 0,
      editable: writable?.write ?? [],
      protected: policy.protectedPaths,
      readOnly: !writable,
      builtAt: null,
      canStartUpdate: false,
      policy: { ...policy, exclude: policy.exclude ?? ["**/.env*"] },
      canManage: true,
      builds: [],
      grants: new Set(),
    });
    return this.editionView(this.editions.get(editionId)!);
  }

  async updateEditionPolicy(org: string, eid: string, policy: EditionPolicyInput) {
    this.log("updateEditionPolicy", org, eid, policy);
    this.needDev();
    const e = this.edition(org, eid);
    e.policy = { ...policy, exclude: policy.exclude ?? ["**/.env*"] };
    e.policyRevision += 1;
    e.editable = policy.sources.find((x) => x.write.length)?.write ?? [];
    e.protected = policy.protectedPaths;
    return this.editionView(e);
  }

  async buildEdition(org: string, eid: string) {
    this.log("buildEdition", org, eid);
    this.needDev();
    const e = this.edition(org, eid);
    const buildId = `edb-${fakeHex(`${eid}-${this.now()}`, 16)}`;
    e.builds = [{ buildId, state: "ready", policyRevision: e.policyRevision, sourceReleaseId: null, canonicalBases: [{ resourceId: WEBSITE, revisionId: ART("website", "w0") }], files: 5, createdAt: this.nowIso() }, ...(e.builds ?? [])];
    Object.assign(e, { state: "ready", ready: true, files: 5, builtAt: this.nowIso() });
    return { buildId, state: "queued" };
  }

  async grantEdition(org: string, eid: string, userId: string) {
    this.log("grantEdition", org, eid, userId);
    this.needDev();
    this.edition(org, eid).grants.add(userId);
  }

  private memberList(org: string): MemberView[] {
    if (org !== FIXTURE_ORG && !this.extraOrgs.some((o) => o.orgId === org)) throw new ApiError(404, "not_found", "organization not found");
    let list = this.members.get(org);
    if (!list) this.members.set(org, (list = [{ userId: `u-${this.role}`, email: "owner@agency.example", role: "owner", since: new Date(this.now()).toISOString() }]));
    return list;
  }

  private needOwner() {
    if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "requires one of: owner");
  }

  async listMembers(org: string): Promise<MemberView[]> {
    this.log("listMembers", org);
    this.needDev();
    return this.memberList(org).map((m) => ({ ...m }));
  }

  async getDeployResources(org: string): Promise<DeployResources> {
    this.log("getDeployResources", org);
    this.memberList(org);
    this.needDev();
    // the Worker: `<COMMONFORGE_DEPLOY_WORKER_PREFIX>-<orgId>-` (default prefix cfapp); the fixture creates no KV/D1
    return { workerPrefix: `cfapp-${org}-`, resources: [] };
  }

  async createOrg(name: string) {
    this.log("createOrg", name);
    if (!this.canCreate()) throw new ApiError(403, "org_create_forbidden", "only the agency's instance admins create organizations");
    const orgId = `o-${(0xa0000 + this.extraOrgs.length + 1).toString(16).padStart(12, "0")}`;
    this.extraOrgs.push({ orgId, name: name.trim(), role: "owner" });
    return { orgId, name: name.trim(), role: "owner" as Role };
  }

  async inviteMember(org: string, body: { email: string; role: Role }): Promise<InviteResult> {
    this.log("inviteMember", org, body);
    this.needOwner();
    const list = this.memberList(org);
    const email = body.email.trim().toLowerCase();
    if (list.some((m) => m.email === email)) throw new ApiError(409, "already_member", "already a member; use PATCH to change the role");
    const m: MemberView = { userId: `u-${email.replace(/[^a-z0-9]/g, "")}`, email, role: body.role, since: new Date(this.now()).toISOString() };
    list.push(m);
    return { ...m, invite: "sent" };
  }

  private levelOf(ops: readonly string[] | undefined): AccessLevel {
    return ops?.includes("write") ? "write" : ops?.includes("read") ? "read" : "none";
  }

  /**
   * resource → the floor: the highest of what the person's OTHER projects give a folder they also
   * mount, each capped by role and never above what they hold now (worker: floorsOf + lower);
   * `via` is the project that gives it
   */
  private folderFloors(userId: string, role: Role, pid: string): Map<string, { level: AccessLevel; via: string }> {
    const rank = { none: 0, read: 1, write: 2 } as const;
    // viewers never write; a client's write is "Can change" (worker: capped)
    const cap = (l: AccessLevel): AccessLevel => (l === "write" && role === "viewer" ? "read" : l);
    const out = new Map<string, { level: AccessLevel; via: string }>();
    for (const other of this.allProjects()) {
      if (other === pid) continue;
      const given = cap(this.levelOf(this.grants.get(`${userId}|project|${other}`)));
      if (given === "none") continue;
      for (const mt of this.mountsOf(other)) {
        const held = cap(this.levelOf(this.grants.get(`${userId}|resource|${mt.resourceId}`)));
        const floor = rank[given] < rank[held] ? given : held;
        if (floor !== "none" && rank[floor] > rank[out.get(mt.resourceId)?.level ?? "none"]) out.set(mt.resourceId, { level: floor, via: other });
      }
    }
    return out;
  }

  async getProjectAccess(org: string, pid: string): Promise<PersonAccess[]> {
    this.log("getProjectAccess", org, pid);
    this.project(org, pid);
    this.needDev();
    const rank = { none: 0, read: 1, write: 2 } as const;
    const cap = (l: AccessLevel, role: Role): AccessLevel => (l === "write" && role === "viewer" ? "read" : l);
    // a developer sees only the folders they can read themselves, for every person (worker: projectAccess with the caller)
    const me = `u-${this.role}`;
    const mounts = this.mountsOf(pid).filter((mt) => this.role === "owner" || this.grants.get(`${me}|resource|${mt.resourceId}`)?.includes("read"));
    return [...this.memberList(org)]
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
      .map((m) => {
        const owner = m.role === "owner";
        const level = owner ? "write" : cap(this.levelOf(this.grants.get(`${m.userId}|project|${pid}`)), m.role);
        const floors = owner || level === "none" ? new Map<string, { level: AccessLevel; via: string }>() : this.folderFloors(m.userId, m.role, pid);
        return {
          userId: m.userId,
          email: m.email,
          role: m.role,
          level,
          folders: mounts.map((mt) => {
            const fl: AccessLevel = owner ? "write" : level === "none" ? "none" : cap(this.levelOf(this.grants.get(`${m.userId}|resource|${mt.resourceId}`)), m.role);
            const f = floors.get(mt.resourceId);
            const floor = f?.level;
            const shared = floor !== undefined && rank[floor] > rank[level];
            const visible = f !== undefined && (this.role === "owner" || this.grants.has(`${me}|project|${f.via}`));
            return { mountName: mt.mountName, resourceId: mt.resourceId, level: fl, ...(mt.operations.includes("write") ? {} : { readOnly: true as const }), ...(floor ? { min: floor } : {}), ...(shared ? { shared: true as const } : {}), ...(shared && visible ? { via: this.projectName(f.via) } : {}) };
          }),
        };
      });
  }

  async putProjectAccess(org: string, pid: string, body: { userId: string; level: AccessLevel; folders?: Record<string, AccessLevel> }): Promise<PersonAccess> {
    this.log("putProjectAccess", org, pid, body);
    this.project(org, pid);
    this.needDev();
    const rank = { none: 0, read: 1, write: 2 } as const;
    const m = this.memberList(org).find((x) => x.userId === body.userId);
    if (!m) throw new ApiError(404, "not_found", "member not found");
    if (m.role === "owner") throw new ApiError(400, "owner_access_implicit", "owners already have access to every project");
    if (body.level === "write" && m.role !== "developer" && m.role !== "client") throw new ApiError(400, "grant_exceeds_role", `a ${m.role} can only hold read access`);
    const mounts = this.mountsOf(pid);
    const ex = body.folders ?? {};
    for (const [rid, l] of Object.entries(ex)) {
      if (!mounts.some((mt) => mt.resourceId === rid)) throw new ApiError(400, "unknown_folder", `${rid} is not a folder of this project`);
      if (rank[l] > rank[body.level]) throw new ApiError(400, "folder_exceeds_project", "a folder cannot have more access than its project");
    }
    const key = (kind: string, id: string) => `${body.userId}|${kind}|${id}`;
    if (this.role !== "owner") {
      const holdsWrite = [key("project", pid), ...mounts.map((mt) => key("resource", mt.resourceId))].some((k) => this.grants.get(k)?.includes("write"));
      if (body.level !== "read" || Object.keys(ex).length || this.grants.has(key("project", pid)) || holdsWrite) throw new ApiError(403, "grant_owner_only", "developers can only give read access to someone who has none");
    }
    const ops = (l: AccessLevel): Operation[] => (l === "write" ? ["read", "write"] : l === "read" ? ["read"] : []);
    const set = (k: string, l: AccessLevel) => (l === "none" ? this.grants.delete(k) : this.grants.set(k, ops(l)));
    const hadProject = this.grants.has(key("project", pid));
    // shared folders: never below their floor (what the other project gives, never above what they hold)
    const floors = this.folderFloors(body.userId, m.role, pid);
    set(key("project", pid), body.level);
    const me = `u-${this.role}`;
    for (const mt of mounts) {
      const wanted: AccessLevel = body.level === "none" ? "none" : (ex[mt.resourceId] ?? body.level);
      // a client's Can change only where this project lets the folder be changed (worker: setProjectAccess)
      const desired: AccessLevel = m.role === "client" && wanted === "write" && !mt.operations.includes("write") ? "read" : wanted;
      const floor = floors.get(mt.resourceId)?.level ?? "none";
      let target: AccessLevel = rank[floor] > rank[desired] ? floor : desired;
      if (this.role !== "owner") {
        // developers grant only what they can read themselves, and never write
        if (!this.grants.get(`${me}|resource|${mt.resourceId}`)?.includes("read")) continue;
        if (target === "write") target = "read";
      }
      set(key("resource", mt.resourceId), target);
    }
    // a real move to none also ends the person's grants on the project's editions (worker: projectEditionGrantsDelete)
    if (body.level === "none" && hadProject) {
      this.seedEditions();
      for (const e of this.editions.values()) if (e.projectId === pid) e.grants.delete(body.userId);
    }
    return (await this.getProjectAccess(org, pid)).find((p) => p.userId === body.userId)!;
  }

  /** a folder attached to a project goes to its people (worker: grantFolderToProjectPeople) */
  private grantFolderToProjectPeople(pid: string, resourceId: string) {
    for (const [k, ops] of [...this.grants]) {
      const [userId, kind, id] = k.split("|");
      if (kind !== "project" || id !== pid) continue;
      const role = this.memberList(FIXTURE_ORG).find((m) => m.userId === userId)?.role;
      if (!role || role === "owner") continue;
      const writable = this.mountsOf(pid).find((x) => x.resourceId === resourceId)?.operations.includes("write") ?? true;
      const want: Operation[] = ops.includes("write") && (role === "developer" || (role === "client" && writable)) ? ["read", "write"] : ["read"];
      const rk = `${userId}|resource|${resourceId}`;
      this.grants.set(rk, [...new Set([...(this.grants.get(rk) ?? []), ...want])].sort() as Operation[]);
    }
  }

  /**
   * a folder detached from a project (call after removing the mount): for each non-owner who holds
   * the project, the folder level becomes lower(floor from the projects still mounting it — another
   * mount in this same project counts too —, current), or the grant goes (worker: planFolderRemoval).
   * Returns the users whose access changed.
   */
  private removeFolderFromProjectPeople(pid: string, resourceId: string): string[] {
    const rank = { none: 0, read: 1, write: 2 } as const;
    const ops = (l: AccessLevel): Operation[] => (l === "write" ? ["read", "write"] : l === "read" ? ["read"] : []);
    const changed: string[] = [];
    for (const m of this.memberList(FIXTURE_ORG)) {
      if (m.role === "owner" || !this.grants.has(`${m.userId}|project|${pid}`)) continue;
      const cap = (l: AccessLevel): AccessLevel => (l === "write" && m.role === "viewer" ? "read" : l);
      const rk = `${m.userId}|resource|${resourceId}`;
      const prev = this.grants.get(rk);
      if (!prev?.length) continue;
      let floor: AccessLevel = "none";
      for (const other of this.allProjects()) {
        if (!this.mountsOf(other).some((x) => x.resourceId === resourceId)) continue;
        const l = cap(this.levelOf(this.grants.get(`${m.userId}|project|${other}`)));
        if (rank[l] > rank[floor]) floor = l;
      }
      const current = cap(this.levelOf(prev));
      const target = rank[floor] < rank[current] ? floor : current;
      const next = ops(target);
      if (prev.length === next.length && prev.every((x) => next.includes(x))) continue;
      if (next.length) this.grants.set(rk, next);
      else this.grants.delete(rk);
      changed.push(m.userId);
    }
    return changed;
  }

  async resendInvite(org: string, userId: string) {
    this.log("resendInvite", org, userId);
    this.needOwner();
    if (!this.memberList(org).some((m) => m.userId === userId)) throw new ApiError(404, "not_found", "member not found");
  }

  async updateMemberRole(org: string, userId: string, role: Role) {
    this.log("updateMemberRole", org, userId, role);
    this.needOwner();
    const list = this.memberList(org);
    const m = list.find((x) => x.userId === userId);
    if (!m) throw new ApiError(404, "not_found", "member not found");
    if (m.role === "owner" && role !== "owner" && list.filter((x) => x.role === "owner").length <= 1) throw new ApiError(409, "last_owner", "an organization needs at least one owner");
    m.role = role;
  }

  async removeMember(org: string, userId: string) {
    this.log("removeMember", org, userId);
    this.needOwner();
    const list = this.memberList(org);
    const i = list.findIndex((x) => x.userId === userId);
    if (i < 0) throw new ApiError(404, "not_found", "member not found");
    if (list[i]!.role === "owner" && list.filter((x) => x.role === "owner").length <= 1) throw new ApiError(409, "last_owner", "an organization needs at least one owner");
    list.splice(i, 1);
  }

  private session(org: string, sid: string): EditionSession {
    this.org(org);
    const s = this.updates.get(sid);
    if (!s || (s.owner !== `u-${this.role}` && !this.isDev())) throw new ApiError(404, "not_found", "session not found");
    const returns: EditionReturn[] = [];
    for (const [returnId, r] of this.updateReturns) {
      if (r.sessionId !== sid) continue;
      const done = this.now() - r.at >= 2000;
      returns.unshift({
        returnId,
        sessionId: sid,
        state: done ? "proposed" : "running",
        mode: r.mode,
        changes: [{ path: "src/quote.ts", kind: "modified" }],
        blocked: [{ path: "package.json", reason: "protected" }],
        keptAsIs: 4,
        ignored: [],
        strippedFolder: null,
        proposalId: done ? ([...this.proposals.keys()][0] ?? null) : null,
        createdAt: new Date(r.at).toISOString(),
      });
    }
    const { owner: _o, ...view } = s;
    return { ...view, returns };
  }

  async startUpdate(org: string, eid: string, body: { title: string; request?: string }) {
    this.log("startUpdate", org, eid, body);
    const e = this.edition(org, eid);
    if (!e.ready) throw new ApiError(409, "edition_not_ready", "this edition has not been published yet");
    const sessionId = `eds-${fakeHex(`${eid}-${this.now()}-${this.updates.size}`, 16)}`;
    this.updates.set(sessionId, {
      sessionId,
      editionId: eid,
      editionName: e.name,
      title: body.title,
      request: body.request ?? "",
      files: e.files,
      stale: false,
      policyChanged: false,
      // fixture mode: a tiny text file stands in for the ZIP
      downloadUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(`fixture working copy of ${e.name}`)}`,
      returns: [],
      createdAt: this.nowIso(),
      owner: `u-${this.role}`,
    });
    this.event(this.nowIso(), "edition.session_started", "edition", eid, { kind: "user", id: `u-${this.role}` }, { sessionId, title: body.title }, { sessionId, title: body.title });
    return this.session(org, sessionId);
  }

  async listUpdates(org: string, eid: string) {
    this.log("listUpdates", org, eid);
    this.edition(org, eid);
    return [...this.updates.values()].filter((s) => s.editionId === eid && (this.isDev() || s.owner === `u-${this.role}`)).map((s) => this.session(org, s.sessionId));
  }

  async getUpdate(org: string, sid: string) {
    this.log("getUpdate", org, sid);
    return this.session(org, sid);
  }

  async sendBack(org: string, sid: string, zip: Blob, opts: { mode: "partial" | "full"; deletions?: string[] }) {
    this.log("sendBack", org, sid, zip.size, opts);
    this.session(org, sid);
    if (zip.size === 0) throw new ApiError(400, "zip_refused", "not a ZIP archive");
    const returnId = `edr-${fakeHex(`${sid}-${this.now()}-${this.updateReturns.size}`, 16)}`;
    this.updateReturns.set(returnId, { sessionId: sid, at: this.now(), mode: opts.mode });
    this.event(this.nowIso(), "edition.returned", "edition", this.updates.get(sid)!.editionId, { kind: "user", id: `u-${this.role}` }, { returnId, sessionId: sid, mode: opts.mode }, { returnId, mode: opts.mode });
    return this.session(org, sid).returns.find((r) => r.returnId === returnId)!;
  }

  // ------------------------------------------------------------------------- fixture controls

  /** Fixture mode: let the running client-edition task finish (shows live status changes). */
  // ------------------------------------------------------------------------------ intake

  /** Simulated runner time for an inventory or a URL import. */
  intakeMs = 1200;

  private intakeTick(i: FakeIntake) {
    if (this.now() < i.readyAt) return;
    if (i.v.state === "inventorying") {
      if (i.listing === null) {
        i.v.state = "failed";
        i.v.error = "inventory zip_refused: the upload is not a readable ZIP archive";
      } else {
        i.v.state = "inventoried";
        i.v.plan = fakePlacementPlan(i.listing, String(i.v.request.filename ?? "upload.zip"));
        i.v.inventory = { files: i.listing.entries.length };
      }
      i.v.updatedAt = this.nowIso();
    }
    if (i.v.state === "queued" || i.v.state === "importing") {
      const req = i.v.request as { resourceId: string; url: string; branch: string; projectId?: string; mountName?: string };
      const r = this.resources.get(req.resourceId)!;
      const rev = ART(r.repoId, `import-${req.resourceId}`);
      r.revisions.set(rev, {
        "README.md": `# ${r.name}\n\nImported from ${req.url} (branch ${req.branch}). Fixture mode: sample content, not the real repository.\n`,
        "package.json": `{\n  "name": "${r.repoId}",\n  "private": true\n}\n`,
        "src/index.ts": "export {};\n",
      });
      r.head = rev;
      r.headAt = this.nowIso();
      r.state = "active";
      r.source = { kind: "url", url: req.url, branch: req.branch };
      this.bindVersion(r);
      const target = req.projectId ? this.mountsOf(req.projectId) : null;
      const mounted = !!target && !!req.mountName && !target.some((m) => m.mountName === req.mountName);
      if (mounted) {
        target!.push({ mountName: req.mountName!, resourceId: r.resourceId, provider: "artifacts", resourceName: r.name, mode: "must-match-accepted", operations: ["read", "write"] });
        this.grantFolderToProjectPeople(req.projectId!, r.resourceId);
      }
      i.v.state = "completed";
      i.v.result = { resourceId: r.resourceId, revisionId: rev, branch: req.branch, ...(req.mountName ? { mounted } : {}) };
      i.v.updatedAt = this.nowIso();
      this.event(this.nowIso(), "intake.imported", "resource", r.resourceId, { kind: "user", id: `u-${this.role}` }, { revisionId: rev });
      if (req.projectId === FIXTURE_EMPTY_PROJECT) this.events[this.events.length - 1]!.handover = true;
    }
  }

  private intake(org: string, id: string) {
    this.org(org);
    this.needDev();
    const i = this.intakes.get(id);
    if (!i) throw new ApiError(404, "not_found", "intake not found");
    this.intakeTick(i);
    return i;
  }

  async startZipIntake(org: string, zip: Blob, filename: string) {
    this.log("startZipIntake", org, filename);
    this.org(org);
    this.needDev();
    if (zip.size === 0) throw new ApiError(411, "length_required", "content-length is required");
    if (zip.size > 100 * 1024 * 1024) throw new ApiError(413, "too_large", "archives are limited to 104857600 bytes");
    const listing = zipListing(new Uint8Array(await zip.arrayBuffer()));
    const intakeId = `in-${fakeHex(`intake-${this.intakes.size}-${filename}`, 16)}`;
    const at = this.nowIso();
    const v: IntakeView = { intakeId, kind: "zip", state: "inventorying", request: { filename, size: zip.size, sha256: fakeHex(`zip-${filename}-${zip.size}`, 64) }, createdAt: at, updatedAt: at };
    this.intakes.set(intakeId, { v, readyAt: this.now() + this.intakeMs, listing });
    this.event(at, "intake.requested", "intake", intakeId, { kind: "user", id: `u-${this.role}` }, { kind: "zip", size: zip.size });
    return { intakeId, state: "inventorying" };
  }

  async startUrlIntake(org: string, body: UrlIntakeInput) {
    this.log("startUrlIntake", org, body);
    this.org(org);
    this.needDev();
    let u: URL | null = null;
    try {
      u = new URL(body.url);
    } catch {
      u = null;
    }
    if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port || !u.hostname.includes(".") || u.hostname === "localhost") {
      throw new ApiError(400, "invalid_url", "only public https:// remotes without credentials are imported (private repositories: not supported in P0)");
    }
    if ((body.projectId === undefined) !== (body.mountName === undefined)) throw new ApiError(400, "invalid_request", "projectId and mountName go together");
    if (body.projectId) {
      // like the Worker: adding a folder is owner-only, and a taken name is refused before anything is created
      if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "only owners add folders to a project; import without projectId to create the resources only");
      this.project(org, body.projectId);
      if (this.mountsOf(body.projectId).some((m) => m.mountName === body.mountName)) throw new ApiError(409, "mount_exists", `mount ${body.mountName} already exists`, { names: [body.mountName] });
    }
    const resourceId = `res-${fakeHex(`url-${body.url}-${this.resources.size}`, 16)}`;
    const r = this.addResource(resourceId, body.name, "artifacts", {});
    r.repoId = body.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    r.state = "importing";
    r.headAt = this.nowIso();
    const intakeId = `in-${fakeHex(`intake-${this.intakes.size}-${body.url}`, 16)}`;
    const at = this.nowIso();
    const v: IntakeView = { intakeId, kind: "url", state: "queued", request: { resourceId, url: u.toString(), branch: body.branch, ...(body.projectId ? { projectId: body.projectId, mountName: body.mountName } : {}) }, createdAt: at, updatedAt: at };
    this.intakes.set(intakeId, { v, readyAt: this.now() + this.intakeMs, listing: null });
    this.event(at, "intake.requested", "intake", intakeId, { kind: "user", id: `u-${this.role}` }, { kind: "url", url: u.toString() });
    return { intakeId, resourceId, state: "queued" };
  }

  async getIntake(org: string, intakeId: string): Promise<IntakeView> {
    this.log("getIntake", org, intakeId);
    const i = this.intake(org, intakeId);
    const v = structuredClone(i.v);
    // like the Worker: the owner's include-anyway choice is shown to owners only
    if (this.role !== "owner") {
      if (v.plan) delete v.plan.includedAnyway;
      if (v.result) delete v.result.includedAnyway;
    }
    return v;
  }

  async confirmIntake(org: string, intakeId: string, body: IntakeConfirmInput): Promise<IntakeConfirmResult> {
    this.log("confirmIntake", org, intakeId, body);
    const i = this.intake(org, intakeId);
    if (i.v.kind !== "zip") throw new ApiError(404, "not_found", "intake not found");
    if (i.v.state !== "inventoried") throw new ApiError(409, "intake_not_ready", `intake is ${i.v.state}`);
    const chosen = i.v.plan!.placements.filter((p) => !body.skip?.includes(p.resourceName));
    const validName = (n: string) => /^[^./][^/]{0,127}$/.test(n);
    // include anyway (owner only): like the Worker (same order: before the mount checks), refused by path before anything is created
    const include = body.include ?? [];
    if (include.length && this.role !== "owner") throw new ApiError(403, "insufficient_role", "only owners include a blocked file anyway");
    const { included, refused } = fakeResolveIncludes(i.v.plan!, i.listing ?? { entries: [], rejected: [] }, chosen, include);
    if (refused.length) throw new ApiError(400, "include_refused", `only files blocked for a secret-looking name, small enough for Git and going into a resource being added can be included: ${refused.map((r) => r.path).join(", ")}`, { paths: refused.map((r) => r.path), refused });
    if (body.projectId) {
      if (this.role !== "owner") throw new ApiError(403, "insufficient_role", "only owners add folders to a project; import without projectId to create the resources only");
      this.project(org, body.projectId);
      const taken = new Set(this.mountsOf(body.projectId).map((m) => m.mountName));
      const clash = chosen.map((p) => p.resourceName).filter((n) => validName(n) && taken.has(n));
      if (clash.length) throw new ApiError(409, "mount_exists", `this project already has folders named ${clash.join(", ")}`, { names: clash });
    }
    const created: IntakeConfirmResult["resources"] = [];
    for (const p of chosen) {
      const resourceId = `res-${fakeHex(`zip-${intakeId}-${p.resourceName}`, 16)}`;
      const r = this.addResource(resourceId, p.resourceName, p.provider, p.provider === "r2-assets" ? { [R2M(`genesis-${resourceId}`)]: {} } : {});
      r.headAt = this.nowIso();
      r.source = { kind: "zip-upload", archive: String(i.v.request.filename ?? "upload.zip") };
      if (p.provider === "r2-assets") this.bindVersion(r);
      else r.state = "empty";
      let mountName: string | undefined;
      if (body.projectId) {
        mountName = validName(p.resourceName) ? p.resourceName : resourceId;
        this.mountsOf(body.projectId).push({ mountName, resourceId, provider: p.provider, resourceName: p.resourceName, mode: "must-match-accepted", operations: ["read", "write"] });
        this.grantFolderToProjectPeople(body.projectId, resourceId);
      }
      created.push({ resourceId, name: p.resourceName, provider: p.provider, ...(mountName ? { mountName } : {}) });
    }
    const result: IntakeConfirmResult = {
      resources: created,
      excluded: i.v.plan!.excluded.length - included.length,
      ...(included.length ? { includedAnyway: included.map((x) => x.path) } : {}),
      pendingPopulation: true,
      note: "resources created; content population from the staged archive needs the runner intake-apply job (not yet available)",
    };
    i.v.state = "confirmed";
    i.v.result = result as unknown as Record<string, unknown>;
    if (included.length) i.v.plan = { ...i.v.plan!, includedAnyway: included };
    i.v.updatedAt = this.nowIso();
    this.event(this.nowIso(), "intake.confirmed", "intake", intakeId, { kind: "user", id: `u-${this.role}` }, { resources: created.length });
    if (body.projectId === FIXTURE_EMPTY_PROJECT) this.events[this.events.length - 1]!.handover = true;
    if (included.length) {
      // org-level and naming no resource: owner-only, like the Worker
      this.event(this.nowIso(), "intake.included_anyway", "intake", intakeId, { kind: "user", id: `u-${this.role}` }, { paths: included.map((x) => x.path), into: included });
      const e = this.events.find((x) => x.action === "intake.included_anyway" && x.subject.id === intakeId)!;
      e.projectId = null;
      e.ownerOnly = true;
    }
    return structuredClone(result);
  }

  // ------------------------------------------------------------ uploads, file changes (Folders)

  /** The viewer's operations on a folder, as the Worker's `resourceOps`: owners hold everything. */
  private folderOps(resourceId: string): Operation[] {
    if (this.role === "owner") return ["read", "write"];
    return this.grants.get(`u-${this.role}|resource|${resourceId}`) ?? [];
  }

  /** `Mount.canWrite`: owners, and developers with write on the folder (never clients or viewers). */
  private mountCanWrite(m: Mount): boolean {
    return this.isDev() && this.folderOps(m.resourceId).includes("write");
  }

  /**
   * `Mount.canStartTask` (Worker `writeMountIssue`, createTask's rule): clients in a staging-mode
   * project for git folders opened for writing where the owner gave them Can change; owners and
   * developers with write on a folder opened for writing; never viewers.
   */
  private mountCanStartTask(pid: string, m: Mount): boolean {
    const r = this.resources.get(m.resourceId);
    if (!r || !m.operations.includes("write")) return false;
    if (this.role === "client") return this.stagingMode(pid) && r.provider === "artifacts" && this.folderOps(m.resourceId).includes("write");
    return this.isDev() && this.folderOps(m.resourceId).includes("write");
  }

  /** The write routes' checks, in the Worker's order: role, a folder the caller can read, write on it. */
  private writableMount(org: string, pid: string, mountName: string) {
    this.project(org, pid);
    this.needDev();
    const found = this.mount(mountName, pid);
    const ops = this.folderOps(found.r.resourceId);
    if (!ops.includes("read")) throw new ApiError(404, "not_found", "mount not found");
    if (!ops.includes("write")) throw new ApiError(403, "no_write_grant", "no write grant on this folder");
    return found;
  }

  private ownUpload(org: string, uploadId: string): FakeUpload {
    this.org(org);
    const u = this.uploads.get(uploadId);
    if (!u || u.userId !== `u-${this.role}`) throw new ApiError(404, "not_found", "upload not found");
    return u;
  }

  async startUpload(org: string, pid: string, mount: string, body: { path: string; size: number; mime: string }): Promise<UploadStart> {
    this.log("startUpload", org, pid, mount, body);
    const { r } = this.writableMount(org, pid, mount);
    const path = fakeUploadPath(body.path);
    // an empty file is an upload of no parts, completed with `parts: []` (like the Worker)
    if (!Number.isInteger(body.size) || body.size < 0) throw new ApiError(400, "invalid_size", "an upload's size is a whole number of bytes");
    if (body.size > FAKE_LIMITS.maxFileBytes) throw new ApiError(413, "file_too_large", `files are limited to ${FAKE_LIMITS.maxFileBytes} bytes`);
    const uploadId = `lfs-${fakeHex(`upload-${++this.uploadSeq}-${this.now()}`, 12)}`;
    const parts = Math.ceil(body.size / UPLOAD_PART_BYTES);
    // like the hash step's text check: only small text uploads keep their content (edit in place, previews)
    const keepText = (isTextMime(body.mime) || body.size === 0) && body.size < EDIT_MAX_BYTES;
    this.uploads.set(uploadId, { uploadId, resourceId: r.resourceId, userId: `u-${this.role}`, path, size: body.size, mime: body.mime, parts, etags: new Map(), texts: keepText ? new Map() : null, state: "uploading", body: undefined, added: false });
    return { uploadId, partSize: UPLOAD_PART_BYTES, parts, expiresAt: new Date(this.now() + 24 * 3600_000).toISOString() };
  }

  async putUploadPart(org: string, uploadId: string, n: number, bytes: Blob, opts: { signal: AbortSignal; onProgress?: (sent: number) => void }) {
    this.log("putUploadPart", org, uploadId, n);
    if (opts.signal.aborted) throw new DOMException("the upload was canceled", "AbortError");
    const u = this.ownUpload(org, uploadId);
    if (u.state !== "uploading") throw new ApiError(409, "upload_finished", "this upload is finished");
    if (!Number.isInteger(n) || n < 1 || n > u.parts) throw new ApiError(400, "invalid_part", "invalid part number");
    const want = n < u.parts ? UPLOAD_PART_BYTES : u.size - (u.parts - 1) * UPLOAD_PART_BYTES;
    if (bytes.size !== want) throw new ApiError(400, "part_size_mismatch", `part ${n} must be ${want} bytes`);
    if (u.texts) u.texts.set(n, await bytes.text());
    opts.onProgress?.(bytes.size);
    const etag = fakeHex(`${uploadId}-${n}-${++this.uploadSeq}`, 32);
    u.etags.set(n, etag);
    return { etag };
  }

  async completeUpload(org: string, uploadId: string, parts: Array<{ n: number; etag: string }>) {
    this.log("completeUpload", org, uploadId, parts);
    const u = this.ownUpload(org, uploadId);
    if (u.state === "uploading") {
      if (parts.length !== u.parts || parts.some((p, i) => p.n !== i + 1)) throw new ApiError(400, "parts_mismatch", `expected parts 1..${u.parts} in order`);
      if (parts.some((p) => u.etags.get(p.n) !== p.etag)) throw new ApiError(400, "upload_incomplete", "the parts do not match what was uploaded");
      if (u.texts) u.body = parts.map((p) => u.texts!.get(p.n) ?? "").join("");
      u.state = "uploaded";
    }
    return { stagingId: u.uploadId, size: u.size };
  }

  async cancelUpload(org: string, uploadId: string) {
    this.log("cancelUpload", org, uploadId);
    const u = this.ownUpload(org, uploadId);
    if (u.state === "uploading") this.uploads.delete(uploadId);
  }

  async createFileChange(org: string, pid: string, mount: string, body: FileChangeRequest): Promise<FileChange> {
    this.log("createFileChange", org, pid, mount, body);
    const { m, r } = this.writableMount(org, pid, mount);
    if (body.ops.length > FAKE_LIMITS.maxOps) throw new ApiError(413, "too_many_operations", `a change has at most ${FAKE_LIMITS.maxOps} operations`);
    if (body.ops.length === 0) throw new ApiError(400, "invalid_request", "ops: a change has at least one operation");
    const title = body.title?.trim();
    if (body.title !== undefined && (!title || title.length > 200)) throw new ApiError(400, "invalid_request", "title: 1 to 200 characters");
    const key = body.idempotencyKey;
    if (key !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new ApiError(400, "invalid_request", "idempotencyKey: 1 to 128 letters, digits, _ or -");
    const ops: FileChangeOp[] = [];
    let editBytes = 0;
    for (const op of body.ops) {
      if ("put" in op) ops.push({ put: fakeUploadPath(op.put), stagingId: op.stagingId });
      else if ("edit" in op) {
        if (r.provider !== "artifacts") throw new ApiError(400, "edit_unsupported", "files in a file collection are not edited in place; upload a new version");
        if (op.baseBlob !== "" && !/^[0-9a-f]{40}$/.test(op.baseBlob)) throw new ApiError(400, "invalid_request", "baseBlob is '' (a new file) or the 40-hex blob id from GET …/file");
        const size = new TextEncoder().encode(op.content).length;
        if (size > FAKE_LIMITS.maxEditBytes || op.content.includes("\0")) throw new ApiError(413, "edit_too_large", `edits are text (no NUL) of at most ${FAKE_LIMITS.maxEditBytes} bytes`);
        editBytes += size;
        if (editBytes > FAKE_LIMITS.maxEditTotalBytes) throw new ApiError(413, "edits_too_large", `the edits of one change are at most ${FAKE_LIMITS.maxEditTotalBytes} bytes together`);
        ops.push({ edit: fakeUploadPath(op.edit), content: op.content, baseBlob: op.baseBlob });
      } else if ("delete" in op) ops.push({ delete: fakeUploadPath(op.delete) });
      else ops.push({ move: fakeUploadPath(op.move), to: fakeUploadPath(op.to) });
    }
    const me = `u-${this.role}`;
    // a repeat of the same user's key (as the Worker): the change it made, before the uploads are
    // checked; the same folder and operations, or 409 (the title is not compared)
    const keyed = key === undefined ? undefined : `${org}|${me}|${key}`;
    const sig = JSON.stringify([pid, m.mountName, ops]);
    const known = keyed === undefined ? undefined : this.changeKeys.get(keyed);
    if (known) {
      if (known.sig !== sig) throw new ApiError(409, "idempotency_key_reused", "this idempotency key was used for another change; use a new key for a new change");
      return structuredClone(this.fileChanges.get(known.changeId)!.v);
    }
    let total = 0;
    for (const op of ops) {
      if (!("put" in op)) continue;
      const u = this.uploads.get(op.stagingId);
      if (!u || u.resourceId !== r.resourceId || u.userId !== me) throw new ApiError(400, "invalid_upload", `upload ${op.stagingId} is not one of your uploads to this folder`);
      if (u.state === "uploading") throw new ApiError(400, "invalid_upload", `upload ${op.stagingId} is not complete`);
      if (u.added) throw new ApiError(400, "invalid_upload", `upload ${op.stagingId} was added already; upload the file again`);
      total += u.size;
    }
    if (total > FAKE_LIMITS.maxChangeBytes) throw new ApiError(413, "change_too_large", `a change puts at most ${FAKE_LIMITS.maxChangeBytes} bytes`);
    const at = this.nowIso();
    const changeId = `fc-${fakeHex(`change-${++this.uploadSeq}-${this.now()}`, 12)}`;
    const v: FileChange = { changeId, projectId: pid, mountName: m.mountName, title: title ?? fakeDefaultTitle(ops, m.mountName), state: "applying", attempt: 1, proposalId: null, createdAt: at, updatedAt: at };
    this.fileChanges.set(changeId, { v, seq: this.uploadSeq, resourceId: r.resourceId, userId: me, role: this.role, ops, base: null });
    if (keyed !== undefined) this.changeKeys.set(keyed, { changeId, sig });
    return structuredClone(v);
  }

  async getFileChange(org: string, changeId: string): Promise<FileChange> {
    this.log("getFileChange", org, changeId);
    this.org(org);
    const fc = this.fileChanges.get(changeId);
    // the uploader, and owners and developers who can read the folder; anyone else: 404
    if (!fc || !(fc.userId === `u-${this.role}` || (this.isDev() && this.folderOps(fc.resourceId).includes("read")))) throw new ApiError(404, "not_found", "change not found");
    this.advanceChange(fc);
    return structuredClone(fc.v);
  }

  async listFileChanges(org: string, pid: string, q: { mount?: string; limit?: number } = {}): Promise<FileChange[]> {
    this.log("listFileChanges", org, pid, q);
    this.project(org, pid);
    this.needDev();
    const limit = q.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, "invalid_request", "limit is an integer from 1 to 50");
    const me = `u-${this.role}`;
    const shown = [...this.fileChanges.values()].filter((fc) => fc.v.projectId === pid && (!q.mount || fc.v.mountName === q.mount) && this.folderOps(fc.resourceId).includes("read"));
    for (const fc of shown) if (isOpenChange(fc.v.state)) this.advanceChange(fc);
    const newest = (a: FakeFileChange, b: FakeFileChange) => (a.v.createdAt !== b.v.createdAt ? (a.v.createdAt < b.v.createdAt ? 1 : -1) : b.seq - a.seq);
    // as the Worker: every open change (up to 100) whatever the limit; terminal ones from the last
    // 24 hours (anyone's for owners, their own for developers) fill the rest of the limit
    const open = shown.filter((fc) => isOpenChange(fc.v.state)).sort(newest).slice(0, 100);
    const rest = shown
      .filter((fc) => !isOpenChange(fc.v.state) && this.now() - Date.parse(fc.v.updatedAt) <= 24 * 3600_000 && (this.role === "owner" || fc.userId === me))
      .sort(newest)
      .slice(0, Math.max(0, limit - open.length));
    return [...open, ...rest].sort(newest).map((fc) => structuredClone(fc.v));
  }

  async readFileForEdit(org: string, pid: string, q: FileQuery): Promise<EditableFile> {
    this.log("readFileForEdit", org, pid, q);
    this.project(org, pid);
    if (q.revision && !this.isDev()) throw new ApiError(403, "revision_not_allowed", "clients and viewers browse the accepted version only");
    const { r } = this.mount(q.mount, pid);
    const notEditable = (why: string) => new ApiError(409, "not_editable", why);
    // file collections send no blob id; LFS files are never edited in place
    if (r.provider !== "artifacts") throw notEditable("only files of git folders can be edited in place");
    const f = this.fileEntry(q, pid);
    if (isLfsEntry(f)) throw notEditable("this file is stored in LFS; replace it with an upload instead");
    const text = typeof f === "string" ? f : f.body;
    if (text === undefined) throw notEditable("this file is not text");
    const size = new TextEncoder().encode(text).length;
    if (size >= EDIT_MAX_BYTES) throw notEditable("files of 1 MiB or more cannot be edited in place");
    if (text.includes("\0")) throw notEditable("this file is not text");
    return { text, baseBlob: blobOf(f), revisionId: q.revision ?? r.head, size };
  }

  /** One poll moves a change one step: verify its uploads, apply, then land (or wait for approval). */
  private advanceChange(fc: FakeFileChange) {
    const r = this.resources.get(fc.resourceId)!;
    const fp = fc.v.proposalId ? this.proposals.get(fc.v.proposalId) : undefined;
    switch (fc.v.state) {
      case "applying": {
        const pending = stagingIds(fc.ops).map((id) => this.uploads.get(id)!).filter((u) => u.state !== "verified");
        if (pending.length) {
          // the hash step: the uploads are verified one poll after they complete
          for (const u of pending) u.state = "verified";
          return;
        }
        this.applyChange(fc, r);
        return;
      }
      case "checking": {
        if (r.head !== fc.base) return this.restartChange(fc, fp);
        this.finishRun(fp!, "pass", fc.v.updatedAt, this.nowIso(), `job-${fakeHex(`${fc.v.changeId}-${fc.v.attempt}`, 24)}`);
        if (this.uploaderApprovalRoles(fc.v.projectId).includes(fc.role)) this.landChange(fc, fp!);
        else this.setChange(fc, { state: "waiting_approval" });
        return;
      }
      case "waiting_approval":
        if (fp?.p.state === "accepted") this.changeAdded(fc);
        else if (r.head !== fc.base) this.restartChange(fc, fp);
        return;
      default:
        return;
    }
  }

  /** Staging mode as the Worker reads it: a policy with both a `staging` and a `release` section. */
  private stagingMode(pid: string): boolean {
    return pid === FIXTURE_PROJECT && this.policy.staging !== undefined && this.policy.release !== undefined;
  }

  /** Ruling R6: the uploader's own approval counts for the roles the policy lists, owners when it lists none. */
  private uploaderApprovalRoles(pid: string): Role[] {
    const roles = pid === FIXTURE_PROJECT ? this.policy.approvalRoles : undefined;
    return roles && roles.length > 0 ? roles : ["owner"];
  }

  private setChange(fc: FakeFileChange, patch: Partial<FileChange>) {
    Object.assign(fc.v, patch, { updatedAt: this.nowIso() });
  }

  private failChange(fc: FakeFileChange, code: string, message: string) {
    this.setChange(fc, { state: "failed", error: { code, message } });
  }

  private changeAdded(fc: FakeFileChange) {
    this.setChange(fc, { state: "added" });
    for (const id of stagingIds(fc.ops)) this.uploads.get(id)!.added = true;
  }

  /** Another change landed first: put/delete/move changes apply again (up to 3 attempts); edits fail. */
  private restartChange(fc: FakeFileChange, fp: FakeProposal | undefined) {
    if (fp && fp.p.state !== "accepted") fp.p.state = "superseded";
    if (fc.ops.some((op) => "edit" in op)) return this.failChange(fc, "file_changed", "the folder changed after the file was opened; open it again");
    if (fc.v.attempt >= 3) return this.failChange(fc, "stale_base", "other changes were accepted first three times");
    delete fc.v.changedPaths;
    this.setChange(fc, { state: "applying", attempt: fc.v.attempt + 1, proposalId: null });
  }

  /** The runner's `apply-files` (git) or the manifest step (file collections), then the proposal. */
  private applyChange(fc: FakeFileChange, r: FakeResource) {
    const git = r.provider === "artifacts";
    const base = r.revisions.get(r.head) ?? {};
    const files: Files = { ...base };
    const has = (p: string) => files[p] !== undefined;
    const under = (p: string) => Object.keys(files).filter((k) => k === p || k.startsWith(`${p}/`));
    // a file below a file, or a file over a folder
    const conflicts = (p: string) => Object.keys(files).some((k) => k.startsWith(`${p}/`)) || p.split("/").slice(0, -1).some((_, i, segs) => has(segs.slice(0, i + 1).join("/")));
    const fail = (code: string, message: string) => (this.failChange(fc, code, message), false);
    const step = (op: FileChangeOp): boolean => {
      if ("put" in op) {
        if (conflicts(op.put)) return fail("path_conflict", `${op.put} conflicts with a file or folder`);
        const u = this.uploads.get(op.stagingId)!;
        files[op.put] = { size: u.size, mime: u.mime, ...(u.body !== undefined ? { body: u.body } : {}) };
      } else if ("edit" in op) {
        const cur = files[op.edit];
        if (op.baseBlob === "" ? cur !== undefined : cur === undefined || blobOf(cur) !== op.baseBlob) return fail("file_changed", `${op.edit} changed after it was opened`);
        if (cur === undefined && conflicts(op.edit)) return fail("path_conflict", `${op.edit} conflicts with a file or folder`);
        files[op.edit] = op.content;
      } else if ("delete" in op) {
        const gone = under(op.delete);
        if (!gone.length && !git) return fail("file_missing", `${op.delete} is not there`);
        for (const k of gone) delete files[k];
      } else {
        const moving = under(op.move);
        if (!moving.length) return git ? fail("path_not_found", `${op.move} is not there`) : fail("file_missing", `${op.move} is not there`);
        const moved: Files = {};
        for (const k of moving) {
          const dest = op.to + k.slice(op.move.length);
          if (has(dest) && !moving.includes(dest)) return git ? fail("path_conflict", `${dest} exists`) : fail("path_exists", `${dest} exists`);
          moved[dest] = files[k]!;
        }
        for (const k of moving) delete files[k];
        Object.assign(files, moved);
      }
      return true;
    };
    for (const op of fc.ops) if (!step(op)) return;

    const lfsOf = (f: Files[string] | undefined) => git && f !== undefined && isLfsEntry(f);
    const changedPaths = [...new Set([...Object.keys(base), ...Object.keys(files)])]
      .filter((p) => JSON.stringify(base[p]) !== JSON.stringify(files[p]))
      .sort()
      .map((path) => {
        const before = base[path];
        const after = files[path];
        const lfs = lfsOf(after ?? before);
        // replacing a code file that was not stored in LFS is code even when the new version is an LFS object
        const code = git && FAKE_CODE_RE.test(path) && (!lfs || (before !== undefined && !lfsOf(before)));
        return { path, change: before === undefined ? "added" : after === undefined ? "deleted" : "modified", lfs, class: code ? ("code" as const) : ("content" as const) };
      });
    if (!changedPaths.length) {
      fc.base = r.head;
      return this.setChange(fc, { state: "added", note: "no_changes" });
    }
    const seed = `${fc.v.changeId}-${fc.v.attempt}`;
    const rev = git ? ART(r.repoId, seed) : R2M(seed);
    r.revisions.set(rev, files);
    // as the Worker: in a staging-mode project a git folder's change stops at staging and reaches
    // the folder only through a promotion (the fake has no staging builds or promotions: it stays)
    if (git && this.stagingMode(fc.v.projectId)) {
      fc.base = r.head;
      return this.setChange(fc, { state: "staged", changedPaths });
    }
    const proposalId = `prop-${fakeHex(`fc-${seed}`, 8)}-0000-4000-8000-${fakeHex(`fc-${seed}-tail`, 12)}`;
    const at = this.nowIso();
    const candidates: Proposal["candidates"] = git
      ? [
          {
            candidateId: `cand:tw-${fc.v.changeId}:${rev.split(":").pop()}`,
            taskWorkspaceId: `tw-${fc.v.changeId}`,
            resourceId: r.resourceId,
            baseRevision: r.head,
            sha: rev.split(":").pop()!,
            treeId: fakeHex(`${rev}-tree`),
            frozenAt: at,
            submitter: { kind: "user", id: fc.userId },
            changedPaths: changedPaths.map((c) => c.path),
            state: "prepared",
            preparedReceiptId: `rcpt-${fakeHex(rev, 12)}`,
          },
        ]
      : [];
    const assets = git ? [] : [{ resourceId: r.resourceId, baseManifestId: r.head ? r.head.slice(4) : null, newManifestId: rev.slice(4) }];
    this.addProposal(proposalId, fc.v.changeId, candidates, assets, "prepared", at, "pass");
    const fp = this.proposals.get(proposalId)!;
    fp.p.projectId = fc.v.projectId;
    this.proposalCreated(fp, at);
    fc.base = r.head;
    this.setChange(fc, { state: "checking", proposalId, changedPaths });
  }

  /** The uploader's approval counts: the Worker records it and accepts the proposal itself. */
  private landChange(fc: FakeFileChange, fp: FakeProposal) {
    const at = this.nowIso();
    fp.approvals.push({ approvalId: `apr-${fakeHex(`${fp.p.proposalId}-auto`, 16)}`, role: fc.role, approvedAt: at, proposalHash: fp.p.proposalHash, approver: { kind: "user", id: fc.userId } });
    const heads = [...fp.p.resourceChanges.map((rc) => ({ resourceId: rc.resourceId, revisionId: rc.candidateRevision })), ...fp.p.assetManifestChanges.map((ac) => ({ resourceId: ac.resourceId, revisionId: `r2m:${ac.newManifestId}` }))];
    const acceptedVersionId = this.commitVersion("accept", fp.p.proposalId, fp.p.proposalHash, heads);
    fp.p.state = "accepted";
    this.event(at, "proposal.accepted", "proposal", fp.p.proposalId, { kind: "user", id: fc.userId }, { acceptedVersionId, proposalHash: fp.p.proposalHash }, undefined, true);
    this.changeAdded(fc);
  }

  // ------------------------------------------------------------------- staging phase 3 (fixture)
  //
  // The Worker's staging and promotion rules the screens depend on (services/staging.ts,
  // services/promotions.ts, services/promotion-gate.ts, routes/staging.ts, routes/promotions.ts,
  // routes/tasks.ts): role-shaped views, landing and promotion states, the gate (path rules, the
  // migration veto with core's linter, the classifier) and the client texts. A staging build takes
  // `integrationMs`; a promotion moves one step every `promotionStepMs` while it is read.

  /** The Customer Portal demo (spec 2026-10-07 §12). */
  private seedStaging(ago: (min: number) => string) {
    // approvalRoles widened to include developers: a promotion that needs a developer (the phone
    // field the classifier declines, the column rename) is approved by a developer only when the policy lists the role (staging mode requires
    // owner or developer there; the demo shows a developer approving)
    this.policy = {
      ...this.policy,
      approvalRoles: ["owner", "developer", "client"],
      // a required check that builds the website and gates alone-first (B8): a website-only task
      // whose closure is larger is promoted alone, the rest "Going without" (the three demo tasks
      // share no path, so they are promoted as before)
      checks: [...this.policy.checks, { checkId: "website-build", mountName: "website", command: "pnpm install --frozen-lockfile --ignore-scripts && pnpm run build", timeoutSeconds: 600, required: true, gatesAlone: true }],
      release: structuredClone(STAGING_RELEASE_SECTION),
      staging: structuredClone(STAGING_POLICY_SECTION),
    };
    const T = FIXTURE_STAGING_TASKS;
    const demo: Array<{ taskId: string; title: string; request: string; at: number; writeMounts: string[]; edits: FakeEdit[]; landed: boolean }> = [
      {
        taskId: T.copy,
        title: "Update the home page copy, banner and footer",
        request: "Rewrite the home page headline and intro, add the autumn offer banner, and add a footer with our address and opening hours.",
        at: 45,
        writeMounts: ["website"],
        edits: [
          { mount: "website", path: "src/index.html", content: HOME_COPY },
          { mount: "website", path: "src/footer.html", content: FOOTER },
        ],
        landed: true,
      },
      {
        taskId: T.phone,
        title: "Add a phone field to the contact form",
        request: "Add an optional phone number to the contact form and store it with the contact (a new column).",
        at: 40,
        writeMounts: ["website", "api"],
        edits: [
          { mount: "api", path: "migrations/0002_phone.sql", content: "ALTER TABLE contacts ADD COLUMN phone TEXT;\n" },
          { mount: "api", path: "src/index.ts", content: API_BASE.replace("export default app;", `${CONTACTS_API.trim()}\n\nexport default app;`) },
          { mount: "website", path: "src/contact.html", content: CONTACT_FORM },
        ],
        landed: true,
      },
      {
        taskId: T.rename,
        title: "Rename the contact name column",
        request: "Rename the contacts table's name column to full_name; the API keeps answering with name.",
        at: 35,
        writeMounts: ["api"],
        edits: [
          { mount: "api", path: "migrations/0003_rename_contact_name.sql", content: "ALTER TABLE contacts RENAME COLUMN name TO full_name;\n" },
          { mount: "api", path: "src/contacts.ts", content: RENAMED_CONTACTS },
        ],
        landed: true,
      },
      {
        taskId: T.working,
        title: "Show opening hours on the contact page",
        request: "Add our opening hours under the contact form.",
        at: 6,
        writeMounts: ["website"],
        edits: [{ mount: "website", path: "src/opening-hours.html", content: OPENING_HOURS }],
        landed: false,
      },
    ];
    const readable = this.mountsOf(FIXTURE_PROJECT).map((m) => m.mountName);
    for (const d of demo) {
      const created = ago(d.at);
      this.tasks.unshift({ taskId: d.taskId, title: d.title, state: d.landed ? "submitted" : "running", changeId: `chg-${fakeHex(`chg-${d.taskId}`, 8)}-0000-4000-8000-${fakeHex(`chg-${d.taskId}-tail`, 12)}`, createdAt: created });
      this.taskInfo.set(d.taskId, { createdBy: "u-client", request: d.request, writeMounts: d.writeMounts, readMounts: readable.filter((m) => !d.writeMounts.includes(m)), staging: true, edits: d.edits, readyAt: 0, updatedAt: created });
      this.event(created, "task.created", "task", d.taskId, { kind: "user", id: "u-client" }, { title: d.title }, {});
      if (!d.landed) continue;
      this.landings.push({ landingId: `lnd-${fakeHex(`lnd-${d.taskId}`, 12)}`, taskId: d.taskId, seq: ++this.stagingSeq, state: "landed", reasonCode: null, reason: null, detail: null, createdBy: "u-client", createdAt: ago(d.at - 3) });
      this.event(ago(d.at - 3), "staging.landed", "task", d.taskId, { kind: "service", id: "release-service" }, {}, {});
    }
    this.stagingCurrent = { buildId: `sbld-${fakeHex("sbld-seed", 12)}`, since: ago(30) };
    this.captures.push(
      {
        captureId: `cap-${fakeHex("cap-2", 12)}`,
        receivedAt: ago(9),
        method: "POST",
        path: "/payments",
        headers: { "content-type": "application/json", "user-agent": "Cloudflare-Workers" },
        body: JSON.stringify({ type: "payment.succeeded", amount: 4900, currency: "eur", customer: "maria.lopez@example.com", reference: "QUOTE-1042" }, null, 2),
        truncated: false,
      },
      {
        captureId: `cap-${fakeHex("cap-1", 12)}`,
        receivedAt: ago(12),
        method: "POST",
        path: "/email",
        headers: { "content-type": "application/json", "user-agent": "Cloudflare-Workers" },
        body: JSON.stringify({ to: "sales@demo-client.example", subject: "New contact: Maria Lopez", text: "Maria Lopez (maria.lopez@example.com) asked for a quote for 3 items." }, null, 2),
        truncated: false,
      },
    );
  }

  private actingUser() {
    return `u-${this.role}`;
  }

  private stagingUrl() {
    return "https://cfapp-o-fixture-website-staging.fixture.invalid";
  }

  private taskTitle(taskId: string) {
    return this.tasks.find((t) => t.taskId === taskId)?.title ?? "";
  }

  private creatorOf(taskId: string) {
    return this.taskInfo.get(taskId)?.createdBy ?? "u-developer";
  }

  /** Time moves the staging story: tasks finish provisioning, a staging build finishes, promotions step. */
  private stagingTick() {
    const now = this.now();
    for (const t of this.tasks) {
      const info = this.taskInfo.get(t.taskId);
      if (info && t.state === "provisioning" && now >= info.readyAt) {
        t.state = "ready";
        t.updatedAt = new Date(info.readyAt).toISOString();
      }
    }
    const b = this.stagingBuild;
    if (b && now >= b.doneAt) {
      this.stagingBuild = null;
      const at = new Date(b.doneAt).toISOString();
      for (const l of this.landings) {
        if (l.state === "checking") {
          l.state = "landed";
          this.event(at, "staging.landed", "task", l.taskId, { kind: "service", id: "release-service" }, {}, {});
        } else if (l.state === "rolling_back") {
          l.state = "rolled_back";
          this.event(at, "staging.rolled_back", "task", l.taskId, { kind: "service", id: "release-service" }, {}, {});
        }
      }
      this.stagingCurrent = { buildId: b.buildId, since: at };
      // as the Worker records a reset when its build runs; the fixture adds the note the header can show
      if (b.reset) this.event(at, "staging.reset", "project", FIXTURE_PROJECT, { kind: "service", id: "release-service" }, { buildId: b.buildId, note: "Demo data was reset" }, { note: "Demo data was reset" });
    }
    for (const p of this.promotions) {
      let guard = 0;
      while (now >= p.stepAt && guard++ < 20 && this.promotionStep(p)) p.stepAt += this.promotionStepMs;
    }
  }

  /** A staging build of every open landing (a newer request supersedes the running one, carrying a reset). */
  private requestStagingBuild(reset = false): string {
    const buildId = `sbld-${fakeHex(`sbld-${++this.stagingSeq}-${this.now()}`, 12)}`;
    this.stagingBuild = { buildId, doneAt: this.now() + this.integrationMs, reset: reset || (this.stagingBuild?.reset ?? false) };
    return buildId;
  }

  /** The task's landing in staging (its own; newest first), like `landingOfTask(…, IN_STAGING)`. */
  private landingOfTask(taskId: string, states: LandingState[] = ["checking", "landed", "promoting"]) {
    return [...this.landings].reverse().find((l) => l.taskId === taskId && states.includes(l.state)) ?? null;
  }

  /** The changed paths of a landing as `<mountName>/<path>`. */
  private landingPaths(l: FakeLanding): string[] {
    return (this.taskInfo.get(l.taskId)?.edits ?? []).map((e) => `${e.mount}/${e.path}`);
  }

  /** The routes' task check (promote, rollback): a client only for a task they created in a staging-mode project; 404 otherwise. */
  private stagingTask(taskId: string) {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new ApiError(404, "not_found", "task not found");
    if (!this.isDev() && this.role !== "client") throw new ApiError(404, "not_found", "task not found");
    if (this.role === "client" && (this.creatorOf(taskId) !== this.actingUser() || !this.stagingMode(FIXTURE_PROJECT))) throw new ApiError(404, "not_found", "task not found");
    if (!this.stagingMode(FIXTURE_PROJECT)) throw new ApiError(404, "not_found", "this project has no staging");
    return task;
  }

  /** The in-flight promotion that claims a landing. */
  private holderOf(landingId: string) {
    return this.promotions.find((p) => IN_FLIGHT.includes(p.state) && p.landingIds.includes(landingId)) ?? null;
  }

  /**
   * `planPromotion` (P3-7): the target's closure (core `promotionSet` over every landing in staging:
   * earlier landings sharing a path, transitively) or, when alone-first applies (B8, Worker
   * `aloneFirstApplies`), the alone set (core `aloneSet`) with the rest of the closure going
   * without it; or the refusal. The fixture has no travel-with links and no revision parts, so
   * `with` and `after` are empty.
   */
  private planPromotion(taskId: string): { set: FakeLanding[]; mode: PromotionMode; going: FakeLanding[] } {
    this.stagingTask(taskId);
    // B6: nothing is promoted before the owner's first production publish
    if (!this.stagingBaseline()) throw new ApiError(409, "staging_awaiting_baseline", "Staging starts after the owner's first production publish");
    const target = this.landingOfTask(taskId);
    if (!target) throw new ApiError(409, "not_in_staging", "this task is not in staging");
    if (target.state === "promoting") {
      const holder = this.holderOf(target.landingId);
      throw new ApiError(409, "promotion_in_progress", "this task is already being promoted", holder ? { promotionId: holder.promotionId } : undefined);
    }
    if (target.state !== "landed") throw new ApiError(409, "not_landed", "this task is not live on staging yet");
    const open = this.landings.filter((l) => l.state === "checking" || l.state === "landed" || l.state === "promoting");
    const input = open.map((l) => ({ landingId: l.landingId, seq: l.seq, paths: this.landingPaths(l) }));
    const byId = (id: string) => open.find((l) => l.landingId === id)!;
    const closure = promotionSet(input, target.landingId);
    const alone = aloneSet(input, target.landingId);
    const changed = new Set(alone.flatMap((id) => (this.taskInfo.get(byId(id).taskId)?.edits ?? []).map((e) => this.mount(e.mount).r.resourceId)));
    const mode: PromotionMode = closure.length > alone.length && this.aloneFirstApplies(changed) ? "alone" : "closure";
    const set = (mode === "alone" ? alone : closure).map(byId);
    const going = mode === "alone" ? closure.filter((id) => !alone.includes(id)).map(byId) : [];
    // only the landings promoted now must be live on staging and unclaimed
    const busy = set.find((l) => l.state !== "landed");
    if (busy?.state === "promoting") {
      const holder = this.holderOf(busy.landingId);
      throw new ApiError(409, "promotion_dependency_busy", `'${this.taskTitle(busy.taskId)}' is being promoted; wait until it finishes`, { ...(holder ? { promotionId: holder.promotionId } : {}), taskId: busy.taskId, title: this.taskTitle(busy.taskId) });
    }
    if (busy) throw new ApiError(409, "promotion_dependency_busy", "a task this one depends on is not live on staging yet; wait until it is", { taskId: busy.taskId, title: this.taskTitle(busy.taskId) });
    return { set, mode, going };
  }

  /**
   * Worker `aloneFirstApplies` (B8): the alone set changes at least one resource and every one is
   * the resource of a mount named by a required policy check marked `gatesAlone`.
   */
  private aloneFirstApplies(changed: ReadonlySet<string>): boolean {
    if (changed.size === 0) return false;
    const covered = new Set<string>();
    for (const c of this.policy.checks ?? []) {
      if (c.required === false || c.gatesAlone !== true) continue;
      for (const m of this.mountsOf(FIXTURE_PROJECT)) if (m.mountName === c.mountName) covered.add(m.resourceId);
    }
    return [...changed].every((r) => covered.has(r));
  }

  /** The owner baseline (B6): staging starts after the first production publish, here the live release. */
  private stagingBaseline() {
    return this.releases.find((r) => r.v.releaseId === this.liveRelease) ?? null;
  }

  /** Worker `goingWithoutText`. */
  private goingWithout(ids: readonly string[]): PromotionView["goingWithout"] {
    return ids.map((id) => {
      const l = this.landings.find((x) => x.landingId === id)!;
      const title = this.taskTitle(l.taskId);
      return { landingId: id, taskId: l.taskId, title, text: `Going to production without '${title}' (${l.state === "promoting" ? "being promoted separately" : "still in staging"})` };
    });
  }

  /** The set's files on top of the current `main` heads, one result revision per resource it changes. */
  private buildResults(p: FakePromotion): FakePromotion["resources"] {
    const byMount = new Map<string, FakeEdit[]>();
    for (const id of p.landingIds) {
      const l = this.landings.find((x) => x.landingId === id)!;
      for (const e of this.taskInfo.get(l.taskId)?.edits ?? []) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
    }
    const out: FakePromotion["resources"] = [];
    for (const [mountName, edits] of byMount) {
      const { r } = this.mount(mountName);
      const files: Files = { ...(r.revisions.get(r.head) ?? {}) };
      for (const e of edits) {
        if (e.content === null) delete files[e.path];
        else files[e.path] = e.content;
      }
      const result = ART(r.repoId, `prm-${p.promotionId}-${r.head}`);
      r.revisions.set(result, files);
      out.push({ resourceId: r.resourceId, mountName, head: r.head, result });
    }
    return out;
  }

  /** The promotion proposal (`kind: "promotion"`), built on the current `main`. */
  private buildPromotionProposal(p: FakePromotion) {
    const proposalId = `prop-pro-${fakeHex(`pro-${p.promotionId}-${p.resources.map((r) => r.result).join()}`, 8)}-4000-8000-${fakeHex(`pro-${p.promotionId}-tail`, 12)}`;
    const at = this.nowIso();
    const candidates: Proposal["candidates"] = p.resources.map((x) => {
      const sha = x.result.split(":").pop()!;
      const changed = p.landingIds.flatMap((id) => this.taskInfo.get(this.landings.find((l) => l.landingId === id)!.taskId)?.edits ?? []).filter((e) => e.mount === x.mountName).map((e) => e.path);
      return { candidateId: `cand:tw-pro-${x.mountName}:${sha}`, taskWorkspaceId: `tw-pro-${x.mountName}`, resourceId: x.resourceId, baseRevision: x.head, sha, treeId: fakeHex(`${x.result}-tree`), frozenAt: at, submitter: { kind: "service", id: "promotion-service" }, changedPaths: [...new Set(changed)].sort(), state: "prepared", preparedReceiptId: `rcpt-${fakeHex(x.result, 12)}` };
    });
    this.addProposal(proposalId, `chg-${fakeHex(`chg-${p.promotionId}`, 8)}-0000-4000-8000-${fakeHex(`chg-${p.promotionId}-tail`, 12)}`, candidates, [], "prepared", at, "pass");
    this.proposals.get(proposalId)!.kind = "promotion";
    p.proposalId = proposalId;
  }

  /** The gate (Worker `gatePromotion`): path levels, the migration veto (core's linter), then the classifier for `classify`. */
  private gatePromotion(p: FakePromotion): PromotionGate {
    const staging = this.policy.staging as typeof STAGING_POLICY_SECTION | undefined;
    const release = this.policy.release as typeof STAGING_RELEASE_SECTION | undefined;
    const paths = [...new Set(p.landingIds.flatMap((id) => this.landingPaths(this.landings.find((l) => l.landingId === id)!)))];
    const notAsked = { asked: false, cleared: false, reason: "not_needed" } as const;
    try {
      const { level: pathLevel, perPath } = promotionLevel((staging?.promotion?.rules ?? []) as PromotionRule[], paths);
      // the migration folders that run on staging and production, resolved to their mounts
      const mountOf = new Map((release?.targets ?? []).map((t) => [t.targetId, t.mountName]));
      const folders = new Set<string>();
      for (const [targetId, env] of Object.entries(staging?.environment ?? {})) for (const d of env.d1 ?? []) if (d.migrationsDir && mountOf.get(targetId)) folders.add(`${mountOf.get(targetId)}/${d.migrationsDir.replace(/\/+$/, "")}`);
      for (const m of release?.migrations ?? []) if (mountOf.get(m.targetId)) folders.add(`${mountOf.get(m.targetId)}/${m.dir.replace(/\/+$/, "")}`);
      const offending: PromotionGate["veto"]["offending"] = [];
      let checked = false;
      for (const folder of folders) {
        if (!paths.some((x) => x.startsWith(`${folder}/`))) continue;
        checked = true;
        const [mountName, ...rest] = folder.split("/");
        const dir = rest.join("/");
        const res = p.resources.find((x) => x.mountName === mountName);
        const { r } = this.mount(mountName!);
        const sql = (rev: string) => Object.fromEntries(Object.entries(r.revisions.get(rev) ?? {}).filter(([k, v]) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/") && k.endsWith(".sql") && typeof v === "string").map(([k, v]) => [k.slice(dir.length + 1), v as string]));
        for (const o of lintMigrations(sql(res?.head ?? r.head), sql(res?.result ?? r.head)).offending) offending.push({ file: `${folder}/${o.file}`, statement: o.statement });
      }
      const veto: PromotionGate["veto"] = checked ? { kind: offending.length ? "destructive" : "additive", offending } : { kind: "none", offending: [] };
      if (veto.kind === "destructive") return { pathLevel, perPath, veto, classifier: notAsked, reasonCode: "migration_destructive" };
      if (pathLevel === "developer") return { pathLevel, perPath, veto, classifier: notAsked, reasonCode: "developer_paths" };
      if (pathLevel === "self") return { pathLevel, perPath, veto, classifier: notAsked, reasonCode: "self" };
      const evidence = this.classify(p, staging?.promotion?.classifier?.threshold ?? 0.9);
      if (evidence.error === null && evidence.cleared && evidence.failed === null && evidence.answers !== null) return { pathLevel, perPath, veto, classifier: { asked: true, cleared: true, reason: "cleared", evidence }, reasonCode: "classifier" };
      if (evidence.error !== null) return { pathLevel, perPath, veto, classifier: { asked: true, cleared: false, reason: "error", evidence }, reasonCode: "classifier_unavailable" };
      return { pathLevel, perPath, veto, classifier: { asked: true, cleared: false, reason: "declined", evidence }, reasonCode: "classifier_declined" };
    } catch {
      return { pathLevel: "developer", perPath: [], veto: { kind: "destructive", offending: [{ file: "(gate)", statement: "(migrations could not be checked)" }] }, classifier: notAsked, reasonCode: "gate_error" };
    }
  }

  /**
   * The fixture's classifier (Jev): answers per `classifierOutcome`, decided like core `riskClears`
   * (the safe options' probabilities summed). The evidence has core `RiskEvidenceSchema`'s shape;
   * `unavailable` is the Worker's timeout evidence (no answers, no probabilities, `failed: null`).
   */
  private classify(p: FakePromotion, threshold: number): RiskEvidence {
    const inputDigest = fakeHex(`risk-input-${p.promotionId}-${p.resources.map((r) => r.result).join()}`, 64);
    const edits = p.landingIds.flatMap((id) => this.taskInfo.get(this.landings.find((l) => l.landingId === id)!.taskId)?.edits ?? []);
    const inputBytes = 512 + edits.reduce((n, e) => n + e.path.length + (e.content?.length ?? 0), 0);
    const base = { provider: "jev", model: "jev-1.13.0", threshold, inputDigest, truncated: false, omittedFiles: 0, inputBytes };
    if (this.classifierOutcome === "unavailable") return { ...base, latencyMs: 5000, answers: null, safeProbability: null, cleared: false, failed: null, error: "timeout" };
    // P3-11: a file the input needs was not read, so the classifier is never asked (Worker `runClassifier`)
    if (this.classifierOutcome === "incomplete") return { ...base, latencyMs: null, answers: null, safeProbability: null, cleared: false, failed: null, error: "input_incomplete", incomplete: ["file_not_read"] };
    const outcome = this.classifierOutcome;
    const answers = Object.fromEntries((Object.keys(RISK_OPTIONS) as RiskQuestionId[]).map((q) => [q, structuredClone(outcome === "live" ? LIVE_ANSWERS[q] : outcome === q ? UNSAFE_ANSWERS[q] : SAFE_ANSWERS[q])])) as Record<RiskQuestionId, RiskAnswer>;
    const safeProbability: Record<string, number> = {};
    let failed: RiskQuestionId | null = null;
    for (const q of Object.keys(RISK_OPTIONS) as RiskQuestionId[]) {
      const safe = Math.round(RISK_OPTIONS[q].safe.reduce((sum, o) => sum + (answers[q].probabilities[o] ?? 0), 0) * 1000) / 1000;
      safeProbability[q] = safe;
      if (failed === null && safe < threshold) failed = q;
    }
    return { ...base, latencyMs: 1840, answers, safeProbability, cleared: failed === null, failed, error: null };
  }

  /**
   * A rebuild's gate when the clearance is carried (Worker `gatePromotion`, P3-11): over a `classify`
   * level a `classifier` clearance keeps its evidence and is not asked again (reasonCode
   * `classifier`); a `developer` one is `carried`. Other levels gate as before.
   */
  private carryGate(p: FakePromotion) {
    const g = p.gate;
    if (!g || g.pathLevel !== "classify" || g.veto.kind === "destructive" || !p.clearance) return;
    if (p.clearance.kind === "developer") p.gate = { ...g, classifier: { asked: false, cleared: false, reason: "carried" }, reasonCode: "carried" };
    else if (p.clearance.kind === "classifier" && g.classifier.evidence) p.gate = { ...g, classifier: { asked: false, cleared: true, reason: "carried", evidence: g.classifier.evidence }, reasonCode: "classifier" };
    else return;
    p.level = "classify";
  }

  private clear(p: FakePromotion, kind: ClearanceKind, clearedBy: string) {
    p.state = "cleared";
    p.clearance = { kind, clearedBy, clearedAt: this.nowIso() };
    p.reasonCode = null;
    p.reason = null;
    this.promotionEvent(p, "promotion.cleared", kind);
  }

  private promotionEvent(p: FakePromotion, action: string, code: string, extra: Record<string, unknown> = {}) {
    this.event(this.nowIso(), action, "promotion", p.promotionId, { kind: "service", id: "promotion-service" }, { promotionId: p.promotionId, code, ...extra }, { promotionId: p.promotionId, code });
  }

  /** One machine step (Worker `next`); false when the promotion waits for a person or ended. */
  private promotionStep(p: FakePromotion): boolean {
    const touch = () => (p.updatedAt = this.nowIso());
    switch (p.state) {
      case "requested":
        p.resources = this.buildResults(p);
        this.buildPromotionProposal(p);
        p.state = "building";
        touch();
        return true;
      case "building": {
        const fp = this.proposals.get(p.proposalId!)!;
        this.finishRun(fp, "pass", p.updatedAt, this.nowIso(), `job-${fakeHex(`pro-run-${p.promotionId}-${this.now()}`, 24)}`);
        p.checks = { checks: fp.integration!.checks.map((c) => ({ checkId: c.checkId, result: c.result })), contractChecks: fp.integration!.contractChecks.map((c) => ({ ...c })), mergeOutcome: fp.integration!.mergeOutcome.map((m) => ({ ...m })) };
        p.state = "gating";
        touch();
        return true;
      }
      case "gating": {
        const g = this.gatePromotion(p);
        p.gate = g;
        // after the veto and the classifier (Worker `GateResult.level`): `classify` only when the classifier cleared it
        p.level = g.reasonCode === "self" ? "self" : g.reasonCode === "classifier" ? "classify" : "developer";
        touch();
        if (g.reasonCode === "self") this.clear(p, "self", p.requestedBy);
        else if (g.reasonCode === "classifier") this.clear(p, "classifier", p.requestedBy);
        else if (p.requestedBy === "u-owner" && (this.policy.approvalRoles ?? []).includes("owner")) this.clear(p, "developer", p.requestedBy);
        else {
          const code = g.reasonCode;
          p.state = "pending_approval";
          p.reasonCode = code;
          p.reason = code === "classifier_declined" ? CLASSIFIER_DECLINED_TEXT[g.classifier.evidence?.failed ?? "addressedToReviewer"] : GATE_REASON_TEXT[code as keyof typeof GATE_REASON_TEXT];
          p.clearance = null;
          // Worker `gate()`: the developer-only detail names the classifier's error
          const ev = g.classifier.evidence;
          p.detail = ev?.error ? `classifier: ${ev.error}${ev.incomplete?.length ? ` (${ev.incomplete.join(", ")})` : ""}` : null;
          this.promotionEvent(p, "promotion.pending_approval", code, { level: p.level });
          return false;
        }
        return true;
      }
      case "cleared": {
        // production is taken by one promotion at a time (B2); the others wait in clearance order
        const holder = this.promotions.find((x) => x !== p && (x.state === "accepting" || x.state === "releasing"));
        if (holder) {
          p.reasonCode = "production_busy";
          p.reason = PROMOTION_REASONS.productionBusy;
          return true;
        }
        p.reasonCode = null;
        p.reason = null;
        p.state = "accepting";
        touch();
        return true;
      }
      case "accepting": {
        // `main` moved since the build (another promotion went live): rebuilt on the new heads, the clearance carried
        if (p.resources.some((x) => this.resources.get(x.resourceId)!.head !== x.head)) {
          p.resources = this.buildResults(p);
          this.carryGate(p);
        }
        const fp = this.proposals.get(p.proposalId!)!;
        p.acceptedVersionId = this.commitVersion("accept", fp.p.proposalId, fp.p.proposalHash, p.resources.map((x) => ({ resourceId: x.resourceId, revisionId: x.result })), { kind: "service", id: "promotion-service" });
        fp.p.state = "accepted";
        this.event(this.nowIso(), "proposal.accepted", "proposal", fp.p.proposalId, { kind: "service", id: "promotion-service" }, { acceptedVersionId: p.acceptedVersionId, proposalHash: fp.p.proposalHash, promotionId: p.promotionId }, { promotionId: p.promotionId });
        this.promotionEvent(p, "promotion.accepted", "accepted");
        p.state = "releasing";
        // the Worker (finishAccept) moves the landings to `promoted` with the accept, not at live:
        // a failed release keeps them promoted (the change is in `main`; the release is retried)
        for (const id of p.landingIds) {
          const l = this.landings.find((x) => x.landingId === id)!;
          if (l.state !== "promoting" && l.state !== "failed") continue;
          l.state = "promoted";
          this.event(this.nowIso(), "staging.promoted", "task", l.taskId, { kind: "service", id: "promotion-service" }, {}, {});
        }
        touch();
        return true;
      }
      case "releasing": {
        touch();
        if (p.failRelease) {
          p.failRelease = false;
          p.state = "release_failed";
          p.reasonCode = "deploy_failed";
          p.reason = PROMOTION_REASONS.releaseFailed;
          p.detail = "deploy of target website failed: the fixture's simulated deploy error";
          this.promotionEvent(p, "promotion.release_failed", "deploy_failed", { channel: "production", reason: p.reason });
          return false;
        }
        this.seedLiveRelease(p.acceptedVersionId!, this.nowIso());
        p.releaseId = this.liveRelease;
        p.state = "live";
        p.reasonCode = null;
        p.reason = null;
        p.detail = null;
        this.event(this.nowIso(), "release.live", "release", p.releaseId!, { kind: "service", id: "promotion-service" }, { channel: "production" }, { channel: "production" });
        this.promotionEvent(p, "promotion.live", "live");
        return false;
      }
      default:
        return false;
    }
  }

  /** End a promotion before it was accepted (sent back, withdrawn): landings back to `landed`, the clearance void, its proposal closed. */
  private endPromotion(p: FakePromotion, state: PromotionState, reasonCode: string, reason: string, action: string) {
    p.state = state;
    p.reasonCode = reasonCode;
    p.reason = reason;
    p.detail = null;
    p.clearance = null;
    p.updatedAt = this.nowIso();
    for (const id of p.landingIds) {
      const l = this.landings.find((x) => x.landingId === id)!;
      if (l.state === "promoting") l.state = "landed";
    }
    const fp = p.proposalId ? this.proposals.get(p.proposalId) : undefined;
    if (fp && fp.p.state !== "accepted") fp.p.state = "superseded";
    this.event(this.nowIso(), action, "promotion", p.promotionId, { kind: "user", id: this.actingUser() }, { promotionId: p.promotionId, code: reasonCode }, { promotionId: p.promotionId, code: reasonCode });
  }

  /**
   * Worker `promotionView`'s developer rule: owners, and developers with read on every resource the
   * promotion changes (before it is built: every folder its tasks name).
   */
  private promotionDeveloperView(p: FakePromotion): boolean {
    if (this.role === "owner") return true;
    if (this.role !== "developer") return false;
    const rids = p.resources.length
      ? p.resources.map((x) => x.resourceId)
      : p.landingIds.flatMap((id) => {
          const info = this.taskInfo.get(this.landings.find((l) => l.landingId === id)!.taskId);
          return [...(info?.writeMounts ?? []), ...(info?.readMounts ?? [])].map((m) => this.mountsOf(FIXTURE_PROJECT).find((x) => x.mountName === m)?.resourceId).filter((x): x is string => !!x);
        });
    return rids.every((r) => this.folderOps(r).includes("read"));
  }

  /**
   * Worker `promotionView`: clients and viewers get the base (reasons only for their own); owners
   * and developers with read on everything it changes get everything (other developers the base,
   * with reasons by the client rule).
   */
  private promotionView(p: FakePromotion): PromotionView {
    const rows = p.landingIds.map((id) => this.landings.find((l) => l.landingId === id)!);
    const dev = this.promotionDeveloperView(p);
    const own = dev || p.requestedBy === this.actingUser() || rows.some((l) => l.createdBy === this.actingUser());
    const base: PromotionView = {
      promotionId: p.promotionId,
      state: p.state,
      landings: rows.map((l) => ({ landingId: l.landingId, taskId: l.taskId, title: this.taskTitle(l.taskId), state: l.state })),
      level: p.level,
      reasonCode: own ? p.reasonCode : null,
      reason: own ? p.reason : null,
      waitingForProduction: p.state === "cleared" && p.reasonCode === "production_busy",
      mode: p.mode,
      goingWithout: this.goingWithout(p.goingWithout),
      needs: [],
    };
    if (!dev) return structuredClone(base);
    const fp = p.proposalId ? this.proposals.get(p.proposalId) : undefined;
    return structuredClone({
      ...base,
      landings: rows.map((l) => ({ landingId: l.landingId, taskId: l.taskId, title: this.taskTitle(l.taskId), state: l.state, request: this.taskInfo.get(l.taskId)?.request ?? "", parts: [{ part: 1, taskId: l.taskId, title: this.taskTitle(l.taskId) }] })),
      targetLandingId: p.targetLandingId,
      proposalId: p.proposalId,
      proposalHash: fp?.p.proposalHash ?? null,
      gate: p.gate,
      detail: p.detail,
      clearance: p.clearance,
      acceptedVersionId: p.acceptedVersionId,
      releaseId: p.releaseId,
      requestedBy: p.requestedBy,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      resources: p.checks ? p.resources : [],
      checks: p.checks,
    });
  }

  private readablePromotion(org: string, id: string) {
    this.org(org);
    const p = this.promotions.find((x) => x.promotionId === id);
    if (!p) throw new ApiError(404, "not_found", "promotion not found");
    this.stagingTick();
    return p;
  }

  async getStaging(org: string, pid: string): Promise<StagingView> {
    this.log("getStaging", org, pid);
    this.project(org, pid);
    if (!this.stagingMode(pid)) return { enabled: false, url: null, current: null, building: false, landings: [] };
    this.stagingTick();
    const dev = this.isDev();
    const own = (l: FakeLanding) => dev || l.createdBy === this.actingUser();
    const live = this.stagingBaseline();
    const promotionOf = (l: FakeLanding) => {
      const p = [...this.promotions].reverse().find((x) => x.landingIds.includes(l.landingId));
      return p ? { promotionId: p.promotionId, state: p.state } : null;
    };
    const landings: StagingLanding[] = [...this.landings]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 100)
      .map((l) => ({
        landingId: l.landingId,
        taskId: l.taskId,
        title: this.taskTitle(l.taskId),
        state: l.state,
        reasonCode: own(l) ? l.reasonCode : null,
        reason: own(l) ? l.reason : null,
        ...(dev ? { detail: l.detail } : {}),
        promotion: promotionOf(l),
        ...(own(l) ? { parts: [{ part: 1, taskId: l.taskId }] } : {}),
        ...(dev ? { travelsWith: [] } : {}),
        createdBy: l.createdBy,
        createdAt: l.createdAt,
      }));
    return structuredClone({
      enabled: true as const,
      state: live ? ("active" as const) : ("awaiting_baseline" as const),
      stateText: live ? null : "Waiting for the owner's first production publish.",
      baseline: live ? { ...(dev ? { releaseId: live.v.releaseId } : {}), since: live.v.createdAt } : null,
      url: this.stagingUrl(),
      current: this.stagingCurrent,
      building: this.stagingBuild !== null,
      landings,
    });
  }

  async resetStaging(org: string, pid: string) {
    this.log("resetStaging", org, pid);
    this.project(org, pid);
    if (this.role === "viewer") throw new ApiError(403, "insufficient_role", "requires one of: owner, developer, client");
    if (!this.stagingMode(pid)) throw new ApiError(404, "not_found", "this project has no staging");
    this.stagingTick();
    if (!this.stagingBaseline()) throw new ApiError(409, "staging_awaiting_baseline", "Staging starts after the owner's first production publish");
    return { buildId: this.requestStagingBuild(true) };
  }

  async listCaptures(org: string, pid: string): Promise<Capture[]> {
    this.log("listCaptures", org, pid);
    this.project(org, pid);
    return pid === FIXTURE_PROJECT ? structuredClone(this.captures) : [];
  }

  async rollbackTask(taskId: string) {
    this.log("rollbackTask", taskId);
    this.stagingTask(taskId);
    this.stagingTick();
    const l = this.landingOfTask(taskId);
    if (l?.state === "promoting") throw new ApiError(409, "promotion_in_progress", "this task is being promoted to production; a developer can send the promotion back first");
    if (!l) throw new ApiError(409, "not_in_staging", "this task is not in staging");
    l.state = "rolling_back";
    this.event(this.nowIso(), "staging.rolling_back", "task", taskId, { kind: "user", id: this.actingUser() }, {}, {});
    return { buildId: this.requestStagingBuild() };
  }

  async listPromotions(org: string, pid: string, states?: PromotionState[]): Promise<PromotionView[]> {
    this.log("listPromotions", org, pid, states);
    this.project(org, pid);
    if (this.role === "viewer") throw new ApiError(403, "insufficient_role", "requires one of: owner, developer, client");
    if (pid !== FIXTURE_PROJECT) return [];
    this.stagingTick();
    // as the Worker: the promotions a client requested, or that carry a landing they created
    const mine = (p: FakePromotion) => this.isDev() || p.requestedBy === this.actingUser() || p.landingIds.some((id) => this.landings.find((l) => l.landingId === id)?.createdBy === this.actingUser());
    return [...this.promotions]
      .reverse()
      .filter((p) => mine(p) && (!states?.length || states.includes(p.state)))
      .slice(0, 100)
      .map((p) => {
        // list rows never carry resources or checks (read them with getPromotion)
        const { resources: _r, checks: _c, ...row } = this.promotionView(p);
        return row;
      });
  }

  async getPromotion(org: string, id: string): Promise<PromotionView> {
    this.log("getPromotion", org, id);
    return this.promotionView(this.readablePromotion(org, id));
  }

  async previewPromotion(taskId: string): Promise<PromotionPreview> {
    this.log("previewPromotion", taskId);
    this.stagingTick();
    const { set, mode, going } = this.planPromotion(taskId);
    return { landings: set.map((l) => ({ landingId: l.landingId, taskId: l.taskId, title: this.taskTitle(l.taskId) })), mode, goingWithout: this.goingWithout(going.map((l) => l.landingId)) };
  }

  async promoteTask(taskId: string): Promise<PromoteResult> {
    this.log("promoteTask", taskId);
    this.stagingTick();
    const { set, mode, going } = this.planPromotion(taskId);
    const at = this.nowIso();
    const promotionId = `prm-${fakeHex(`prm-${this.promotions.length}-${taskId}-${this.now()}`, 10)}`;
    const p: FakePromotion = {
      promotionId,
      state: "requested",
      landingIds: set.map((l) => l.landingId),
      targetLandingId: this.landingOfTask(taskId)!.landingId,
      mode,
      goingWithout: going.map((l) => l.landingId),
      requestedBy: this.actingUser(),
      createdAt: at,
      updatedAt: at,
      stepAt: this.now() + this.promotionStepMs,
      level: null,
      gate: null,
      reasonCode: null,
      reason: null,
      detail: null,
      clearance: null,
      proposalId: null,
      acceptedVersionId: null,
      releaseId: null,
      resources: [],
      checks: null,
      failRelease: this.failNextPromotionRelease,
    };
    this.failNextPromotionRelease = false;
    for (const l of set) l.state = "promoting";
    this.promotions.push(p);
    this.event(at, "promotion.requested", "promotion", promotionId, { kind: "user", id: this.actingUser() }, { promotionId, code: "requested", landings: p.landingIds, mode, ...(going.length ? { goingWithout: p.goingWithout } : {}) }, { promotionId, code: "requested" });
    return { promotionId, landings: set.map((l) => ({ landingId: l.landingId, taskId: l.taskId })), mode, goingWithout: this.goingWithout(p.goingWithout) };
  }

  async approvePromotion(org: string, id: string): Promise<PromotionView> {
    this.log("approvePromotion", org, id);
    this.org(org);
    if (!this.isDev()) throw new ApiError(403, "insufficient_role", "requires one of: owner, developer");
    const p = this.readablePromotion(org, id);
    if (!(this.policy.approvalRoles ?? ["owner", "developer", "client"]).includes(this.role)) throw new ApiError(403, "approval_role_not_allowed", "this project does not accept approvals from your role");
    if (p.state !== "pending_approval") throw new ApiError(409, "promotion_not_pending", `the promotion is ${p.state}, not waiting for approval`);
    this.clear(p, "developer", this.actingUser());
    p.updatedAt = this.nowIso();
    p.stepAt = this.now() + this.promotionStepMs;
    return this.promotionView(p);
  }

  async sendBackPromotion(org: string, id: string, note: string): Promise<PromotionView> {
    this.log("sendBackPromotion", org, id, note);
    this.org(org);
    if (!this.isDev()) throw new ApiError(403, "insufficient_role", "requires one of: owner, developer");
    const text = note.trim();
    if (text.length < 1 || text.length > 2000) throw new ApiError(400, "invalid_request", "note: must be 1 to 2000 characters");
    const p = this.readablePromotion(org, id);
    if (p.state !== "pending_approval" && p.state !== "cleared") throw new ApiError(409, "promotion_not_pending", `the promotion is ${p.state}; it can no longer be sent back`);
    this.endPromotion(p, "sent_back", "sent_back", text, "promotion.sent_back");
    return this.promotionView(p);
  }

  async withdrawPromotion(org: string, id: string): Promise<PromotionView> {
    this.log("withdrawPromotion", org, id);
    const p = this.readablePromotion(org, id);
    if (!this.isDev() && p.requestedBy !== this.actingUser()) throw new ApiError(403, "not_promotion_requester", "only the client who requested this promotion, an owner or a developer can withdraw it");
    if (ACCEPTED.includes(p.state)) throw new ApiError(409, "promotion_accepted", "this promotion was accepted into production; a failed release is retried, not withdrawn");
    if (!BEFORE_ACCEPT.includes(p.state)) throw new ApiError(409, "promotion_not_in_flight", `the promotion is ${p.state}; it is no longer in flight`);
    this.endPromotion(p, "withdrawn", "withdrawn", PROMOTION_REASONS.withdrawn, "promotion.withdrawn");
    return this.promotionView(p);
  }

  async retryPromotionRelease(org: string, id: string): Promise<PromotionView> {
    this.log("retryPromotionRelease", org, id);
    this.org(org);
    if (!this.isDev()) throw new ApiError(403, "insufficient_role", "requires one of: owner, developer");
    const p = this.readablePromotion(org, id);
    // write on every resource the release deploys from (its recipe's and targets' mounts) and the promotion changes, like the Worker route
    const release = this.policy.release as typeof STAGING_RELEASE_SECTION | undefined;
    const names = new Set([...(release?.recipe.steps ?? []), ...(release?.targets ?? [])].map((x) => x.mountName));
    const needs = new Set([...this.mountsOf(FIXTURE_PROJECT).filter((m) => names.has(m.mountName)).map((m) => m.resourceId), ...p.resources.map((x) => x.resourceId)]);
    for (const r of needs) if (!this.folderOps(r).includes("write")) throw new ApiError(403, "no_write_grant", `no write grant on ${r}`);
    if (p.state !== "release_failed") throw new ApiError(409, "promotion_not_release_failed", `the promotion is ${p.state}; only a failed release can be retried`);
    const holder = this.promotions.find((x) => x !== p && (x.state === "accepting" || x.state === "releasing"));
    if (holder) throw new ApiError(409, "production_busy", "another promotion is updating production; retry when it finishes", { promotionId: holder.promotionId });
    p.state = "releasing";
    p.reasonCode = null;
    p.reason = null;
    p.detail = null;
    p.updatedAt = this.nowIso();
    p.stepAt = this.now() + this.promotionStepMs;
    this.promotionEvent(p, "promotion.release_retried", "release_retried", { channel: "production" });
    return this.promotionView(p);
  }

  /** `POST …/projects/:pid/tasks` (Worker `routes/tasks.ts` and `services/task-create.ts`). */
  async createTask(org: string, pid: string, body: CreateTaskInput): Promise<TaskView> {
    this.log("createTask", org, pid, body);
    this.project(org, pid);
    // clients only in a staging-mode project; anything else answers as for a client without it
    if (!this.isDev() && !(this.role === "client" && this.stagingMode(pid))) throw new ApiError(403, "insufficient_role", "requires one of: owner, developer");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const request = body.request ?? "";
    const issue =
      title.length < 1 || title.length > 200
        ? "title: must be 1 to 200 characters"
        : request.length > 16_000
          ? "request: at most 16000 characters"
          : body.writeMounts !== undefined && (!Array.isArray(body.writeMounts) || body.writeMounts.length < 1 || body.writeMounts.length > 16)
            ? "writeMounts: 1 to 16 folders"
            : body.readMounts !== undefined && body.readMounts.length > 32
              ? "readMounts: at most 32 folders"
              : null;
    if (issue) throw new ApiError(400, "invalid_request", issue);
    const canRead = (m: Mount) => this.folderOps(m.resourceId).includes("read");
    // none named: every folder the person may start a task in that has a first version (Worker defaultWriteMounts)
    const writes = body.writeMounts ? [...new Set(body.writeMounts)] : this.mountsOf(pid).filter((m) => canRead(m) && this.mountCanStartTask(pid, m) && !!this.resources.get(m.resourceId)?.head).map((m) => m.mountName);
    if (!writes.length) throw new ApiError(403, "no_write_grant", "there is no folder you can start a task in in this project; ask your developer to open one for changes");
    for (const name of writes) {
      const m = this.mountsOf(pid).find((x) => x.mountName === name);
      if (!m || !canRead(m)) throw new ApiError(404, "not_found", `mount ${name} not found`);
      const r = this.resources.get(m.resourceId)!;
      if (this.role === "client") {
        // staging mode: a client writes only task copies of git folders the owner opened for writing
        if (!m.operations.includes("write")) throw new ApiError(403, "mount_read_only", `mount ${name} is read-only in this project`);
        if (r.provider !== "artifacts" || !this.folderOps(m.resourceId).includes("write")) throw new ApiError(403, "no_write_grant", `no write grant on mount ${name}`);
      } else {
        if (!this.folderOps(m.resourceId).includes("write")) throw new ApiError(403, "no_write_grant", `no write grant on mount ${name}`);
        if (!m.operations.includes("write")) throw new ApiError(403, "mount_read_only", `mount ${name} is read-only in this project`);
      }
      if (!r.head) throw new ApiError(409, "no_accepted_head", `mount ${name} has no accepted version`);
    }
    const reads = body.readMounts ? [...new Set(body.readMounts)] : this.mountsOf(pid).filter((m) => !writes.includes(m.mountName) && canRead(m)).map((m) => m.mountName);
    for (const name of reads) {
      const m = this.mountsOf(pid).find((x) => x.mountName === name);
      if (!m || !canRead(m)) throw new ApiError(404, "not_found", `mount ${name} not found`);
    }
    const n = this.tasks.length;
    const taskId = `task-${fakeHex(`new-task-${n}-${this.now()}`, 8)}-0000-4000-8000-${fakeHex(`new-task-${n}-tail`, 12)}`;
    const changeId = `chg-${fakeHex(`new-chg-${taskId}`, 8)}-0000-4000-8000-${fakeHex(`new-chg-${taskId}-tail`, 12)}`;
    const at = this.nowIso();
    // the agent's work, simulated: one line in each folder's CHANGES.md
    const edits: FakeEdit[] = writes.map((mount) => {
      const { r } = this.mount(mount, pid);
      const before = r.revisions.get(r.head)?.["CHANGES.md"];
      return { mount, path: "CHANGES.md", content: `${typeof before === "string" ? before : "# Changes\n\n"}- ${title}\n` };
    });
    this.tasks.unshift({ taskId, title, state: "provisioning", changeId, createdAt: at, updatedAt: at, leaseExpiresAt: null });
    this.taskInfo.set(taskId, { createdBy: this.actingUser(), request, writeMounts: writes, readMounts: reads, staging: this.stagingMode(pid), edits, readyAt: this.now() + this.promotionStepMs, updatedAt: at });
    this.event(at, "task.created", "task", taskId, { kind: "user", id: this.actingUser() }, { title }, {});
    const workspace = (mountName: string, access: "read" | "write"): TaskWorkspaceView | null => {
      const m = this.mountsOf(pid).find((x) => x.mountName === mountName)!;
      const r = this.resources.get(m.resourceId)!;
      // reference folders are read-only copies of git folders only (Worker I-6)
      if (access === "read" && r.provider !== "artifacts") return null;
      return { taskWorkspaceId: `tw-${fakeHex(`${taskId}-${mountName}`, 12)}`, mountName, resourceId: m.resourceId, provider: r.provider, access, baseRevision: r.head, state: "provisioning" };
    };
    const workspaces = [...writes.map((m) => workspace(m, "write")), ...reads.map((m) => workspace(m, "read"))].filter((w): w is TaskWorkspaceView => w !== null);
    return structuredClone({
      taskId,
      orgId: org,
      projectId: pid,
      changeId,
      title,
      request,
      state: "provisioning" as const,
      snapshot: { projectId: pid, entries: workspaces.map((w) => ({ resourceId: w.resourceId, revisionId: w.baseRevision, mountName: w.mountName, operations: w.access === "write" ? ["read", "write"] : ["read"] })) },
      lease: null,
      workspaces,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** `GET /tasks/:id`: owners and developers; a client only for a task they created in a staging-mode project. */
  async getTask(taskId: string): Promise<TaskView> {
    this.log("getTask", taskId);
    this.stagingTick();
    const t = this.tasks.find((x) => x.taskId === taskId);
    const info = this.taskInfo.get(taskId);
    const pid = FIXTURE_PROJECT;
    if (!t || (!this.isDev() && !(this.role === "client" && this.stagingMode(pid) && this.creatorOf(taskId) === this.actingUser()))) throw new ApiError(404, "not_found", "task not found");
    const writes = info?.writeMounts ?? [];
    const reads = info?.readMounts ?? [];
    const wsState = t.state === "provisioning" ? "provisioning" : t.state === "submitted" ? "frozen" : "writable";
    const workspaces: TaskWorkspaceView[] = [];
    for (const [mountName, access] of [...writes.map((m) => [m, "write"] as const), ...reads.map((m) => [m, "read"] as const)]) {
      const m = this.mountsOf(pid).find((x) => x.mountName === mountName);
      const r = m ? this.resources.get(m.resourceId) : undefined;
      if (!m || !r || (access === "read" && r.provider !== "artifacts")) continue;
      workspaces.push({ taskWorkspaceId: `tw-${fakeHex(`${taskId}-${mountName}`, 12)}`, mountName, resourceId: m.resourceId, provider: r.provider, access, baseRevision: r.head, state: access === "read" ? "writable" : wsState });
    }
    const snapshot = { projectId: pid, entries: [...writes.map((m) => ({ mountName: m, operations: ["read", "write"] })), ...reads.map((m) => ({ mountName: m, operations: ["read"] }))] };
    const lease = t.leaseExpiresAt ? { generation: 1, expiresAt: t.leaseExpiresAt, holder: this.isDev() ? (info?.createdBy ?? "u-developer") : null } : null;
    return structuredClone({ taskId, orgId: FIXTURE_ORG, projectId: pid, changeId: t.changeId, title: t.title, request: info?.request ?? "", state: t.state, snapshot, lease, workspaces, createdAt: t.createdAt, updatedAt: t.updatedAt ?? t.createdAt });
  }

  /**
   * `POST /orgs/:org/proposals {taskId}` outside staging (Worker `routes/proposals.ts`): owners and
   * developers; the task's submitted work becomes a proposal, prepared and ready to validate.
   */
  async createProposal(org: string, taskId: string): Promise<Proposal> {
    this.log("createProposal", org, taskId);
    this.needDev();
    const t = this.tasks.find((x) => x.taskId === taskId);
    const info = this.taskInfo.get(taskId);
    if (!t) throw new ApiError(404, "not_found", "task not found");
    if (this.stagingMode(FIXTURE_PROJECT)) throw new ApiError(409, "staging_proposal", "this project uses staging: promote the task instead");
    if (t.state !== "submitted" || !info) throw new ApiError(409, "candidate_not_available", "the task has no submitted work");
    const at = this.nowIso();
    const proposalId = `prop-${fakeHex(`prop-${taskId}-${this.proposals.size}`, 8)}-0000-4000-8000-${fakeHex(`prop-${taskId}-tail`, 12)}`;
    const byMount = new Map<string, FakeEdit[]>();
    for (const e of info.edits) byMount.set(e.mount, [...(byMount.get(e.mount) ?? []), e]);
    const candidates: Proposal["candidates"] = [];
    for (const [mountName, edits] of byMount) {
      const { r } = this.mount(mountName);
      const files: Files = { ...(r.revisions.get(r.head) ?? {}) };
      for (const e of edits) {
        if (e.content === null) delete files[e.path];
        else files[e.path] = e.content;
      }
      const result = ART(r.repoId, `task-${taskId}-${mountName}-${r.head}`);
      r.revisions.set(result, files);
      const sha = result.split(":").pop()!;
      candidates.push({ candidateId: `cand:tw-${fakeHex(`${taskId}-${mountName}`, 12)}:${sha}`, taskWorkspaceId: `tw-${fakeHex(`${taskId}-${mountName}`, 12)}`, resourceId: r.resourceId, baseRevision: r.head, sha, treeId: fakeHex(`${result}-tree`), frozenAt: info.updatedAt, submitter: { kind: "agent", id: `${taskId}:${info.createdBy}` }, changedPaths: edits.map((e) => e.path).sort(), state: "prepared", preparedReceiptId: `rcpt-${fakeHex(result, 12)}` });
    }
    this.addProposal(proposalId, t.changeId, candidates, [], "prepared", at, "pass");
    const fp = this.proposals.get(proposalId)!;
    this.proposalCreated(fp, at);
    return this.getProposal(org, proposalId);
  }

  /** Fixture control "Agent checks out": every task ready for an agent is leased (`cforge checkout`) and running. */
  checkOutReadyTasks() {
    this.stagingTick();
    for (const t of this.tasks) {
      const info = this.taskInfo.get(t.taskId);
      if (!info || t.state !== "ready") continue;
      t.state = "running";
      t.updatedAt = this.nowIso();
      t.leaseExpiresAt = new Date(this.now() + 3600_000).toISOString();
      info.updatedAt = t.updatedAt;
      this.event(t.updatedAt, "task.started", "task", t.taskId, { kind: "user", id: info.createdBy }, { leaseGeneration: 1 }, {});
    }
  }

  /** A staging task's agent submitted: the task becomes a landing (`checking`) and a staging build runs. */
  private landTask(t: TaskSummary, info: FakeTaskInfo) {
    t.state = "submitted";
    info.updatedAt = this.nowIso();
    t.updatedAt = info.updatedAt;
    this.event(this.nowIso(), "task.candidate_frozen", "candidate", `cand:tw-${fakeHex(t.taskId, 8)}:${fakeHex(`${t.taskId}-frozen`)}`, { kind: "agent", id: `${t.taskId}:${info.createdBy}` }, { taskId: t.taskId, changedPaths: info.edits.length });
    this.landings.push({ landingId: `lnd-${fakeHex(`lnd-${t.taskId}`, 12)}`, taskId: t.taskId, seq: ++this.stagingSeq, state: "checking", reasonCode: null, reason: null, detail: null, createdBy: info.createdBy, createdAt: this.nowIso() });
    this.event(this.nowIso(), "staging.landing_checking", "task", t.taskId, { kind: "service", id: "release-service" }, {}, {});
    this.requestStagingBuild();
  }

  /** The submitted repair of the quote change (A2), when Agent A is still repairing. */
  submitRepair() {
    const go = this.pendingRepair;
    this.pendingRepair = null;
    go?.();
  }

  completeRunningTasks() {
    this.submitRepair();
    for (const t of this.tasks) {
      // staging mode: a client's task (or one from New task) lands on staging when its agent submits
      const info = this.taskInfo.get(t.taskId);
      if (info) {
        const working = t.state === "provisioning" || t.state === "ready" || t.state === "running";
        if (info.staging && this.stagingMode(FIXTURE_PROJECT)) {
          if (working) this.landTask(t, info);
        } else if (working) {
          // outside staging the agent's submit freezes a candidate (no landing)
          t.state = "submitted";
          info.updatedAt = this.nowIso();
          t.updatedAt = info.updatedAt;
          this.event(this.nowIso(), "task.candidate_frozen", "candidate", `cand:tw-${fakeHex(t.taskId, 8)}:${fakeHex(`${t.taskId}-frozen`)}`, { kind: "agent", id: `${t.taskId}:${info.createdBy}` }, { taskId: t.taskId, changedPaths: info.edits.length });
        }
        continue;
      }
      if (t.state !== "running") continue;
      t.state = "submitted";
      this.event(this.nowIso(), "task.candidate_frozen", "candidate", `cand:tw-b:${fakeHex(t.taskId)}`, { kind: "agent", id: `${t.taskId}:u-developer` }, { taskId: t.taskId, changedPaths: 1 });
    }
  }
}

// ------------------------------------------------------------------------------- intake helpers

export interface ZipListing {
  entries: Array<{ path: string; size: number }>;
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * The file list of a ZIP from its central directory (names and uncompressed sizes; nothing is
 * extracted). Fixture mode only: the Worker's runner does the real inventory. null: not a ZIP.
 */
export function zipListing(bytes: Uint8Array): ZipListing | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) return null;
  const out: ZipListing = { entries: [], rejected: [] };
  let found = false;
  const dec = new TextDecoder();
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue;
    found = true;
    const size = dv.getUint32(i + 24, true);
    const n = dv.getUint16(i + 28, true);
    const extra = dv.getUint16(i + 30, true);
    const comment = dv.getUint16(i + 32, true);
    const path = dec.decode(bytes.subarray(i + 46, i + 46 + n));
    i += 45 + n + extra + comment;
    if (path.endsWith("/")) continue;
    if (path.startsWith("/") || path.split("/").includes("..")) out.rejected.push({ path, reason: "path_escape" });
    else out.entries.push({ path, size });
  }
  if (!found) {
    // an empty archive is just the end-of-central-directory record
    for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) return out;
    return null;
  }
  return out;
}

/** The Worker's secret-looking-name exclusion reason (`SECRET_NAME_REASON`): the only one an owner may override. */
export const SECRET_NAME_REASON = "looks like a credential file; blocked (content not inspected or shown)";

/** The Worker's `resolveIncludes` (apps/worker/src/services/intake.ts), for fixture mode. */
export function fakeResolveIncludes(plan: IntakePlan, listing: ZipListing, chosen: IntakePlan["placements"], include: string[]) {
  // every exclusion row of a path counts (a duplicate entry the inventory refused is never includable)
  const reasons = new Map<string, string[]>();
  for (const e of plan.excluded) reasons.set(e.path, [...(reasons.get(e.path) ?? []), e.reason]);
  const sizes = new Map(listing.entries.map((e) => [e.path, e.size]));
  const included: Array<{ path: string; resourceName: string }> = [];
  const refused: Array<{ path: string; why: "not_excluded" | "not_secret_name" | "oversize" | "no_placement" }> = [];
  for (const path of [...new Set(include)]) {
    const rows = reasons.get(path);
    const size = sizes.get(path);
    if (rows === undefined) refused.push({ path, why: "not_excluded" });
    else if (rows.some((r) => r !== SECRET_NAME_REASON) || size === undefined) refused.push({ path, why: "not_secret_name" });
    else if (size > 32 * 1024 * 1024) refused.push({ path, why: "oversize" });
    else {
      const segs = path.split("/");
      const prefix = segs.length > 1 ? `${segs[0]}/` : "";
      const into = chosen.find((p) => p.provider === "artifacts" && p.pathPrefix === prefix);
      if (into) included.push({ path, resourceName: into.resourceName });
      else refused.push({ path, why: "no_placement" });
    }
  }
  return { included, refused };
}

const MEDIA_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|mov|webm|mkv|mp3|wav|ogg|flac|pdf|psd|ai|zip|gz|tgz|woff2?|ttf|otf)$/i;
const SECRET_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc|service-account.*\.json)$/i;
const EXCLUDED_SEGMENTS: Record<string, string> = {
  node_modules: "dependency folder (reinstall from the lockfile)",
  ".git": "nested repository metadata (import the repository by URL to keep its history)",
  dist: "build output",
  build: "build output",
  ".next": "build output",
  ".turbo": "build cache",
  ".cache": "cache",
};

/** The Worker's deterministic placement rules (apps/worker/src/services/intake.ts), for fixture mode. */
export function fakePlacementPlan(inventory: ZipListing, archiveName: string): IntakePlan {
  const excluded: IntakePlan["excluded"] = inventory.rejected.map((r) => ({ path: r.path, reason: `refused by inventory: ${r.reason}` }));
  const code = new Map<string, { files: number; bytes: number }>();
  const assets = { files: 0, bytes: 0 };
  for (const e of inventory.entries) {
    const segs = e.path.split("/");
    const seg = segs.map((x) => x.toLowerCase()).find((x) => Object.hasOwn(EXCLUDED_SEGMENTS, x));
    if (seg) {
      excluded.push({ path: e.path, reason: EXCLUDED_SEGMENTS[seg]! });
      continue;
    }
    if (SECRET_RE.test(e.path)) {
      excluded.push({ path: e.path, reason: SECRET_NAME_REASON });
      continue;
    }
    if (e.size > 32 * 1024 * 1024 || MEDIA_RE.test(e.path)) {
      assets.files++;
      assets.bytes += e.size;
      continue;
    }
    const top = segs.length > 1 ? segs[0]! : "";
    const g = code.get(top) ?? { files: 0, bytes: 0 };
    g.files++;
    g.bytes += e.size;
    code.set(top, g);
  }
  const base = archiveName.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "upload";
  const placements: IntakePlan["placements"] = [];
  const rootOnly = code.size === 1 && code.has("");
  for (const [top, g] of [...code.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    placements.push({
      resourceName: top === "" ? base : top,
      provider: "artifacts",
      pathPrefix: top === "" ? "" : `${top}/`,
      files: g.files,
      bytes: g.bytes,
      reason: rootOnly ? "source files at the archive root" : top === "" ? "loose files at the archive root" : `top-level folder "${top}" kept as its own code resource`,
    });
  }
  if (assets.files > 0) placements.push({ resourceName: `${base}-assets`, provider: "r2-assets", pathPrefix: "", files: assets.files, bytes: assets.bytes, reason: "media/binary files and files over 32 MiB stay out of Git (R2 asset collection)" });
  return { placements, excluded };
}
