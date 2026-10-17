/** Narrow unprivileged Linux adapter: allow only Node entrypoints, all inside mount/PID/net namespaces. */
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandSettings } from './context.js';
export async function localNamespaceCommands(binDir: string): Promise<CommandSettings> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const node = await realpath(process.execPath);
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const script = `#!/usr/bin/bash\nset -euo pipefail\nexec /usr/bin/bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind ${shellQuote(node)} /node --proc /proc --dev /dev --tmpfs /tmp --bind "$PWD" /candidate --chdir /candidate /node "$@"\n`;
  await writeFile(join(binDir, 'node'), script, { mode: 0o700 }); await chmod(join(binDir, 'node'), 0o700);
  return {
    // Existing runner uid guard is bypassed only because this pinned wrapper supplies the stronger
    // namespace boundary. Candidate code sees /candidate and system runtime files, never the supervisor.
    unsafeSameUid: true, path: binDir, allowlist: [['node', '{path}', '{args*}']],
    network: 'inherit', install: { enabled: false }, maxOutputBytes: 65536,
  };
}
