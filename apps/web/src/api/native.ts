import { ProjectStateSchema, type ProjectState } from '@commonforge-org/core';
import { ApiError } from './client.js';

async function request(org: string, pid: string, suffix = '', body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(pid)}/native${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : data;
    throw new ApiError(res.status, String(error.code ?? 'native_request_failed'), String(error.message ?? 'The operation could not be completed.'));
  }
  return data;
}
export async function loadNativeProject(org: string, pid: string): Promise<ProjectState | null> {
  const data = await request(org, pid);
  if (data.protocolVersion !== 1) throw new ApiError(409, 'unsupported_version', 'This server does not support project context version 1.');
  return data.state === null ? null : ProjectStateSchema.parse(data.state);
}
export async function enableNativeProject(org: string, pid: string): Promise<void> {
  await request(org, pid, '/enable', { idempotencyKey: crypto.randomUUID() });
}
export async function nativeCommand(org: string, pid: string, generation: number, body: Record<string, unknown>): Promise<void> {
  if(body.type==='prepareRecovery'){
    await request(org,pid,'/recoveries',{manifestHash:body.manifestHash,expectedGeneration:generation,idempotencyKey:crypto.randomUUID()});
    return;
  }
  if (body.type === 'requestVerification') {
    await request(org, pid, `/proposals/${encodeURIComponent(String(body.proposalId))}/verify`, { idempotencyKey: crypto.randomUUID() });
    return;
  }
  await request(org, pid, '/commands', { ...body, expectedGeneration: generation, idempotencyKey: crypto.randomUUID() });
}
