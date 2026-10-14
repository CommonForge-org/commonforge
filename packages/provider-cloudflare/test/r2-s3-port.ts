/**
 * Node-only {@link R2PortBucket} over the R2 S3-compatible API with hand-rolled SigV4 (no AWS SDK),
 * used by the live test. Credentials are derived from a Cloudflare API token as documented for R2:
 * access key id = the token's id, secret access key = hex sha256 of the token value.
 *
 * Test-only; a production Node/CLI adapter would move to `src/` once something outside tests needs it.
 */
import { createHash, createHmac } from 'node:crypto';
import type {
  R2PortBucket,
  R2PortListOptions,
  R2PortListResult,
  R2PortMultipartOptions,
  R2PortMultipartUpload,
  R2PortObject,
  R2PortObjectBody,
  R2PortPutOptions,
  R2PortReader,
  R2PortUploadedPart,
} from '../src/r2-port.js';

export interface S3Creds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Uint8Array | string, s: string) => createHmac('sha256', k).update(s).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const xmlDecode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlDecode(m[1]!) : undefined;
};

/**
 * Derive S3 credentials from an API token. The token id comes from `/accounts/:id/tokens/verify`
 * (account-owned tokens) or, failing that, `/user/tokens/verify` (user tokens).
 */
export async function s3CredsFromApiToken(accountId: string, apiToken: string): Promise<S3Creds> {
  for (const url of [
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ]) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` } });
    const body = (await res.json()) as { success: boolean; result?: { id: string } };
    if (body.success && body.result?.id) {
      return { accountId, accessKeyId: body.result.id, secretAccessKey: sha256Hex(apiToken) };
    }
  }
  throw new Error('token verify failed on both the account and user endpoints');
}

export class S3R2Port implements R2PortBucket {
  private readonly host: string;

  constructor(
    private readonly creds: S3Creds,
    private readonly bucket: string,
  ) {
    this.host = `${creds.accountId}.r2.cloudflarestorage.com`;
  }

  private async send(
    method: string,
    key: string | null,
    o: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array | string; unsignedPayload?: boolean } = {},
  ): Promise<Response> {
    const path = `/${this.bucket}${key === null ? '' : `/${key.split('/').map(rfc3986).join('/')}`}`;
    const query = Object.entries(o.query ?? {})
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const body = o.body ?? '';
    const payloadHash = o.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256Hex(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v.trim();
    const names = Object.keys(headers).sort();
    const canonical = [method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${date}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.creds.secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const { host: _h, ...sendHeaders } = headers;
    sendHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${this.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    const url = `https://${this.host}${path}${query ? `?${query}` : ''}`;
    return fetch(url, { method, headers: sendHeaders, ...(o.body !== undefined ? { body: o.body as NonNullable<RequestInit['body']> } : {}) });
  }

  private async ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`S3 ${what} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  private metaHeaders(o: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
    const h: Record<string, string> = {};
    if (o.httpMetadata?.contentType) h['content-type'] = o.httpMetadata.contentType;
    for (const [k, v] of Object.entries(o.customMetadata ?? {})) h[`x-amz-meta-${k.toLowerCase()}`] = v;
    return h;
  }

  private objectFrom(key: string, res: Response): R2PortObject {
    const custom: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-amz-meta-')) custom[k.slice('x-amz-meta-'.length)] = v;
    });
    const ct = res.headers.get('content-type');
    return {
      key,
      size: Number(res.headers.get('content-length') ?? '0'),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
      uploaded: new Date(res.headers.get('last-modified') ?? 0),
      httpMetadata: ct ? { contentType: ct } : {},
      customMetadata: custom,
    };
  }

  async head(key: string): Promise<R2PortObject | null> {
    const res = await this.send('HEAD', key);
    if (res.status === 404) return null;
    await this.ok(res, `HEAD ${key}`);
    return this.objectFrom(key, res);
  }

  async get(key: string): Promise<R2PortObjectBody | null> {
    const res = await this.send('GET', key, { unsignedPayload: true });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    await this.ok(res, `GET ${key}`);
    const meta = this.objectFrom(key, res);
    const stream = res.body!;
    return {
      ...meta,
      body: { getReader: () => stream.getReader() as unknown as R2PortReader },
      arrayBuffer: () => res.arrayBuffer(),
    };
  }

  async put(key: string, value: Uint8Array | string, options: R2PortPutOptions = {}): Promise<R2PortObject | null> {
    if (options.sha256 !== undefined && sha256Hex(value) !== options.sha256) throw new Error(`put ${key}: sha256 mismatch`);
    // SigV4's x-amz-content-sha256 makes R2 verify the payload hash server-side.
    await this.ok(await this.send('PUT', key, { body: value, headers: this.metaHeaders(options) }), `PUT ${key}`);
    return this.head(key);
  }

  async delete(keys: string | string[]): Promise<void> {
    const ks = typeof keys === 'string' ? [keys] : keys;
    for (let i = 0; i < ks.length; i += 16) {
      await Promise.all(
        ks.slice(i, i + 16).map(async (k) => {
          const res = await this.send('DELETE', k);
          if (res.status !== 404) await this.ok(res, `DELETE ${k}`);
        }),
      );
    }
  }

  async list(options: R2PortListOptions = {}): Promise<R2PortListResult> {
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(options.limit ?? 1000) };
    if (options.prefix) query.prefix = options.prefix;
    if (options.cursor) query['continuation-token'] = options.cursor;
    const xml = await (await this.ok(await this.send('GET', null, { query }), 'LIST')).text();
    const objects: R2PortObject[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1]!;
      objects.push({
        key: tag(c, 'Key')!,
        size: Number(tag(c, 'Size')),
        etag: (tag(c, 'ETag') ?? '').replace(/"/g, ''),
        uploaded: new Date(tag(c, 'LastModified')!),
      });
    }
    const truncated = tag(xml, 'IsTruncated') === 'true';
    const cursor = tag(xml, 'NextContinuationToken');
    return truncated && cursor ? { objects, truncated, cursor } : { objects, truncated: false };
  }

  async createMultipartUpload(key: string, options: R2PortMultipartOptions = {}): Promise<R2PortMultipartUpload> {
    const xml = await (
      await this.ok(await this.send('POST', key, { query: { uploads: '' }, headers: this.metaHeaders(options) }), `MPU create ${key}`)
    ).text();
    const uploadId = tag(xml, 'UploadId');
    if (!uploadId) throw new Error(`MPU create ${key}: no UploadId`);
    const self = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: Uint8Array): Promise<R2PortUploadedPart> {
        const res = await self.ok(
          await self.send('PUT', key, { query: { partNumber: String(partNumber), uploadId }, body: value }),
          `MPU part ${partNumber}`,
        );
        return { partNumber, etag: (res.headers.get('etag') ?? '').replace(/"/g, '') };
      },
      async abort(): Promise<void> {
        const res = await self.send('DELETE', key, { query: { uploadId } });
        if (res.status !== 404) await self.ok(res, `MPU abort ${key}`);
      },
      async complete(parts: R2PortUploadedPart[]): Promise<R2PortObject> {
        const body =
          '<CompleteMultipartUpload>' +
          [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
            .join('') +
          '</CompleteMultipartUpload>';
        const res = await self.ok(
          await self.send('POST', key, { query: { uploadId }, body, headers: { 'content-type': 'application/xml' } }),
          `MPU complete ${key}`,
        );
        const text = await res.text();
        if (text.includes('<Error>')) throw new Error(`MPU complete ${key}: ${text.slice(0, 300)}`);
        const head = await self.head(key);
        if (!head) throw new Error(`MPU complete ${key}: object missing`);
        return head;
      },
    };
  }
}

/** Cloudflare REST bucket management (create/delete) for disposable live-test buckets. */
export async function r2Bucket(accountId: string, apiToken: string, op: 'create' | 'delete', name: string): Promise<void> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`;
  const res =
    op === 'create'
      ? await fetch(base, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      : await fetch(`${base}/${name}`, { method: 'DELETE', headers: { authorization: `Bearer ${apiToken}` } });
  const body = (await res.json()) as { success: boolean; errors?: Array<{ code: number; message: string }> };
  if (!body.success) throw new Error(`R2 bucket ${op} ${name} failed: ${JSON.stringify(body.errors)}`);
}
