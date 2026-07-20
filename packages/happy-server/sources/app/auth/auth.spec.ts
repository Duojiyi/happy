import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    account: { disabledAt: null as Date | null, tokenEpoch: 0 },
    verified: null as null | { user: string; extras?: Record<string, unknown> },
}));

vi.mock("@/storage/db", () => ({
    db: { account: { findUnique: vi.fn(async () => ({ ...state.account })) } },
}));

vi.mock("privacy-kit", () => ({
    createPersistentTokenGenerator: vi.fn(async () => ({
        publicKey: new Uint8Array(32),
        new: vi.fn(async ({ user, extras }) => `token:${user}:${String(extras?.tokenEpoch)}`),
    })),
    createPersistentTokenVerifier: vi.fn(async () => ({ verify: vi.fn(async () => state.verified) })),
    createEphemeralTokenGenerator: vi.fn(async () => ({ publicKey: new Uint8Array(32), new: vi.fn() })),
    createEphemeralTokenVerifier: vi.fn(async () => ({ verify: vi.fn() })),
}));

import { AuthModule } from "./auth";

describe("Chimera REST token account policy", () => {
    beforeEach(() => {
        process.env.HANDY_MASTER_SECRET = "test-secret";
        state.account = { disabledAt: null, tokenEpoch: 0 };
        state.verified = null;
    });

    it("rechecks disabled status and token epoch for cached tokens", async () => {
        const module = new AuthModule();
        await module.init();
        const token = await module.createToken("account-1");
        expect(await module.verifyToken(token)).toMatchObject({ userId: "account-1", tokenEpoch: 0 });

        state.account.tokenEpoch = 1;
        expect(await module.verifyToken(token)).toBeNull();
        state.account.tokenEpoch = 0;
        state.account.disabledAt = new Date();
        expect(await module.verifyToken(token)).toBeNull();
    });

    it("rejects disabled and stale verified tokens before caching them", async () => {
        const module = new AuthModule();
        await module.init();
        state.verified = { user: "account-1", extras: { tokenEpoch: 4 } };
        state.account.tokenEpoch = 5;
        expect(await module.verifyToken("uncached-stale")).toBeNull();

        state.account.tokenEpoch = 4;
        state.account.disabledAt = new Date();
        expect(await module.verifyToken("uncached-disabled")).toBeNull();
        state.account.disabledAt = null;
        expect(await module.verifyToken("uncached-active")).toMatchObject({ userId: "account-1", tokenEpoch: 4 });
    });
});
