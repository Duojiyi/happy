import { readdir, stat, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MIN_FREE_BYTES = 15n * 1024n * 1024n * 1024n;
const EXPIRED_CLEANUP_BATCH = 100;

export class AttachmentQuotaError extends Error {
    constructor() { super("Attachment upload unavailable"); }
}

type DiskState = { totalBytes: bigint; freeBytes: bigint };
type Claim = { accountId: string; bytes: bigint };

async function inspectLocalDisk(): Promise<DiskState> {
    const root = join(process.env.DATA_DIR || "./data", "files");
    const value = await statfs(root, { bigint: true });
    return { totalBytes: value.blocks * value.bsize, freeBytes: value.bavail * value.bsize };
}

export function createAttachmentQuotaService(dependencies: {
    db?: any;
    runTransaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
    inspectDisk?: () => Promise<DiskState>;
    now?: () => Date;
    minFreeBytes?: bigint;
    reservationTtlMs?: number;
} = {}) {
    const database = dependencies.db ?? db;
    const runTransaction = dependencies.runTransaction ?? inTx;
    const inspectDisk = dependencies.inspectDisk ?? inspectLocalDisk;
    const now = dependencies.now ?? (() => new Date());
    const minFreeBytes = dependencies.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    const reservationTtlMs = dependencies.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;

    const cleanupExpired = async () => {
        const expired = await database.chimeraAttachmentReservation.findMany({
            where: { expiresAt: { lt: now() } }, orderBy: { expiresAt: "asc" }, take: EXPIRED_CLEANUP_BATCH,
        });
        let released = 0;
        for (const reservation of expired) {
            const didRelease = await runTransaction(async (tx) => {
                const deleted = await tx.chimeraAttachmentReservation.deleteMany({ where: { id: reservation.id } });
                if (deleted.count !== 1) return false;
                await tx.account.update({ where: { id: reservation.accountId }, data: { attachmentReservedBytes: { decrement: reservation.bytes } } });
                return true;
            });
            if (didRelease) released++;
        }
        return released;
    };

    return {
        cleanupExpired,
        async reserve(accountId: string, bytes: number, objectKey: string) {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || !objectKey || objectKey.length > 500) throw new AttachmentQuotaError();
            await cleanupExpired();
            const disk = await inspectDisk();
            if (disk.totalBytes <= 0n || disk.freeBytes < minFreeBytes
                || (disk.totalBytes - disk.freeBytes) * 100n >= disk.totalBytes * 80n) throw new AttachmentQuotaError();
            return runTransaction(async (tx) => {
                const account = await tx.account.findUnique({ where: { id: accountId }, select: { disabledAt: true, attachmentQuotaBytes: true, attachmentUsedBytes: true, attachmentReservedBytes: true } });
                const requested = BigInt(bytes);
                if (!account || account.disabledAt || account.attachmentUsedBytes + account.attachmentReservedBytes + requested > account.attachmentQuotaBytes) throw new AttachmentQuotaError();
                await tx.account.update({ where: { id: accountId }, data: { attachmentReservedBytes: { increment: requested } } });
                return tx.chimeraAttachmentReservation.create({ data: { accountId, bytes: requested, objectKey, expiresAt: new Date(now().getTime() + reservationTtlMs) } });
            });
        },
        async claim(reservationId: string, accountId: string, objectKey: string, actualBytes: number): Promise<Claim> {
            if (!reservationId || !Number.isSafeInteger(actualBytes) || actualBytes < 0) throw new AttachmentQuotaError();
            return runTransaction(async (tx) => {
                const reservation = await tx.chimeraAttachmentReservation.findUnique({ where: { id: reservationId } });
                const account = await tx.account.findUnique({ where: { id: accountId }, select: { disabledAt: true } });
                if (!reservation || reservation.accountId !== accountId || reservation.objectKey !== objectKey || reservation.expiresAt <= now() || !account || account.disabledAt || BigInt(actualBytes) > reservation.bytes) throw new AttachmentQuotaError();
                const deleted = await tx.chimeraAttachmentReservation.deleteMany({ where: { id: reservationId, accountId } });
                if (deleted.count !== 1) throw new AttachmentQuotaError();
                await tx.account.update({ where: { id: accountId }, data: {
                    attachmentReservedBytes: { decrement: reservation.bytes }, attachmentUsedBytes: { increment: BigInt(actualBytes) },
                } });
                return { accountId, bytes: BigInt(actualBytes) };
            });
        },
        async rollback(claim: Claim) {
            await runTransaction((tx) => tx.account.update({ where: { id: claim.accountId }, data: { attachmentUsedBytes: { decrement: claim.bytes } } }));
        },
    };
}

export type AttachmentQuotaService = ReturnType<typeof createAttachmentQuotaService>;

export async function reconcileAttachmentStorage(root: string, dependencies: { db?: any; cleanupExpired?: () => Promise<number>; now?: () => Date } = {}) {
    const database = dependencies.db ?? db;
    const now = dependencies.now ?? (() => new Date());
    await (dependencies.cleanupExpired ?? createAttachmentQuotaService({ db: database }).cleanupExpired)();

    const removeStalePartials = async (directory: string): Promise<void> => {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
        for (const entry of entries) {
            const fullPath = join(directory, entry.name);
            if (entry.isDirectory()) await removeStalePartials(fullPath);
            else if (entry.name.endsWith(".partial")) {
                const info = await stat(fullPath);
                if (now().getTime() - info.mtimeMs >= DEFAULT_RESERVATION_TTL_MS) await unlink(fullPath).catch(() => undefined);
            }
        }
    };
    await removeStalePartials(root);

    const totals = new Map<string, bigint>();
    const sessions = await database.session.findMany({ select: { id: true, accountId: true } });
    for (const session of sessions) {
        const directory = join(root, "sessions", session.id, "attachments");
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
        let total = totals.get(session.accountId) ?? 0n;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".enc")) continue;
            total += BigInt((await stat(join(directory, entry.name))).size);
        }
        totals.set(session.accountId, total);
    }
    const accounts = await database.account.findMany({ select: { id: true } });
    for (const account of accounts) {
        await database.account.update({ where: { id: account.id }, data: { attachmentUsedBytes: totals.get(account.id) ?? 0n } });
    }
}
