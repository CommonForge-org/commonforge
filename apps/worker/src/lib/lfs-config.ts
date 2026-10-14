/** Settings and key layout of LFS objects and uploads (spec 2026-10-07 §4–§5, plan phase 2). */
import { DEFAULT_LFS_THRESHOLD_BYTES } from "@commonforge-org/runner-protocol";
import type { Env } from "../env.js";

export const DEFAULT_UPLOAD_PART_BYTES = 52_428_800;
/** R2 refuses multipart parts under 5 MiB (except the last). */
export const MIN_UPLOAD_PART_BYTES = 5_242_880;
export const UNFINISHED_UPLOAD_TTL_HOURS = 24;

const intVar = (v: string | undefined, fallback: number, min = 1) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

export function lfsSettings(env: Pick<Env, "COMMONFORGE_LFS_THRESHOLD_BYTES" | "COMMONFORGE_STAGING_TTL_DAYS" | "COMMONFORGE_UPLOAD_PART_BYTES">) {
  return {
    thresholdBytes: intVar(env.COMMONFORGE_LFS_THRESHOLD_BYTES, DEFAULT_LFS_THRESHOLD_BYTES),
    stagingTtlDays: intVar(env.COMMONFORGE_STAGING_TTL_DAYS, 7),
    uploadPartBytes: intVar(env.COMMONFORGE_UPLOAD_PART_BYTES, DEFAULT_UPLOAD_PART_BYTES, MIN_UPLOAD_PART_BYTES),
  };
}

/**
 * A folder's Git LFS endpoint (`lfs.url`): the `.lfsconfig` of a new folder, the materialization
 * plan's `lfsUrl` and the batch API's `href`s all use it (folders phase 4, ruling P4-6).
 */
export function lfsEndpointUrl(env: Pick<Env, "COMMONFORGE_PUBLIC_URL">, org: string, resourceId: string): string {
  return `${env.COMMONFORGE_PUBLIC_URL.replace(/\/+$/, "")}/api/lfs/${org}/${resourceId}/info/lfs`;
}

/** 15 minutes, longer for big objects (their size at 2 MB/s), at most 1 hour (spike recommendation). */
export function presignTtlSeconds(size: number): number {
  return Math.min(3600, Math.max(900, Math.ceil(size / 2_000_000)));
}

/** One key per stored object; acceptance is the database's `accepted_at`, bytes never move. */
export function lfsObjectKey(orgId: string, resourceId: string, stagingId: string): string {
  return `org/${orgId}/lfs/${resourceId}/obj/${stagingId}`;
}
