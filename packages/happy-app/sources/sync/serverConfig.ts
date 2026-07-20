import { MMKV } from 'react-native-mmkv';
import { RELAY_ORIGIN } from '@/chimera/product.generated';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
const DEFAULT_SERVER_URL = RELAY_ORIGIN;

function isDevelopment(): boolean {
    return __DEV__;
}

export function isServerConfigurationAvailable(): boolean {
    return isDevelopment();
}

function isLoopbackServerUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            !parsed.username &&
            !parsed.password &&
            (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
    } catch {
        return false;
    }
}

export function getServerUrl(): string {
    if (!isDevelopment()) {
        return DEFAULT_SERVER_URL;
    }

    const customServerUrl = serverConfigStorage.getString(SERVER_KEY);
    return customServerUrl && isLoopbackServerUrl(customServerUrl)
        ? customServerUrl
        : DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (!isDevelopment()) {
        throw new Error('Custom server URLs are only available in development builds');
    }

    if (url === null) {
        serverConfigStorage.delete(SERVER_KEY);
        return;
    }

    const trimmedUrl = url?.trim();
    if (!trimmedUrl || !isLoopbackServerUrl(trimmedUrl)) {
        throw new Error('Development server URL must be a loopback HTTP or HTTPS URL without credentials');
    }

    serverConfigStorage.set(SERVER_KEY, trimmedUrl);
}

export function getLogServerUrl(): string | null {
    if (!isDevelopment()) {
        return null;
    }

    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (!isDevelopment()) {
        throw new Error('Remote log URLs are only available in development builds');
    }

    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
