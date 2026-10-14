import type { LedgerTx, LedgerWrite } from './store.js';

/**
 * Apply planned writes in order. Every store uses this so writes land identically everywhere.
 * Must run inside the same transaction that produced the plan.
 */
export function applyWrites(tx: LedgerTx, writes: readonly LedgerWrite[]): void {
  for (const w of writes) {
    switch (w.op) {
      case 'setHead':
        tx.setHead(w.head);
        break;
      case 'putProposal':
        tx.putProposal(w.proposal);
        break;
      case 'bindResource':
        tx.bindResource(w.resourceId, w.organizationId);
        break;
      case 'putAcceptedVersion':
        tx.putAcceptedVersion(w.version);
        break;
      case 'putIdempotency':
        tx.putIdempotency(w.organizationId, w.record);
        break;
      case 'appendOutbox':
        tx.appendOutbox(w.event);
        break;
      case 'appendAudit':
        tx.appendAudit(w.event);
        break;
      default: {
        const never: never = w;
        throw new Error(`unknown ledger write ${JSON.stringify(never)}`);
      }
    }
  }
}
