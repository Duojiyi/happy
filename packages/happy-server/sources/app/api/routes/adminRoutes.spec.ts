import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { adminRoutes, createLoginLimits } from "@/app/chimera/adminRoutes";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const passwordHash = "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg";

function app() {
    const server = fastify();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    const account = { id: "A".repeat(43), createdAt: "2026-07-19T00:00:00.000Z", disabled: false, attachmentUsedBytes: "12", attachmentQuotaBytes: "5368709120" };
    const accounts = {
        list: async () => [account],
        disable: async () => ({ ...account, disabled: true }),
        restore: async () => account,
        revokeTokens: async () => account,
        setQuota: async (_id: string, bytes: number) => ({ ...account, attachmentQuotaBytes: String(bytes) }),
    };
    const invitations = {
        list: async () => [{ id: "invite-1", label: "Tester", maxUses: 1, usedCount: 0, expiresAt: new Date("2026-07-26T00:00:00Z"), revokedAt: null, createdAt: new Date("2026-07-19T00:00:00Z") }],
        create: async () => ({ code: "one-time-code", invitation: { id: "invite-1", label: "Tester", maxUses: 1, usedCount: 0 } }),
        revoke: async () => ({ id: "invite-1", revokedAt: new Date("2026-07-19T01:00:00Z") }),
    };
    const sessions = {
        create: async () => ({ sessionId: "session", csrfToken: "csrf" }),
        authenticate: async (sessionId: string) => sessionId === "session" ? { id: "s1", csrfToken: "csrf" } : null,
        authorizeMutation: async (sessionId: string, csrf: string) => sessionId === "session" && csrf === "csrf" ? { id: "s1", csrfToken: "csrf" } : null,
        revoked: [] as string[],
        revoke: async (sessionId: string) => { sessions.revoked.push(sessionId); },
        revokeAll: async () => undefined,
    };
    adminRoutes(server as any, { passwordHash, sessions: sessions as any, accounts: accounts as any, invitations: invitations as any, verifyPassword: async (password, hash) => password === "correct" && hash === passwordHash, loginLimits: { acquire: () => true, release: () => undefined } });
    return Object.assign(server, { sessions });
}

describe("Chimera admin routes", () => {
    it("serves the local control console with restrictive browser headers", async () => {
        const server = app();
        const response = await server.inject({ method: "GET", url: "/chimera-control" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
        expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect((await server.inject({ method: "GET", url: "/chimera-control/control.js" })).headers["content-type"]).toContain("javascript");
        await server.close();
    });

    it("returns one bounded public 401 shape for malformed and rejected login", async () => {
        const server = app();
        const malformed = await server.inject({ method: "POST", url: "/chimera-control/api/session", payload: {} });
        const rejected = await server.inject({ method: "POST", url: "/chimera-control/api/session", payload: { password: "wrong" } });
        expect(malformed.statusCode).toBe(401); expect(rejected.statusCode).toBe(401);
        expect(malformed.payload).toBe(rejected.payload);
        await server.close();
    });

    it("sets the scoped secure HttpOnly strict cookie and returns the CSRF token after login", async () => {
        const server = app();
        const response = await server.inject({ method: "POST", url: "/chimera-control/api/session", payload: { password: "correct" } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ csrfToken: "csrf" });
        expect(response.headers["set-cookie"]).toContain("__Secure-chimera_admin=session; Path=/chimera-control; HttpOnly; Secure; SameSite=Strict");
        await server.close();
    });

    it("requires the exact origin and session-bound CSRF token for mutations", async () => {
        const server = app();
        for (const headers of [{ cookie: "__Secure-chimera_admin=session", "x-chimera-csrf": "csrf" }, { cookie: "__Secure-chimera_admin=session", origin: "https://example.test", "x-chimera-csrf": "csrf" }, { cookie: "__Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "wrong" }]) {
            expect((await server.inject({ method: "DELETE", url: "/chimera-control/api/session", headers })).statusCode).toBe(401);
        }
        const logout = await server.inject({ method: "DELETE", url: "/chimera-control/api/session", headers: { cookie: "foo=bar; __Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "csrf" } });
        expect(logout.statusCode).toBe(204);
        expect(logout.headers["set-cookie"]).toBe("__Secure-chimera_admin=; Path=/chimera-control; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
        expect((server as any).sessions.revoked).toEqual(["session"]);
        await server.close();
    });

    it("authenticates GET sessions and supports revoke-all mutations", async () => {
        const server = app();
        expect((await server.inject({ method: "GET", url: "/chimera-control/api/session", headers: { cookie: "foo=bar; __Secure-chimera_admin=session" } })).statusCode).toBe(200);
        expect((await server.inject({ method: "GET", url: "/chimera-control/api/session" })).statusCode).toBe(401);
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/session/revoke-all", headers: { cookie: "__Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "csrf" } })).statusCode).toBe(204);
        await server.close();
    });

    it("bounds per-IP windows and global concurrent logins", async () => {
        let now = 0; const limits = createLoginLimits(() => now, 2);
        expect(limits.acquire("a")).toBe(true); expect(limits.acquire("b")).toBe(true); expect(limits.acquire("c")).toBe(false);
        limits.release(); limits.release();
        for (let i = 0; i < 5; i++) { expect(limits.acquire("ip")).toBe(true); limits.release(); }
        expect(limits.acquire("ip")).toBe(false); now = 15 * 60 * 1000 + 1;
        expect(limits.acquire("ip")).toBe(true); limits.release();
    });

    it("sweeps stale identities and fails closed at the identity cap", () => {
        let now = 0; const limits = createLoginLimits(() => now, 10, 3);
        for (const ip of ["a", "b"]) { expect(limits.acquire(ip)).toBe(true); limits.release(); }
        expect(limits.acquire("c")).toBe(false);
        now = 15 * 60 * 1000 + 1;
        expect(limits.acquire("c")).toBe(true); limits.release();
    });

    it("does not consume a concurrency slot for malformed login bodies", async () => {
        const server = fastify(); let active = 0;
        server.setValidatorCompiler(validatorCompiler);
        server.setSerializerCompiler(serializerCompiler);
        adminRoutes(server as any, { passwordHash, sessions: { create: async () => ({ sessionId: "s", csrfToken: "c" }) } as any, accounts: { list: async () => [] } as any, invitations: { list: async () => [] } as any, verifyPassword: async () => true, loginLimits: { acquire: () => { active++; return active === 1; }, release: () => { active--; } } });
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/session", payload: {} })).statusCode).toBe(401);
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/session", payload: { password: "x" } })).statusCode).toBe(200);
        await server.close();
    });

    it("requires admin authentication and returns only allowlisted account fields", async () => {
        const server = app();
        expect((await server.inject({ method: "GET", url: "/chimera-control/api/accounts" })).statusCode).toBe(401);
        const response = await server.inject({ method: "GET", url: "/chimera-control/api/accounts", headers: { cookie: "__Secure-chimera_admin=session" } });
        expect(response.statusCode).toBe(200);
        expect(Object.keys(response.json()[0]).sort()).toEqual(["attachmentQuotaBytes", "attachmentUsedBytes", "createdAt", "disabled", "id"]);
        await server.close();
    });

    it("requires origin and CSRF and rejects unknown account-control inputs", async () => {
        const server = app();
        const id = "A".repeat(43);
        const base = { method: "POST" as const, url: `/chimera-control/api/accounts/${id}/disable`, payload: {} };
        expect((await server.inject({ ...base, headers: { cookie: "__Secure-chimera_admin=session" } })).statusCode).toBe(401);
        const headers = { cookie: "__Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "csrf" };
        expect((await server.inject({ ...base, headers })).statusCode).toBe(200);
        expect((await server.inject({ ...base, headers, payload: { extra: true } })).statusCode).toBe(400);
        expect((await server.inject({ method: "GET", url: "/chimera-control/api/accounts?extra=1", headers: { cookie: "__Secure-chimera_admin=session" } })).statusCode).toBe(400);
        expect((await server.inject({ method: "PUT", url: `/chimera-control/api/accounts/${id}/quota`, headers, payload: { attachmentQuotaBytes: 100 * 1024 * 1024, extra: true } })).statusCode).toBe(400);
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/accounts/not-valid/disable", headers, payload: {} })).statusCode).toBe(400);
        await server.close();
    });

    it("creates invitation plaintext once and never includes digests in list responses", async () => {
        const server = app();
        const headers = { cookie: "__Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "csrf" };
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/invitations", headers: { cookie: "__Secure-chimera_admin=session" }, payload: {} })).statusCode).toBe(401);
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/invitations", headers, payload: { extra: true } })).statusCode).toBe(400);
        const created = await server.inject({ method: "POST", url: "/chimera-control/api/invitations", headers, payload: { label: "Tester", maxUses: 1, expiresAt: "2026-07-26T00:00:00.000Z" } });
        expect(created.statusCode).toBe(200);
        expect(created.json().code).toBe("one-time-code");
        const listed = await server.inject({ method: "GET", url: "/chimera-control/api/invitations", headers: { cookie: "__Secure-chimera_admin=session" } });
        expect(listed.statusCode).toBe(200);
        expect(listed.payload).not.toContain("codeDigest");
        expect(listed.payload).not.toContain("one-time-code");
        expect((await server.inject({ method: "POST", url: "/chimera-control/api/invitations/invite-1/revoke", headers, payload: {} })).statusCode).toBe(200);
        await server.close();
    });
});
