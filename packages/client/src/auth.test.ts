import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToken, getAuthUser, getFreshToken, getStoredToken, refreshSession, signOut, storeSession } from "./auth.js";

/** An unsigned JWT-shaped token; the client only decodes, never verifies. */
function fakeJwt(expiresInSeconds: number, sub = "user-1"): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode({ sub, email: "ada@example.com", exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  clearToken();
  vi.unstubAllGlobals();
});

describe("client session", () => {
  it("exposes the signed-in user from the stored access token", () => {
    storeSession({ token: fakeJwt(900), refreshToken: "r1" });
    expect(getAuthUser()).toEqual({ id: "user-1", email: "ada@example.com" });
  });

  it("returns the current token while it is comfortably valid", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const token = fakeJwt(900);
    storeSession({ token, refreshToken: "r1" });
    expect(await getFreshToken()).toBe(token);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes a token that is about to expire and stores the rotated pair", async () => {
    const next = fakeJwt(900);
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { token: next, refreshToken: "r2" }));
    vi.stubGlobal("fetch", fetchSpy);
    storeSession({ token: fakeJwt(10), refreshToken: "r1" });

    expect(await getFreshToken()).toBe(next);
    expect(JSON.parse(fetchSpy.mock.calls[0]![1].body)).toEqual({ refreshToken: "r1" });
    expect(getStoredToken()).toBe(next);
  });

  it("shares one refresh between concurrent callers (refresh tokens are single-use)", async () => {
    const next = fakeJwt(900);
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { token: next, refreshToken: "r2" }));
    vi.stubGlobal("fetch", fetchSpy);
    storeSession({ token: fakeJwt(5), refreshToken: "r1" });

    const results = await Promise.all([refreshSession(), refreshSession(), getFreshToken()]);
    expect(results).toEqual([next, next, next]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("signs out locally when the server rejects the refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "session expired" })));
    storeSession({ token: fakeJwt(5), refreshToken: "r1" });
    expect(await refreshSession()).toBeNull();
    expect(getAuthUser()).toBeNull();
  });

  it("keeps the session through a transient refresh failure", async () => {
    const token = fakeJwt(5);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    storeSession({ token, refreshToken: "r1" });
    expect(await refreshSession()).toBe(token);
    expect(getStoredToken()).toBe(token);
  });

  it("revokes the server session on sign out", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    storeSession({ token: fakeJwt(900), refreshToken: "r1" });
    await signOut();
    expect(fetchSpy.mock.calls[0]![0]).toMatch(/\/auth\/logout$/);
    expect(getStoredToken()).toBeNull();
  });
});
