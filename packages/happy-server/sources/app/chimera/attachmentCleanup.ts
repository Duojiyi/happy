import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { deleteSessionAttachments, inventorySessionAttachments } from "@/storage/files";
import { log } from "@/utils/log";

type Storage = {
    inventorySessionAttachments(sessionId: string): Promise<{ bytes: bigint }>;
    deleteSessionAttachments(sessionId: string): Promise<void>;
};

export function createAttachmentCleanupService(dependencies: {
    db?: any;
    runTransaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
    storage?: Storage;
    now?: () => Date;
    batchSize?: number;
} = {}) {
    const database = dependencies.db ?? db;
    const runTransaction = dependencies.runTransaction ?? inTx;
    const storage = dependencies.storage ?? { inventorySessionAttachments, deleteSessionAttachments };
    const now = dependencies.now ?? (() => new Date());
    const batchSize = dependencies.batchSize ?? 100;

    const process = async (id: string): Promise<boolean> => {
        try {
            let cleanup = await database.chimeraAttachmentCleanup.findUnique({ where: { id } });
            if (!cleanup) return false;
            if (cleanup.plannedBytes === null) {
                const inventory = await storage.inventorySessionAttachments(cleanup.sessionId);
                const planned = await database.chimeraAttachmentCleanup.updateMany({
                    where: { id, plannedBytes: null }, data: { plannedBytes: inventory.bytes },
                });
                if (planned.count !== 1) return process(id);
                cleanup = { ...cleanup, plannedBytes: inventory.bytes };
            }
            if (cleanup.storageDeletedAt === null) {
                await storage.deleteSessionAttachments(cleanup.sessionId);
                const deleted = await database.chimeraAttachmentCleanup.updateMany({
                    where: { id, storageDeletedAt: null }, data: { storageDeletedAt: now() },
                });
                if (deleted.count !== 1) return process(id);
            }
            await runTransaction(async (tx) => {
                const current = await tx.chimeraAttachmentCleanup.findUnique({ where: { id } });
                if (!current || current.accountedAt !== null) return;
                if (current.plannedBytes === null || current.storageDeletedAt === null) throw new Error("Attachment cleanup incomplete");
                const marked = await tx.chimeraAttachmentCleanup.updateMany({
                    where: { id, accountedAt: null }, data: { accountedAt: now() },
                });
                if (marked.count !== 1) return;
                const account = await tx.account.findUnique({ where: { id: current.accountId }, select: { attachmentUsedBytes: true } });
                if (!account) throw new Error("Attachment cleanup incomplete");
                await tx.account.update({ where: { id: current.accountId }, data: {
                    attachmentUsedBytes: account.attachmentUsedBytes > current.plannedBytes
                        ? account.attachmentUsedBytes - current.plannedBytes : 0n,
                } });
            });
            return true;
        } catch {
            throw new Error("Attachment cleanup failed");
        }
    };

    const drainPending = async (): Promise<void> => {
        const attempted = new Set<string>();
        let failed = false;
        while (true) {
            const pending = await database.chimeraAttachmentCleanup.findMany({
                where: { accountedAt: null, id: { notIn: [...attempted] } }, orderBy: { createdAt: "asc" }, take: batchSize,
            });
            if (!pending.length) break;
            for (const cleanup of pending) {
                attempted.add(cleanup.id);
                try { await process(cleanup.id); } catch { failed = true; }
            }
        }
        if (failed) throw new Error("Attachment cleanup pending");
    };

    return { process, drainPending };
}

export const attachmentCleanupService = createAttachmentCleanupService();

let retryTimer: ReturnType<typeof setInterval> | undefined;
export function stopAttachmentCleanupRetry() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
}
export function startAttachmentCleanupRetry(service = attachmentCleanupService, intervalMs = 60_000) {
    stopAttachmentCleanupRetry();
    retryTimer = setInterval(() => {
        void service.drainPending().catch(() => log({ module: "attachment-cleanup" }, "Attachment cleanup retry pending"));
    }, intervalMs);
    return () => {
        stopAttachmentCleanupRetry();
    };
}
