import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const storage = vi.hoisted(() => ({
    getString: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
}));

vi.mock('react-native-mmkv', () => ({
    MMKV: vi.fn(() => storage),
}));

const originalHappyConfigDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__HAPPY_CONFIG__');
const originalServerUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;

async function loadServerConfig(dev: boolean) {
    vi.stubGlobal('__DEV__', dev);
    vi.resetModules();
    return import('./serverConfig');
}

describe('serverConfig', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        storage.getString.mockReset();
        storage.set.mockReset();
        storage.delete.mockReset();
        (globalThis as { __HAPPY_CONFIG__?: unknown }).__HAPPY_CONFIG__ = {
            serverUrl: 'https://runtime-attacker.invalid',
        };
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://environment-attacker.invalid';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        storage.getString.mockClear();
        storage.set.mockClear();
        storage.delete.mockClear();
        if (originalHappyConfigDescriptor) {
            Object.defineProperty(globalThis, '__HAPPY_CONFIG__', originalHappyConfigDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, '__HAPPY_CONFIG__');
        }
        if (originalServerUrl === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        } else {
            process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = originalServerUrl;
        }
    });

    test('returns the generated relay without reading hostile production overrides', async () => {
        const { getServerUrl } = await loadServerConfig(false);

        expect(getServerUrl()).toBe('https://103.250.173.136');
        expect(storage.getString).not.toHaveBeenCalled();
    });

    test('rejects production server changes without writing storage', async () => {
        const { setServerUrl } = await loadServerConfig(false);

        expect(() => setServerUrl('http://localhost:3000')).toThrow();
        expect(storage.set).not.toHaveBeenCalled();
        expect(storage.delete).not.toHaveBeenCalled();
    });

    test('only makes server configuration available in development', async () => {
        const productionConfig = await loadServerConfig(false);
        expect(productionConfig.isServerConfigurationAvailable()).toBe(false);

        const developmentConfig = await loadServerConfig(true);
        expect(developmentConfig.isServerConfigurationAvailable()).toBe(true);
    });

    test('allows a development localhost override', async () => {
        const { getServerUrl, setServerUrl } = await loadServerConfig(true);
        storage.getString.mockReturnValue('http://localhost:3000');

        setServerUrl('http://localhost:3000');

        expect(storage.set).toHaveBeenCalledWith('custom-server-url', 'http://localhost:3000');
        expect(getServerUrl()).toBe('http://localhost:3000');
    });

    test('allows clearing a development override', async () => {
        const { setServerUrl } = await loadServerConfig(true);

        setServerUrl(null);

        expect(storage.delete).toHaveBeenCalledWith('custom-server-url');
    });

    test.each([
        'https://example.com',
        'https://user:password@localhost:3000',
        'not a url',
    ])('rejects unsafe development override %s', async (url) => {
        const { setServerUrl } = await loadServerConfig(true);

        expect(() => setServerUrl(url)).toThrow();
        expect(storage.set).not.toHaveBeenCalled();
        expect(storage.delete).not.toHaveBeenCalled();
    });
});
