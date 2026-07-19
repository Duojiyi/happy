import * as React from 'react';
import { AppState, Platform } from 'react-native';
import {
    cacheDirectory,
    createDownloadResumable,
    deleteAsync,
    getInfoAsync,
    makeDirectoryAsync,
    moveAsync,
    readDirectoryAsync,
} from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';

import { ANDROID_VERSION_CODE, RELAY_ORIGIN } from './product.generated';
import { createAndroidUpdater, createAndroidUpdaterLifecycleCoordinator, type AndroidUpdateState } from './androidUpdater';
import { useStartupAnnouncement, type StartupAnnouncementState } from './useStartupAnnouncement';

export function useAndroidUpdater(announcement: StartupAnnouncementState): AndroidUpdateState {
    const lifecycleRef = React.useRef(createAndroidUpdaterLifecycleCoordinator<ReturnType<typeof createAndroidUpdater>>());
    const announcementRef = React.useRef(announcement);
    announcementRef.current = announcement;
    const mountedRef = React.useRef(false);
    const [state, setState] = React.useState<AndroidUpdateState>({ phase: 'idle' });

    React.useEffect(() => {
        if (Platform.OS !== 'android') {
            return;
        }
        mountedRef.current = true;
        let cancelled = false;
        const start = async () => {
            try {
                const updater = await lifecycleRef.current.mount(async () => {
                    const { default: native } = await import('../../modules/chimera-updater');
                    if (!cacheDirectory) throw new Error('Android cache directory is unavailable');
                    return createAndroidUpdater({
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
                                void resumable.pauseAsync().catch(() => {}).finally(() => {
                                    rejectAbort(new DOMException('The operation was aborted.', 'AbortError'));
                                });
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
                            return { bytes: info.size };
                        },
                        hashFile: (uri) => native.hashFile(uri),
                        move: (fromUri, toUri) => moveAsync({ from: fromUri, to: toUri }),
                        remove: (uri) => deleteAsync(uri, { idempotent: true }),
                        listCacheFiles: async () => {
                            const directory = `${cacheDirectory}chimera-updates`;
                            await makeDirectoryAsync(directory, { intermediates: true });
                            return (await readDirectoryAsync(directory)).map((name) => `${directory}/${name}`);
                        },
                        createRunId: () => randomUUID(),
                        inspectApk: (uri) => native.inspectApk(uri),
                        canRequestPackageInstalls: () => native.canRequestPackageInstalls(),
                        openInstallPermissionSettings: () => native.openInstallPermissionSettings(),
                        launchInstaller: (uri) => native.launchInstaller(uri),
                        logger: (message, error) => console.warn(message, error),
                    }, { cacheDirectory: `${cacheDirectory}chimera-updates` });
                });
                if (cancelled) return;
                const currentAnnouncement = announcementRef.current;
                await updater.start({
                    announcementDismissed: currentAnnouncement.settled && currentAnnouncement.dismissed,
                });
                if (!cancelled && mountedRef.current) setState(updater.getState());
            } catch (error) {
                if (!cancelled) {
                    console.warn('[chimera-updater] unavailable', error);
                    setState({ phase: 'failed', retryOnNextStart: true });
                }
            }
        };
        void start();
        return () => {
            cancelled = true;
            mountedRef.current = false;
            void lifecycleRef.current.unmount().catch((error) => {
                console.warn('[chimera-updater] cancellation failed', error);
            });
        };
    }, []);

    React.useEffect(() => {
        const updater = lifecycleRef.current.getCurrent();
        if (Platform.OS !== 'android' || !updater) return;
        void updater.start({
            announcementDismissed: announcement.settled && announcement.dismissed,
        }).then(() => {
            if (mountedRef.current) setState(updater.getState());
        }).catch((error) => {
            if (mountedRef.current) console.warn('[chimera-updater] state transition failed', error);
        });
    }, [announcement.dismissed, announcement.settled]);

    React.useEffect(() => {
        if (Platform.OS !== 'android') return;
        const subscription = AppState.addEventListener('change', (nextState) => {
            const updater = lifecycleRef.current.getCurrent();
            if (nextState !== 'active' || !updater) return;
            const currentAnnouncement = announcementRef.current;
            void updater.start({
                announcementDismissed: currentAnnouncement.settled && currentAnnouncement.dismissed,
            }).then(() => {
                if (mountedRef.current) setState(updater.getState());
            }).catch((error) => {
                if (mountedRef.current) console.warn('[chimera-updater] foreground retry failed', error);
            });
        });
        return () => subscription.remove();
    }, []);

    return state;
}

export function useAndroidUpdaterWithAnnouncement(): AndroidUpdateState {
    return useAndroidUpdater(useStartupAnnouncement());
}
