import * as React from 'react';
import { AppState, Platform } from 'react-native';
import {
    cacheDirectory,
    createDownloadResumable,
    deleteAsync,
    getInfoAsync,
    makeDirectoryAsync,
    moveAsync,
} from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';

import { readFileBytes } from '@/utils/readFileBytes';
import { ANDROID_VERSION_CODE, RELAY_ORIGIN } from './product.generated';
import { createAndroidUpdater, type AndroidUpdateState } from './androidUpdater';
import { useStartupAnnouncement, type StartupAnnouncementState } from './useStartupAnnouncement';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function useAndroidUpdater(announcement: StartupAnnouncementState): AndroidUpdateState {
    const updaterRef = React.useRef<ReturnType<typeof createAndroidUpdater> | null>(null);
    const announcementRef = React.useRef(announcement);
    announcementRef.current = announcement;
    const [state, setState] = React.useState<AndroidUpdateState>({ phase: 'idle' });

    React.useEffect(() => {
        if (Platform.OS !== 'android') {
            return;
        }
        let cancelled = false;
        const start = async () => {
            try {
                const { default: native } = await import('../../modules/chimera-updater');
                if (cancelled) return;
                if (!updaterRef.current) {
                    updaterRef.current = createAndroidUpdater({
                        platform: 'android',
                        origin: RELAY_ORIGIN,
                        manifestPath: '/downloads/chimera-update.json',
                        currentVersionCode: ANDROID_VERSION_CODE,
                        fetchManifest: async (url, signal) => {
                            const response = await fetch(url, { signal });
                            if (!response.ok) throw new Error(`update manifest request failed: ${response.status}`);
                            return response.json();
                        },
                        download: async (url, partialUri, signal) => {
                            if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
                            const directory = partialUri.slice(0, partialUri.lastIndexOf('/'));
                            await makeDirectoryAsync(directory, { intermediates: true });
                            const resumable = createDownloadResumable(url, partialUri);
                            let rejectAbort!: (error: Error) => void;
                            const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
                            const abort = () => {
                                void resumable.pauseAsync().catch(() => {});
                                rejectAbort(new DOMException('The operation was aborted.', 'AbortError'));
                            };
                            signal.addEventListener('abort', abort, { once: true });
                            let result: Awaited<ReturnType<typeof resumable.downloadAsync>>;
                            try {
                                result = await Promise.race([resumable.downloadAsync(), aborted]);
                            } finally {
                                signal.removeEventListener('abort', abort);
                            }
                            if (!result) throw new Error('downloaded APK is missing');
                            const info = await getInfoAsync(result.uri);
                            if (!info.exists || info.size === undefined) throw new Error('downloaded APK is missing');
                            const digest = await sha256Hex(await readFileBytes(result.uri));
                            return { bytes: info.size, sha256: digest };
                        },
                        move: (fromUri, toUri) => moveAsync({ from: fromUri, to: toUri }),
                        remove: (uri) => deleteAsync(uri, { idempotent: true }),
                        inspectApk: (uri) => native.inspectApk(uri),
                        canRequestPackageInstalls: () => native.canRequestPackageInstalls(),
                        openInstallPermissionSettings: () => native.openInstallPermissionSettings(),
                        launchInstaller: (uri) => native.launchInstaller(uri),
                        logger: (message, error) => console.warn(message, error),
                    }, { cacheDirectory: cacheDirectory ? `${cacheDirectory}chimera-updates` : undefined });
                }
                await updaterRef.current.start({
                    announcementDismissed: announcement.settled && announcement.dismissed,
                });
                if (!cancelled) setState(updaterRef.current.getState());
            } catch (error) {
                if (!cancelled) {
                    console.warn('[chimera-updater] unavailable', error);
                    setState({ phase: 'failed', retryOnNextStart: true });
                }
            }
        };
        void start();
        return () => { cancelled = true; };
    }, [announcement.dismissed, announcement.settled]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const subscription = AppState.addEventListener('change', (nextState) => {
            const updater = updaterRef.current;
            if (nextState !== 'active' || !updater) return;
            const currentAnnouncement = announcementRef.current;
            void updater.start({
                announcementDismissed: currentAnnouncement.settled && currentAnnouncement.dismissed,
            }).then(() => setState(updater.getState()));
        });
        return () => subscription.remove();
    }, []);

    return state;
}

export function useAndroidUpdaterWithAnnouncement(): AndroidUpdateState {
    return useAndroidUpdater(useStartupAnnouncement());
}
