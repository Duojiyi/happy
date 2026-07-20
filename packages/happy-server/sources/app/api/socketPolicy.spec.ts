import { beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ disabledAt: null as Date | null, tokenEpoch: 2 }));
vi.mock("@/storage/db", () => ({
    db: { account: { findUnique: vi.fn(async () => ({ ...account })) } },
}));

import { assertSocketAccountActive, disconnectAccountSockets } from "./socket";

describe("Chimera socket account policy", () => {
    beforeEach(() => {
        account.disabledAt = null;
        account.tokenEpoch = 2;
    });

    it("allows only a socket whose bound account epoch is still active", async () => {
        const disconnect = vi.fn();
        const socket = { data: { accountId: "account-1", tokenEpoch: 2 }, disconnect };
        expect(await assertSocketAccountActive(socket)).toBe(true);
        expect(disconnect).not.toHaveBeenCalled();

        account.tokenEpoch = 3;
        expect(await assertSocketAccountActive(socket)).toBe(false);
        expect(disconnect).toHaveBeenCalledWith(true);
    });

    it("disconnects a disabled socket before an event can proceed", async () => {
        account.disabledAt = new Date();
        const disconnect = vi.fn();
        expect(await assertSocketAccountActive({ data: { accountId: "account-1", tokenEpoch: 2 }, disconnect })).toBe(false);
        expect(disconnect).toHaveBeenCalledWith(true);
    });

    it("forces every live socket in the account room to disconnect", () => {
        const disconnectSockets = vi.fn();
        const server = { in: vi.fn(() => ({ disconnectSockets })) };
        disconnectAccountSockets("account-1", server as never);
        expect(server.in).toHaveBeenCalledWith("chimera-account:account-1");
        expect(disconnectSockets).toHaveBeenCalledWith(true);
    });
});
