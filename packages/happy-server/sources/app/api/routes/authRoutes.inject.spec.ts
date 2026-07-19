import fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";
import { authRoutes } from "./authRoutes";
import { createAuthPayload } from "@/app/chimera/authChallenge";
import { isTrustedLoopbackProxy } from "../api";

const config = { relayOrigin: "https://39.98.68.173" as const, adminSessionSecret: new Uint8Array(32).fill(4) };

describe("account auth HTTP routes", () => {
    it("issues then completes an existing account exactly once", async () => {
        const { app, tokens, rows } = testApp();
        const pair = nacl.sign.keyPair(); const publicKey = Buffer.from(pair.publicKey).toString("base64");
        const issue = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } });
        expect(issue.statusCode).toBe(200);
        const challenge = issue.json();
        const signature = Buffer.from(nacl.sign.detached(createAuthPayload(challenge), pair.secretKey)).toString("base64");
        const complete = await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature } });
        expect(complete.statusCode).toBe(200); expect(tokens).toHaveLength(1);
        const replay = await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature } });
        expect(replay.statusCode).toBe(401); expect(tokens).toHaveLength(1); expect(rows).toHaveLength(1);
        await app.close();
    });

    it("returns generic 401 for expired, malformed, and wrong-origin signatures", async () => {
        const { app, rows, tokens } = testApp(new Date("2026-07-19T10:00:00.000Z"));
        const pair = nacl.sign.keyPair(); const publicKey = Buffer.from(pair.publicKey).toString("base64");
        const issued = (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } })).json();
        for (const signature of ["bad", Buffer.from(nacl.sign.detached(createAuthPayload({ ...issued, origin: "https://bad.example" }), pair.secretKey)).toString("base64")]) {
            expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: issued.challengeId, signature } })).statusCode).toBe(401);
        }
        const expired = (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } })).json();
        rows.find((row) => expired.challengeId.startsWith(`${row.id}.`)).expiresAt = new Date("2026-07-19T09:59:59.999Z");
        const valid = Buffer.from(nacl.sign.detached(createAuthPayload(expired), pair.secretKey)).toString("base64");
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: expired.challengeId, signature: valid } })).statusCode).toBe(401);
        expect(tokens).toHaveLength(0);
        await app.close();
    });

    it("allows only one concurrent completion and rejects a foreign signing key without mutation", async () => {
        const { app, tokens, rows } = testApp();
        const pair = nacl.sign.keyPair(); const publicKey = Buffer.from(pair.publicKey).toString("base64");
        const challenge = (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } })).json();
        const signature = Buffer.from(nacl.sign.detached(createAuthPayload(challenge), pair.secretKey)).toString("base64");
        const [a, b] = await Promise.all([app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature } }), app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature } })]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]); expect(tokens).toHaveLength(1);
        const before = tokens.length;
        const foreign = Buffer.from(nacl.sign.detached(createAuthPayload(challenge), nacl.sign.keyPair().secretKey)).toString("base64");
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature: foreign } })).statusCode).toBe(401);
        expect(tokens).toHaveLength(before); expect(rows).toHaveLength(1);
        await app.close();
    });

    it("does not consume a fresh challenge when its signature is from another key", async () => {
        const { app, tokens, rows } = testApp();
        const owner = nacl.sign.keyPair(); const publicKey = Buffer.from(owner.publicKey).toString("base64");
        const challenge = (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } })).json();
        const foreign = Buffer.from(nacl.sign.detached(createAuthPayload(challenge), nacl.sign.keyPair().secretKey)).toString("base64");
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature: foreign } })).statusCode).toBe(401);
        expect(rows[0].consumedAt).toBeNull(); expect(tokens).toEqual([]);
        await app.close();
    });

    it("returns the same 429 envelope for every exhausted issuance cap", async () => {
        const { app } = testApp();
        const keys = Array.from({ length: 4 }, () => Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"));
        for (const key of keys.slice(0, 3)) expect((await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey: key } })).statusCode).toBe(200);
        const limited = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey: keys[3] } });
        expect(limited.statusCode).toBe(429); expect(limited.json()).toEqual({ error: "Too many requests" });
        await app.close();
    });

    it("uses XFF only from a loopback proxy", async () => {
        const app = fastify({ trustProxy: isTrustedLoopbackProxy }); app.get("/ip", (req) => ({ ip: req.ip }));
        expect((await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "198.51.100.7" }, remoteAddress: "127.0.0.1" })).json().ip).toBe("198.51.100.7");
        expect((await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "198.51.100.7" }, remoteAddress: "10.0.0.2" })).json().ip).toBe("10.0.0.2");
        await app.close();
    });
});

function testApp(now = new Date()) {
    const rows: any[] = []; const tokens: string[] = [];
    const account = { id: "account", publicKey: Buffer.alloc(32).toString("hex") };
    const db: any = { chimeraAuthChallenge: {
        count: async ({ where }: any) => rows.filter((r) => !r.consumedAt && r.expiresAt > now && (!where.clientIp || r.clientIp === where.clientIp) && (!where.publicKey || r.publicKey === where.publicKey)).length,
        create: async ({ data }: any) => { const row = { id: `c${rows.length}`, consumedAt: null, ...data }; rows.push(row); return row; },
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
        updateMany: async ({ where, data }: any) => { const r = rows.find((r) => r.id === where.id && !r.consumedAt && r.expiresAt > where.expiresAt.gt); if (!r) return { count: 0 }; Object.assign(r, data); return { count: 1 }; },
    }, account: { findUnique: async () => account } };
    const app = fastify({ trustProxy: isTrustedLoopbackProxy }); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    authRoutes(app as any, { db, config, inTransaction: async (fn) => fn(db), issueToken: async () => { tokens.push("token"); return "token"; } });
    return { app, rows, tokens };
}
