import { describe, expect, it } from "vitest";
import { hmacSha256Hex, imageSig, sha256Hex, timingSafeEqual } from "../src/utils/crypto.js";
import { extractSecrets } from "../src/utils/albumSecrets.js";

describe("sha256Hex / hmacSha256Hex", () => {
  it("matches known vectors", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // RFC 4231 test case 2
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
  });
});

describe("imageSig", () => {
  it("is deterministic and depends on every input", async () => {
    const a = await imageSig("album", "1.jpg", "secret");
    expect(a).toBe(await imageSig("album", "1.jpg", "secret"));
    expect(a).toHaveLength(64);
    expect(a).not.toBe(await imageSig("album", "2.jpg", "secret"));
    expect(a).not.toBe(await imageSig("album2", "1.jpg", "secret"));
    expect(a).not.toBe(await imageSig("album", "1.jpg", "other"));
  });
});

describe("timingSafeEqual", () => {
  it("compares strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("abc", null)).toBe(false);
  });
});

describe("extractSecrets", () => {
  it("reads the secrets object keys and ignores anything else", () => {
    expect(extractSecrets({ secrets: { a: {}, b: 1 } })).toEqual(["a", "b"]);
    expect(extractSecrets({ secret: "a" })).toEqual([]);
    expect(extractSecrets({})).toEqual([]);
    expect(extractSecrets(null)).toEqual([]);
    expect(extractSecrets({ secrets: { "": 1 } })).toEqual([]);
  });
});
