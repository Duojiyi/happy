import { createHmac } from "node:crypto";
import { db } from "@/storage/db";

export const MIN_ATTACHMENT_QUOTA_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_QUOTA_BYTES = 50 * 1024 * 1024 * 1024;

type Account = {
    id: string; createdAt: Date; disabledAt: Date | null; tokenEpoch: number;
    attachmentUsedBytes: bigint; attachmentQuotaBytes: bigint;
};

export function accountPseudonym(accountId: string, key: Uint8Array): string {
    return createHmac("sha256", key).update(accountId, "utf8").digest("base64url");
}

export function formatAccountForAdmin(account: Account, key: Uint8Array) {
    return {
        id: accountPseudonym(account.id, key),
        createdAt: account.createdAt.toISOString(),
        disabled: account.disabledAt !== null,
        attachmentUsedBytes: account.attachmentUsedBytes.toString(),
        attachmentQuotaBytes: account.attachmentQuotaBytes.toString(),
    };
}

export function createAccountPolicy(dependencies: { db?: Pick<typeof db, "account">; pseudonymKey: Uint8Array; onAccountInvalidated?: (accountId: string) => void | Promise<void> }) {
    const database = dependencies.db ?? db;
    const find = async (pseudonym: string) => {
        const accounts = await database.account.findMany({ select: { id: true, createdAt: true, disabledAt: true, tokenEpoch: true, attachmentUsedBytes: true, attachmentQuotaBytes: true } });
        const account = accounts.find((candidate) => accountPseudonym(candidate.id, dependencies.pseudonymKey) === pseudonym);
        if (!account) throw new Error("Account not found");
        return account;
    };
    const invalidate = async (id: string) => { await dependencies.onAccountInvalidated?.(id); };
    return {
        list: async () => (await database.account.findMany({ select: { id: true, createdAt: true, disabledAt: true, tokenEpoch: true, attachmentUsedBytes: true, attachmentQuotaBytes: true }, orderBy: { createdAt: "desc" } })).map((account) => formatAccountForAdmin(account, dependencies.pseudonymKey)),
        disable: async (pseudonym: string) => { const account = await find(pseudonym); const updated = await database.account.update({ where: { id: account.id }, data: { disabledAt: new Date() } }); await invalidate(account.id); return formatAccountForAdmin(updated, dependencies.pseudonymKey); },
        restore: async (pseudonym: string) => { const account = await find(pseudonym); const updated = await database.account.update({ where: { id: account.id }, data: { disabledAt: null } }); return formatAccountForAdmin(updated, dependencies.pseudonymKey); },
        revokeTokens: async (pseudonym: string) => { const account = await find(pseudonym); const updated = await database.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } }); await invalidate(account.id); return formatAccountForAdmin(updated, dependencies.pseudonymKey); },
        setQuota: async (pseudonym: string, bytes: number) => {
            if (!Number.isSafeInteger(bytes) || bytes < MIN_ATTACHMENT_QUOTA_BYTES || bytes > MAX_ATTACHMENT_QUOTA_BYTES) throw new Error("Invalid attachment quota");
            const account = await find(pseudonym); const updated = await database.account.update({ where: { id: account.id }, data: { attachmentQuotaBytes: BigInt(bytes) } }); return formatAccountForAdmin(updated, dependencies.pseudonymKey);
        },
    };
}
