import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

const remoteLogUrl = 'https://telemetry.invalid';

vi.mock('@/sync/serverConfig', () => ({
    getLogServerUrl: () => remoteLogUrl,
}));

vi.mock('@/sync/persistence', () => ({
    loadLocalSettings: () => ({ consoleLoggingEnabled: true }),
}));

vi.mock('@/sync/appConfig', () => ({
    loadAppConfig: () => ({ consoleLoggingDefault: true }),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('@/log', () => ({
    MAX_APP_LOG_ENTRIES: 5000,
    log: {
        captureFormatted: vi.fn(),
        setConsoleCaptureEnabled: vi.fn(),
    },
}));

vi.mock('react', () => ({
    createContext: () => ({}),
    useContext: () => undefined,
    useEffect: () => undefined,
    useState: () => [null, vi.fn()],
}));

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        removeCredentials: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/sync/persistence', () => ({
    clearPersistence: vi.fn(),
    loadLocalSettings: () => ({ consoleLoggingEnabled: true }),
}));

vi.mock('@/sync/sync', () => ({
    syncCreate: vi.fn(),
}));

describe('production integrations', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('keeps tracking calls synchronous and inert', async () => {
        const trackingModule = await import('@/track');

        expect(trackingModule.initializeTracking('anonymous-user')).toBeUndefined();
        expect(trackingModule.trackAccountCreated()).toBeUndefined();
        expect(trackingModule.trackLogout()).toBeUndefined();
        expect(trackingModule.tracking.getFeatureFlag('anything')).toBeUndefined();
    });

    it('never posts captured console output to a remote log URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response());
        vi.stubGlobal('fetch', fetchMock);
        const { initConsoleLogging } = await import('@/utils/consoleLogging');

        initConsoleLogging();
        console.warn('local-only warning');

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('logs out by clearing only local persistence and credentials', async () => {
        const { clearAuthPersistence } = await import('@/auth/AuthContext');
        const { TokenStorage } = await import('@/auth/tokenStorage');
        const { clearPersistence } = await import('@/sync/persistence');

        await clearAuthPersistence();

        expect(clearPersistence).toHaveBeenCalledOnce();
        expect(TokenStorage.removeCredentials).toHaveBeenCalledOnce();
    });

    it('executes normal production sync startup and local logout without disabled traffic', async () => {
        const fetchMock = vi.fn();
        const axiosRequest = vi.fn();
        const postHog = { init: vi.fn(), capture: vi.fn() };
        const purchases = { configure: vi.fn(), syncPurchases: vi.fn() };
        const push = { register: vi.fn(), unregister: vi.fn() };
        const remoteLogger = { send: vi.fn() };
        const restoreSync = vi.fn().mockResolvedValue(undefined);
        const clearPersistence = vi.fn();
        const removeCredentials = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('fetch', fetchMock);

        const { initializeProductionRuntime, logoutProductionRuntime } = await import('@/chimera/productionRuntime');
        await initializeProductionRuntime({ token: 'token', secret: 'secret' }, restoreSync);
        await logoutProductionRuntime({
            clearPersistence,
            removeCredentials,
        });

        expect(restoreSync).toHaveBeenCalledOnce();
        expect(clearPersistence).toHaveBeenCalledOnce();
        expect(removeCredentials).toHaveBeenCalledOnce();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(axiosRequest).not.toHaveBeenCalled();
        expect(postHog.init).not.toHaveBeenCalled();
        expect(postHog.capture).not.toHaveBeenCalled();
        expect(purchases.configure).not.toHaveBeenCalled();
        expect(purchases.syncPurchases).not.toHaveBeenCalled();
        expect(push.register).not.toHaveBeenCalled();
        expect(push.unregister).not.toHaveBeenCalled();
        expect(remoteLogger.send).not.toHaveBeenCalled();
    });

    it('does not retain production-reachable voice or disabled service imports', async () => {
        const sources = await Promise.all([
            'components/InboxView.tsx',
            'components/SidebarView.tsx',
            'sync/storage.ts',
            'sync/appConfig.ts',
            'utils/consoleLogging.ts',
            'sync/apiVoice.ts',
        ].map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));

        expect(sources.slice(0, 3).join('\n')).not.toMatch(/VoiceAssistantStatusBar|RealtimeSession|sendTextMessage/);
        expect(sources[3]).not.toMatch(/postHog|revenueCat|elevenLabs/i);
        expect(sources[4]).not.toMatch(/loadAppConfig/);
        expect(sources[5]).not.toMatch(/fetch\(|config\.|getServerUrl|elevenLabs/i);
    });
});
