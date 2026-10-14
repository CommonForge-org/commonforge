/**
 * Worker HTTP surface (Hono). Routes are documented in apps/worker/API.md.
 *
 * `createWorker(deps)` returns the module handlers (`fetch`, `queue`); tests inject in-memory
 * doubles for Artifacts, email and the queues through `deps`.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { activeChaos } from "./chaos.js";
import { createServices, type AppEnv } from "./context.js";
import { defaultDeps, type Deps } from "./deps.js";
import type { Env } from "./env.js";
import { emailLogAllowed } from "./services/email.js";
import { clientView, taskOrgOf } from "./lib/client-view.js";
import { errorBody, toErrorResponse } from "./lib/http.js";
import { authenticate, csrfGuard } from "./middleware/authz.js";
import { authRoutes } from "./routes/auth.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { resourceRoutes } from "./routes/resources.js";
import { intakeRoutes } from "./routes/intake.js";
import { runnerRoutes } from "./routes/runner.js";
import { taskRoutes } from "./routes/tasks.js";
import { taskAssetRoutes } from "./routes/task-assets.js";
import { candidateRoutes } from "./routes/candidates.js";
import { proposalRoutes } from "./routes/proposals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { acceptRoutes } from "./routes/accept.js";
import { restoreRoutes } from "./routes/restore.js";
import { exportRoutes } from "./routes/export.js";
import { eventRoutes } from "./routes/events.js";
import { editionsRoutes } from "./routes/editions.js";
import { previewsRoutes } from "./routes/previews.js";
import { releasesRoutes } from "./routes/releases.js";
import { uploadRoutes } from "./routes/uploads.js";
import { lfsRoutes } from "./routes/lfs.js";
import { fileChangeRoutes } from "./routes/file-changes.js";
import { stagingRoutes } from "./routes/staging.js";
import { promotionRoutes } from "./routes/promotions.js";
import { ARTIFACT_EVENTS_QUEUE, handleArtifactEventsBatch } from "./services/artifact-events.js";
import { runGc } from "./services/gc.js";
import { OUTBOX_DLQ, OUTBOX_QUEUE, handleOutboxBatch, handleOutboxDeadLetters } from "./services/outbox-consumer.js";
import { handleStepBatch } from "./services/steps.js";
import "./services/lfs-hash.js"; // registers the lfs.hash queue step
import "./services/asset-changes.js"; // registers the files.assets.copy / files.assets.manifest steps (file collections)
import "./services/file-changes.js"; // registers the files.apply / files.candidate steps and the apply-files result
import "./services/folder-init.js"; // registers the folders.init step and the init-folder result

export function createApp(deps: Deps = defaultDeps) {
  const app = new Hono<AppEnv>();
  app.onError((e, c) => toErrorResponse(c, e));
  app.notFound((c) => c.json(errorBody("not_found", "route not found"), 404));

  app.get("/health", (c) => {
    const env = c.env as Env | undefined;
    const injected = activeChaos(env);
    if (!env) return c.json({ ok: true, service: "commonforge-worker" });
    // review m4/m8: which deployment this is, and whether its email mode is allowed here
    const emailMode = env.COMMONFORGE_EMAIL_MODE === "log" ? "log" : "send";
    const emailRefused = emailMode === "log" && !emailLogAllowed(env);
    return c.json({
      ok: !emailRefused,
      service: "commonforge-worker",
      deployment: env.COMMONFORGE_DEPLOYMENT || "production",
      emailMode,
      ...(emailRefused ? { problems: ["COMMONFORGE_EMAIL_MODE=log is refused outside a local or named non-production deployment"] } : {}),
      ...(injected.length ? { chaos: injected } : {}),
    });
  });

  // The web app (COMMONFORGE_APP_URL) calls the API with its session cookie.
  app.use("/api/*", (c, next) =>
    cors({
      origin: (origin) => (origin && origin === new URL(c.env.COMMONFORGE_APP_URL).origin ? origin : null),
      credentials: true,
      allowHeaders: ["content-type", "authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: 600,
    })(c, next),
  );
  app.use("/api/*", csrfGuard());
  app.use("/api/*", async (c, next) => {
    c.set("svc", createServices(c.env, deps));
    await next();
  });
  app.use("/api/*", authenticate());
  // O-1: clients and viewers never receive raw revision ids (lib/client-view.ts)
  app.use("/api/orgs/:org/*", clientView());
  app.use("/api/tasks/*", clientView(taskOrgOf));

  app.route("/api", authRoutes);
  app.route("/api", orgRoutes);
  app.route("/api", projectRoutes);
  app.route("/api", resourceRoutes);
  app.route("/api", intakeRoutes);
  app.route("/api", runnerRoutes);
  app.route("/api", taskRoutes);
  app.route("/api", taskAssetRoutes);
  app.route("/api", candidateRoutes);
  app.route("/api", proposalRoutes);
  app.route("/api", approvalRoutes);
  app.route("/api", acceptRoutes);
  app.route("/api", restoreRoutes);
  app.route("/api", exportRoutes);
  app.route("/api", eventRoutes);
  app.route("/api", editionsRoutes);
  app.route("/api", previewsRoutes);
  app.route("/api", releasesRoutes);
  app.route("/api", uploadRoutes);
  app.route("/api", lfsRoutes);
  app.route("/api", fileChangeRoutes);
  app.route("/api", stagingRoutes);
  app.route("/api", promotionRoutes);
  return app;
}

/** Queue name of the Worker-internal step queue (wrangler.jsonc). */
export const STEPS_QUEUE = "commonforge-steps";

/**
 * The queue name the dispatch switch knows, given the deployment's `COMMONFORGE_QUEUE_SUFFIX`
 * (queue names are account-wide, so a second deployment on the same account, e.g. CI, suffixes
 * every queue: `commonforge-steps-ci`). Without a suffix the name is unchanged.
 */
export function queueBaseName(queue: string, suffix: string | undefined): string {
  return suffix && queue.endsWith(suffix) && queue.length > suffix.length ? queue.slice(0, -suffix.length) : queue;
}

export type WorkerHandlers = Required<Pick<ExportedHandler<Env>, "fetch" | "queue" | "scheduled">>;

export function createWorker(deps: Deps = defaultDeps): WorkerHandlers {
  const app = createApp(deps);
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    async queue(batch: MessageBatch, env: Env): Promise<void> {
      const svc = createServices(env, deps);
      switch (queueBaseName(batch.queue, env.COMMONFORGE_QUEUE_SUFFIX)) {
        case STEPS_QUEUE:
          return handleStepBatch(svc, batch);
        case OUTBOX_QUEUE:
          return handleOutboxBatch(svc, batch);
        case OUTBOX_DLQ:
          return handleOutboxDeadLetters(svc, batch);
        case ARTIFACT_EVENTS_QUEUE:
          return handleArtifactEventsBatch(svc, batch);
        default:
          console.error(`no consumer for queue ${batch.queue}`);
          batch.retryAll({ delaySeconds: 300 });
      }
    },
    /** Cron (wrangler.jsonc `triggers.crons`): the GC sweep, single-flight across invocations. */
    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
      // awaited: a failure shows up in the cron invocation's status
      await runGc(createServices(env, deps));
    },
  };
}
