/**
 * Agent 3's one allowed command (review I-1). The fixture generator takes its output path from the
 * command line, so allowing it directly would let a model overwrite any file with a PNG. Instead
 * the agent may run exactly `node <tools>/brand-logo.mjs --color=#rrggbb`: a read-only wrapper
 * outside the workspace that
 * - accepts exactly one argument matching `^--color=#[0-9a-f]{6}$` (exit 2 otherwise),
 * - always writes `<cwd>/website/public/logo.png`, refusing a symlinked target or a `website/public`
 *   that resolves outside the cwd,
 * - runs a read-only copy of the generator that also lives outside the workspace.
 */
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOGO_OUTPUT = "website/public/logo.png";

function wrapperSource(generator: string): string {
  return `#!/usr/bin/env node
// CommonForge demo: agent 3's only allowed command. Generated; read-only.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
const GENERATOR = ${JSON.stringify(generator)};
const args = process.argv.slice(2);
if (args.length !== 1 || !/^--color=#[0-9a-f]{6}$/.test(args[0])) {
  process.stderr.write("usage: brand-logo.mjs --color=#rrggbb (exactly one argument; the output is always ${LOGO_OUTPUT})\\n");
  process.exit(2);
}
const root = realpathSync(process.cwd());
const dir = realpathSync(join(root, "website", "public"));
if (!dir.startsWith(root + sep)) {
  process.stderr.write("refusing: website/public resolves outside the workspace\\n");
  process.exit(2);
}
const out = join(dir, "logo.png");
let isLink = false;
try { isLink = lstatSync(out).isSymbolicLink(); } catch { /* absent: fine */ }
if (isLink) {
  process.stderr.write("refusing: website/public/logo.png is a symlink\\n");
  process.exit(2);
}
const r = spawnSync(process.execPath, [GENERATOR, out, args[0]], { stdio: "inherit", env: { PATH: process.env.PATH ?? "" } });
process.exit(r.status ?? 1);
`;
}

/** Install the generator copy and the wrapper (both 0444) in `toolsDir`; returns the exact command prefix `node <wrapper>`. */
export async function installLogoTool(toolsDir: string, generatorSource: string): Promise<string> {
  await mkdir(toolsDir, { recursive: true });
  const generator = join(toolsDir, "make-logo.mjs");
  const wrapper = join(toolsDir, "brand-logo.mjs");
  await copyFile(generatorSource, generator);
  await writeFile(wrapper, wrapperSource(generator));
  await chmod(generator, 0o444);
  await chmod(wrapper, 0o444);
  return `node ${wrapper}`;
}
