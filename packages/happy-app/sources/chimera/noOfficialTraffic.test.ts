import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
