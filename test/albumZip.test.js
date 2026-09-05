import { describe, expect, it } from "vitest";
import { zipPolicy, ZIP_DEFAULT_MAX_BYTES, ZIP_DEFAULT_MAX_FILES } from "../src/utils/albumZip.js";

const entry = (i, size) => ({ name: `${i}.jpg`, ref: "a".repeat(64), ...(size === undefined ? {} : { size }) });
const many = (n, size) => Array.from({ length: n }, (_, i) => entry(i, size));

describe("zipPolicy", () => {
  it("allows albums within the default limits", () => {
    expect(zipPolicy(many(100, 5 * 1024 * 1024))).toEqual({
      enabled: true, available: true, reason: null, fileCount: 100, totalBytes: 100 * 5 * 1024 * 1024,
      sizeKnown: true, maxFiles: ZIP_DEFAULT_MAX_FILES, maxBytes: ZIP_DEFAULT_MAX_BYTES
    });
  });

  it("blocks more than maxFiles photos (checked before size)", () => {
    expect(zipPolicy(many(101, 1))).toMatchObject({ available: false, reason: "too_many_files", fileCount: 101 });
    expect(zipPolicy(many(101))).toMatchObject({ available: false, reason: "too_many_files", sizeKnown: false });
  });

  it("blocks more than maxBytes in total", () => {
    const r = zipPolicy([entry(0, ZIP_DEFAULT_MAX_BYTES), entry(1, 1)]);
    expect(r).toMatchObject({ available: false, reason: "too_large", totalBytes: ZIP_DEFAULT_MAX_BYTES + 1 });
    expect(zipPolicy([entry(0, ZIP_DEFAULT_MAX_BYTES)])).toMatchObject({ available: true });
  });

  it("blocks when any size is missing, reports empty albums and the kill switch", () => {
    expect(zipPolicy([entry(0, 10), entry(1)])).toMatchObject({ available: false, reason: "size_unknown", totalBytes: 10, sizeKnown: false });
    expect(zipPolicy([])).toMatchObject({ available: false, reason: "empty", fileCount: 0 });
    expect(zipPolicy(many(1, 1), { ZIP_DOWNLOAD: "0" })).toMatchObject({ enabled: false, available: false, reason: "disabled" });
  });

  it("reads limits from env and ignores garbage values", () => {
    expect(zipPolicy(many(3, 10), { ZIP_MAX_FILES: "2" })).toMatchObject({ reason: "too_many_files", maxFiles: 2 });
    expect(zipPolicy(many(3, 10), { ZIP_MAX_BYTES: "29" })).toMatchObject({ reason: "too_large", maxBytes: 29 });
    expect(zipPolicy(many(3, 10), { ZIP_MAX_FILES: "0", ZIP_MAX_BYTES: "abc" })).toMatchObject({
      available: true, maxFiles: ZIP_DEFAULT_MAX_FILES, maxBytes: ZIP_DEFAULT_MAX_BYTES
    });
  });
});
