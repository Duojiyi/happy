import { describe, expect, it } from "vitest";
import { loadChimeraServerConfig } from "./config";

const validEnv = (): NodeJS.ProcessEnv => ({
    CHIMERA_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
    CHIMERA_ADMIN_SESSION_SECRET: Buffer.alloc(32, 1).toString("base64url"),
    CHIMERA_INVITATION_PEPPER: Buffer.alloc(32, 2).toString("base64url"),
    CHIMERA_ACCOUNT_PSEUDONYM_KEY: Buffer.alloc(32, 3).toString("base64url"),
    CHIMERA_UPDATE_PUBLIC_KEY: Buffer.alloc(32, 4).toString("base64url"),
});

describe("loadChimeraServerConfig", () => {
    it("parses an immutable configuration with the fixed relay origin", () => {
        const config = loadChimeraServerConfig(validEnv());

        expect(config).toMatchObject({
            relayOrigin: "https://39.98.68.173",
            adminPasswordHash: validEnv().CHIMERA_ADMIN_PASSWORD_HASH,
        });
        expect(config.adminSessionSecret).toEqual(new Uint8Array(32).fill(1));
        expect(config.invitationPepper).toEqual(new Uint8Array(32).fill(2));
        expect(config.accountPseudonymKey).toEqual(new Uint8Array(32).fill(3));
        expect(config.updatePublicKey).toEqual(new Uint8Array(32).fill(4));
        expect(Object.isFrozen(config)).toBe(true);
    });

    it.each([
        "CHIMERA_ADMIN_PASSWORD_HASH",
        "CHIMERA_ADMIN_SESSION_SECRET",
        "CHIMERA_INVITATION_PEPPER",
        "CHIMERA_ACCOUNT_PSEUDONYM_KEY",
        "CHIMERA_UPDATE_PUBLIC_KEY",
    ])("fails closed when %s is missing", (name) => {
        const env = validEnv();
        delete env[name];

        expect(() => loadChimeraServerConfig(env)).toThrow("Invalid Chimera server configuration");
    });

    it.each([
        "$argon2i$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2d$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2id$v=16$m=65536,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2id$v=19$m=32768,t=3,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2id$v=19$m=65536,t=3,p=2$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "$argon2id$v=19$t=3,m=65536,p=1$c29tZXNhbHQ$MDEyMzQ1Njc4OWFiY2RlZg",
        "not-a-phc-string",
    ])("rejects invalid Argon2 password hashes", (hash) => {
        const env = validEnv();
        env.CHIMERA_ADMIN_PASSWORD_HASH = hash;

        expect(() => loadChimeraServerConfig(env)).toThrow("Invalid Chimera server configuration");
    });

    it.each([
        ["CHIMERA_ADMIN_SESSION_SECRET", "not base64url"],
        ["CHIMERA_INVITATION_PEPPER", Buffer.alloc(31).toString("base64url")],
        ["CHIMERA_ACCOUNT_PSEUDONYM_KEY", "AQ"],
        ["CHIMERA_UPDATE_PUBLIC_KEY", Buffer.alloc(31).toString("base64url")],
    ] as const)("rejects invalid %s", (name, value) => {
        const env = validEnv();
        env[name] = value;

        expect(() => loadChimeraServerConfig(env)).toThrow("Invalid Chimera server configuration");
    });

    it("requires an exactly 32-byte raw Ed25519 update public key", () => {
        const env = validEnv();
        env.CHIMERA_UPDATE_PUBLIC_KEY = Buffer.alloc(33).toString("base64url");

        expect(() => loadChimeraServerConfig(env)).toThrow("Invalid Chimera server configuration");
    });
});
