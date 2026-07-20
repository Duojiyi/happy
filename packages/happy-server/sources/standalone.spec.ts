import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startServer: vi.fn(), awaitShutdown: vi.fn() }));
vi.mock("./index", () => ({ startServer: mocks.startServer }));
vi.mock("./utils/shutdown", () => ({ awaitShutdown: mocks.awaitShutdown }));

import { isStandaloneEntrypoint, serve } from "./standalone";

const originalEnv = { ...process.env };
const chimeraEnv = {
    CHIMERA_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
    CHIMERA_ADMIN_SESSION_SECRET: Buffer.alloc(32, 1).toString("base64url"),
    CHIMERA_INVITATION_PEPPER: Buffer.alloc(32, 2).toString("base64url"),
    CHIMERA_ACCOUNT_PSEUDONYM_KEY: Buffer.alloc(32, 3).toString("base64url"),
    CHIMERA_UPDATE_PUBLIC_KEY: Buffer.alloc(32, 4).toString("base64url"),
};

afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
    mocks.startServer.mockReset();
    mocks.awaitShutdown.mockReset();
});

describe("isStandaloneEntrypoint", () => {
    it("recognizes standalone script paths on Windows and POSIX", () => {
        expect(isStandaloneEntrypoint("C:\\Projects\\Work\\happy\\packages\\happy-server\\sources\\standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/standalone.ts")).toBe(true);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/dist/happy-server")).toBe(true);
        expect(isStandaloneEntrypoint("C:\\repo\\packages\\happy-server\\dist\\happy-server.exe")).toBe(true);
    });

    it("rejects unrelated entrypoints", () => {
        expect(isStandaloneEntrypoint("C:\\repo\\node_modules\\vitest\\vitest.mjs")).toBe(false);
        expect(isStandaloneEntrypoint("/repo/packages/happy-server/sources/main.ts")).toBe(false);
    });
});

describe("standalone server binding", () => {
    it("always gives startServer the loopback host", async () => {
        const env = { ...chimeraEnv, HANDY_MASTER_SECRET: "test-secret", HOST: "0.0.0.0" };
        Object.assign(process.env, env);
        mocks.startServer.mockResolvedValue({ port: 3005, host: "127.0.0.1" });
        mocks.awaitShutdown.mockResolvedValue(undefined);
        vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        await serve(env);

        expect(mocks.startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1" }));
    });
});
