import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createPublicConfigService, PublicConfigSchema, registerPublicConfigRoutes } from "./publicConfig";

const enabled = {
    announcement: { enabled: true, title: "Maintenance", body: "A brief announcement", primaryButtonLabel: "Continue", linkButtonLabel: "Learn more", linkUrl: "https://example.test/info" },
    androidUpdateManifestPath: "/downloads/chimera-update.json",
};

function store(initial: unknown = null) {
    let value = initial;
    return {
        chimeraConfiguration: {
            findUnique: async () => value === null ? null : { value },
            upsert: async ({ create, update }: any) => {
                value = update.value ?? create.value;
                return { value };
            },
        },
        value: () => value,
    };
}

describe("Chimera public configuration", () => {
    it("uses a disabled, safe default and creates a fresh allowlisted public response", async () => {
        const database = store({ ...enabled, secret: "never public", accounts: [{ id: "a" }] });
        const service = createPublicConfigService(database as any);

        expect(await createPublicConfigService(store() as any).get()).toEqual({
            announcement: { enabled: false, title: "", body: "", primaryButtonLabel: "", linkButtonLabel: null, linkUrl: null },
            androidUpdateManifestPath: "/downloads/chimera-update.json",
        });
        expect(await service.get()).toEqual(enabled);
        expect(await service.get()).not.toBe(database.value());
    });

    it("rejects unknown fields, controls, invalid enabled text, unpaired links, and non-HTTPS URLs", () => {
        for (const value of [
            { ...enabled, extra: true },
            { ...enabled, announcement: { ...enabled.announcement, title: "\u0000" } },
            { ...enabled, announcement: { ...enabled.announcement, body: "\u0001" } },
            { ...enabled, announcement: { ...enabled.announcement, primaryButtonLabel: "  " } },
            { ...enabled, announcement: { ...enabled.announcement, linkButtonLabel: null } },
            { ...enabled, announcement: { ...enabled.announcement, linkUrl: "http://example.test" } },
        ]) expect(PublicConfigSchema.safeParse(value).success).toBe(false);
    });

    it("allows empty announcement strings only when disabled", () => {
        expect(PublicConfigSchema.safeParse({
            announcement: { enabled: false, title: "", body: "", primaryButtonLabel: "", linkButtonLabel: null, linkUrl: null },
            androidUpdateManifestPath: "/downloads/chimera-update.json",
        }).success).toBe(true);
    });

    it("serves public config unauthenticated with no-store and restricts control updates to session, origin, and CSRF", async () => {
        const server = fastify();
        const database = store();
        registerPublicConfigRoutes(server as any, createPublicConfigService(database as any), {
            authenticate: async (id) => id === "session",
            authorizeMutation: async (id, csrf) => id === "session" && csrf === "csrf",
        });

        const publicResponse = await server.inject({ method: "GET", url: "/v1/chimera/config" });
        expect(publicResponse.statusCode).toBe(200);
        expect(publicResponse.headers["cache-control"]).toBe("no-store");
        expect(publicResponse.json()).toEqual(await createPublicConfigService(store() as any).get());

        const payload = { ...enabled, announcement: { ...enabled.announcement, linkButtonLabel: null, linkUrl: null } };
        expect((await server.inject({ method: "PUT", url: "/chimera-control/api/config", payload })).statusCode).toBe(401);
        expect((await server.inject({ method: "PUT", url: "/chimera-control/api/config", headers: { cookie: "__Secure-chimera_admin=session", origin: "https://103.250.173.136", "x-chimera-csrf": "csrf" }, payload })).statusCode).toBe(200);
        expect((await server.inject({ method: "GET", url: "/chimera-control/api/config", headers: { cookie: "__Secure-chimera_admin=session" } })).json()).toEqual(payload);
        await server.close();
    });
});
