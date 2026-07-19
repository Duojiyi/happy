import { afterEach, describe, expect, it } from "vitest";
import { buildApi, isTrustedLoopbackProxy, resolveApiHost } from "./api";

const chimeraEnv = {
    CHIMERA_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
    CHIMERA_ADMIN_SESSION_SECRET: Buffer.alloc(32, 1).toString("base64url"),
    CHIMERA_INVITATION_PEPPER: Buffer.alloc(32, 2).toString("base64url"),
    CHIMERA_ACCOUNT_PSEUDONYM_KEY: Buffer.alloc(32, 3).toString("base64url"),
    CHIMERA_UPDATE_PUBLIC_KEY: Buffer.alloc(32, 4).toString("base64url"),
};

afterEach(() => {
    for (const key of Object.keys(chimeraEnv)) delete process.env[key];
});

async function app() {
    Object.assign(process.env, chimeraEnv);
    return buildApi();
}

describe("trusted proxy boundary", () => {
    it.each(["127.0.0.1", "::1"])("trusts only loopback proxy address %s", (address) => {
        expect(isTrustedLoopbackProxy(address)).toBe(true);
    });

    it.each(["10.0.0.1", "::ffff:127.0.0.1", "203.0.113.10"])("does not trust spoofable proxy address %s", (address) => {
        expect(isTrustedLoopbackProxy(address)).toBe(false);
    });
});

describe("listener binding", () => {
    it("fails closed to loopback while allowing explicit local development overrides", () => {
        expect(resolveApiHost({})).toBe("127.0.0.1");
        expect(resolveApiHost({ host: "0.0.0.0" })).toBe("0.0.0.0");
    });
});

describe("Chimera production API surface", () => {
    it("returns exact CORS headers only for the relay origin and its preflight", async () => {
        const server = await app();
        const allowed = await server.inject({ method: "OPTIONS", url: "/v1/chimera/config", headers: { origin: "https://39.98.68.173", "access-control-request-method": "PUT", "access-control-request-headers": "content-type,x-chimera-csrf" } });
        expect(allowed.statusCode).toBe(204);
        expect(allowed.headers["access-control-allow-origin"]).toBe("https://39.98.68.173");
        expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
        expect(allowed.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, DELETE");
        expect(allowed.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization, X-Chimera-CSRF");
        const denied = await server.inject({ method: "GET", url: "/", headers: { origin: "https://example.test" } });
        expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
        await server.close();
    });

    it("does not register removed routes while keeping core authenticated routes", async () => {
        const server = await app();
        for (const url of ["/v1/voice/usage", "/v1/push-tokens", "/v1/connect/github/params", "/logs-combined-from-cli-and-mobile-for-simple-ai-debugging"]) {
            expect((await server.inject({ method: "GET", url })).statusCode).toBe(404);
        }
        for (const url of ["/v1/machines", "/v1/artifacts", "/v1/access-keys/session/machine", "/v1/sessions/session/attachments/file"]) {
            expect((await server.inject({ method: "GET", url })).statusCode).not.toBe(404);
        }
        await server.close();
    });
});
