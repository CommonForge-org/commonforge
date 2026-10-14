/**
 * Connecting an AI app to CommonForge through the `cforge mcp` server (apps/cli/src/mcp.ts): the
 * Claude Desktop extension, the Claude Code plugin and the Codex config. Until the CLI is on npm
 * ({@link CLI_PUBLISHED}), Claude Code and Codex run a `cforge` built from the source; the Desktop
 * extension carries its own copy and needs neither.
 */
import { CLI_PACKAGE, CLI_PUBLISHED, isLoginCode, shellWord } from "./handoff.js";

export const REPO_SLUG = "CommonForge-org/commonforge";

/** The extension file attached to the repository's latest release (apps/cli `pnpm mcpb`). */
export const DESKTOP_EXTENSION_URL = `https://github.com/${REPO_SLUG}/releases/latest/download/commonforge.mcpb`;

/** How the MCP server is started: from npm once published, else the `cforge` on the PATH. */
function server(): { command: string; args: string[] } {
  return CLI_PUBLISHED ? { command: "npx", args: ["-y", CLI_PACKAGE, "mcp"] } : { command: "cforge", args: ["mcp"] };
}

/** Claude Code: the plugin from this repository's marketplace, or the source-built server. */
export function claudeCodeSetup(): string {
  if (CLI_PUBLISHED) return `/plugin install commonforge --marketplace ${REPO_SLUG}`;
  const s = server();
  return `claude mcp add --scope user commonforge -- ${[s.command, ...s.args].join(" ")}`;
}

/** Codex: the `[mcp_servers]` entry for `~/.codex/config.toml`. */
export function codexConfig(): string {
  const s = server();
  return [`[mcp_servers.commonforge]`, `command = ${JSON.stringify(s.command)}`, `args = [${s.args.map((a) => JSON.stringify(a)).join(", ")}]`].join("\n");
}

/** What the person pastes into their AI app to sign it in (the `sign_in` tool reads the address and code from it). */
export function signInMessage(apiUrl: string, code: string): string | null {
  const api = shellWord(apiUrl);
  if (!api || !isLoginCode(code)) return null;
  return `Sign in to CommonForge: cforge login --api-url ${api} --code ${code}`;
}
