import { describe, expect, it } from "vitest";
import {
  issueAdminSessionToken,
  issueHumanBypassToken,
  verifyAdminSessionToken,
  verifyHumanBypassToken
} from "../src/utils/session.js";

const ADMIN = "super-secret-admin";
const T0 = 1_700_000_000_000;

describe("admin session token", () => {
  it("round-trips and carries a 7-day expiry", async () => {
    const { token, payload } = await issueAdminSessionToken(ADMIN, T0);
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60 * 1000);
    const v = await verifyAdminSessionToken(token, ADMIN, T0 + 1000);
    expect(v.ok).toBe(true);
    expect(v.payload.iat).toBe(T0);
  });

  it("rejects expiry, wrong key, tampering and garbage", async () => {
    const { token } = await issueAdminSessionToken(ADMIN, T0);
    expect((await verifyAdminSessionToken(token, ADMIN, T0 + 8 * 24 * 3600 * 1000)).ok).toBe(false);
    expect((await verifyAdminSessionToken(token, "other-key", T0)).ok).toBe(false);

    const [payload, sig] = token.split(".");
    const tampered = `${payload.slice(0, -2)}AA.${sig}`;
    expect((await verifyAdminSessionToken(tampered, ADMIN, T0)).ok).toBe(false);
    expect((await verifyAdminSessionToken("nope", ADMIN, T0)).ok).toBe(false);
    expect((await verifyAdminSessionToken("", ADMIN, T0)).ok).toBe(false);
  });
});

describe("human bypass token", () => {
  it("is bound to the client IP", async () => {
    const { token } = await issueHumanBypassToken("turnstile-secret", "1.2.3.4", 60_000, T0);
    expect((await verifyHumanBypassToken(token, "turnstile-secret", "1.2.3.4", T0 + 10)).ok).toBe(true);
    expect((await verifyHumanBypassToken(token, "turnstile-secret", "5.6.7.8", T0 + 10)).ok).toBe(false);
    expect((await verifyHumanBypassToken(token, "turnstile-secret", "1.2.3.4", T0 + 61_000)).ok).toBe(false);
  });

  it("enforces a minimum ttl of 5s", async () => {
    const { payload } = await issueHumanBypassToken("k", "ip", 1, T0);
    expect(payload.exp - payload.iat).toBe(5000);
  });
});
