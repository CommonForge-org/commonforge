import { describe, expect, it } from "vitest";
import { lfsEndpointUrl } from "../../src/lib/lfs-config.js";

describe("lfsEndpointUrl", () => {
  it("is the folder's LFS endpoint under COMMONFORGE_PUBLIC_URL, without its trailing slashes", () => {
    expect(lfsEndpointUrl({ COMMONFORGE_PUBLIC_URL: "https://cf.example" }, "o1", "r1")).toBe("https://cf.example/api/lfs/o1/r1/info/lfs");
    expect(lfsEndpointUrl({ COMMONFORGE_PUBLIC_URL: "https://cf.example//" }, "o1", "r1")).toBe("https://cf.example/api/lfs/o1/r1/info/lfs");
    expect(lfsEndpointUrl({ COMMONFORGE_PUBLIC_URL: "http://localhost:8787/" }, "o1", "r1")).toBe("http://localhost:8787/api/lfs/o1/r1/info/lfs");
  });
});
