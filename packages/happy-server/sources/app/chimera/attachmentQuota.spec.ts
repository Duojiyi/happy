import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentQuotaService, AttachmentQuotaError, reconcileAttachmentStorage, reconcileS3AttachmentStorage } from "./attachmentQuota";
import { putLocalFileAtomic } from "@/storage/files";

function database() {
    const account = { id: "account", disabledAt: null as Date | null, attachmentQuotaBytes: 1_000n, attachmentUsedBytes: 100n, attachmentReservedBytes: 0n };
    const reservations: Array<{ id: string; accountId: string; bytes: bigint; objectKey: string; expiresAt: Date; createdAt: Date; claimedAt?: Date | null }> = [];
    let sequence = 0;
    const db: any = {
        session: { findFirst: async ({ where }: any) => where.id === "s1" && where.accountId === "account" ? { id: "s1" } : null },
        chimeraAttachmentCleanup: { findUnique: async () => null },
        account: {
            findUnique: async ({ where }: any) => where.id === account.id ? { ...account } : null,
            aggregate: async () => ({ _sum: { attachmentUsedBytes: account.attachmentUsedBytes, attachmentReservedBytes: account.attachmentReservedBytes } }),
            update: async ({ data }: any) => {
                for (const field of ["attachmentUsedBytes", "attachmentReservedBytes"] as const) {
                    const value = data[field];
                    if (value?.increment !== undefined) account[field] += BigInt(value.increment);
                    else if (value?.decrement !== undefined) account[field] -= BigInt(value.decrement);
                    else if (value !== undefined) account[field] = BigInt(value);
                }
                return { ...account };
            },
        },
        chimeraAttachmentReservation: {
            create: async ({ data }: any) => { const row = { id: `r${++sequence}`, createdAt: new Date(), ...data }; reservations.push(row); return row; },
            findUnique: async ({ where }: any) => reservations.find((row) => row.id === where.id) ?? null,
            findMany: async ({ where, take }: any) => reservations.filter((row) => row.expiresAt < where.expiresAt.lt && (where.claimedAt !== null || row.claimedAt == null)).slice(0, take),
            updateMany: async ({ where, data }: any) => { const row = reservations.find((row) => row.id === where.id && row.accountId === where.accountId && row.objectKey === where.objectKey && row.claimedAt == null && row.expiresAt > where.expiresAt.gt); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
            deleteMany: async ({ where }: any) => {
                if (where.claimedAt?.not === null) { const count = reservations.filter((row) => row.claimedAt != null).length; for (let index = reservations.length - 1; index >= 0; index--) if (reservations[index].claimedAt != null) reservations.splice(index, 1); return { count }; }
                const index = reservations.findIndex((row) => row.id === where.id && (!where.accountId || row.accountId === where.accountId) && (where.claimedAt !== null || row.claimedAt == null)); if (index < 0) return { count: 0 }; reservations.splice(index, 1); return { count: 1 };
            },
            aggregate: async ({ where }: any) => ({ _sum: { bytes: reservations.filter((row) => row.expiresAt > where.expiresAt.gt).reduce((total, row) => total + row.bytes, 0n) } }),
        },
    };
    let queue = Promise.resolve();
    const runTransaction = <T>(fn: (tx: any) => Promise<T>) => {
        const result = queue.then(() => fn(db));
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    return { account, reservations, db, runTransaction };
}

const GiB = 1024n * 1024n * 1024n;
const healthyDisk = async () => ({ totalBytes: 100n * GiB, freeBytes: 50n * GiB, dataBytes: 1n * GiB });

describe("Chimera attachment quota", () => {
    it("atomically bounds concurrent reservations by the account quota", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk, now: () => new Date("2026-07-19T00:00:00Z") });
        const results = await Promise.allSettled([service.reserve("account", 500, "a.enc"), service.reserve("account", 500, "b.enc")]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(state.account.attachmentReservedBytes).toBe(500n);
        expect(state.reservations).toHaveLength(1);
    });

    it("rejects disabled accounts and unhealthy disks without reserving bytes", async () => {
        for (const configure of [
            (state: ReturnType<typeof database>) => { state.account.disabledAt = new Date(); },
            () => undefined,
        ]) {
            const state = database(); configure(state);
            const inspectDisk = state.account.disabledAt ? healthyDisk : async () => ({ totalBytes: 100_000n, freeBytes: 10n, dataBytes: 1_000n });
            const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk });
            await expect(service.reserve("account", 10, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
            expect(state.reservations).toHaveLength(0);
        }
    });

    it("rejects a disk at the 80 percent high-water mark", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: async () => ({ totalBytes: 100n * GiB, freeBytes: 20n * GiB, dataBytes: 5n * GiB }) });
        await expect(service.reserve("account", 10, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
    });

    it("accepts a healthy dedicated 30 GiB data filesystem above the default reserve", async () => {
        const state = database();
        const service = createAttachmentQuotaService({
            db: state.db,
            runTransaction: state.runTransaction,
            inspectDisk: async () => ({ totalBytes: 30n * GiB, freeBytes: 18n * GiB, dataBytes: 5n * GiB }),
        });
        await expect(service.reserve("account", 10, "a.enc")).resolves.toBeDefined();
    });

    it("enforces the shared attachment ceiling across all accounts", async () => {
        const state = database();
        const service = createAttachmentQuotaService({
            db: state.db,
            runTransaction: state.runTransaction,
            inspectDisk: healthyDisk,
            globalLimitBytes: 200n,
        });
        await expect(service.reserve("account", 101, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
        expect(state.reservations).toHaveLength(0);
    });

    it("preserves enough data-disk space for the next deploy and rollback", async () => {
        const state = database();
        const service = createAttachmentQuotaService({
            db: state.db,
            runTransaction: state.runTransaction,
            inspectDisk: async () => ({ totalBytes: 30n * GiB, freeBytes: 16n * GiB, dataBytes: 5n * GiB }),
        });
        await expect(service.reserve("account", 10, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
    });

    it("includes live reservations from other accounts in projected disk capacity", async () => {
        const state = database();
        state.reservations.push({ id: "other", accountId: "other-account", bytes: 6n * GiB, objectKey: "other.enc", createdAt: new Date(), expiresAt: new Date("2026-07-20T00:00:00Z") });
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, now: () => new Date("2026-07-19T00:00:00Z"), minFreeBytes: 15n * GiB, inspectDisk: async () => ({ totalBytes: 100n * GiB, freeBytes: 20n * GiB, dataBytes: 1n * GiB }) });
        await expect(service.reserve("account", 1, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
    });

    it("claims a reservation once, accounts actual bytes, and rolls back failed writes", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk });
        const objectKey = "sessions/s1/attachments/a.enc";
        const reservation = await service.reserve("account", 400, objectKey);
        await expect(service.claim("s1", reservation.id, "account", "other.enc", 250)).rejects.toBeInstanceOf(AttachmentQuotaError);
        const claim = await service.claim("s1", reservation.id, "account", objectKey, 250);
        expect(state.account).toMatchObject({ attachmentReservedBytes: 400n, attachmentUsedBytes: 100n });
        await service.finalize(claim);
        expect(state.account).toMatchObject({ attachmentReservedBytes: 0n, attachmentUsedBytes: 350n });
        await expect(service.claim("s1", reservation.id, "account", objectKey, 250)).rejects.toBeInstanceOf(AttachmentQuotaError);
    });

    it("releases expired reservations in bounded cleanup", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk, now: () => new Date("2026-07-19T01:00:00Z") });
        state.account.attachmentReservedBytes = 20n;
        state.reservations.push({ id: "expired", accountId: "account", bytes: 20n, objectKey: "a.enc", createdAt: new Date(0), expiresAt: new Date("2026-07-19T00:00:00Z") });
        expect(await service.cleanupExpired()).toBe(1);
        expect(state.account.attachmentReservedBytes).toBe(0n);
        expect(state.reservations).toHaveLength(0);
    });

    it("never releases a claimed reservation during runtime cleanup", async () => {
        const state = database();
        let current = new Date("2026-07-19T00:00:00Z");
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk, now: () => current, reservationTtlMs: 100 });
        const objectKey = "sessions/s1/attachments/a.enc";
        const reservation = await service.reserve("account", 20, objectKey);
        await service.claim("s1", reservation.id, "account", objectKey, 20);
        current = new Date(current.getTime() + 1_000);
        expect(await service.cleanupExpired()).toBe(0);
        expect(state.reservations).toHaveLength(1);
        expect(state.account.attachmentReservedBytes).toBe(20n);
    });

    it("explicitly recovers claimed reservations only during startup", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk });
        state.reservations.push({ id: "claimed", accountId: "account", bytes: 20n, objectKey: "sessions/s1/attachments/a.enc", createdAt: new Date(), expiresAt: new Date(0), claimedAt: new Date() });
        state.reservations.push({ id: "unclaimed", accountId: "account", bytes: 10n, objectKey: "sessions/s1/attachments/b.enc", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), claimedAt: null });
        await expect(service.recoverStaleClaims()).resolves.toEqual({ count: 1 });
        expect(state.reservations.map((row) => row.id)).toEqual(["unclaimed"]);
    });

    it("claims a reservation only once under concurrent callers", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk });
        const reservation = await service.reserve("account", 400, "sessions/s1/attachments/a.enc");
        const claims = await Promise.allSettled([
            service.claim("s1", reservation.id, "account", "sessions/s1/attachments/a.enc", 100),
            service.claim("s1", reservation.id, "account", "sessions/s1/attachments/a.enc", 100),
        ]);
        expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    });
});

describe("atomic local attachment writes", () => {
    const roots: string[] = [];
    afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

    it("renames a fully flushed partial file into place", async () => {
        const root = await mkdtemp(join(tmpdir(), "chimera-attachment-")); roots.push(root);
        await putLocalFileAtomic("sessions/s1/attachments/a.enc", Buffer.from("ciphertext"), root);
        expect(await readFile(join(root, "sessions/s1/attachments/a.enc"), "utf8")).toBe("ciphertext");
    });

    it("removes its partial file when the final rename fails", async () => {
        const root = await mkdtemp(join(tmpdir(), "chimera-attachment-")); roots.push(root);
        await mkdir(join(root, "sessions/s1/attachments/a.enc"), { recursive: true });
        await expect(putLocalFileAtomic("sessions/s1/attachments/a.enc", Buffer.from("ciphertext"), root)).rejects.toThrow();
        expect((await readdir(join(root, "sessions/s1/attachments"))).filter((name) => name.endsWith(".partial"))).toEqual([]);
    });

    it("removes stale partials and reconciles stored bytes from encrypted blobs", async () => {
        const root = await mkdtemp(join(tmpdir(), "chimera-attachment-")); roots.push(root);
        const directory = join(root, "sessions/s1/attachments");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "a.enc"), Buffer.alloc(17));
        const partial = join(directory, "orphan.partial");
        await writeFile(partial, Buffer.alloc(100));
        await utimes(partial, new Date(0), new Date(0));
        const updates: any[] = [];
        const db: any = {
            session: { findMany: async () => [{ id: "s1", accountId: "account" }] },
            chimeraAttachmentReservation: { groupBy: async () => [] },
            account: { findMany: async () => [{ id: "account" }], update: async (input: any) => { updates.push(input); } },
        };
        await reconcileAttachmentStorage(root, { db, cleanupExpired: async () => 0 });
        expect(updates).toEqual([
            { where: { id: "account" }, data: { attachmentUsedBytes: 17n } },
            { where: { id: "account" }, data: { attachmentReservedBytes: 0n } },
        ]);
        expect(await readdir(directory)).toEqual(["a.enc"]);
    });

    it("drains every expired cleanup batch and recomputes reserved bytes", async () => {
        const root = await mkdtemp(join(tmpdir(), "chimera-attachment-")); roots.push(root);
        const expired = Array.from({ length: 101 }, (_, index) => ({ id: `e${index}` }));
        const updates: any[] = [];
        const db: any = {
            session: { findMany: async () => [] },
            chimeraAttachmentReservation: { groupBy: async () => [{ accountId: "a1", _sum: { bytes: 9n } }] },
            account: { findMany: async () => [{ id: "a1" }, { id: "a2" }], update: async (input: any) => { updates.push(input); } },
        };
        await reconcileAttachmentStorage(root, { db, cleanupExpired: async () => expired.splice(0, 100).length });
        expect(updates).toEqual([
            { where: { id: "a1" }, data: { attachmentUsedBytes: 0n } },
            { where: { id: "a2" }, data: { attachmentUsedBytes: 0n } },
            { where: { id: "a1" }, data: { attachmentReservedBytes: 9n } },
            { where: { id: "a2" }, data: { attachmentReservedBytes: 0n } },
        ]);
    });

    it("startup recovery accounts a claimed local blob from actual storage", async () => {
        const root = await mkdtemp(join(tmpdir(), "chimera-attachment-")); roots.push(root);
        const directory = join(root, "sessions/s1/attachments"); await mkdir(directory, { recursive: true }); await writeFile(join(directory, "a.enc"), Buffer.alloc(17));
        let reservation: any = { id: "r1", accountId: "account", bytes: 20n, claimedAt: new Date() };
        const account = { id: "account", attachmentReservedBytes: 20n, attachmentUsedBytes: 0n };
        const db: any = {
            chimeraAttachmentReservation: {
                deleteMany: async () => { reservation = null; return { count: 1 }; },
                findMany: async () => [], groupBy: async () => reservation ? [{ accountId: "account", _sum: { bytes: reservation.bytes } }] : [],
            },
            session: { findMany: async () => [{ id: "s1", accountId: "account" }] },
            account: { findMany: async () => [{ id: "account" }], update: async ({ data }: any) => Object.assign(account, data) },
        };
        await createAttachmentQuotaService({ db }).recoverStaleClaims();
        await reconcileAttachmentStorage(root, { db, cleanupExpired: async () => 0 });
        expect(account).toMatchObject({ attachmentReservedBytes: 0n, attachmentUsedBytes: 17n });
    });

    it("startup recovery clears a claimed S3 reservation with no blob", async () => {
        let reservation: any = { id: "r1", accountId: "account", bytes: 20n, claimedAt: new Date() };
        const account = { id: "account", attachmentReservedBytes: 20n, attachmentUsedBytes: 10n };
        const db: any = {
            chimeraAttachmentReservation: { deleteMany: async () => { reservation = null; return { count: 1 }; }, findMany: async () => [], groupBy: async () => [] },
            session: { findMany: async () => [{ id: "s1", accountId: "account" }] },
            account: { findMany: async () => [{ id: "account" }], update: async ({ data }: any) => Object.assign(account, data) },
        };
        await createAttachmentQuotaService({ db }).recoverStaleClaims();
        await reconcileS3AttachmentStorage({ db, inventoryAll: async () => [], cleanupExpired: async () => 0 });
        expect(account).toMatchObject({ attachmentReservedBytes: 0n, attachmentUsedBytes: 0n });
    });
});
