import { createHmac, randomBytes } from "node:crypto";

export type InvitationInput = { label?: string | null; maxUses?: number; expiresAt?: Date };

export function validateInvitationInput(input: InvitationInput, now = new Date()) {
    const label = input.label ?? null;
    const maxUses = input.maxUses ?? 1;
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if ((label !== null && (typeof label !== "string" || label.length > 120))
        || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000
        || !(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())
        || expiresAt.getTime() < now.getTime() + 60 * 60 * 1000
        || expiresAt.getTime() > now.getTime() + 365 * 24 * 60 * 60 * 1000) throw new Error("Invalid invitation");
    return { label, maxUses, expiresAt };
}

export function digestInvitation(code: string, pepper: Uint8Array): string {
    return createHmac("sha256", pepper).update(code).digest("base64url");
}

export function createInvitation(input: InvitationInput & { pepper: Uint8Array; now?: Date }) {
    const { pepper, now = new Date(), ...options } = input;
    const data = validateInvitationInput(options, now);
    const raw = randomBytes(24).toString("base64url");
    const code = raw.match(/.{1,8}/g)!.join(".");
    return { code, data: { ...data, codeDigest: digestInvitation(code, pepper) } };
}
