-- AlterTable
ALTER TABLE "Account"
    ADD COLUMN "disabledAt" TIMESTAMP(3),
    ADD COLUMN "tokenEpoch" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "attachmentQuotaBytes" BIGINT NOT NULL DEFAULT 5368709120,
    ADD COLUMN "attachmentUsedBytes" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "attachmentReservedBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ChimeraAuthChallenge" (
    "id" TEXT NOT NULL,
    "nonceDigest" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChimeraAuthChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChimeraInvitation" (
    "id" TEXT NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChimeraInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChimeraAdminSession" (
    "id" TEXT NOT NULL,
    "sessionDigest" TEXT NOT NULL,
    "csrfDigest" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChimeraAdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChimeraConfiguration" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChimeraConfiguration_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ChimeraAttachmentReservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChimeraAttachmentReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChimeraAuthChallenge_nonceDigest_key" ON "ChimeraAuthChallenge"("nonceDigest");

-- CreateIndex
CREATE INDEX "ChimeraAuthChallenge_expiresAt_idx" ON "ChimeraAuthChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChimeraInvitation_codeDigest_key" ON "ChimeraInvitation"("codeDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ChimeraAdminSession_sessionDigest_key" ON "ChimeraAdminSession"("sessionDigest");

-- CreateIndex
CREATE INDEX "ChimeraAdminSession_expiresAt_idx" ON "ChimeraAdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ChimeraAttachmentReservation_accountId_expiresAt_idx" ON "ChimeraAttachmentReservation"("accountId", "expiresAt");

-- AddForeignKey
ALTER TABLE "ChimeraAttachmentReservation"
    ADD CONSTRAINT "ChimeraAttachmentReservation_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
