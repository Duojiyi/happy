import type { AuthCredentials } from '@/auth/tokenStorage';

export type RestoreSync = (credentials: AuthCredentials) => Promise<void>;

export type LocalLogout = {
    clearPersistence: () => void;
    removeCredentials: () => Promise<unknown>;
};

export async function initializeProductionRuntime(
    credentials: AuthCredentials,
    restoreSync: RestoreSync,
): Promise<void> {
    await restoreSync(credentials);
}

export async function logoutProductionRuntime({
    clearPersistence,
    removeCredentials,
}: LocalLogout): Promise<void> {
    clearPersistence();
    await removeCredentials();
}
