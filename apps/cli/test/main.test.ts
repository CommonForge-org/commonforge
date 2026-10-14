import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { helperValue } from "../src/git.js";
import { CLI_NAME, VERSION, helperCommandFor, run } from "../src/main.js";

describe("cforge", () => {
  it("is named cforge and exits 0 on --version", async () => {
    expect(CLI_NAME).toBe("cforge");
    let out = "";
    expect(await run(["--version", "--json"], { stdout: (t) => void (out += t) })).toBe(0);
    expect(JSON.parse(out)).toEqual({ name: "cforge", version: VERSION });
  });

  it("reports the published package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("rejects unknown commands with exit 2 and a JSON error in --json mode", async () => {
    let out = "";
    expect(await run(["frobnicate", "--json"], { stdout: (t) => void (out += t), stderr: () => {} })).toBe(2);
    expect(JSON.parse(out).error.code).toBe("unknown_command");
  });

  it("reports bad arguments as invalid_arguments", async () => {
    let out = "";
    expect(await run(["login", "--bogus", "--json"], { stdout: (t) => void (out += t), stderr: () => {}, env: { CFORGE_CONFIG_DIR: "/nonexistent" } })).toBe(2);
    expect(JSON.parse(out).error.code).toBe("invalid_arguments");
  });
});

describe("helperCommandFor", () => {
  it("runs the bundle with node, or with an Electron app binary told to act as Node", () => {
    expect(helperCommandFor("/usr/bin/node", "/x/index.js", false)).toEqual(["/usr/bin/node", "/x/index.js"]);
    const electron = helperCommandFor("/Applications/Claude.app/Contents/MacOS/Claude", "/ext/server/index.js", true);
    expect(helperValue(electron, "/cfg/checkouts/a.json")).toBe("/usr/bin/env ELECTRON_RUN_AS_NODE=1 /Applications/Claude.app/Contents/MacOS/Claude /ext/server/index.js credential-helper --record /cfg/checkouts/a.json");
  });
});
