import { describe, expect, it } from "vitest";
import { isValidAlbumId, isValidAlbumSecret, isValidPhotoFileName, normalizeJpgName } from "../src/utils/validate.js";

describe("isValidAlbumId", () => {
  it("accepts date-prefixed kebab ids", () => {
    expect(isValidAlbumId("2025.12.25-sunny-family-beach")).toBe(true);
    expect(isValidAlbumId("abc_123")).toBe(true);
  });
  it("rejects slashes, spaces, empty and overlong", () => {
    expect(isValidAlbumId("")).toBe(false);
    expect(isValidAlbumId("a/b")).toBe(false);
    expect(isValidAlbumId("a b")).toBe(false);
    expect(isValidAlbumId("x".repeat(129))).toBe(false);
    expect(isValidAlbumId(null)).toBe(false);
  });
});

describe("isValidAlbumSecret", () => {
  it("accepts url-fragment-safe strings", () => {
    expect(isValidAlbumSecret("a1b2c3")).toBe(true);
    expect(isValidAlbumSecret("with-dash_and_underscore")).toBe(true);
  });
  it("rejects characters that need encoding in a fragment", () => {
    expect(isValidAlbumSecret("has space")).toBe(false);
    expect(isValidAlbumSecret("has#hash")).toBe(false);
    expect(isValidAlbumSecret("")).toBe(false);
  });
});

describe("normalizeJpgName", () => {
  it("strips paths and forces a jpeg extension", () => {
    expect(normalizeJpgName("dir/sub\\photo.PNG")).toBe("photo.jpg");
    expect(normalizeJpgName("photo")).toBe("photo.jpg");
    expect(normalizeJpgName("Photo.JPEG")).toBe("Photo.jpeg");
    expect(normalizeJpgName("Photo.JPG")).toBe("Photo.jpg");
    expect(normalizeJpgName("   ")).toBe("");
  });
});

describe("isValidPhotoFileName", () => {
  it("accepts plain jpeg names", () => {
    expect(isValidPhotoFileName("001_beach.jpg")).toBe(true);
    expect(isValidPhotoFileName("Sunset 2.jpeg")).toBe(true);
  });
  it("rejects traversal, hidden files and non-jpeg", () => {
    expect(isValidPhotoFileName("../x.jpg")).toBe(false);
    expect(isValidPhotoFileName(".hidden.jpg")).toBe(false);
    expect(isValidPhotoFileName("a/b.jpg")).toBe(false);
    expect(isValidPhotoFileName("photo.png")).toBe(false);
    expect(isValidPhotoFileName("x".repeat(160) + ".jpg")).toBe(false);
  });
});
