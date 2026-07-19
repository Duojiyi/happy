import { describe, expect, it } from "vitest";
import { createAccountPolicy, formatAccountForAdmin, MAX_ATTACHMENT_QUOTA_BYTES, MIN_ATTACHMENT_QUOTA_BYTES } from "./accountPolicy";

const key = new Uint8Array(32).fill(7);
const account = {
    id: "internal-account-id", createdAt: new Date("2026-01-02T03:04:05.000Z"), disabledAt: null,
    tokenEpoch: 4, attachmentUsedBytes: 123n, attachmentQuotaBytes: 456n,
    publicKey: "must never leave the server", firstName: "private",
};

describe("Chimera account policy", () => {
    it("returns an exact, pseudonymous admin account shape", () => {
        const result = formatAccountForAdmin(account, key);
        expect(Object.keys(result).sort()).toEqual(["attachmentQuotaBytes", "attachmentUsedBytes", "createdAt", "disabled", "id"]);
        expect(result).toMatchObject({ createdAt: account.createdAt.toISOString(), disabled: false, attachmentUsedBytes: "123", attachmentQuotaBytes: "456" });
        expect(result.id).not.toContain(account.id);
        expect(result.id).not.toContain(account.publicKey);
    });

    it("validates quota bounds and applies account state mutations by pseudonym", async () => {
        const updates: any[] = [];
        const database = {
            account: {
                findMany: async () => [account],
                update: async (input: any) => { updates.push(input); return { ...account, ...input.data }; },
            },
        };
        const policy = createAccountPolicy({ db: database as any, pseudonymKey: key });
        const id = formatAccountForAdmin(account, key).id;
        await policy.disable(id);
        await policy.restore(id);
        await policy.revokeTokens(id);
        await policy.setQuota(id, MIN_ATTACHMENT_QUOTA_BYTES);
        expect(updates.map((update) => update.data)).toEqual([
            { disabledAt: expect.any(Date) }, { disabledAt: null }, { tokenEpoch: { increment: 1 } }, { attachmentQuotaBytes: BigInt(MIN_ATTACHMENT_QUOTA_BYTES) },
        ]);
        await expect(policy.setQuota(id, MIN_ATTACHMENT_QUOTA_BYTES - 1)).rejects.toThrow("Invalid attachment quota");
        await expect(policy.setQuota(id, MAX_ATTACHMENT_QUOTA_BYTES + 1)).rejects.toThrow("Invalid attachment quota");
    });
});
