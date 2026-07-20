import { describe, expect, it } from "vitest";
import { createInvitation, createInvitationService, digestInvitation, validateInvitationInput } from "./invitations";

const pepper = new Uint8Array(32).fill(9);

describe("chimera invitations", () => {
    it("generates a grouped 192-bit code and stores only its HMAC digest", () => {
        const invitation = createInvitation({ pepper, now: new Date("2026-01-01T00:00:00Z") });
        expect(invitation.code).toMatch(/^[A-Za-z0-9_-]{8}(?:\.[A-Za-z0-9_-]{8}){3}$/);
        expect(Buffer.from(invitation.code.replace(/\./g, ""), "base64url")).toHaveLength(24);
        expect(invitation.data).toEqual({ codeDigest: digestInvitation(invitation.code, pepper), label: null, maxUses: 1, expiresAt: new Date("2026-01-08T00:00:00Z") });
        expect(JSON.stringify(invitation.data)).not.toContain(invitation.code);
    });

    it("validates invitation limits and defaults", () => {
        const now = new Date("2026-01-01T00:00:00Z");
        expect(validateInvitationInput({}, now)).toEqual({ label: null, maxUses: 1, expiresAt: new Date("2026-01-08T00:00:00Z") });
        expect(() => validateInvitationInput({ label: "x".repeat(121) }, now)).toThrow();
        expect(() => validateInvitationInput({ maxUses: 0 }, now)).toThrow();
        expect(() => validateInvitationInput({ expiresAt: new Date(now.getTime() + 3599_000) }, now)).toThrow();
    });

    it("accepts the inclusive validation boundaries", () => {
        const now = new Date("2026-01-01T00:00:00Z");
        expect(validateInvitationInput({ label: "x".repeat(120), maxUses: 1, expiresAt: new Date(now.getTime() + 3600_000) }, now).maxUses).toBe(1);
        expect(validateInvitationInput({ maxUses: 1000, expiresAt: new Date(now.getTime() + 365 * 24 * 3600_000) }, now).maxUses).toBe(1000);
        for (const input of [{ maxUses: 1001 }, { maxUses: 1.5 }, { expiresAt: new Date(now.getTime() + 3600_000 - 1) }, { expiresAt: new Date(now.getTime() + 365 * 24 * 3600_000 + 1) }]) expect(() => validateInvitationInput(input, now)).toThrow();
    });

    it("persists only metadata and digest, then lists and revokes without plaintext", async () => {
        const rows: any[] = [];
        const service = createInvitationService({ pepper, db: { chimeraInvitation: {
            create: async ({ data }: any) => { const row = { id: "i1", usedCount: 0, revokedAt: null, createdAt: new Date(), ...data }; rows.push(row); return row; },
            findMany: async () => rows,
            update: async ({ where, data }: any) => Object.assign(rows.find((row) => row.id === where.id), data),
        } } });
        const created = await service.create({ label: "team" });
        expect(rows[0].codeDigest).toBe(digestInvitation(created.code, pepper)); expect(JSON.stringify(rows[0])).not.toContain(created.code);
        expect(await service.list()).toEqual([expect.objectContaining({ id: "i1", label: "team", usedCount: 0 })]);
        expect(JSON.stringify(await service.list())).not.toContain("code");
        await service.revoke("i1"); expect(rows[0].revokedAt).toBeInstanceOf(Date);
    });
});
