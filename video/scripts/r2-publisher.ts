/**
 * Uploads evidence files to a Cloudflare R2 bucket through its S3-compatible endpoint, for
 * `pnpm evidence --publish`. The bucket must already exist with public access (an r2.dev URL or a
 * custom domain); this never creates or reconfigures it.
 *
 * Environment (from the shell or video/.env; values are never printed):
 *   CF_ACCOUNT_ID            CommonForge Cloudflare account id (endpoint <id>.r2.cloudflarestorage.com)
 *   CF_R2_ACCESS_KEY_ID      R2 API token access key with Object Read & Write on the bucket
 *   CF_R2_SECRET_ACCESS_KEY  its secret
 *   CF_R2_PUBLIC_URL         the bucket's public base URL, e.g. https://pub-….r2.dev or https://evidence.example.com
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { existsSync, readFileSync } from 'node:fs';

export interface Publisher {
  /** Bucket name, recorded in the manifest. */
  readonly bucket: string;
  /** Uploads `file` as `key`; R2 verifies the bytes against `sha256` (hex) and rejects a mismatch. */
  put(key: string, file: string, meta: { contentType: string; sha256: string }): Promise<void>;
  /** Public URL at which `key` is served. */
  publicUrl(key: string): string;
}

const REQUIRED = ['CF_ACCOUNT_ID', 'CF_R2_ACCESS_KEY_ID', 'CF_R2_SECRET_ACCESS_KEY', 'CF_R2_PUBLIC_URL'] as const;

/** `https://host/base` + `video/a b.png` → `https://host/base/video/a%20b.png` */
export function joinPublicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function createR2Publisher(o: { bucket: string; envFile?: string; env?: NodeJS.ProcessEnv }): Publisher {
  // video/.env fills in what the shell does not set (process.loadEnvFile never overrides)
  if (!o.env && o.envFile && existsSync(o.envFile)) process.loadEnvFile(o.envFile);
  const env = o.env ?? process.env;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`--publish needs ${missing.join(', ')} (in the environment or video/.env); see scripts/r2-publisher.ts`);
  }
  const baseUrl = env.CF_R2_PUBLIC_URL!;
  if (!/^https:\/\//.test(baseUrl)) throw new Error('CF_R2_PUBLIC_URL must be an https:// URL (the bucket\'s public r2.dev or custom-domain URL)');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.CF_R2_ACCESS_KEY_ID!, secretAccessKey: env.CF_R2_SECRET_ACCESS_KEY! },
    // R2 does not accept the SDK's default streaming CRC trailers; send the SHA-256 we computed instead
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    bucket: o.bucket,
    async put(key, file, meta) {
      await client.send(
        new PutObjectCommand({
          Bucket: o.bucket,
          Key: key,
          Body: readFileSync(file),
          ContentType: meta.contentType,
          ChecksumSHA256: Buffer.from(meta.sha256, 'hex').toString('base64'),
        }),
      );
    },
    publicUrl: (key) => joinPublicUrl(baseUrl, key),
  };
}
