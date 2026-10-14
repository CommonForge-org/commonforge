/**
 * Member invites (admin screens spec §4): an email with a plain sign-in link, rate limited per org
 * and per inviter through OpsGate. The membership never depends on the email: the caller has
 * already added the member and reports the outcome.
 */
import type { Services } from "../context.js";

export const INVITE_LIMIT = 30;
export const INVITE_WINDOW_MS = 3600_000;

export type InviteOutcome = "sent" | "failed" | "rate_limited";

export async function sendMemberInvite(svc: Services, o: { orgId: string; inviterId: string; inviterEmail: string; to: string; role: string }): Promise<InviteOutcome> {
  const gate = svc.env.OPS_GATE.get(svc.env.OPS_GATE.idFromName("ratelimit:invite"));
  const limited = await gate.hit([
    { key: `org:${o.orgId}`, limit: INVITE_LIMIT, windowMs: INVITE_WINDOW_MS },
    { key: `inviter:${o.inviterId}`, limit: INVITE_LIMIT, windowMs: INVITE_WINDOW_MS },
  ]);
  if (!limited.ok) return "rate_limited";
  const org = await svc.db.prepare("SELECT name FROM orgs WHERE org_id = ?").bind(o.orgId).first<{ name: string }>();
  try {
    await svc.deps.email(svc.env).sendInvite({ to: o.to, orgName: org?.name ?? o.orgId, inviter: o.inviterEmail, role: o.role, link: `${svc.env.COMMONFORGE_APP_URL}/signin` });
    return "sent";
  } catch (e) {
    console.error(`invite email to org ${o.orgId} member failed: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
