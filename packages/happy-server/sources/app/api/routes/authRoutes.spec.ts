import { describe, expect, it } from "vitest";
import { canonicalSigningPublicKey, verifyAuthChallengeSignature } from "./authRoutes";
import nacl from "tweetnacl";
import { createAuthPayload } from "@/app/chimera/authChallenge";

describe("account auth public key canonicalization", () => {
    it("rejects a non-canonical base64 alias before it can affect rate limits", () => {
        const canonical = Buffer.alloc(32, 7).toString("base64");
        const alias = `${canonical.slice(0, -2)}B=`;
        expect(canonicalSigningPublicKey(canonical)).toBe(canonical);
        expect(canonicalSigningPublicKey(alias)).toBeNull();
    });
});

describe("account auth signatures", () => {
    const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const base = { origin: "https://39.98.68.173", purpose: "chimera-account-auth", challengeId: "id.nonce", nonce: "AAECAwQFBgcICQoLDA0ODw", publicKey: Buffer.from(pair.publicKey).toString("base64"), expiresAt: new Date("2026-07-19T10:00:00.000Z") };
    const signature = Buffer.from(nacl.sign.detached(createAuthPayload({ ...base, purpose: "chimera-account-auth", expiresAt: base.expiresAt.toISOString() }), pair.secretKey)).toString("base64");

    it("accepts a real signature for the exact canonical payload", async () => {
        await expect(verifyAuthChallengeSignature({ ...base, signature })).resolves.toBe(true);
    });

    it.each([{ origin: "https://other.example" }, { purpose: "other-purpose" }, { signature: "not-base64" }])("rejects altered or malformed signed challenge fields", async (override) => {
        await expect(verifyAuthChallengeSignature({ ...base, signature, ...override })).resolves.toBe(false);
    });
});
