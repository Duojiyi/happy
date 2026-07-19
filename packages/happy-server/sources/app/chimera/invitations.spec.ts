import { describe, expect, it } from "vitest";
import { createInvitation, digestInvitation, validateInvitationInput } from "./invitations";

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
});
