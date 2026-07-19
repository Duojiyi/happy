import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentQuotaService, AttachmentQuotaError, reconcileAttachmentStorage } from "./attachmentQuota";
import { putLocalFileAtomic } from "@/storage/files";

function database() {
    const account = { id: "account", disabledAt: null as Date | null, attachmentQuotaBytes: 1_000n, attachmentUsedBytes: 100n, attachmentReservedBytes: 0n };
    const reservations: Array<{ id: string; accountId: string; bytes: bigint; objectKey: string; expiresAt: Date; createdAt: Date }> = [];
    let sequence = 0;
    const db: any = {
        account: {
            findUnique: async ({ where }: any) => where.id === account.id ? { ...account } : null,
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
            findMany: async ({ where, take }: any) => reservations.filter((row) => row.expiresAt < where.expiresAt.lt).slice(0, take),
            deleteMany: async ({ where }: any) => { const index = reservations.findIndex((row) => row.id === where.id && (!where.accountId || row.accountId === where.accountId)); if (index < 0) return { count: 0 }; reservations.splice(index, 1); return { count: 1 }; },
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
const healthyDisk = async () => ({ totalBytes: 100n * GiB, freeBytes: 50n * GiB });

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
            const inspectDisk = state.account.disabledAt ? healthyDisk : async () => ({ totalBytes: 100_000n, freeBytes: 10n });
            const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk });
            await expect(service.reserve("account", 10, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
            expect(state.reservations).toHaveLength(0);
        }
    });

    it("rejects a disk at the 80 percent high-water mark", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: async () => ({ totalBytes: 100n * GiB, freeBytes: 20n * GiB }) });
        await expect(service.reserve("account", 10, "a.enc")).rejects.toBeInstanceOf(AttachmentQuotaError);
    });

    it("claims a reservation once, accounts actual bytes, and rolls back failed writes", async () => {
        const state = database();
        const service = createAttachmentQuotaService({ db: state.db, runTransaction: state.runTransaction, inspectDisk: healthyDisk });
        const reservation = await service.reserve("account", 400, "a.enc");
        await expect(service.claim(reservation.id, "account", "other.enc", 250)).rejects.toBeInstanceOf(AttachmentQuotaError);
        const claim = await service.claim(reservation.id, "account", "a.enc", 250);
        expect(state.account).toMatchObject({ attachmentReservedBytes: 0n, attachmentUsedBytes: 350n });
        await expect(service.claim(reservation.id, "account", "a.enc", 250)).rejects.toBeInstanceOf(AttachmentQuotaError);
        await service.rollback(claim);
        expect(state.account.attachmentUsedBytes).toBe(100n);
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
            account: { findMany: async () => [{ id: "account" }], update: async (input: any) => { updates.push(input); } },
        };
        await reconcileAttachmentStorage(root, { db, cleanupExpired: async () => 0 });
        expect(updates).toEqual([{ where: { id: "account" }, data: { attachmentUsedBytes: 17n } }]);
        expect(await readdir(directory)).toEqual(["a.enc"]);
    });
});
