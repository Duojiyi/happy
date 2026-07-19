-- CreateTable
CREATE TABLE "ChimeraAttachmentCleanup" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "plannedBytes" BIGINT,
    "storageDeletedAt" TIMESTAMP(3),
    "accountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChimeraAttachmentCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChimeraAttachmentCleanup_sessionId_key" ON "ChimeraAttachmentCleanup"("sessionId");

-- CreateIndex
CREATE INDEX "ChimeraAttachmentCleanup_accountId_idx" ON "ChimeraAttachmentCleanup"("accountId");

-- AddForeignKey
ALTER TABLE "ChimeraAttachmentCleanup"
    ADD CONSTRAINT "ChimeraAttachmentCleanup_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
