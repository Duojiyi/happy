import { z } from 'zod';

const controlCharacter = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function plainText(maximumLength: number) {
    return z.string().max(maximumLength).refine((value) => !controlCharacter.test(value), {
        message: 'Must not contain control characters',
    });
}

export const ChimeraConfigSchema = z.object({
    announcement: z.object({
        enabled: z.boolean(),
        title: plainText(120),
        body: plainText(4000),
        primaryButtonLabel: plainText(40),
        linkButtonLabel: plainText(40).nullable(),
        linkUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', {
            message: 'Must use HTTPS',
        }).nullable(),
    }).strict(),
    androidUpdateManifestPath: z.literal('/downloads/chimera-update.json'),
}).strict();

export type ChimeraConfig = z.infer<typeof ChimeraConfigSchema>;

export async function fetchChimeraConfig(): Promise<ChimeraConfig | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
        const response = await fetch('/v1/chimera/config', { signal: controller.signal });
        if (!response.ok) {
            return null;
        }

        return ChimeraConfigSchema.safeParse(await response.json()).data ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
