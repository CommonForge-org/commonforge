import { describe, expect, it } from "vitest";
import { inviteText } from "../../src/services/email.js";
import { email, harness, member, ownerWithOrg } from "../helpers.js";

describe("member invites", () => {
  it("adding a member emails an invite with a plain sign-in link", async () => {
    const h = harness();
    const o = await ownerWithOrg(h, "Acme <Co>");
    const to = email("client");
    const r = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: to, role: "client" } });
    expect(r.status).toBe(201);
    expect(r.body.invite).toBe("sent");
    const m = h.email.invites.at(-1)!;
    expect(m).toMatchObject({ to, orgName: "Acme <Co>", role: "client" });
    expect(m.inviter).toMatch(/@example\.test$/);
    expect(m.link).toBe(`${h.env().COMMONFORGE_APP_URL}/signin`);
    expect(new URL(m.link).search).toBe("");
  });

  it("the invite text escapes the org name and inviter in HTML", () => {
    const t = inviteText({ to: "a@b.c", orgName: "<b>x</b>", inviter: "o&o@b.c", role: "client", link: "https://app.test/signin" });
    expect(t.subject).toContain("<b>x</b>");
    expect(t.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(t.html).toContain("o&amp;o@b.c");
    expect(t.html).not.toContain("<b>x</b>");
    expect(t.text).toContain("https://app.test/signin");
  });

  it("the invite text strips control characters so an org name cannot inject headers", () => {
    const t = inviteText({ to: "a@b.c", orgName: "Acme\r\nBcc: x@evil.test", inviter: "o@b.c\n", role: "cli\rent", link: "https://app.test/signin" });
    expect(t.subject).not.toMatch(/[\r\n]/);
    expect(t.subject).toBe("You were added to AcmeBcc: x@evil.test on CommonForge");
    expect(t.text.split("\n")[0]).toBe("o@b.c added you to AcmeBcc: x@evil.test on CommonForge as client.");
    expect(t.html).not.toMatch(/[\r\n]/);
  });

  it("a failed send still adds the member; the owner can resend", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    h.email.failInvites = true;
    const to = email("dev");
    const r = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: to, role: "developer" } });
    expect(r.status).toBe(201);
    expect(r.body.invite).toBe("failed");
    const list = await h.api("GET", `/api/orgs/${o.orgId}/members`, { token: o.token });
    expect(list.body.members.map((x: any) => x.email)).toContain(to);

    const again = await h.api("POST", `/api/orgs/${o.orgId}/members/${r.body.userId}/invite`, { token: o.token });
    expect(again.status).toBe(502);
    expect(again.body.error.code).toBe("invite_failed");
    h.email.failInvites = false;
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/members/${r.body.userId}/invite`, { token: o.token });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ invite: "sent" });
    expect(h.email.invites.at(-1)!.to).toBe(to);
  });

  it("only owners resend; unknown members are 404", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const dev = await member(h, o, "developer");
    expect((await h.api("POST", `/api/orgs/${o.orgId}/members/${dev.userId}/invite`, { token: dev.token })).status).toBe(403);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/members/u-nope/invite`, { token: o.token })).status).toBe(404);
  });

  it("invites are rate limited per org; over the limit the member is still added", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    for (let i = 0; i < 30; i++) {
      const r = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: email(`v${i}`), role: "viewer" } });
      expect(r.body.invite).toBe("sent");
    }
    const over = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: email("late"), role: "viewer" } });
    expect(over.status).toBe(201);
    expect(over.body.invite).toBe("rate_limited");
    const resend = await h.api("POST", `/api/orgs/${o.orgId}/members/${over.body.userId}/invite`, { token: o.token });
    expect(resend.status).toBe(429);
    expect(resend.body.error.code).toBe("invite_rate_limited");
  });
});
