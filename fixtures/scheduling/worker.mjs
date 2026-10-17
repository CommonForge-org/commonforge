/** Synthetic fixture only. Actor roles are fixture inputs, never production authentication. */
export const CLOCK = '2026-10-17T12:00:00.000Z';
export const TIMEZONE = 'UTC';

export function reschedule(input) {
  const now = Date.parse(input.now ?? CLOCK);
  const appointment = Date.parse(input.appointment);
  if (!Number.isFinite(now) || !Number.isFinite(appointment)) return { allowed: false, code: 'invalid_time' };
  if (input.traveling) return { allowed: false, code: 'technician_traveling' };
  if (appointment - now >= 24 * 60 * 60 * 1000) return { allowed: true, override: null };
  if (input.actor !== 'manager') return { allowed: false, code: 'cutoff' };
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 500) return { allowed: false, code: 'override_reason_required' };
  return { allowed: true, override: { actor: 'manager', reason, recordedAt: new Date(now).toISOString() } };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, fixture: true, clock: CLOCK, timezone: TIMEZONE });
    if (url.pathname === '/reschedule' && request.method === 'POST') {
      try { return Response.json(reschedule(await request.json())); }
      catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
    }
    return new Response('<!doctype html><html lang="en"><title>Synthetic scheduling preview</title><h1>Synthetic scheduling preview</h1><p>Clock: 2026-10-17 12:00 UTC. No real appointments or external effects.</p><p>Customers may reschedule at least 24 hours ahead, before travel begins. Managers may override the cutoff with a recorded reason.</p></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
