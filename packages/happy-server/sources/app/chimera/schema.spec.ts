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
            await prisma.chimeraAttachmentReservation.create({
                data: {
                    accountId: account.id,
                    bytes: 1024n,
                    objectKey: "sessions/s1/attachments/a.enc",
                    expiresAt: new Date("2026-07-20T00:00:00.000Z"),
                },
            });

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
