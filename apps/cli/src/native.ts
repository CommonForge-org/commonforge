/** Task-scoped G1 handoff and immutable pinned context; no broad login is created. */
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalJson, materializeProjectContext, type ProjectContextPacket } from '@commonforge-org/core';
import { ApiClient, agentClient, resolveApiUrl } from './api.js';
import { parse, positional, str, type CommandContext } from './command.js';
import { CliError, rememberSecret } from './context.js';

const SafeTaskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/);
const ContextWire = z.object({ packet: z.unknown(), digest: z.string().regex(/^[a-f0-9]{64}$/), json: z.string(), markdown: z.string() }).strict();
const Reply = z.object({ protocolVersion: z.literal(1), attemptId: z.string(), mandateId: z.string(), context: ContextWire, knowledgeStale: z.boolean().optional(), generation: z.number().int().nonnegative().optional(), agentId: z.string().optional() });
export type NativeContext = { attemptId: string; mandateId: string; context: ReturnType<typeof materializeProjectContext>; knowledgeStale?: boolean; generation?: number; agentId?: string };
export function validateNativeContext(raw: unknown, taskId: string): NativeContext {
  if (!SafeTaskId.safeParse(taskId).success) throw new CliError('context_invalid', 'invalid task identifier');
  const r = Reply.safeParse(raw);
  if (!r.success) throw new CliError('unsupported_version', 'server returned unsupported project context');
  const materialized = materializeProjectContext(r.data.context.packet as ProjectContextPacket);
  if (materialized.packet.taskId !== taskId || materialized.packet.attemptId !== r.data.attemptId || materialized.packet.mandate.id !== r.data.mandateId || materialized.digest !== r.data.context.digest || materialized.json !== r.data.context.json || materialized.markdown !== r.data.context.markdown) throw new CliError('context_invalid', 'project context digest or subject does not match');
  return { attemptId: r.data.attemptId, mandateId: r.data.mandateId, context: materialized, ...(r.data.generation === undefined ? {} : { generation: r.data.generation }), ...(r.data.agentId === undefined ? {} : { agentId: r.data.agentId }), ...(r.data.knowledgeStale === undefined ? {} : { knowledgeStale: r.data.knowledgeStale }) };
}
async function protectedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || !(await lstat(path)).isDirectory()) throw new CliError('context_path_invalid', 'context destination must be a real directory');
  await chmod(path, 0o700);
}
async function safeWrite(dir: string, name: string, value: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(name)) throw new CliError('context_path_invalid', 'invalid context filename');
  await protectedDirectory(dir);
  const temp = join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  await writeFile(temp, value, { mode: 0o600, flag: 'wx' });
  await rename(temp, join(dir, name));
}
export async function writeNativeContext(root: string, data: NativeContext): Promise<void> {
  const dir = join(await realpath(root), '.commonforge');
  await safeWrite(dir, 'context.json', data.context.json + '\n');
  await safeWrite(dir, 'context.md', data.context.markdown);
  await safeWrite(dir, 'attempt.json', canonicalJson({ protocolVersion: 1, taskId: data.context.packet.taskId, attemptId: data.attemptId, mandateId: data.mandateId, contextDigest: data.context.digest }) + '\n');
}
export async function fetchNativeContext(api: ApiClient, taskId: string): Promise<NativeContext> {
  const data = validateNativeContext(await api.get(`/api/tasks/${encodeURIComponent(taskId)}/native/context`), taskId);
  if (data.knowledgeStale) throw new CliError('knowledge_stale', 'project requirements changed; obtain a new task handoff and rerun verification');
  return data;
}
export async function checkPinnedNativeContext(root: string, data: NativeContext): Promise<void> {
  let pin: unknown;
  try { pin = JSON.parse(await readFile(join(root, '.commonforge', 'attempt.json'), 'utf8')); } catch { throw new CliError('context_missing', 'native workspace has no pinned attempt; check out the task again'); }
  const expected = { protocolVersion: 1, taskId: data.context.packet.taskId, attemptId: data.attemptId, mandateId: data.mandateId, contextDigest: data.context.digest };
  if (canonicalJson(pin) !== canonicalJson(expected)) throw new CliError('context_invalid', 'workspace attempt does not match current scoped authority');
  const raw = JSON.parse(await readFile(join(root, '.commonforge', 'context.json'), 'utf8')) as unknown;
  if (materializeProjectContext(raw as ProjectContextPacket).digest !== data.context.digest) throw new CliError('context_invalid', 'workspace context was altered');
}
export async function handoff(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { code: { type: 'string' } }, 'cforge handoff --code <task-scoped code>');
  const code = str(p, 'code'); if (!code) throw new CliError('invalid_arguments', 'a task-scoped --code is required');
  rememberSecret(code);
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const raw = await new ApiClient(ctx.io, apiUrl, null).post<Record<string, unknown>>('/api/auth/task/verify', { code });
  const lease = z.object({ taskId: SafeTaskId, leaseToken: z.string().startsWith('cfl_'), leaseGeneration: z.number().int().nonnegative(), expiresAt: z.string().datetime({ offset: true }) }).parse(raw);
  rememberSecret(lease.leaseToken);
  const data = validateNativeContext(raw, lease.taskId);
  await ctx.store.saveConfig({ apiUrl });
  await ctx.store.saveLease({ apiUrl, ...lease });
  await safeWrite(join(ctx.store.dir, 'native'), `${lease.taskId}.json`, canonicalJson(data));
  ctx.out.result({ taskId: lease.taskId, attemptId: data.attemptId, mandateId: data.mandateId, contextDigest: data.context.digest, expiresAt: lease.expiresAt }, `Task-scoped handoff ready for ${lease.taskId}. Run cforge checkout, then read .commonforge/context.md.`);
}
export async function contextCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { out: { type: 'string' } }, 'cforge context <taskId> [--out <workspace>]');
  const taskId = positional(p, 0, 'taskId', 'cforge context <taskId>');
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = await agentClient(ctx.io, ctx.store, taskId, apiUrl);
  const data = await fetchNativeContext(api, taskId);
  const root = resolve(ctx.io.cwd, str(p, 'out') ?? '.');
  await mkdir(root, { recursive: true });
  await writeNativeContext(root, data);
  ctx.out.result({ taskId, attemptId: data.attemptId, mandateId: data.mandateId, contextDigest: data.context.digest, packet: data.context.packet, generation: data.generation, agentId: data.agentId, directory: join(root, '.commonforge') }, `Pinned project context written to ${join(root, '.commonforge')}.`);
}
/** Structured agent correction/proposal command. Server refuses authority beyond mandate. */
export async function nativeCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { command: { type: 'string' } }, 'cforge native <taskId> --command <JSON>');
  const taskId = positional(p, 0, 'taskId', 'cforge native <taskId> --command <JSON>');
  let body: unknown; try { body = JSON.parse(str(p, 'command') ?? ''); } catch { throw new CliError('invalid_arguments', '--command must be structured JSON'); }
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = await agentClient(ctx.io, ctx.store, taskId, apiUrl);
  const data = await fetchNativeContext(api, taskId);
  if (body && typeof body === "object" && !Array.isArray(body)) body = { expectedGeneration: data.generation, idempotencyKey: crypto.randomUUID(), ...body };
  const result = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/native/commands`, body);
  ctx.out.result(result, 'Project command recorded. Drafts require separate human confirmation.');
}


export async function propose(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { 'inner-proposal': { type: 'string' } }, 'cforge propose <taskId> [--inner-proposal <id>]');
  const taskId = positional(p, 0, 'taskId', 'cforge propose <taskId>');
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = await agentClient(ctx.io, ctx.store, taskId, apiUrl);
  let context = await fetchNativeContext(api, taskId);
  let innerId = str(p, 'inner-proposal');
  if (!innerId) {
    const inner = await api.post<{ innerProposalId: string; jobId: string; state: string }>(`/api/tasks/${encodeURIComponent(taskId)}/native/submit`, {});
    if (inner.state !== 'integrated') { ctx.out.result(inner, `Artifact integration queued (${inner.jobId}). Run cforge propose ${taskId} again after integration completes.`); return; }
    innerId = inner.innerProposalId;
    context = await fetchNativeContext(api, taskId);
  }
  if (context.generation === undefined) throw new CliError('unsupported_version', 'server must provide project generation for scoped proposal preparation');
  const result = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/native/proposals`, { innerProposalId: innerId, expectedGeneration: context.generation, idempotencyKey: crypto.randomUUID(), outcome: null });
  ctx.out.result(result, 'Exact project proposal prepared. A human must request verification and review the evidence before accepting.');
}

export async function nativeResults(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, {}, 'cforge results <taskId>');
  const taskId = positional(p, 0, 'taskId', 'cforge results <taskId>');
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = await agentClient(ctx.io, ctx.store, taskId, apiUrl);
  const result = await api.get<Record<string, unknown>>(`/api/tasks/${encodeURIComponent(taskId)}/native/results`);
  if (result.protocolVersion !== 1) throw new CliError('unsupported_version', 'unsupported project results protocol');
  ctx.out.result(result, () => JSON.stringify(result, null, 2));
}
