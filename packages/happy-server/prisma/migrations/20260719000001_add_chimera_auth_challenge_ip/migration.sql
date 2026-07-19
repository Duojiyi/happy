ALTER TABLE "ChimeraAuthChallenge" ADD COLUMN "clientIp" TEXT NOT NULL DEFAULT '';
CREATE INDEX "ChimeraAuthChallenge_clientIp_expiresAt_idx" ON "ChimeraAuthChallenge"("clientIp", "expiresAt");
