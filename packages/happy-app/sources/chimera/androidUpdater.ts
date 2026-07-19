import { verifyUpdateManifest, type UpdateManifestPayload } from './updateManifest';

export type AndroidUpdatePayload = UpdateManifestPayload;

export type AndroidUpdateState =
    | { phase: 'idle' }
    | { phase: 'downloading'; versionCode: number }
    | { phase: 'waiting-for-announcement'; fileUri: string }
    | { phase: 'waiting-for-permission'; fileUri: string }
    | { phase: 'launching-installer'; fileUri: string }
    | { phase: 'failed'; retryOnNextStart: true };

export type InspectedApk = {
    packageName: string;
    versionName: string;
    versionCode: number;
    signerSha256: string;
};

export type AndroidUpdaterDependencies = {
    platform: 'android' | 'web' | string;
    origin: string;
    manifestPath: '/downloads/chimera-update.json';
    currentVersionCode: number;
    fetchManifest: (url: string, signal: AbortSignal) => Promise<unknown>;
    verifyManifest?: typeof verifyUpdateManifest;
    download: (url: string, partialUri: string, signal: AbortSignal) => Promise<{ bytes: number; sha256: string }>;
    move: (fromUri: string, toUri: string) => Promise<void>;
    remove: (uri: string) => Promise<void>;
    inspectApk: (uri: string) => Promise<InspectedApk>;
    canRequestPackageInstalls: () => Promise<boolean>;
    openInstallPermissionSettings: () => Promise<void>;
    launchInstaller: (uri: string) => Promise<void>;
    logger?: (message: string, error?: unknown) => void;
};

export type AndroidUpdaterOptions = {
    downloadTimeoutMs?: number;
    cacheDirectory?: string;
    now?: string | Date;
};

export type StartOptions = { announcementDismissed: boolean };

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

function isNewerVersion(payload: AndroidUpdatePayload, currentVersionCode: number): boolean {
    return payload.versionCode > currentVersionCode;
}

function sameIdentity(archive: InspectedApk, payload: AndroidUpdatePayload): boolean {
    return archive.packageName === payload.packageName
        && archive.versionName === payload.versionName
        && archive.versionCode === payload.versionCode
        && archive.signerSha256 === payload.signerSha256;
}

function asErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createAndroidUpdater(
    dependencies: AndroidUpdaterDependencies,
    options: AndroidUpdaterOptions = {},
) {
    let state: AndroidUpdateState = { phase: 'idle' };
    let activeRun: Promise<void> | null = null;
    let cachedFileUri: string | null = null;
    let permissionPrompted = false;
    let runNumber = 0;
    let latestAnnouncementDismissed = false;

    const logFailure = (error: unknown) => {
        dependencies.logger?.(`[chimera-updater] update failed: ${asErrorMessage(error)}`, error);
    };

    const removeQuietly = async (uri: string | null) => {
        if (!uri) return;
        try {
            await dependencies.remove(uri);
        } catch (error) {
            dependencies.logger?.(`[chimera-updater] cleanup failed: ${asErrorMessage(error)}`, error);
        }
    };

    const nextCacheUri = (versionCode: number, partial: boolean) => {
        const root = options.cacheDirectory ?? 'file:///chimera-updates/';
        const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
        const suffix = partial ? '.partial' : '.apk';
        return `${normalizedRoot}chimera-${versionCode}-${runNumber}${suffix}`;
    };

    const continueDownloaded = async (announcementDismissed: boolean): Promise<void> => {
        if (!cachedFileUri) {
            state = { phase: 'failed', retryOnNextStart: true };
            return;
        }
        if (!announcementDismissed) {
            state = { phase: 'waiting-for-announcement', fileUri: cachedFileUri };
            return;
        }
        if (!(await dependencies.canRequestPackageInstalls())) {
            state = { phase: 'waiting-for-permission', fileUri: cachedFileUri };
            if (!permissionPrompted) {
                permissionPrompted = true;
                await dependencies.openInstallPermissionSettings();
            }
            return;
        }
        const fileUri = cachedFileUri;
        state = { phase: 'launching-installer', fileUri };
        await dependencies.launchInstaller(fileUri);
    };

    const run = async (): Promise<void> => {
        if (dependencies.platform !== 'android') {
            state = { phase: 'idle' };
            return;
        }

        if (state.phase === 'waiting-for-announcement' || state.phase === 'waiting-for-permission') {
            await continueDownloaded(latestAnnouncementDismissed);
            return;
        }
        if (state.phase === 'launching-installer') return;

        runNumber += 1;
        cachedFileUri = null;
        permissionPrompted = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
        let partialUri: string | null = null;
        let finalUri: string | null = null;

        try {
            const manifestUrl = `${dependencies.origin}${dependencies.manifestPath}`;
            const envelope = await dependencies.fetchManifest(manifestUrl, controller.signal);
            const verify = dependencies.verifyManifest ?? verifyUpdateManifest;
            const payload = await verify(envelope, {
                origin: dependencies.origin,
                now: options.now,
            });
            if (!isNewerVersion(payload, dependencies.currentVersionCode)) {
                state = { phase: 'idle' };
                return;
            }

            state = { phase: 'downloading', versionCode: payload.versionCode };
            partialUri = nextCacheUri(payload.versionCode, true);
            finalUri = nextCacheUri(payload.versionCode, false);
            const downloadResult = await dependencies.download(
                `${dependencies.origin}${payload.apkPath}`,
                partialUri,
                controller.signal,
            );
            if (downloadResult.bytes !== payload.size || downloadResult.sha256.toLowerCase() !== payload.sha256) {
                throw new Error('download size or sha256 mismatch');
            }
            await dependencies.move(partialUri, finalUri);
            partialUri = null;
            const archive = await dependencies.inspectApk(finalUri);
            if (!sameIdentity(archive, payload)) {
                throw new Error('downloaded APK identity mismatch');
            }
            cachedFileUri = finalUri;
            await continueDownloaded(latestAnnouncementDismissed);
        } catch (error) {
            logFailure(error);
            state = { phase: 'failed', retryOnNextStart: true };
            await removeQuietly(partialUri);
            await removeQuietly(finalUri);
            cachedFileUri = null;
        } finally {
            clearTimeout(timeout);
        }
    };

    return {
        getState: () => state,
        start(startOptions: StartOptions): Promise<void> {
            latestAnnouncementDismissed = startOptions.announcementDismissed;
            if (activeRun) return activeRun;
            activeRun = run().finally(() => {
                activeRun = null;
            });
            return activeRun;
        },
    };
}
