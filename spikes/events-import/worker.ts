// Task 4 (S4) spike Worker: Queue consumer for Artifacts event subscriptions.
// Every delivered message is appended to a SQLite Durable Object (one global instance) with the
// Worker's receive time and the Queue delivery attempt, and can be read back over HTTP.
import { DurableObject } from 'cloudflare:workers';

interface Env {
  RECORDER: DurableObjectNamespace<EventRecorder>;
  SPIKE_ADMIN_TOKEN: string;
}

interface Row {
  msgId: string;
  attempts: number;
  enqueuedAt: number;
  receivedAt: number;
  type: string | null;
  sourceType: string | null;
  namespace: string | null;
  repoName: string | null;
  ref: string | null;
  before: string | null;
  after: string | null;
  eventTimestamp: string | null;
  subscriptionId: string | null;
  body: string;
}

export class EventRecorder extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, msgId TEXT, attempts INTEGER, enqueuedAt INTEGER,
      receivedAt INTEGER, storedAt INTEGER, type TEXT, sourceType TEXT, namespace TEXT, repoName TEXT,
      ref TEXT, before TEXT, after TEXT, eventTimestamp TEXT, subscriptionId TEXT, body TEXT)`);
  }
  record(r: Row): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO events (msgId, attempts, enqueuedAt, receivedAt, storedAt, type, sourceType, namespace,
        repoName, ref, before, after, eventTimestamp, subscriptionId, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.msgId, r.attempts, r.enqueuedAt, r.receivedAt, Date.now(), r.type, r.sourceType, r.namespace,
      r.repoName, r.ref, r.before, r.after, r.eventTimestamp, r.subscriptionId, r.body,
    );
  }
  list(sinceSeq: number): unknown[] {
    return this.ctx.storage.sql.exec(`SELECT * FROM events WHERE seq > ? ORDER BY seq`, sinceSeq).toArray();
  }
  reset(): number {
    const n = this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM events`).one().n as number;
    this.ctx.storage.sql.exec(`DELETE FROM events`);
    return n;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const receivedAt = Date.now();
    const rec = env.RECORDER.getByName('global');
    for (const m of batch.messages) {
      const b = (m.body ?? {}) as Record<string, any>;
      await rec.record({
        msgId: m.id,
        attempts: m.attempts,
        enqueuedAt: m.timestamp.getTime(),
        receivedAt,
        type: str(b.type),
        sourceType: str(b.source?.type),
        namespace: str(b.source?.namespace),
        repoName: str(b.source?.repoName),
        ref: str(b.payload?.ref),
        before: str(b.payload?.before),
        after: str(b.payload?.after),
        eventTimestamp: str(b.metadata?.eventTimestamp),
        subscriptionId: str(b.metadata?.eventSubscriptionId),
        body: JSON.stringify(m.body),
      });
      m.ack();
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Clock probe for the client's skew estimate (no auth; returns only the time).
    if (url.pathname === '/time') return Response.json({ now: Date.now() });
    if (req.headers.get('authorization') !== `Bearer ${env.SPIKE_ADMIN_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    const rec = env.RECORDER.getByName('global');
    if (url.pathname === '/events' && req.method === 'GET') {
      return Response.json(await rec.list(Number(url.searchParams.get('since') ?? 0)));
    }
    if (url.pathname === '/events' && req.method === 'DELETE') {
      return Response.json({ deleted: await rec.reset() });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
