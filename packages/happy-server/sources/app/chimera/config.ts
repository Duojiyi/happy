export interface ChimeraServerConfig {
    readonly relayOrigin: "https://103.250.173.136";
    readonly adminPasswordHash: string;
    readonly adminSessionSecret: Uint8Array;
    readonly invitationPepper: Uint8Array;
    readonly accountPseudonymKey: Uint8Array;
    readonly updatePublicKey: Uint8Array;
}

type Environment = Record<string, string | undefined>;

const RELAY_ORIGIN = "https://103.250.173.136" as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64_STANDARD = /^[A-Za-z0-9+/]+$/;

export function loadChimeraServerConfig(env: Environment): ChimeraServerConfig {
    const adminPasswordHash = env.CHIMERA_ADMIN_PASSWORD_HASH;
    const adminSessionSecret = decodeSecret(env.CHIMERA_ADMIN_SESSION_SECRET);
    const invitationPepper = decodeSecret(env.CHIMERA_INVITATION_PEPPER);
    const accountPseudonymKey = decodeSecret(env.CHIMERA_ACCOUNT_PSEUDONYM_KEY);
    const updatePublicKey = decodeSecret(env.CHIMERA_UPDATE_PUBLIC_KEY, 32, 32);

    if (!adminPasswordHash || !isValidArgon2idPhc(adminPasswordHash)
        || !adminSessionSecret || !invitationPepper || !accountPseudonymKey || !updatePublicKey) {
        throw new Error("Invalid Chimera server configuration");
    }

    return Object.freeze({
        relayOrigin: RELAY_ORIGIN,
        adminPasswordHash,
        get adminSessionSecret() {
            return new Uint8Array(adminSessionSecret);
        },
        get invitationPepper() {
            return new Uint8Array(invitationPepper);
        },
        get accountPseudonymKey() {
            return new Uint8Array(accountPseudonymKey);
        },
        get updatePublicKey() {
            return new Uint8Array(updatePublicKey);
        },
    });
}

function isValidArgon2idPhc(value: string): boolean {
    const parts = value.split("$");
    if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "argon2id"
        || parts[2] !== "v=19" || parts[3] !== "m=65536,t=3,p=1") {
        return false;
    }

    return isCanonicalStandardBase64(parts[4], 8) && isCanonicalStandardBase64(parts[5], 16);
}

function isCanonicalStandardBase64(value: string, minimumLength: number): boolean {
    if (!BASE64_STANDARD.test(value)) {
        return false;
    }

    const decoded = Buffer.from(value, "base64");
    return decoded.length >= minimumLength && decoded.toString("base64").replace(/=+$/, "") === value;
}

function decodeSecret(value: string | undefined, minLength = 32, maxLength = Number.POSITIVE_INFINITY): Uint8Array | undefined {
    if (!value || !BASE64URL.test(value)) {
        return undefined;
    }

    const decoded = Buffer.from(value, "base64url");
    if (decoded.length < minLength || decoded.length > maxLength || decoded.toString("base64url") !== value) {
        return undefined;
    }

    return new Uint8Array(decoded);
}
