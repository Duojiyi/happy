import argon2 from "argon2";
import { db } from "@/storage/db";
import { loadChimeraServerConfig } from "./config";
import { createAdminSessionService, deriveAdminSessionSecret } from "./adminSessions";

const COOKIE_NAME = "__Secure-chimera_admin";
const ORIGIN = "https://39.98.68.173";
const UNAUTHORIZED = { error: "Unauthorized" };

type LoginLimits = { acquire(ip: string): boolean; release(): void };
export function createLoginLimits(now = () => Date.now(), maxConcurrent = 10): LoginLimits {
    const attempts = new Map<string, number[]>();
    let active = 0;
    return { acquire(ip) {
        const floor = now() - 15 * 60 * 1000;
        const global = (attempts.get("*") ?? []).filter((at) => at > floor);
        const perIp = (attempts.get(ip) ?? []).filter((at) => at > floor);
        if (active >= maxConcurrent || global.length >= 100 || perIp.length >= 5) return false;
        const at = now(); active++; attempts.set("*", [...global, at]); attempts.set(ip, [...perIp, at]); return true;
    }, release() { active = Math.max(0, active - 1); } };
}

function cookie(request: { headers: Record<string, unknown> }) {
    const header = request.headers.cookie;
    if (typeof header !== "string") return null;
    return header.split(/;\s*/).map((part) => part.split("=", 2)).find(([name]) => name === COOKIE_NAME)?.[1] ?? null;
}

export function adminRoutes(app: any, dependencies: { passwordHash?: string; sessions?: ReturnType<typeof createAdminSessionService>; verifyPassword?: (password: string, hash: string) => Promise<boolean>; loginLimits?: LoginLimits } = {}) {
    const config = dependencies.passwordHash ? null : loadChimeraServerConfig(process.env);
    const passwordHash = dependencies.passwordHash ?? config!.adminPasswordHash;
    const sessions = dependencies.sessions ?? createAdminSessionService({ secret: deriveAdminSessionSecret(config!.adminSessionSecret, passwordHash), db });
    const verifyPassword = dependencies.verifyPassword ?? ((password, hash) => argon2.verify(hash, password));
    const limits = dependencies.loginLimits ?? createLoginLimits();
    const unauthorised = (reply: any) => reply.code(401).send(UNAUTHORIZED);
    app.post("/chimera-control/api/session", async (request: any, reply: any) => {
        if (!limits.acquire(request.ip) || !request.body || typeof request.body !== "object" || Array.isArray(request.body)
            || Object.keys(request.body).length !== 1 || typeof request.body.password !== "string" || request.body.password.length > 1024) return unauthorised(reply);
        let verified = false;
        try { verified = await verifyPassword(request.body.password, passwordHash); } catch { verified = false; } finally { limits.release(); }
        if (!verified) return unauthorised(reply);
        const session = await sessions.create();
        reply.header("set-cookie", `${COOKIE_NAME}=${session.sessionId}; Path=/chimera-control; HttpOnly; Secure; SameSite=Strict`);
        return reply.send({ csrfToken: session.csrfToken });
    });
    app.get("/chimera-control/api/session", async (request: any, reply: any) => {
        const sessionId = cookie(request); if (!sessionId || !await sessions.authenticate(sessionId)) return unauthorised(reply);
        return reply.send({ authenticated: true });
    });
    app.delete("/chimera-control/api/session", async (request: any, reply: any) => {
        const sessionId = cookie(request);
        if (request.headers.origin !== ORIGIN || !sessionId || typeof request.headers["x-chimera-csrf"] !== "string" || !await sessions.authorizeMutation(sessionId, request.headers["x-chimera-csrf"])) return unauthorised(reply);
        await sessions.revoke(sessionId);
        reply.header("set-cookie", `${COOKIE_NAME}=; Path=/chimera-control; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
        return reply.code(204).send();
    });
    app.post("/chimera-control/api/session/revoke-all", async (request: any, reply: any) => {
        const sessionId = cookie(request);
        if (request.headers.origin !== ORIGIN || !sessionId || typeof request.headers["x-chimera-csrf"] !== "string" || !await sessions.authorizeMutation(sessionId, request.headers["x-chimera-csrf"])) return unauthorised(reply);
        await sessions.revokeAll(); return reply.code(204).send();
    });
}
