import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { adminRoutes } from "@/app/chimera/adminRoutes";

const passwordHash = "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg";

function app() {
    const server = fastify();
    const sessions = {
        create: async () => ({ sessionId: "session", csrfToken: "csrf" }),
        authenticate: async (sessionId: string) => sessionId === "session" ? { id: "s1", csrfToken: "csrf" } : null,
        authorizeMutation: async (sessionId: string, csrf: string) => sessionId === "session" && csrf === "csrf" ? { id: "s1", csrfToken: "csrf" } : null,
        revoke: async () => undefined,
        revokeAll: async () => undefined,
    };
    adminRoutes(server as any, { passwordHash, sessions: sessions as any, verifyPassword: async (password, hash) => password === "correct" && hash === passwordHash, loginLimits: { consume: () => true } });
    return server;
}

describe("Chimera admin routes", () => {
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
        expect((await server.inject({ method: "DELETE", url: "/chimera-control/api/session", headers: { cookie: "__Secure-chimera_admin=session", origin: "https://39.98.68.173", "x-chimera-csrf": "csrf" } })).statusCode).toBe(204);
        await server.close();
    });
});
