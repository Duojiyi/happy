import { z } from 'zod';
import { RELAY_ORIGIN } from './product.generated';

const controlCharacter = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function plainText(maximumLength: number) {
    return z.string().max(maximumLength).refine((value) => !controlCharacter.test(value), {
        message: 'Must not contain control characters',
    });
}

function requiredPlainText(maximumLength: number) {
    return plainText(maximumLength).refine((value) => value.trim().length > 0, {
        message: 'Must not be empty',
    });
}

export const ChimeraConfigSchema = z.object({
    announcement: z.object({
        enabled: z.boolean(),
        title: requiredPlainText(120),
        body: plainText(4000),
        primaryButtonLabel: requiredPlainText(40),
        linkButtonLabel: requiredPlainText(40).nullable(),
        linkUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', {
            message: 'Must use HTTPS',
        }).nullable(),
    }).strict().superRefine((announcement, context) => {
        if ((announcement.linkButtonLabel === null) !== (announcement.linkUrl === null)) {
            context.addIssue({ code: 'custom', message: 'Link label and URL must be supplied together' });
        }
    }),
    androidUpdateManifestPath: z.literal('/downloads/chimera-update.json'),
}).strict();

export type ChimeraConfig = z.infer<typeof ChimeraConfigSchema>;

export async function fetchChimeraConfig(externalSignal?: AbortSignal): Promise<ChimeraConfig | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const abortFromExternalSignal = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    if (externalSignal?.aborted) {
        controller.abort();
    }

    try {
        const response = await fetch(`${RELAY_ORIGIN}/v1/chimera/config`, { signal: controller.signal });
        if (!response.ok) {
            return null;
        }

        return ChimeraConfigSchema.safeParse(await response.json()).data ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    }
}
