import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@prisma/client";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../standalone";

let database: any;

// Keep production inTx intact while pointing its db import at the test PGlite client.
vi.mock("@/storage/db", () => ({ get db() { return database; } }));

const tick = () => new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));

describe.sequential("attachment claim/delete transaction race", () => {
    let root: string;
    let pg: PGlite;
    let quota: ReturnType<typeof import("./attachmentQuota").createAttachmentQuotaService>;
    let sessionDelete: typeof import("../session/sessionDelete").sessionDelete;
    let SessionAttachmentBusyError: typeof import("../session/sessionDelete").SessionAttachmentBusyError;
    let inTx: typeof import("@/storage/inTx").inTx;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "happy-attachment-race-"));
        await runMigrations({ pgliteDir: join(root, "pglite"), migrationsDir: resolve(process.cwd(), "prisma/migrations") });
        pg = new PGlite(join(root, "pglite"));
        database = new PrismaClient({ adapter: new PrismaPGlite(pg) } as any) as any;
        await database.$connect();
        ({ inTx } = await import("@/storage/inTx"));
        const quotaModule = await import("./attachmentQuota");
        ({ sessionDelete, SessionAttachmentBusyError } = await import("../session/sessionDelete"));
        quota = quotaModule.createAttachmentQuotaService({
            inspectDisk: async () => ({ totalBytes: 100n * 1024n ** 3n, freeBytes: 50n * 1024n ** 3n, dataBytes: 1n * 1024n ** 3n }),
            minFreeBytes: 0n,
        });
    }, 30_000);

    afterEach(async () => {
        await database?.$disconnect();
        await pg?.close();
        await rm(root, { recursive: true, force: true });
        database = undefined;
    });

    async function fixture() {
        const account = await database.account.create({ data: { publicKey: crypto.randomUUID(), attachmentQuotaBytes: 1_000n } });
        const session = await database.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: "{}" } });
        const objectKey = `sessions/${session.id}/attachments/a.enc`;
        const reservation = await quota.reserve(account.id, 100, objectKey);
        return { account, session, objectKey, reservation };
    }

    const deletionDependencies = () => ({
        inTx,
        afterTx: (_tx: any, _callback: () => void) => undefined,
        allocateUserSeq: async () => 1,
        emitUpdate: () => undefined,
        process: async () => true,
    });

    it("makes a late claim fail after delete commits, before any storage write", async () => {
        const { account, session, objectKey, reservation } = await fixture();
        let allowClaim!: () => void;
        const claimBarrier = new Promise<void>((resolveBarrier) => { allowClaim = resolveBarrier; });
        let writes = 0;

        const upload = (async () => {
            await claimBarrier;
            const claim = await quota.claim(session.id, reservation.id, account.id, objectKey, 100);
            writes++;
            await quota.finalize(claim);
        })();
        await tick();
        expect(await sessionDelete({ uid: account.id } as any, session.id, deletionDependencies() as any)).toBe(true);
        allowClaim();
        await expect(upload).rejects.toThrow("Attachment upload unavailable");
        expect(writes).toBe(0);
        expect(await database.session.findUnique({ where: { id: session.id } })).toBeNull();
        expect(await database.chimeraAttachmentCleanup.findUnique({ where: { sessionId: session.id } })).not.toBeNull();
        expect(await database.chimeraAttachmentReservation.findUnique({ where: { id: reservation.id } })).toBeNull();
        expect(await database.account.findUnique({ where: { id: account.id }, select: { attachmentReservedBytes: true, attachmentUsedBytes: true } })).toEqual({ attachmentReservedBytes: 0n, attachmentUsedBytes: 0n });
    });

    it("does not claim an orphaned session or a session already queued for cleanup", async () => {
        const first = await fixture();
        await database.session.delete({ where: { id: first.session.id } });
        await expect(quota.claim(first.session.id, first.reservation.id, first.account.id, first.objectKey, 100)).rejects.toThrow("Attachment upload unavailable");

        const second = await fixture();
        await database.chimeraAttachmentCleanup.create({ data: { sessionId: second.session.id, accountId: second.account.id } });
        await expect(quota.claim(second.session.id, second.reservation.id, second.account.id, second.objectKey, 100)).rejects.toThrow("Attachment upload unavailable");
        expect(await database.account.findUnique({ where: { id: second.account.id }, select: { attachmentReservedBytes: true, attachmentUsedBytes: true } })).toEqual({ attachmentReservedBytes: 100n, attachmentUsedBytes: 0n });
    });

    it("rejects delete while a claim is live, then permits deletion after rollback", async () => {
        const { account, session, objectKey, reservation } = await fixture();
        const claim = await quota.claim(session.id, reservation.id, account.id, objectKey, 80);

        await expect(sessionDelete({ uid: account.id } as any, session.id, deletionDependencies() as any)).rejects.toBeInstanceOf(SessionAttachmentBusyError);
        expect(await database.session.findUnique({ where: { id: session.id } })).not.toBeNull();
        expect(await database.chimeraAttachmentCleanup.findUnique({ where: { sessionId: session.id } })).toBeNull();
        expect(await database.account.findUnique({ where: { id: account.id }, select: { attachmentReservedBytes: true, attachmentUsedBytes: true } })).toEqual({ attachmentReservedBytes: 100n, attachmentUsedBytes: 0n });

        await quota.rollback(claim);
        expect(await sessionDelete({ uid: account.id } as any, session.id, deletionDependencies() as any)).toBe(true);
        expect(await database.chimeraAttachmentReservation.findUnique({ where: { id: reservation.id } })).toBeNull();
        expect(await database.chimeraAttachmentCleanup.findUnique({ where: { sessionId: session.id } })).not.toBeNull();
        expect(await database.account.findUnique({ where: { id: account.id }, select: { attachmentReservedBytes: true, attachmentUsedBytes: true } })).toEqual({ attachmentReservedBytes: 0n, attachmentUsedBytes: 0n });
    });

    it("keeps deletion busy past TTL until a paused write finalizes", async () => {
        const { account, session, objectKey, reservation } = await fixture();
        const claim = await quota.claim(session.id, reservation.id, account.id, objectKey, 80);
        await database.chimeraAttachmentReservation.update({ where: { id: reservation.id }, data: { expiresAt: new Date(0) } });
        expect(await quota.cleanupExpired()).toBe(0);
        await expect(sessionDelete({ uid: account.id } as any, session.id, deletionDependencies() as any)).rejects.toBeInstanceOf(SessionAttachmentBusyError);
        await quota.finalize(claim);
        await expect(sessionDelete({ uid: account.id } as any, session.id, deletionDependencies() as any)).resolves.toBe(true);
    });
});
