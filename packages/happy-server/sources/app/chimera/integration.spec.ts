import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.sequential("Chimera standalone integration", () => {
    let root: string;
    let app: any;
    let db: any;
    let pg: any;
    let socketClient: any;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "chimera-integration-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = join(root, "pglite");
        process.env.DATA_DIR = join(root, "data");
        process.env.HANDY_MASTER_SECRET = Buffer.alloc(32, 7).toString("base64url");
        process.env.CHIMERA_ADMIN_SESSION_SECRET = Buffer.alloc(32, 1).toString("base64url");
        process.env.CHIMERA_INVITATION_PEPPER = Buffer.alloc(32, 2).toString("base64url");
        process.env.CHIMERA_ACCOUNT_PSEUDONYM_KEY = Buffer.alloc(32, 3).toString("base64url");
        process.env.CHIMERA_UPDATE_PUBLIC_KEY = Buffer.alloc(32, 4).toString("base64url");
        const argon2 = (await import("argon2")).default;
        process.env.CHIMERA_ADMIN_PASSWORD_HASH = await argon2.hash("control-password", { type: argon2.argon2id, version: 19, memoryCost: 65536, timeCost: 3, parallelism: 1 });

        const { runMigrations } = await import("../../standalone");
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: resolve(process.cwd(), "prisma/migrations") });
        const storage = await import("@/storage/db");
        db = storage.db; pg = storage.getPGlite(); await db.$connect();
        const { auth } = await import("@/app/auth/auth"); await auth.init();
        const { buildApi } = await import("@/app/api/api");
        app = await buildApi();
        await app.listen({ port: 0, host: "127.0.0.1" });
        const { startSocket } = await import("@/app/api/socket"); startSocket(app);
    }, 30_000);

    afterAll(async () => {
        socketClient?.close();
        const { stopSocket } = await import("@/app/api/socket"); await stopSocket();
        await app?.close();
        await db?.$disconnect();
        await pg?.close();
        await rm(root, { recursive: true, force: true });
    }, 30_000);

    it("runs invitation admission, configuration, revocation, quota, and removed-route checks", async () => {
        const login = await app.inject({ method: "POST", url: "/chimera-control/api/session", payload: { password: "control-password" } });
        expect(login.statusCode).toBe(200);
        const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
        const csrf = login.json().csrfToken;
        const mutationHeaders = { cookie, origin: "https://39.98.68.173", "x-chimera-csrf": csrf };

        const invitation = await app.inject({ method: "POST", url: "/chimera-control/api/invitations", headers: mutationHeaders, payload: {} });
        expect(invitation.statusCode).toBe(200);

        const nacl = (await import("tweetnacl")).default;
        const pair = nacl.sign.keyPair();
        const publicKey = Buffer.from(pair.publicKey).toString("base64");
        const authenticate = async (code?: string) => {
            const challengeResponse = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { publicKey } });
            expect(challengeResponse.statusCode).toBe(200);
            const challenge = challengeResponse.json();
            const { createAuthPayload } = await import("./authChallenge");
            const signature = Buffer.from(nacl.sign.detached(createAuthPayload({ ...challenge, purpose: "chimera-account-auth" }), pair.secretKey)).toString("base64");
            const completed = await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: challenge.challengeId, signature, ...(code ? { invitation: code } : {}) } });
            return { challenge, signature, completed };
        };

        const registered = await authenticate(invitation.json().code);
        expect(registered.completed.statusCode).toBe(200);
        const token = registered.completed.json().token;
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { challengeId: registered.challenge.challengeId, signature: registered.signature, invitation: invitation.json().code } })).statusCode).toBe(401);
        expect((await authenticate()).completed.statusCode).toBe(200);

        const announcement = { announcement: { enabled: true, title: "维护通知", body: "今晚进行例行维护。", primaryButtonLabel: "知道了", linkButtonLabel: null, linkUrl: null }, androidUpdateManifestPath: "/downloads/chimera-update.json" };
        expect((await app.inject({ method: "PUT", url: "/chimera-control/api/config", headers: mutationHeaders, payload: announcement })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/v1/chimera/config" })).json()).toEqual(announcement);
        expect((await app.inject({ method: "GET", url: "/v1/account/profile", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

        const accounts = await app.inject({ method: "GET", url: "/chimera-control/api/accounts", headers: { cookie } });
        const account = accounts.json()[0];
        const address = app.server.address();
        socketClient = (await import("socket.io-client")).io(`http://127.0.0.1:${address.port}`, { path: "/v1/updates", transports: ["websocket"], auth: { token, clientType: "user-scoped" }, extraHeaders: { Origin: "https://39.98.68.173" } });
        await new Promise<void>((resolveConnect, reject) => { socketClient.once("connect", resolveConnect); socketClient.once("connect_error", reject); setTimeout(() => reject(new Error("socket connect timeout")), 5_000); });
        const disconnected = new Promise<void>((resolveDisconnect) => socketClient.once("disconnect", () => resolveDisconnect()));
        expect((await app.inject({ method: "POST", url: `/chimera-control/api/accounts/${account.id}/disable`, headers: mutationHeaders, payload: {} })).statusCode).toBe(200);
        await disconnected;
        expect((await app.inject({ method: "GET", url: "/v1/account/profile", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url: `/chimera-control/api/accounts/${account.id}/restore`, headers: mutationHeaders, payload: {} })).statusCode).toBe(200);

        const internal = await db.account.findFirst();
        const session = await db.session.create({ data: { accountId: internal.id, tag: "quota-test", metadata: "{}" } });
        await db.account.update({ where: { id: internal.id }, data: { attachmentQuotaBytes: 104857600n, attachmentUsedBytes: 104857600n } });
        expect((await app.inject({ method: "POST", url: `/v1/sessions/${session.id}/attachments/request-upload`, headers: { authorization: `Bearer ${token}` }, payload: { filename: "a.enc", size: 1 } })).statusCode).toBe(507);
        const attachmentDirectory = join(process.env.DATA_DIR!, "files", "sessions", session.id, "attachments");
        await mkdir(attachmentDirectory, { recursive: true });
        await writeFile(join(attachmentDirectory, "existing.enc"), Buffer.from("ciphertext"));
        expect((await app.inject({ method: "GET", url: `/v1/sessions/${session.id}/attachments/existing.enc`, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

        expect((await app.inject({ method: "GET", url: "/v1/voice/usage", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
        expect((await app.inject({ method: "GET", url: "/v1/push-tokens", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
        expect((await app.inject({ method: "POST", url: "/v1/auth", payload: { publicKey, challenge: "client-chosen", signature: "invalid" } })).statusCode).toBe(400);
        socketClient.close();
    }, 30_000);
});
