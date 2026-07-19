import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChimeraConfigSchema, fetchChimeraConfig } from './config';
import { RELAY_ORIGIN } from './product.generated';
import { SERVER_DISABLED_DEFAULT_CONFIG, SERVER_ENABLED_CONFIG } from './config.fixtures';

const validConfig = {
    announcement: {
        enabled: true,
        title: 'Service notice',
        body: 'Plain text\nwith a line break.',
        primaryButtonLabel: 'Got it',
        linkButtonLabel: 'Learn more',
        linkUrl: 'https://chimera.example/notices',
    },
    androidUpdateManifestPath: '/downloads/chimera-update.json',
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ChimeraConfigSchema', () => {
    test('parses the server disabled default and enabled response fixtures', () => {
        expect(ChimeraConfigSchema.parse(SERVER_DISABLED_DEFAULT_CONFIG)).toEqual(SERVER_DISABLED_DEFAULT_CONFIG);
        expect(ChimeraConfigSchema.parse(SERVER_ENABLED_CONFIG)).toEqual(SERVER_ENABLED_CONFIG);
    });

    test('accepts an enabled announcement with the fixed update manifest path', () => {
        expect(ChimeraConfigSchema.parse(validConfig)).toEqual(validConfig);
    });

    test('accepts a disabled announcement with nullable link fields', () => {
        expect(ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: {
                ...validConfig.announcement,
                enabled: false,
                linkButtonLabel: null,
                linkUrl: null,
            },
        })).toMatchObject({ announcement: { enabled: false } });
    });

    test('requires non-empty trimmed primary text and a complete optional HTTPS link pair', () => {
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, title: '   ' },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, primaryButtonLabel: '\t' },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, linkButtonLabel: ' ' },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, linkButtonLabel: null },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, linkUrl: null },
        })).toThrow();
    });

    test('rejects oversized announcement fields, control characters, non-HTTPS links, unknown fields, and mutable manifest paths', () => {
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, title: 'x'.repeat(121) },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, body: 'x'.repeat(4001) },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, primaryButtonLabel: 'x'.repeat(41) },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, linkButtonLabel: 'x'.repeat(41) },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, body: 'not\u0000safe' },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({
            ...validConfig,
            announcement: { ...validConfig.announcement, linkUrl: 'http://chimera.example' },
        })).toThrow();
        expect(() => ChimeraConfigSchema.parse({ ...validConfig, extra: true })).toThrow();
        expect(() => ChimeraConfigSchema.parse({ ...validConfig, androidUpdateManifestPath: '/downloads/other.json' })).toThrow();
    });
});

describe('fetchChimeraConfig', () => {
    test('fetches only the fixed absolute relay endpoint', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validConfig), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchChimeraConfig()).resolves.toEqual(validConfig);
        expect(fetchMock).toHaveBeenCalledWith(`${RELAY_ORIGIN}/v1/chimera/config`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    test('returns null for unsuccessful responses, invalid JSON, and invalid schemas', async () => {
        vi.stubGlobal('fetch', vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(new Response('', { status: 500 }))
            .mockResolvedValueOnce(new Response('{', { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...validConfig, extra: true }), { status: 200 })));

        await expect(fetchChimeraConfig()).resolves.toBeNull();
        await expect(fetchChimeraConfig()).resolves.toBeNull();
        await expect(fetchChimeraConfig()).resolves.toBeNull();
        await expect(fetchChimeraConfig()).resolves.toBeNull();
    });

    test('aborts requests after 1500 milliseconds and settles silently', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        vi.stubGlobal('fetch', fetchMock);

        const result = fetchChimeraConfig();
        await vi.advanceTimersByTimeAsync(1500);
        await expect(result).resolves.toBeNull();
        vi.useRealTimers();
    });
});
