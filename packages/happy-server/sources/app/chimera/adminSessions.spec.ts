import { describe, expect, it } from "vitest";
import { createAdminSessionService, digestAdminToken } from "./adminSessions";

const secret = new Uint8Array(32).fill(7);

function service(now = new Date("2026-07-19T00:00:00.000Z")) {
    const rows: any[] = [];
    const clock = { value: now };
    return {
        rows,
        clock,
        value: createAdminSessionService({
            secret,
            now: () => new Date(clock.value),
            db: { chimeraAdminSession: {
                create: async ({ data }: any) => { const row = { id: `s${rows.length + 1}`, createdAt: now, revokedAt: null, ...data }; rows.push(row); return row; },
                findUnique: async ({ where }: any) => rows.find((row) => row.sessionDigest === where.sessionDigest) ?? null,
                update: async ({ where, data }: any) => Object.assign(rows.find((row) => row.id === where.id), data),
                updateMany: async ({ data }: any) => { for (const row of rows) if (!row.revokedAt) Object.assign(row, data); return { count: rows.length }; },
            } },
        }),
    };
}

describe("Chimera admin sessions", () => {
    it("creates independent 32-byte session and CSRF tokens while persisting HMAC digests only", async () => {
        const fixture = service();
        const session = await fixture.value.create();

        expect(Buffer.from(session.sessionId, "base64url")).toHaveLength(32);
        expect(Buffer.from(session.csrfToken, "base64url")).toHaveLength(32);
        expect(session.sessionId).not.toBe(session.csrfToken);
        expect(fixture.rows[0]).toMatchObject({ sessionDigest: digestAdminToken(session.sessionId, secret), csrfDigest: digestAdminToken(session.csrfToken, secret) });
        expect(JSON.stringify(fixture.rows[0])).not.toContain(session.sessionId);
        expect(JSON.stringify(fixture.rows[0])).not.toContain(session.csrfToken);
    });

    it("accepts and slides only a live session without exceeding its eight-hour absolute expiry", async () => {
        const fixture = service();
        const created = await fixture.value.create();
        fixture.clock.value = new Date("2026-07-19T00:29:00.000Z");

        const authenticated = await fixture.value.authenticate(created.sessionId);
        expect(authenticated).toMatchObject({ id: "s1" });
        expect(fixture.rows[0].lastSeenAt).toEqual(fixture.clock.value);
        expect(fixture.rows[0].expiresAt).toEqual(new Date("2026-07-19T00:59:00.000Z"));

        fixture.clock.value = new Date("2026-07-19T08:00:00.000Z");
        expect(await fixture.value.authenticate(created.sessionId)).toBeNull();
        expect(fixture.rows[0].lastSeenAt).toEqual(new Date("2026-07-19T00:29:00.000Z"));
    });

    it("rejects revoked and CSRF-mismatched sessions without touching them", async () => {
        const fixture = service();
        const created = await fixture.value.create();
        const lastSeen = fixture.rows[0].lastSeenAt;
        expect(await fixture.value.authorizeMutation(created.sessionId, "wrong")).toBeNull();
        expect(fixture.rows[0].lastSeenAt).toEqual(lastSeen);
        await fixture.value.revoke(created.sessionId);

        expect(await fixture.value.authenticate(created.sessionId)).toBeNull();
        expect(await fixture.value.authorizeMutation(created.sessionId, created.csrfToken)).toBeNull();
    });

    it("revoke-all invalidates every outstanding session", async () => {
        const fixture = service();
        const first = await fixture.value.create();
        const second = await fixture.value.create();
        await fixture.value.revokeAll();

        expect(await fixture.value.authenticate(first.sessionId)).toBeNull();
        expect(await fixture.value.authenticate(second.sessionId)).toBeNull();
    });
});
