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
    download: (url: string, partialUri: string, signal: AbortSignal) => Promise<{ bytes: number }>;
    hashFile: (uri: string) => Promise<string>;
    move: (fromUri: string, toUri: string) => Promise<void>;
    remove: (uri: string) => Promise<void>;
    listCacheFiles: () => Promise<string[]>;
    createRunId?: () => string;
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

export function createAndroidUpdaterLifecycleCoordinator<T extends { cancel: () => Promise<void> }>() {
    let current: T | null = null;
    let creating: Promise<T> | null = null;
    let barrier: Promise<void> = Promise.resolve();
    return {
        getCurrent: () => current,
        async mount(factory: () => Promise<T>): Promise<T> {
            await barrier;
            if (current) return current;
            if (!creating) {
                creating = factory().then((created) => {
                    current = created;
                    return created;
                }).finally(() => { creating = null; });
            }
            return creating;
        },
        unmount(): Promise<void> {
            const target = creating ?? Promise.resolve(current);
            const shutdown = (async () => {
                const updater = await target;
                if (updater) await updater.cancel();
                if (current === updater) current = null;
            })();
            barrier = shutdown.catch(() => {});
            return shutdown;
        },
    };
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
let processRunCounter = 0;

function defaultRunId(): string {
    processRunCounter += 1;
    return `${Date.now().toString(36)}-${processRunCounter.toString(36)}`;
}

async function withPhaseTimeout<T>(
    operation: Promise<T>,
    controller: AbortController,
    timeoutMs: number,
    phase: string,
): Promise<T> {
    if (controller.signal.aborted) throw new Error(`Android update ${phase} cancelled`);
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error(`Android update ${phase} cancelled`));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
    }
}

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
    let latestAnnouncementDismissed = false;
    let activeController: AbortController | null = null;

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

    const nextCacheUri = (versionCode: number, runId: string, partial: boolean) => {
        const root = options.cacheDirectory ?? 'file:///chimera-updates/';
        const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
        const suffix = partial ? '.partial' : '.apk';
        return `${normalizedRoot}chimera-${versionCode}-${runId}${suffix}`;
    };

    const cleanupStaleCache = async (controller: AbortController, timeoutMs: number) => {
        const staleFiles = await withPhaseTimeout(dependencies.listCacheFiles(), controller, timeoutMs, 'stale cache scan');
        for (const uri of staleFiles) {
            const leaf = uri.slice(uri.lastIndexOf('/') + 1);
            if (/^chimera-[1-9][0-9]*-[A-Za-z0-9-]+\.(?:apk|partial)$/.test(leaf)) {
                await withPhaseTimeout(dependencies.remove(uri), controller, timeoutMs, 'stale cache cleanup');
            }
        }
    };

    const continueDownloaded = async (
        announcementDismissed: boolean,
        controller: AbortController,
        timeoutMs: number,
    ): Promise<void> => {
        if (!cachedFileUri) {
            state = { phase: 'failed', retryOnNextStart: true };
            return;
        }
        if (!announcementDismissed) {
            state = { phase: 'waiting-for-announcement', fileUri: cachedFileUri };
            return;
        }
        if (!(await withPhaseTimeout(dependencies.canRequestPackageInstalls(), controller, timeoutMs, 'permission check'))) {
            state = { phase: 'waiting-for-permission', fileUri: cachedFileUri };
            if (!permissionPrompted) {
                permissionPrompted = true;
                await withPhaseTimeout(dependencies.openInstallPermissionSettings(), controller, timeoutMs, 'permission settings');
            }
            return;
        }
        const fileUri = cachedFileUri;
        state = { phase: 'launching-installer', fileUri };
        await withPhaseTimeout(dependencies.launchInstaller(fileUri), controller, timeoutMs, 'installer launch');
        // Returning means Android did not replace this process. Keep the verified APK
        // available so a foreground event or later start can launch the installer again.
        state = { phase: 'waiting-for-permission', fileUri };
    };

    const run = async (): Promise<void> => {
        if (dependencies.platform !== 'android') {
            state = { phase: 'idle' };
            return;
        }

        if (state.phase === 'launching-installer') return;

        const controller = new AbortController();
        activeController = controller;
        const timeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
        let partialUri: string | null = null;
        let finalUri: string | null = cachedFileUri;
        let activeDownload: Promise<{ bytes: number }> | null = null;

        try {
            if (state.phase === 'waiting-for-announcement' || state.phase === 'waiting-for-permission') {
                await continueDownloaded(latestAnnouncementDismissed, controller, timeoutMs);
                return;
            }

            const runId = (dependencies.createRunId ?? defaultRunId)();
            if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) throw new Error('Invalid Android update run ID');
            cachedFileUri = null;
            finalUri = null;
            permissionPrompted = false;
            await cleanupStaleCache(controller, timeoutMs);
            const manifestUrl = `${dependencies.origin}${dependencies.manifestPath}`;
            const envelope = await withPhaseTimeout(
                dependencies.fetchManifest(manifestUrl, controller.signal),
                controller,
                timeoutMs,
                'manifest fetch',
            );
            const verify = dependencies.verifyManifest ?? verifyUpdateManifest;
            const payload = await withPhaseTimeout(
                verify(envelope, { origin: dependencies.origin, now: options.now }),
                controller,
                timeoutMs,
                'manifest verification',
            );
            if (!isNewerVersion(payload, dependencies.currentVersionCode)) {
                state = { phase: 'idle' };
                return;
            }

            state = { phase: 'downloading', versionCode: payload.versionCode };
            partialUri = nextCacheUri(payload.versionCode, runId, true);
            finalUri = nextCacheUri(payload.versionCode, runId, false);
            activeDownload = dependencies.download(
                `${dependencies.origin}${payload.apkPath}`,
                partialUri,
                controller.signal,
            );
            const downloadResult = await withPhaseTimeout(activeDownload, controller, timeoutMs, 'download');
            activeDownload = null;
            if (downloadResult.bytes !== payload.size) {
                throw new Error('download size or sha256 mismatch');
            }
            const sha256 = await withPhaseTimeout(dependencies.hashFile(partialUri), controller, timeoutMs, 'sha256');
            if (sha256.toLowerCase() !== payload.sha256) throw new Error('download size or sha256 mismatch');
            const movingPartial = partialUri;
            const movingFinal = finalUri;
            const moveOperation = dependencies.move(movingPartial, movingFinal);
            try {
                await withPhaseTimeout(moveOperation, controller, timeoutMs, 'atomic rename');
            } catch (error) {
                // A native rename cannot be cancelled. Isolate it under this run's
                // unique names and remove either outcome after the late operation settles.
                partialUri = null;
                finalUri = null;
                void (async () => {
                    try { await moveOperation; } catch { /* source may have been removed */ }
                    await removeQuietly(movingPartial);
                    await removeQuietly(movingFinal);
                })();
                throw error;
            }
            partialUri = null;
            const archive = await withPhaseTimeout(dependencies.inspectApk(finalUri), controller, timeoutMs, 'APK inspection');
            if (!sameIdentity(archive, payload)) {
                throw new Error('downloaded APK identity mismatch');
            }
            cachedFileUri = finalUri;
            await continueDownloaded(latestAnnouncementDismissed, controller, timeoutMs);
        } catch (error) {
            // The transfer owns the partial path until it has finished pausing.
            // Waiting here prevents a late writer from recreating a deleted file.
            if (activeDownload) {
                try { await activeDownload; } catch { /* expected after abort */ }
            }
            logFailure(error);
            state = { phase: 'failed', retryOnNextStart: true };
            await removeQuietly(partialUri);
            await removeQuietly(finalUri);
            cachedFileUri = null;
        } finally {
            if (activeController === controller) activeController = null;
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
        async cancel(): Promise<void> {
            activeController?.abort();
            await activeRun;
            const fileUri = cachedFileUri;
            cachedFileUri = null;
            await removeQuietly(fileUri);
            state = { phase: 'idle' };
        },
    };
}
