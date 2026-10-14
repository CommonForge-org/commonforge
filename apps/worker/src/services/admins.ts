/**
 * Instance admins (admin screens spec §8): the people of the agency that runs this deployment.
 * Only they create organizations. Being one grants nothing inside an org: rights there come from the
 * org role. `COMMONFORGE_ADMIN_EMAILS` is comma-separated and case-insensitive; an entry is an email
 * or a whole domain written `@domain`. Empty or unset: nobody.
 */
export function parseAdminList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isInstanceAdmin(env: { COMMONFORGE_ADMIN_EMAILS?: string }, email: string): boolean {
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return parseAdminList(env.COMMONFORGE_ADMIN_EMAILS).some((entry) => (entry.startsWith("@") ? entry === domain : entry === e));
}
