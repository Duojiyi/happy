import { describe, expect, it } from "vitest";
import { isTrustedLoopbackProxy } from "./api";

describe("trusted proxy boundary", () => {
    it.each(["127.0.0.1", "::1"])("trusts only loopback proxy address %s", (address) => {
        expect(isTrustedLoopbackProxy(address)).toBe(true);
    });

    it.each(["10.0.0.1", "::ffff:127.0.0.1", "203.0.113.10"])("does not trust spoofable proxy address %s", (address) => {
        expect(isTrustedLoopbackProxy(address)).toBe(false);
    });
});
