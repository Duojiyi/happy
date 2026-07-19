import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@prisma/client";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runMigrations } from "../../standalone";

const tempDirs: string[] = [];

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("Chimera Prisma security state", () => {
    it("upgrades pre-object-key reservations without carrying unsafe quota state", async () => {
        const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "happy-chimera-upgrade-"));
        const oldMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "happy-chimera-old-migrations-"));
        tempDirs.push(pgliteDir, oldMigrations);
        const source = path.resolve(process.cwd(), "prisma/migrations");
        for (const name of fs.readdirSync(source).filter((name) => name <= "20260719000000_add_chimera_control")) {
            fs.cpSync(path.join(source, name), path.join(oldMigrations, name), { recursive: true });
        }
        await runMigrations({ pgliteDir, migrationsDir: oldMigrations });
        const before = new PGlite(pgliteDir);
        await before.exec(`INSERT INTO "Account" ("id", "publicKey", "updatedAt", "attachmentReservedBytes") VALUES ('a1', 'upgrade-account', CURRENT_TIMESTAMP, 99)`);
        await before.exec(`INSERT INTO "ChimeraAttachmentReservation" ("id", "accountId", "bytes", "expiresAt", "createdAt") VALUES ('r1', 'a1', 99, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
        await before.close();

        await runMigrations({ pgliteDir, migrationsDir: source });
        const after = new PGlite(pgliteDir);
        const prisma = new PrismaClient({ adapter: new PrismaPGlite(after) } as any) as any;
        try {
            expect(await prisma.chimeraAttachmentReservation.count()).toBe(0);
            expect((await prisma.account.findUnique({ where: { id: "a1" } })).attachmentReservedBytes).toBe(0n);
            const reservation = await prisma.chimeraAttachmentReservation.create({ data: { accountId: "a1", bytes: 1n, objectKey: "sessions/s1/attachments/a.enc", expiresAt: new Date("2026-07-21T00:00:00Z") } });
            expect(reservation).toMatchObject({ objectKey: "sessions/s1/attachments/a.enc", claimedAt: null });
        } finally { await prisma.$disconnect(); await after.close(); }
    }, 20_000);

    it("persists defaults and rejects duplicate digests", async () => {
        const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "happy-chimera-schema-"));
        tempDirs.push(pgliteDir);
        await runMigrations({
            pgliteDir,
            migrationsDir: path.resolve(process.cwd(), "prisma/migrations"),
        });

        const pg = new PGlite(pgliteDir);
        const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) } as any) as any;

        try {
            const account = await prisma.account.create({
                data: { publicKey: "chimera-account" },
            });
            expect(account).toMatchObject({
                tokenEpoch: 0,
                attachmentQuotaBytes: 5368709120n,
                attachmentUsedBytes: 0n,
                attachmentReservedBytes: 0n,
                disabledAt: null,
            });

            await prisma.chimeraAuthChallenge.create({
                data: {
                    nonceDigest: "challenge-digest",
                    publicKey: account.publicKey,
                    clientIp: "127.0.0.1",
                    origin: "https://39.98.68.173",
                    purpose: "register",
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            });
            await expect(prisma.chimeraAuthChallenge.create({
                data: {
                    nonceDigest: "challenge-digest",
                    publicKey: account.publicKey,
                    clientIp: "127.0.0.1",
                    origin: "https://39.98.68.173",
                    purpose: "register",
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            })).rejects.toMatchObject({ code: "P2002" });

            await prisma.chimeraInvitation.create({
                data: {
                    codeDigest: "invitation-digest",
                    maxUses: 1,
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            });
            await expect(prisma.chimeraInvitation.create({
                data: {
                    codeDigest: "invitation-digest",
                    maxUses: 1,
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            })).rejects.toMatchObject({ code: "P2002" });

            await prisma.chimeraAdminSession.create({
                data: {
                    sessionDigest: "session-digest",
                    csrfDigest: "csrf-digest",
                    lastSeenAt: new Date("2026-07-19T00:00:00.000Z"),
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            });
            await expect(prisma.chimeraAdminSession.create({
                data: {
                    sessionDigest: "session-digest",
                    csrfDigest: "other-csrf-digest",
                    lastSeenAt: new Date("2026-07-19T00:00:00.000Z"),
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            })).rejects.toMatchObject({ code: "P2002" });

            await prisma.chimeraConfiguration.create({
                data: { key: "singleton", value: { enabled: true } },
            });
            const reservation = await prisma.chimeraAttachmentReservation.create({
                data: {
                    accountId: account.id,
                    bytes: 1024n,
                    objectKey: "sessions/s1/attachments/a.enc",
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            });
            expect(reservation.claimedAt).toBeNull();
            const claimedAt = new Date("2026-07-20T00:00:00.000Z");
            await prisma.chimeraAttachmentReservation.update({ where: { id: reservation.id }, data: { claimedAt } });
            await expect(prisma.chimeraAttachmentReservation.findUnique({ where: { id: reservation.id } })).resolves.toMatchObject({ claimedAt });

            const session = await prisma.session.create({
                data: { accountId: account.id, tag: "deleted-session", metadata: "encrypted-metadata" },
            });
            const cleanup = await prisma.chimeraAttachmentCleanup.create({
                data: { sessionId: session.id, accountId: account.id },
            });
            expect(cleanup).toMatchObject({
                sessionId: session.id,
                accountId: account.id,
                plannedBytes: null,
                storageDeletedAt: null,
                accountedAt: null,
            });
            expect(cleanup.createdAt).toBeInstanceOf(Date);
            expect(cleanup.updatedAt).toBeInstanceOf(Date);
            await expect(prisma.chimeraAttachmentCleanup.create({
                data: { sessionId: session.id, accountId: account.id, plannedBytes: 12n },
            })).rejects.toMatchObject({ code: "P2002" });
            await prisma.session.delete({ where: { id: session.id } });
            await expect(prisma.chimeraAttachmentCleanup.findUnique({ where: { sessionId: session.id } })).resolves.toMatchObject({ id: cleanup.id });
            await prisma.account.delete({ where: { id: account.id } });
            await expect(prisma.chimeraAttachmentCleanup.findUnique({ where: { sessionId: session.id } })).resolves.toBeNull();
        } finally {
            await prisma.$disconnect();
            await pg.close();
        }
    }, 20_000);
});
