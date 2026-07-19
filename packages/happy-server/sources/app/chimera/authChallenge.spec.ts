import { describe, expect, it } from "vitest";
import { createAuthChallengeService, createAuthPayload } from "./authChallenge";

const key = Buffer.alloc(32, 7).toString("base64");
const config = { relayOrigin: "https://39.98.68.173" as const, adminSessionSecret: new Uint8Array(32).fill(4) };

describe("Chimera auth challenges", () => {
    it("uses the client-compatible canonical UTF-8 payload", () => {
        expect(Buffer.from(createAuthPayload({
            origin: config.relayOrigin, purpose: "chimera-account-auth", challengeId: "id", nonce: "nonce", publicKey: "key", expiresAt: "2026-07-19T10:00:00.000Z",
        })).toString("utf8")).toBe("chimera-auth-v2\nhttps://39.98.68.173\nchimera-account-auth\nid\nnonce\nkey\n2026-07-19T10:00:00.000Z");
    });

    it("issues a 16-byte nonce while persisting only its keyed digest", async () => {
        const rows: any[] = [];
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => new Date("2026-07-19T10:00:00.000Z") });
        const issued = await service.issue({ publicKey: key, clientIp: "127.0.0.1" });
        expect(Buffer.from(issued.nonce, "base64url")).toHaveLength(16);
        expect(rows).toHaveLength(1);
        expect(rows[0].nonceDigest).not.toBe(issued.nonce);
        expect(rows[0].publicKey).toBe(key);
        service.stop();
    });

    it("rejects a fourth pending request without inserting it", async () => {
        const rows: any[] = [];
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => new Date("2026-07-19T10:00:00.000Z") });
        for (let i = 0; i < 3; i++) await service.issue({ publicKey: key, clientIp: "127.0.0.1" });
        await expect(service.issue({ publicKey: key, clientIp: "127.0.0.1" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
        expect(rows).toHaveLength(3);
        service.stop();
    });

    it("consumes an unexpired challenge once", async () => {
        const rows: any[] = [];
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => new Date("2026-07-19T10:00:00.000Z") });
        const issued = await service.issue({ publicKey: key, clientIp: "127.0.0.1" });
        expect(await service.consume(issued.challengeId)).toMatchObject({ publicKey: key });
        expect(await service.consume(issued.challengeId)).toBeNull();
        service.stop();
    });
});

function fakeDb(rows: any[]) {
    return { chimeraAuthChallenge: {
        deleteMany: async ({ where }: any) => { const before = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (where.OR.some((c: any) => (c.expiresAt?.lt && rows[i].expiresAt < c.expiresAt.lt) || (c.consumedAt?.lt && rows[i].consumedAt && rows[i].consumedAt < c.consumedAt.lt))) rows.splice(i, 1); return { count: before - rows.length }; },
        count: async ({ where }: any) => rows.filter((r) => !where || Object.entries(where).every(([k, v]: any) => k === "consumedAt" ? r.consumedAt === v : k === "expiresAt" ? r.expiresAt > v.gt : r[k] === v)).length,
        create: async ({ data }: any) => { const row = { id: `id-${rows.length + 1}`, createdAt: new Date(), consumedAt: null, ...data }; rows.push(row); return row; },
        updateMany: async ({ where, data }: any) => { const row = rows.find((r) => r.id === where.id && r.consumedAt === null && r.expiresAt > where.expiresAt.gt); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    } };
}
