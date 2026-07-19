import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PURPOSE = "chimera-account-auth";
const MAX_TTL_MS = 2 * 60 * 1000;
const CONSUMED_RETENTION_MS = 5 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const DEFAULT_GLOBAL_PENDING_CAP = 1_000;

export interface AuthChallengePayload {
    origin: string;
    purpose: typeof PURPOSE;
    challengeId: string;
    nonce: string;
    publicKey: string;
    expiresAt: string;
}

export class AuthChallengeError extends Error {
    constructor(readonly code: "RATE_LIMITED" | "INVALID") { super(code); }
}

interface ChallengeDb {
    chimeraAuthChallenge: any;
}

interface ChallengeConfig {
    relayOrigin: "https://39.98.68.173";
    adminSessionSecret: Uint8Array;
}

export function createAuthPayload(input: AuthChallengePayload): Uint8Array {
    return new TextEncoder().encode([
        "chimera-auth-v2", input.origin, input.purpose, input.challengeId,
        input.nonce, input.publicKey, input.expiresAt,
    ].join("\n"));
}

export function createAuthChallengeService(options: {
    config: ChallengeConfig;
    db: ChallengeDb;
    now?: () => Date;
    globalPendingCap?: number;
    cleanupIntervalMs?: number;
}) {
    const now = options.now ?? (() => new Date());
    const db = options.db;
    const limits = new Map<string, TokenBucket>();
    const globalPendingCap = options.globalPendingCap ?? DEFAULT_GLOBAL_PENDING_CAP;
    const timer = setInterval(() => void cleanup(), options.cleanupIntervalMs ?? 30_000);
    (timer as unknown as { unref?: () => void }).unref?.();
    let issuanceLock = Promise.resolve();

    async function serialized<T>(fn: () => Promise<T>): Promise<T> {
        let release!: () => void;
        const previous = issuanceLock;
        issuanceLock = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await fn(); } finally { release(); }
    }

    function nonceDigest(nonce: string) {
        return createHmac("sha256", options.config.adminSessionSecret)
            .update("chimera-auth-challenge-v2\0", "utf8").update(nonce, "utf8").digest("hex");
    }

    function allow(identity: string, current: number) {
        const bucket = limits.get(identity) ?? { tokens: 3, updatedAt: current };
        bucket.tokens = Math.min(3, bucket.tokens + ((current - bucket.updatedAt) / 60_000) * 3);
        bucket.updatedAt = current;
        if (bucket.tokens < 1) { limits.set(identity, bucket); return false; }
        bucket.tokens--;
        limits.set(identity, bucket);
        return true;
    }

    async function cleanup() {
        const current = now();
        // Prisma deleteMany has no limit; select a bounded set first so cleanup is never unbounded.
        if (typeof db.chimeraAuthChallenge.findMany !== "function") return;
        const stale = await db.chimeraAuthChallenge.findMany({
            where: { OR: [{ expiresAt: { lt: current } }, { consumedAt: { lt: new Date(current.getTime() - CONSUMED_RETENTION_MS) } }] },
            select: { id: true }, take: CLEANUP_BATCH_SIZE, orderBy: { expiresAt: "asc" },
        });
        if (stale.length) await db.chimeraAuthChallenge.deleteMany({ where: { id: { in: stale.map((row: { id: string }) => row.id) } } });
    }

    return {
        async issue(input: { publicKey: string; clientIp: string }) { return serialized(async () => {
            const current = now();
            await cleanup();
            // Check all caps before creating a row; JavaScript execution is atomic between awaits.
            const [byIp, byKey, total] = await Promise.all([
                db.chimeraAuthChallenge.count({ where: { clientIp: input.clientIp, consumedAt: null, expiresAt: { gt: current } } }),
                db.chimeraAuthChallenge.count({ where: { publicKey: input.publicKey, consumedAt: null, expiresAt: { gt: current } } }),
                db.chimeraAuthChallenge.count({ where: { consumedAt: null, expiresAt: { gt: current } } }),
            ]);
            if (byIp >= 3 || byKey >= 3 || total >= globalPendingCap || !allow(`ip:${input.clientIp}`, current.getTime()) || !allow(`key:${input.publicKey}`, current.getTime())) {
                throw new AuthChallengeError("RATE_LIMITED");
            }
            const nonce = randomBytes(16).toString("base64url");
            const expiresAt = new Date(current.getTime() + MAX_TTL_MS);
            const row = await db.chimeraAuthChallenge.create({ data: {
                nonceDigest: nonceDigest(nonce), publicKey: input.publicKey, clientIp: input.clientIp, origin: options.config.relayOrigin,
                purpose: PURPOSE, expiresAt,
            } });
            // The nonce travels as an opaque suffix of the challenge ID. It is never persisted,
            // but remains available during completion without adding another client field.
            return { version: 2 as const, origin: options.config.relayOrigin, purpose: PURPOSE, challengeId: `${row.id}.${nonce}`, nonce, publicKey: input.publicKey, expiresAt: expiresAt.toISOString() };
        }); },
        async consume(challengeId: string, tx: ChallengeDb = db) {
            const separator = challengeId.lastIndexOf(".");
            const id = challengeId.slice(0, separator);
            const nonce = challengeId.slice(separator + 1);
            if (!id || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || Buffer.from(nonce, "base64url").length !== 16) return null;
            const row = await tx.chimeraAuthChallenge.findUnique({ where: { id } });
            if (!row) return null;
            const expected = Buffer.from(row.nonceDigest, "hex");
            const actual = Buffer.from(nonceDigest(nonce), "hex");
            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
            const current = now();
            const updated = await tx.chimeraAuthChallenge.updateMany({
                where: { id, consumedAt: null, expiresAt: { gt: current }, origin: options.config.relayOrigin, purpose: PURPOSE },
                data: { consumedAt: current },
            });
            if (updated.count !== 1) return null;
            return { ...row, challengeId, nonce };
        },
        stop() { clearInterval(timer); },
        cleanup,
    };
}

interface TokenBucket { tokens: number; updatedAt: number; }
