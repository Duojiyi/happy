import { z } from "zod";
import { db } from "@/storage/db";

export const CHIMERA_CONFIG_KEY = "startup-announcement";
export const CHIMERA_UPDATE_MANIFEST_PATH = "/downloads/chimera-update.json" as const;
export const CHIMERA_CONTROL_ORIGIN = "https://103.250.173.136";

const controlCharacter = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const plainText = (maximumLength: number) => z.string().max(maximumLength).refine((value) => !controlCharacter.test(value), "Must not contain control characters");

export const PublicConfigSchema = z.object({
    announcement: z.object({
        enabled: z.boolean(),
        title: plainText(120),
        body: plainText(4000),
        primaryButtonLabel: plainText(40),
        linkButtonLabel: plainText(40).nullable(),
        linkUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "Must use HTTPS").nullable(),
    }).strict().superRefine((announcement, context) => {
        if (announcement.enabled && (!announcement.title.trim() || !announcement.primaryButtonLabel.trim())) {
            context.addIssue({ code: "custom", message: "Enabled announcements require title and primary button label" });
        }
        if (announcement.linkButtonLabel !== null && !announcement.linkButtonLabel.trim()) {
            context.addIssue({ code: "custom", message: "Link label must not be empty" });
        }
        if ((announcement.linkButtonLabel === null) !== (announcement.linkUrl === null)) {
            context.addIssue({ code: "custom", message: "Link label and URL must be supplied together" });
        }
    }),
    androidUpdateManifestPath: z.literal(CHIMERA_UPDATE_MANIFEST_PATH),
}).strict();

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

const defaultConfig: PublicConfig = {
    announcement: { enabled: false, title: "", body: "", primaryButtonLabel: "", linkButtonLabel: null, linkUrl: null },
    androidUpdateManifestPath: CHIMERA_UPDATE_MANIFEST_PATH,
};

function allowlisted(config: PublicConfig): PublicConfig {
    return {
        announcement: {
            enabled: config.announcement.enabled,
            title: config.announcement.title,
            body: config.announcement.body,
            primaryButtonLabel: config.announcement.primaryButtonLabel,
            linkButtonLabel: config.announcement.linkButtonLabel,
            linkUrl: config.announcement.linkUrl,
        },
        androidUpdateManifestPath: CHIMERA_UPDATE_MANIFEST_PATH,
    };
}

function fromStoredValue(value: unknown): PublicConfig | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (!raw.announcement || typeof raw.announcement !== "object" || Array.isArray(raw.announcement)) return null;
    const announcement = raw.announcement as Record<string, unknown>;
    return PublicConfigSchema.safeParse({
        announcement: {
            enabled: announcement.enabled, title: announcement.title, body: announcement.body,
            primaryButtonLabel: announcement.primaryButtonLabel, linkButtonLabel: announcement.linkButtonLabel, linkUrl: announcement.linkUrl,
        },
        androidUpdateManifestPath: raw.androidUpdateManifestPath,
    }).data ?? null;
}

export function createPublicConfigService(database: Pick<typeof db, "chimeraConfiguration"> = db) {
    return {
        async get(): Promise<PublicConfig> {
            const record = await database.chimeraConfiguration.findUnique({ where: { key: CHIMERA_CONFIG_KEY } });
            const stored = record ? fromStoredValue(record.value) : null;
            return allowlisted(stored ?? defaultConfig);
        },
        async put(value: unknown): Promise<PublicConfig> {
            const config = PublicConfigSchema.parse(value);
            await database.chimeraConfiguration.upsert({
                where: { key: CHIMERA_CONFIG_KEY },
                create: { key: CHIMERA_CONFIG_KEY, value: config },
                update: { value: config },
            });
            return allowlisted(config);
        },
    };
}

type AdminSessions = {
    authenticate(sessionId: string): Promise<unknown>;
    authorizeMutation(sessionId: string, csrf: string): Promise<unknown>;
};

function sessionCookie(request: { headers: Record<string, unknown> }) {
    const header = request.headers.cookie;
    return typeof header === "string"
        ? header.split(/;\s*/).map((part) => part.split("=", 2)).find(([name]) => name === "__Secure-chimera_admin")?.[1] ?? null
        : null;
}

export function registerPublicConfigRoute(app: any, service = createPublicConfigService()) {
    app.get("/v1/chimera/config", async (_request: any, reply: any) => {
        reply.header("cache-control", "no-store");
        return reply.send(await service.get());
    });
}

export function registerAdminPublicConfigRoutes(app: any, service: ReturnType<typeof createPublicConfigService>, sessions: AdminSessions) {
    const unauthorized = (reply: any) => reply.code(401).send({ error: "Unauthorized" });
    app.get("/chimera-control/api/config", async (request: any, reply: any) => {
        const sessionId = sessionCookie(request);
        if (!sessionId || !await sessions.authenticate(sessionId)) return unauthorized(reply);
        return reply.send(await service.get());
    });
    app.put("/chimera-control/api/config", async (request: any, reply: any) => {
        const sessionId = sessionCookie(request);
        const csrf = request.headers["x-chimera-csrf"];
        if (request.headers.origin !== CHIMERA_CONTROL_ORIGIN || !sessionId || typeof csrf !== "string" || !await sessions.authorizeMutation(sessionId, csrf)) return unauthorized(reply);
        const parsed = PublicConfigSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Invalid configuration" });
        return reply.send(await service.put(parsed.data));
    });
}

export function registerPublicConfigRoutes(app: any, service = createPublicConfigService(), sessions?: AdminSessions) {
    registerPublicConfigRoute(app, service);
    if (sessions) registerAdminPublicConfigRoutes(app, service, sessions);
}
