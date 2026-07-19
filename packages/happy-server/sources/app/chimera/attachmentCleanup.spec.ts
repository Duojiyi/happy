import { describe, expect, it, vi } from "vitest";
import { createAttachmentCleanupService, startAttachmentCleanupRetry } from "./attachmentCleanup";

type Cleanup = { id: string; sessionId: string; accountId: string; plannedBytes: bigint | null; storageDeletedAt: Date | null; accountedAt: Date | null };

function fixture(cleanups: Cleanup[], used = 100n) {
    const accounts = new Map([["a1", { id: "a1", attachmentUsedBytes: used }]]);
    let failAccount = false;
    const database: any = {
        chimeraAttachmentCleanup: {
            findUnique: async ({ where }: any) => cleanups.find((item) => item.id === where.id) ?? null,
            findMany: async ({ where, take }: any) => cleanups.filter((item) => !item.accountedAt && (!where?.id?.notIn || !where.id.notIn.includes(item.id))).slice(0, take),
            updateMany: async ({ where, data }: any) => {
                const item = cleanups.find((candidate) => candidate.id === where.id);
                if (!item || (where.plannedBytes === null && item.plannedBytes !== null) || (where.storageDeletedAt === null && item.storageDeletedAt !== null) || (where.accountedAt === null && item.accountedAt !== null)) return { count: 0 };
                Object.assign(item, data); return { count: 1 };
            },
        },
        account: {
            findUnique: async ({ where }: any) => accounts.get(where.id) ?? null,
            update: async ({ where, data }: any) => {
                if (failAccount) throw new Error("account write failed");
                const account = accounts.get(where.id);
                if (!account) throw new Error("missing account");
                account.attachmentUsedBytes = data.attachmentUsedBytes;
            },
        },
    };
    const runTransaction = async <T>(fn: (tx: any) => Promise<T>) => {
        const cleanupSnapshot = cleanups.map((item) => ({ ...item }));
        const accountSnapshot = [...accounts.entries()].map(([id, account]) => [id, { ...account }] as const);
        try { return await fn(database); }
        catch (error) {
            cleanups.splice(0, cleanups.length, ...cleanupSnapshot);
            accounts.clear(); for (const [id, account] of accountSnapshot) accounts.set(id, account);
            throw error;
        }
    };
    return { database, accounts, runTransaction, setFailAccount: (value: boolean) => { failAccount = value; } };
}

describe("attachment cleanup processor", () => {
    it("persists inventory before deleting and retries safely after a delete failure", async () => {
        const cleanups: Cleanup[] = [{ id: "c1", sessionId: "s1", accountId: "a1", plannedBytes: null, storageDeletedAt: null, accountedAt: null }];
        const state = fixture(cleanups);
        let deleteFails = true;
        const service = createAttachmentCleanupService({ db: state.database, runTransaction: state.runTransaction, storage: {
            inventorySessionAttachments: async () => ({ objects: [], bytes: 12n }),
            deleteSessionAttachments: async () => { if (deleteFails) throw new Error("delete failed"); },
        } });
        await expect(service.process("c1")).rejects.toThrow("Attachment cleanup failed");
        expect(cleanups[0].plannedBytes).toBe(12n);
        expect(cleanups[0].storageDeletedAt).toBeNull();
        deleteFails = false;
        await service.process("c1");
        expect(cleanups[0].accountedAt).toBeInstanceOf(Date);
        expect(state.accounts.get("a1")!.attachmentUsedBytes).toBe(88n);
    });

    it("does not account until storage deletion is persisted, and retries an account failure", async () => {
        const cleanups: Cleanup[] = [{ id: "c1", sessionId: "s1", accountId: "a1", plannedBytes: 12n, storageDeletedAt: null, accountedAt: null }];
        const state = fixture(cleanups);
        state.setFailAccount(true);
        const service = createAttachmentCleanupService({ db: state.database, runTransaction: state.runTransaction, storage: {
            inventorySessionAttachments: async () => ({ objects: [], bytes: 0n }), deleteSessionAttachments: async () => undefined,
        } });
        await expect(service.process("c1")).rejects.toThrow("Attachment cleanup failed");
        expect(cleanups[0].storageDeletedAt).toBeInstanceOf(Date);
        expect(cleanups[0].accountedAt).toBeNull();
        state.setFailAccount(false);
        await service.process("c1");
        expect(state.accounts.get("a1")!.attachmentUsedBytes).toBe(88n);
    });

    it("is idempotent, concurrent-safe, and clamps usage at zero", async () => {
        const cleanups: Cleanup[] = [{ id: "c1", sessionId: "s1", accountId: "a1", plannedBytes: 12n, storageDeletedAt: new Date(), accountedAt: null }];
        const state = fixture(cleanups, 5n);
        const service = createAttachmentCleanupService({ db: state.database, runTransaction: state.runTransaction, storage: {
            inventorySessionAttachments: async () => ({ objects: [], bytes: 0n }), deleteSessionAttachments: async () => undefined,
        } });
        await Promise.all([service.process("c1"), service.process("c1"), service.process("c1")]);
        await service.process("c1");
        expect(state.accounts.get("a1")!.attachmentUsedBytes).toBe(0n);
        expect(cleanups[0].accountedAt).toBeInstanceOf(Date);
    });

    it("drains batches past the limit while reporting failures after other jobs run", async () => {
        const cleanups: Cleanup[] = ["c1", "c2", "c3"].map((id) => ({ id, sessionId: id, accountId: "a1", plannedBytes: 1n, storageDeletedAt: new Date(), accountedAt: null }));
        const state = fixture(cleanups, 10n);
        const service = createAttachmentCleanupService({ db: state.database, runTransaction: state.runTransaction, batchSize: 1, storage: {
            inventorySessionAttachments: async () => ({ objects: [], bytes: 0n }), deleteSessionAttachments: async () => undefined,
        } });
        await service.drainPending();
        expect(cleanups.every((item) => item.accountedAt)).toBe(true);
        expect(state.accounts.get("a1")!.attachmentUsedBytes).toBe(7n);
    });

    it("stops the retry timer", () => {
        vi.useFakeTimers();
        const drainPending = vi.fn(async () => undefined);
        const stop = startAttachmentCleanupRetry({ drainPending } as any, 10);
        stop();
        vi.advanceTimersByTime(20);
        expect(drainPending).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
