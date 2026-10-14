/** Your account (/account): the sessions you are signed in with, and ending them. */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../src/api/fake.js";
import { parseRoute } from "../src/lib/router.js";
import { claudeCodeSetup, codexConfig, signInMessage } from "../src/lib/agentapps.js";
import { AccountView } from "../src/screens/Account.js";

const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const noop = () => {};

describe("Account", () => {
  it("is /account", () => {
    expect(parseRoute("/account", "")).toEqual({ name: "account" });
  });

  it("lists the browser, cforge and hand-off sessions; every one but this browser can be ended", async () => {
    const api = new FakeApi({ role: "client" });
    const sessions = await api.listSessions();
    const out = html(createElement(AccountView, { email: "client@customer.example", sessions, busy: false, error: null, onEnd: noop, onEndOthers: noop }));
    expect(out).toContain("Where you are signed in");
    expect([...out.matchAll(/data-client="([a-z]+)"/g)].map((m) => m[1])).toEqual(["web", "handoff", "cli"]);
    expect(out).toContain("This browser");
    expect(out).toContain("An agent or AI app, signed in with a one-time code");
    expect([...out.matchAll(/>Sign out</g)]).toHaveLength(2);
    expect(out).toContain("Sign out everywhere else (2)");
    expect(out).not.toMatch(/cfs_/);
  });

  it("the fake ends one session, or all but this one", async () => {
    const api = new FakeApi({ role: "owner" });
    const [, handoff] = await api.listSessions();
    expect(await api.revokeSessions({ sessionId: handoff!.sessionId })).toBe(1);
    expect((await api.listSessions()).map((x) => x.client)).toEqual(["web", "cli"]);
    expect(await api.revokeSessions({ others: true })).toBe(1);
    const only = await api.listSessions();
    expect(only.map((x) => x.current)).toEqual([true]);
    const out = html(createElement(AccountView, { email: "o@x", sessions: only, busy: false, error: null, onEnd: noop, onEndOthers: noop }));
    expect(out).toContain("You are signed in only here.");
  });
});

describe("Use CommonForge from your AI app", () => {
  it("offers the Desktop extension, Claude Code and Codex setups, and a sign-in code on request", () => {
    const out = html(createElement(AccountView, { email: "o@x", sessions: [], busy: false, error: null, onEnd: noop, onEndOthers: noop, apiUrl: "https://forge.example.com", cliCode: async () => ({ code: "cfm_abcdefghijklmnopqrstuv" }) }));
    expect(out).toContain("Use CommonForge from your AI app");
    expect(out).toContain('href="https://github.com/CommonForge-org/commonforge/releases/latest/download/commonforge.mcpb"');
    expect(out).toContain("/plugin install commonforge --marketplace CommonForge-org/commonforge");
    expect(out).toContain("command = &quot;npx&quot;");
    expect(out).toContain("[mcp_servers.commonforge]");
    expect(out).toContain("Get a sign-in code");
    // the code is made on the click, never on page load
    expect(out).not.toContain("cfm_");
  });

  it("the setups and the sign-in message", () => {
    expect(codexConfig()).toBe('[mcp_servers.commonforge]\ncommand = "npx"\nargs = ["-y", "@commonforge-org/cli", "mcp"]');
    expect(signInMessage("https://forge.example.com", "cfm_abcdefghijklmnopqrstuv")).toBe("Sign in to CommonForge: cforge login --api-url https://forge.example.com --code cfm_abcdefghijklmnopqrstuv");
    expect(signInMessage("https://forge.example.com", "not a code")).toBeNull();
    expect(signInMessage("https://x.example.com; rm -rf /", "cfm_abcdefghijklmnopqrstuv")).toBeNull();
    expect(claudeCodeSetup()).toBe("/plugin install commonforge --marketplace CommonForge-org/commonforge");
  });
});
