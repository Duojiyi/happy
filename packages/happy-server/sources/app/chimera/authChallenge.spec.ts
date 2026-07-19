import { describe, expect, it, vi } from "vitest";
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

    it("serializes concurrent issuance at the pending cap", async () => {
        const rows: any[] = [];
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => new Date("2026-07-19T10:00:00.000Z") });
        const settled = await Promise.allSettled(Array.from({ length: 8 }, () => service.issue({ publicKey: key, clientIp: "127.0.0.1" })));
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(3);
        expect(rows).toHaveLength(3);
        service.stop();
    });

    it("refills a deterministic IP token bucket without mixing keys", async () => {
        const rows: any[] = [];
        let current = new Date("2026-07-19T10:00:00.000Z");
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => current });
        const issued = [];
        for (let i = 0; i < 3; i++) issued.push(await service.issue({ publicKey: `${key}${i}`, clientIp: "127.0.0.1" }));
        await Promise.all(issued.map((challenge) => service.consume(challenge.challengeId)));
        await expect(service.issue({ publicKey: `${key}4`, clientIp: "127.0.0.1" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
        current = new Date(current.getTime() + 20_000);
        await expect(service.issue({ publicKey: `${key}5`, clientIp: "127.0.0.1" })).resolves.toBeTruthy();
        service.stop();
    });

    it("keeps a public-key bucket separate from client IP buckets", async () => {
        const rows: any[] = []; const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => new Date("2026-07-19T10:00:00.000Z") });
        const issued = await Promise.all(["1", "2", "3"].map((clientIp) => service.issue({ publicKey: key, clientIp })));
        await Promise.all(issued.map((challenge) => service.consume(challenge.challengeId)));
        await expect(service.issue({ publicKey: key, clientIp: "4" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
        expect(rows).toHaveLength(3); service.stop();
    });

    it("cannot consume a challenge using a service with another server secret", async () => {
        const rows: any[] = [];
        const issuer = createAuthChallengeService({ config, db: fakeDb(rows) });
        const issued = await issuer.issue({ publicKey: key, clientIp: "127.0.0.1" });
        const other = createAuthChallengeService({ config: { ...config, adminSessionSecret: new Uint8Array(32).fill(9) }, db: fakeDb(rows) });
        expect(await other.consume(issued.challengeId)).toBeNull();
        expect(rows[0].consumedAt).toBeNull();
        issuer.stop(); other.stop();
    });

    it("runs bounded timer cleanup and captures cleanup failures", async () => {
        vi.useFakeTimers();
        const failure = new Error("database unavailable");
        const onCleanupError = vi.fn();
        const service = createAuthChallengeService({ config, db: { chimeraAuthChallenge: { findMany: vi.fn().mockRejectedValue(failure) } } as any, cleanupIntervalMs: 10, onCleanupError });
        await vi.advanceTimersByTimeAsync(10);
        expect(onCleanupError).toHaveBeenCalledWith(failure);
        service.stop();
        vi.useRealTimers();
    });

    it("deletes only a bounded batch of expired and old consumed challenges", async () => {
        const rows: any[] = Array.from({ length: 101 }, (_, i) => ({ id: `old-${i}`, nonceDigest: "x", consumedAt: null, expiresAt: new Date("2026-07-19T09:00:00.000Z") }));
        rows.push({ id: "consumed", nonceDigest: "x", consumedAt: new Date("2026-07-19T09:00:00.000Z"), expiresAt: new Date("2026-07-20T00:00:00.000Z") });
        rows.push({ id: "recent", nonceDigest: "x", consumedAt: new Date("2026-07-19T09:59:00.000Z"), expiresAt: new Date("2026-07-20T00:00:00.000Z") });
        const db: any = fakeDb(rows);
        db.chimeraAuthChallenge.findMany = async () => rows.filter((row) => row.expiresAt < new Date("2026-07-19T10:00:00.000Z") || row.consumedAt?.getTime() < new Date("2026-07-19T09:55:00.000Z").getTime()).slice(0, 100).map((row) => ({ id: row.id }));
        db.chimeraAuthChallenge.deleteMany = async ({ where }: any) => { const ids = new Set(where.id.in); for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].id)) rows.splice(i, 1); return { count: ids.size }; };
        const service = createAuthChallengeService({ config, db, now: () => new Date("2026-07-19T10:00:00.000Z") });
        await service.cleanup();
        expect(rows).toHaveLength(3); expect(rows.some((row) => row.id === "recent")).toBe(true); expect(rows.some((row) => row.id === "consumed")).toBe(true);
        service.stop();
    });

    it("bounds rotating limiter identities and removes only safely idle entries", async () => {
        const rows: any[] = [];
        let current = new Date("2026-07-19T10:00:00.000Z");
        const service = createAuthChallengeService({ config, db: fakeDb(rows), now: () => current, issueBucketCapacity: 10, limiterMaxEntries: 4 });
        for (const [publicKey, clientIp] of [["key-1", "ip-1"], ["key-2", "ip-2"]]) {
            const challenge = await service.issue({ publicKey, clientIp });
            await service.consume(challenge.challengeId);
        }
        expect(service.getLimiterStats().size).toBe(4);
        await expect(service.issue({ publicKey: "key-3", clientIp: "ip-3" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
        expect(rows).toHaveLength(2);

        await service.cleanup();
        expect(service.getLimiterStats().size).toBe(4);
        current = new Date(current.getTime() + 6 * 60_000);
        await service.cleanup();
        expect(service.getLimiterStats().size).toBe(0);
        await expect(service.issue({ publicKey: "key-3", clientIp: "ip-3" })).resolves.toBeTruthy();
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
