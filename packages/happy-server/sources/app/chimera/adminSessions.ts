import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

type SessionRow = { id: string; sessionDigest: string; csrfDigest: string; lastSeenAt: Date; expiresAt: Date; createdAt: Date; revokedAt: Date | null };
type SessionDb = { chimeraAdminSession: { create(args: any): Promise<SessionRow>; findUnique(args: any): Promise<SessionRow | null>; update(args: any): Promise<SessionRow>; updateMany(args: any): Promise<{ count: number }> } };

export function digestAdminToken(token: string, secret: Uint8Array): string {
    return createHmac("sha256", secret).update(token).digest("base64url");
}

export function deriveAdminSessionSecret(sessionSecret: Uint8Array, passwordHash: string): Uint8Array {
    return createHmac("sha256", sessionSecret).update(passwordHash).digest();
}

function equalDigest(a: string, b: string): boolean {
    const left = Buffer.from(a); const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function createAdminSessionService({ secret, db, now = () => new Date() }: { secret: Uint8Array; db: SessionDb; now?: () => Date }) {
    const digest = (token: string) => digestAdminToken(token, secret);
    async function live(sessionId: string) {
        const row = await db.chimeraAdminSession.findUnique({ where: { sessionDigest: digest(sessionId) } });
        const current = now();
        if (!row || row.revokedAt || row.expiresAt.getTime() <= current.getTime() || row.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS <= current.getTime()) return null;
        return { row, current };
    }
    async function touch(row: SessionRow, current: Date) {
        const absoluteExpiry = new Date(row.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS);
        const expiresAt = new Date(Math.min(current.getTime() + IDLE_TIMEOUT_MS, absoluteExpiry.getTime()));
        return db.chimeraAdminSession.update({ where: { id: row.id }, data: { lastSeenAt: current, expiresAt } });
    }
    return {
        async create() {
            const sessionId = randomBytes(32).toString("base64url");
            const csrfToken = randomBytes(32).toString("base64url");
            const current = now();
            await db.chimeraAdminSession.create({ data: { sessionDigest: digest(sessionId), csrfDigest: digest(csrfToken), lastSeenAt: current, expiresAt: new Date(current.getTime() + IDLE_TIMEOUT_MS) } });
            return { sessionId, csrfToken };
        },
        async authenticate(sessionId: string) {
            const active = await live(sessionId);
            if (!active) return null;
            return touch(active.row, active.current);
        },
        async authorizeMutation(sessionId: string, csrfToken: string) {
            const active = await live(sessionId);
            if (!active || !equalDigest(active.row.csrfDigest, digest(csrfToken))) return null;
            return touch(active.row, active.current);
        },
        async revoke(sessionId: string) {
            const active = await live(sessionId);
            if (active) await db.chimeraAdminSession.update({ where: { id: active.row.id }, data: { revokedAt: active.current } });
        },
        async revokeAll() { await db.chimeraAdminSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: now() } }); },
    };
}
