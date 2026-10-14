/** Proposal hashes as the web app shows them. */

/** A real proposal hash: 64 lowercase hex characters. */
export const PROPOSAL_HASH = /^[0-9a-f]{64}$/;

/**
 * The web app's short review code: the first 12 hex characters in groups of four (apps/web
 * `shortCode` in screens/ProposalReview.tsx). Anything that is not a real hash (a placeholder) is
 * shown as is, so it cannot pass for one.
 */
export function shortCode(hash: string): string {
  if (!PROPOSAL_HASH.test(hash)) return hash;
  return (hash.slice(0, 12).match(/.{4}/g) ?? []).join(' ');
}
