/**
 * Staging header and Sent from staging (staging phase 3, Task 6): server-rendered markup is the contract.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID } from "../src/api/fake.js";
import type { Capture, Role, StagingView } from "../src/api/types.js";
import { loadLive } from "../src/screens/project-data.js";
import { SentFromStaging } from "../src/screens/SentFromStaging.js";
import { recentCaptureCount, safeStagingUrl, StagingHeader } from "../src/screens/StagingHeader.js";

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

const NOW = new Date("2026-10-11T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const noop = () => {};
const resolved = () => Promise.resolve();

function active(over: Partial<Extract<StagingView, { enabled: true }>> = {}): StagingView {
  return {
    enabled: true,
    state: "active",
    stateText: null,
    baseline: { since: minutesAgo(600) },
    url: "https://cfapp-website-staging.example.workers.dev",
    current: { buildId: "sbld-1", since: minutesAgo(30) },
    building: false,
    landings: [],
    ...over,
  };
}

const OFF: StagingView = { enabled: false, url: null, current: null, building: false, landings: [] };

function capture(id: string, mins: number, over: Partial<Capture> = {}): Capture {
  return { captureId: id, receivedAt: minutesAgo(mins), method: "POST", path: `/${id}`, headers: { "content-type": "application/json" }, body: `{"id":"${id}"}`, truncated: false, ...over };
}

function header(staging: StagingView, role: Role = "client", captures: Capture[] = []) {
  return renderToString(createElement(StagingHeader, { staging, role, captures, now: NOW, onReset: resolved, onOpenSent: noop, sentOpen: false }));
}

describe("staging header", () => {
  it("shows the label, the staging link in a new tab, and when staging last changed", () => {
    const html = header(active());
    expect(html).toContain('data-testid="staging-header"');
    expect(html).toContain(">Staging<");
    expect(html).toMatch(/<a[^>]*href="https:\/\/cfapp-website-staging\.example\.workers\.dev"[^>]*>/);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Updated 30 min ago");
    expect(html).not.toContain("Building…");
  });

  it("links only to http: and https: URLs (never javascript:, data:, malformed or null)", () => {
    expect(safeStagingUrl("https://a.example.dev")).toBe("https://a.example.dev");
    expect(safeStagingUrl("http://localhost:8787/")).toBe("http://localhost:8787/");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<p>x</p>", "not a url", "//no-scheme.example", "", null, undefined]) expect(safeStagingUrl(bad)).toBeNull();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "::::", null]) {
      const html = header(active({ url: bad }));
      expect(html).not.toContain('data-testid="staging-link"');
      expect(html).not.toContain("javascript:");
      expect(html).toContain("Updated");
    }
  });

  it("says Building… while a staging build runs", () => {
    expect(header(active({ building: true }))).toContain("Building…");
  });

  it("awaiting the baseline: says staging starts after the first production publish, and no staging link", () => {
    const html = header(active({ state: "awaiting_baseline", stateText: "Waiting for the owner's first production publish.", url: null, current: null, baseline: null }));
    expect(html).toContain("Staging starts after your developer&#x27;s first production publish.");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Updated ");
  });

  it("awaiting the baseline: owners and developers get the way to publish", () => {
    const waiting = active({ state: "awaiting_baseline", stateText: "Waiting for the owner's first production publish.", url: null, current: null, baseline: null });
    for (const role of ["owner", "developer"] as const) {
      const html = renderToString(createElement(StagingHeader, { staging: waiting, role, captures: [], now: NOW, onReset: resolved, onOpenSent: noop, sentOpen: false, publishHref: "/o/o-1/p/p-1/versions" }));
      expect(html).toContain("Staging starts after your first production publish.");
      expect(html).toMatch(/<a href="\/o\/o-1\/p\/p-1\/versions"[^>]*>Publish now<\/a>/);
    }
    // no link without a target, and never once staging is active
    expect(header(waiting, "owner")).not.toContain("<a ");
    expect(renderToString(createElement(StagingHeader, { staging: active(), role: "owner", captures: [], now: NOW, onReset: resolved, onOpenSent: noop, sentOpen: false, publishHref: "/v" }))).not.toContain("Publish now");
  });

  it("awaiting the baseline hides a link even if one is returned", () => {
    const html = header(active({ state: "awaiting_baseline", stateText: "Waiting for the owner's first production publish." }));
    expect(html).not.toContain("<a ");
  });

  it("offers Reset demo data to owners, developers and clients, never viewers", () => {
    for (const role of ["owner", "developer", "client"] as const) expect(header(active(), role)).toContain("Reset demo data");
    expect(header(active(), "viewer")).not.toContain("Reset demo data");
  });

  it("Sent from staging counts the captures of the last 24 hours", () => {
    const caps = [capture("a", 5), capture("b", 60 * 23), capture("c", 60 * 25)];
    expect(recentCaptureCount(caps, NOW)).toBe(2);
    const html = header(active(), "viewer", caps);
    expect(html).toContain("Sent from staging");
    expect(html).toContain('id="cf-sent-toggle"');
    expect(html).toMatch(/count-badge[^>]*>.*2 sent in the last 24 hours/);
    expect(header(active(), "viewer", [capture("c", 60 * 25)])).not.toContain("count-badge");
  });

  it("renders nothing when staging is off or not loaded", () => {
    expect(header(OFF)).toBe("");
    expect(renderToString(createElement(StagingHeader, { staging: undefined, role: "owner", captures: undefined, now: NOW, onReset: resolved, onOpenSent: noop, sentOpen: false }))).toBe("");
  });
});

describe("sent from staging drawer", () => {
  const drawer = (captures: Capture[] | undefined, open = true) => renderToString(createElement(SentFromStaging, { open, captures, now: NOW, onClose: noop }));

  it("lists captures newest first with time, method, path, headers and a collapsible monospace body", () => {
    const html = drawer([capture("older", 120), capture("newer", 5, { method: "PUT", headers: { "content-type": "text/plain", "user-agent": "Cloudflare-Workers" } })]);
    expect(html).toContain("Sent from staging");
    expect(html.indexOf("/newer")).toBeGreaterThan(-1);
    expect(html.indexOf("/newer")).toBeLessThan(html.indexOf("/older"));
    expect(html).toContain(">PUT<");
    expect(html).toContain("5 min ago");
    expect(html).toContain("2 hours ago");
    expect(html).toContain("user-agent");
    expect(html).toContain("Cloudflare-Workers");
    expect(html).toMatch(/<details[^>]*class="capture-part"/);
    expect(html).toMatch(/<pre class="mono capture-body">/);
    expect(html).toContain("{&quot;id&quot;:&quot;newer&quot;}");
    expect(html).not.toContain("truncated");
  });

  it("marks a truncated body", () => {
    const html = drawer([capture("big", 1, { truncated: true })]);
    expect(html).toContain("truncated");
  });

  it("shows the empty state", () => {
    const html = drawer([]);
    expect(html).toContain("Nothing sent yet.");
    expect(html).toContain("Emails and webhooks from staging are caught here and never delivered.");
  });

  it("renders nothing when closed", () => {
    expect(drawer([capture("a", 1)], false)).toBe("");
  });
});

describe("live staging state", () => {
  it("a project without staging loads enabled: false and never asks for captures", async () => {
    const api = new FakeApi({ role: "owner" });
    const live = await loadLive(api, ORG, PID, "owner");
    expect(live.staging?.enabled).toBe(false);
    expect(live.captures).toBeUndefined();
    expect(api.calls.some((c) => c.method === "listCaptures")).toBe(false);
  });

  it("a staging project loads the staging view and its captures with the poll", async () => {
    const api = new FakeApi({ role: "client", staging: true });
    const live = await loadLive(api, ORG, PID, "client");
    expect(live.staging?.enabled).toBe(true);
    expect(live.captures?.length).toBe(2);
  });

  it("staging read errors never surface: the rest of the live state still loads", async () => {
    const api = new FakeApi({ role: "owner", staging: true });
    api.getStaging = () => Promise.reject(new Error("boom"));
    const live = await loadLive(api, ORG, PID, "owner");
    expect(live.staging).toBeUndefined();
    expect(live.proposals.length).toBeGreaterThan(0);
    const api2 = new FakeApi({ role: "owner", staging: true });
    api2.listCaptures = () => Promise.reject(new Error("boom"));
    const live2 = await loadLive(api2, ORG, PID, "owner");
    expect(live2.staging?.enabled).toBe(true);
    expect(live2.captures).toBeUndefined();
  });

  it("a failed poll keeps the previous staging and captures", async () => {
    const api = new FakeApi({ role: "client", staging: true });
    const first = await loadLive(api, ORG, PID, "client");
    expect(first.captures?.length).toBe(2);
    api.getStaging = () => Promise.reject(new Error("boom"));
    api.listCaptures = () => Promise.reject(new Error("boom"));
    const second = await loadLive(api, ORG, PID, "client", { previous: first });
    expect(second.staging).toEqual(first.staging);
    expect(second.captures).toEqual(first.captures);
  });

  it("captures are read alongside staging when the previous poll or the policy says staging is on", async () => {
    const api = new FakeApi({ role: "owner", staging: true });
    const project = await api.getProject(ORG, PID);
    const order: string[] = [];
    const getStaging = api.getStaging.bind(api);
    const listCaptures = api.listCaptures.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.getStaging = async (...a) => {
      order.push("staging:start");
      await gate;
      order.push("staging:end");
      return getStaging(...a);
    };
    api.listCaptures = async (...a) => {
      order.push("captures:start");
      return listCaptures(...a);
    };
    const pending = loadLive(api, ORG, PID, "owner", { project });
    await Promise.resolve();
    release();
    const live = await pending;
    expect(order.indexOf("captures:start")).toBeLessThan(order.indexOf("staging:end"));
    expect(live.captures?.length).toBe(2);
  });

  it("owners and developers: a policy without staging never asks for staging", async () => {
    const api = new FakeApi({ role: "developer" });
    const project = await api.getProject(ORG, PID);
    const live = await loadLive(api, ORG, PID, "developer", { project });
    expect(live.staging).toBeUndefined();
    expect(api.calls.some((c) => c.method === "getStaging" || c.method === "listCaptures")).toBe(false);
    // a client has no policy: the poll asks, and staging answers enabled: false
    const client = new FakeApi({ role: "client" });
    const clientLive = await loadLive(client, ORG, PID, "client", { project: await client.getProject(ORG, PID) });
    expect(clientLive.staging?.enabled).toBe(false);
  });
});
