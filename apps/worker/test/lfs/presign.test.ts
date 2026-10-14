import { describe, expect, it } from "vitest";
import { CREATE_ONLY_HEADERS, presignParts, presignR2, presignUrl } from "../../src/lib/presign.js";
import { lfsObjectKey, lfsSettings, presignTtlSeconds } from "../../src/lib/lfs-config.js";

describe("SigV4 query presigning", () => {
  it("matches the AWS documentation example", async () => {
    const url = await presignUrl({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("R2: path-style on <account>.r2.cloudflarestorage.com, region auto, one key, encoded segments", async () => {
    const url = new URL(
      await presignR2({ accountId: "acc123", bucket: "commonforge-assets-dev", accessKeyId: "KID", secretAccessKey: "SECRET" }, "org/o1/lfs/r1/obj/lfs-ab cd", "PUT", 900, new Date("2026-10-07T12:00:00Z")),
    );
    expect(url.host).toBe("acc123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/commonforge-assets-dev/org/o1/lfs/r1/obj/lfs-ab%20cd");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("KID/20261007/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the canonical request of an LFS upload URL signs host and if-none-match: * (sorted, lower-case, UNSIGNED-PAYLOAD)", async () => {
    const input = {
      method: "PUT" as const,
      host: "acc123.r2.cloudflarestorage.com",
      path: "/commonforge-assets-dev/org/o1/lfs/r1/obj/lfs-x",
      region: "auto",
      service: "s3",
      accessKeyId: "KID",
      secretAccessKey: "SECRET",
      expiresSeconds: 900,
      now: new Date("2026-10-07T12:00:00Z"),
    };
    const { canonicalRequest } = presignParts({ ...input, headers: { ...CREATE_ONLY_HEADERS } });
    expect(canonicalRequest).toBe(
      [
        "PUT",
        "/commonforge-assets-dev/org/o1/lfs/r1/obj/lfs-x",
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KID%2F20261007%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261007T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host%3Bif-none-match",
        "host:acc123.r2.cloudflarestorage.com",
        "if-none-match:*",
        "",
        "host;if-none-match",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );
    // without extra headers the canonical request is exactly the one the AWS example above verifies
    expect(presignParts(input).canonicalRequest).toBe(
      [
        "PUT",
        "/commonforge-assets-dev/org/o1/lfs/r1/obj/lfs-x",
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=KID%2F20261007%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261007T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host",
        "host:acc123.r2.cloudflarestorage.com",
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );
    const url = new URL(await presignUrl({ ...input, headers: { ...CREATE_ONLY_HEADERS } }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
    // a different signed header value is a different signature
    expect(url.searchParams.get("X-Amz-Signature")).not.toBe(new URL(await presignUrl(input)).searchParams.get("X-Amz-Signature"));
    expect(() => presignParts({ ...input, headers: { "If-None-Match": "*" } })).toThrow(/lower-case/);
  });
});

describe("LFS settings", () => {
  it("defaults, overrides and the part-size floor", () => {
    expect(lfsSettings({} as never)).toEqual({ thresholdBytes: 1_048_576, stagingTtlDays: 7, uploadPartBytes: 52_428_800 });
    expect(lfsSettings({ COMMONFORGE_LFS_THRESHOLD_BYTES: "2048", COMMONFORGE_STAGING_TTL_DAYS: "3", COMMONFORGE_UPLOAD_PART_BYTES: "5242880" } as never)).toEqual({ thresholdBytes: 2048, stagingTtlDays: 3, uploadPartBytes: 5_242_880 });
    expect(lfsSettings({ COMMONFORGE_UPLOAD_PART_BYTES: "1000" } as never).uploadPartBytes).toBe(52_428_800);
  });
  it("presigned TTL: 15 min, scaled at 2 MB/s, at most 1 h", () => {
    expect(presignTtlSeconds(10)).toBe(900);
    expect(presignTtlSeconds(4_000_000_000)).toBe(2000);
    expect(presignTtlSeconds(5_000_000_000)).toBe(2500);
    expect(presignTtlSeconds(50_000_000_000)).toBe(3600);
  });
  it("object keys live under the org and the folder", () => {
    expect(lfsObjectKey("o1", "r1", "lfs-x")).toBe("org/o1/lfs/r1/obj/lfs-x");
  });
});
