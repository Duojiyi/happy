export interface ChimeraServerConfig {
    readonly relayOrigin: "https://39.98.68.173";
    readonly adminPasswordHash: string;
    readonly adminSessionSecret: Uint8Array;
    readonly invitationPepper: Uint8Array;
    readonly accountPseudonymKey: Uint8Array;
    readonly updatePublicKey: Uint8Array;
}

type Environment = Record<string, string | undefined>;

const RELAY_ORIGIN = "https://39.98.68.173" as const;
const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function loadChimeraServerConfig(env: Environment): ChimeraServerConfig {
    const adminPasswordHash = env.CHIMERA_ADMIN_PASSWORD_HASH;
    const adminSessionSecret = decodeSecret(env.CHIMERA_ADMIN_SESSION_SECRET);
    const invitationPepper = decodeSecret(env.CHIMERA_INVITATION_PEPPER);
    const accountPseudonymKey = decodeSecret(env.CHIMERA_ACCOUNT_PSEUDONYM_KEY);
    const updatePublicKey = decodeSecret(env.CHIMERA_UPDATE_PUBLIC_KEY, 32, 32);

    if (!adminPasswordHash || !ARGON2ID_PHC.test(adminPasswordHash)
        || !adminSessionSecret || !invitationPepper || !accountPseudonymKey || !updatePublicKey) {
        throw new Error("Invalid Chimera server configuration");
    }

    return Object.freeze({
        relayOrigin: RELAY_ORIGIN,
        adminPasswordHash,
        adminSessionSecret,
        invitationPepper,
        accountPseudonymKey,
        updatePublicKey,
    });
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
