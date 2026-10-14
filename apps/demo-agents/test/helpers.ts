import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoFake } from "./demo-fake.js";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const MAKE_LOGO = join(REPO, "fixtures", "brand-assets", "scripts", "make-logo.mjs");

/** Tracked files of a fixture; the fake seeds text only, so the binary logo becomes a text placeholder (agent 3 regenerates it). */
export function fixtureFiles(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  const files = execFileSync("git", ["ls-files", `fixtures/${name}`], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    out[f.slice(`fixtures/${name}/`.length)] = f.endsWith(".png") ? "teal logo placeholder\n" : readFileSync(join(REPO, f), "utf8");
  }
  return out;
}

/** The "Demo Client / Customer Portal" project: three git resources from fixtures/ + a writable R2 asset set. */
export async function demoWorld(): Promise<{ world: DemoFake; ownerToken: string }> {
  const world = new DemoFake();
  await world.listen();
  world.addResource("website", fixtureFiles("website"));
  world.addResource("api", fixtureFiles("api"));
  world.addResource("requirements", fixtureFiles("requirements"));
  const assets = world.addAssetResource("brand-assets", { "logo.png": "teal-logo-v1" });
  world.resources.get(assets.resourceId)!.writable = true;
  const ownerToken = world.sessionFor("owner@example.com");
  return { world, ownerToken };
}
