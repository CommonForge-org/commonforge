import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { VerificationHistory } from '../src/screens/NativeReview.js';
it('keeps unavailable execution distinct from actual completed runs',()=>{
 const html=renderToString(<VerificationHistory jobs={[{runId:'unavailable',envelopeDigest:'a'.repeat(64),issuedAt:'2026-10-17T12:00:00Z',completedAt:null,status:'error',execution:'not-established',failure:{code:'transport_unavailable',summary:'Isolation was unavailable; execution was not established.'},evidenceIds:[]},{runId:'actual-run',envelopeDigest:'a'.repeat(64),issuedAt:'2026-10-17T12:01:00Z',completedAt:'2026-10-17T12:01:01Z',status:'completed',execution:'bubblewrap-linux-http',failure:null,evidenceIds:['error-evidence']}]} />).replace(/<!-- -->/g,'');
 expect(html).toContain('Candidate execution not established');expect(html).toContain('Isolation was unavailable');expect(html).toContain('Isolated runner execution');expect(html).not.toContain('Verified');
});
