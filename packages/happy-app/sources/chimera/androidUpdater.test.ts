import { describe, expect, test, vi } from 'vitest';
import { createAndroidUpdater, type AndroidUpdatePayload, type AndroidUpdaterDependencies } from './androidUpdater';

const payload: AndroidUpdatePayload = {
    schemaVersion: 1,
    packageName: 'org.chimerahub.chimera',
    versionName: '1.7.0-chimera.2',
    versionCode: 2,
    apkPath: '/downloads/chimera-1.7.0-chimera.2.apk',
    size: 4,
    sha256: 'a'.repeat(64),
    signerSha256: '58AA84B6C0D84963E841EED5EF953FC35D4B17D612C923D19A2264F96E4C8A93',
    commitSha: 'b'.repeat(40),
    publishedAt: '2026-07-20T00:00:00.000Z',
};

function deps(overrides: Partial<AndroidUpdaterDependencies> = {}): AndroidUpdaterDependencies {
    return {
        platform: 'android',
        origin: 'https://updates.example.test',
        manifestPath: '/downloads/chimera-update.json',
        currentVersionCode: 1,
        fetchManifest: vi.fn(async () => ({ payload, signature: 'signature' })),
        verifyManifest: vi.fn(async () => payload),
        download: vi.fn(async () => ({ bytes: payload.size })),
        hashFile: vi.fn(async () => payload.sha256),
        move: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        inspectApk: vi.fn(async () => ({ packageName: payload.packageName, versionName: payload.versionName, versionCode: payload.versionCode, signerSha256: payload.signerSha256 })),
        canRequestPackageInstalls: vi.fn(async () => true),
        openInstallPermissionSettings: vi.fn(async () => {}),
        launchInstaller: vi.fn(async () => {}),
        ...overrides,
    };
}

describe('Android update state machine', () => {
    test('is a web no-op and never touches update dependencies', async () => {
        const d = deps({ platform: 'web' });
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: true });
        expect(updater.getState()).toEqual({ phase: 'idle' });
        expect(d.fetchManifest).not.toHaveBeenCalled();
    });

    test('ignores same or older versions without downloading', async () => {
        const d = deps({ currentVersionCode: 2, verifyManifest: vi.fn(async () => ({ ...payload, versionCode: 2 })) });
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: true });
        expect(updater.getState()).toEqual({ phase: 'idle' });
        expect(d.download).not.toHaveBeenCalled();
    });

    test('verifies manifest before downloading and waits for announcement dismissal', async () => {
        const d = deps();
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: false });
        expect(d.verifyManifest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ origin: d.origin }));
        expect(d.download).toHaveBeenCalledWith(`${d.origin}${payload.apkPath}`, expect.stringMatching(/\.partial$/), expect.any(AbortSignal));
        expect(updater.getState()).toEqual({ phase: 'waiting-for-announcement', fileUri: expect.stringMatching(/\.apk$/) });
        expect(d.launchInstaller).not.toHaveBeenCalled();
        await updater.start({ announcementDismissed: true });
        expect(d.launchInstaller).toHaveBeenCalledTimes(1);
    });

    test('does not download when signature, path, or manifest verification fails', async () => {
        for (const error of ['signature', 'apkPath']) {
            const d = deps({ verifyManifest: vi.fn(async () => { throw new Error(error); }) });
            const updater = createAndroidUpdater(d);
            await updater.start({ announcementDismissed: true });
            expect(updater.getState()).toEqual({ phase: 'failed', retryOnNextStart: true });
            expect(d.download).not.toHaveBeenCalled();
        }
    });

    test('cleans partial files after timeout and retries only on a later start', async () => {
        const d = deps({ download: vi.fn((_url, partial, signal) => new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })) });
        const updater = createAndroidUpdater(d, { downloadTimeoutMs: 5 });
        const first = updater.start({ announcementDismissed: true });
        await first;
        expect(d.remove).toHaveBeenCalledWith(expect.stringMatching(/\.partial$/));
        expect(updater.getState()).toEqual({ phase: 'failed', retryOnNextStart: true });
        expect(d.download).toHaveBeenCalledTimes(1);
        const retry = updater.start({ announcementDismissed: true });
        await retry;
        expect(d.download).toHaveBeenCalledTimes(2);
    });

    test('rejects byte/sha mismatches and removes both partial and final files', async () => {
        const d = deps({ download: vi.fn(async () => ({ bytes: 3 })), hashFile: vi.fn(async () => 'c'.repeat(64)) });
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: true });
        expect(updater.getState()).toEqual({ phase: 'failed', retryOnNextStart: true });
        expect(d.remove).toHaveBeenCalledWith(expect.stringMatching(/\.partial$/));
        expect(d.remove).toHaveBeenCalledWith(expect.stringMatching(/\.apk$/));
        expect(d.inspectApk).not.toHaveBeenCalled();
    });

    test('rejects archive package, version, and signer mismatches', async () => {
        for (const archive of [
            { packageName: 'other.app', versionName: payload.versionName, versionCode: 2, signerSha256: payload.signerSha256 },
            { packageName: payload.packageName, versionName: 'wrong-version', versionCode: 2, signerSha256: payload.signerSha256 },
            { packageName: payload.packageName, versionName: payload.versionName, versionCode: 1, signerSha256: payload.signerSha256 },
            { packageName: payload.packageName, versionName: payload.versionName, versionCode: 2, signerSha256: 'BAD' },
        ]) {
            const d = deps({ inspectApk: vi.fn(async () => archive) });
            const updater = createAndroidUpdater(d);
            await updater.start({ announcementDismissed: true });
            expect(updater.getState()).toEqual({ phase: 'failed', retryOnNextStart: true });
            expect(d.launchInstaller).not.toHaveBeenCalled();
        }
    });

    test('waits for install permission and launches after permission is granted', async () => {
        let allowed = false;
        const d = deps({ canRequestPackageInstalls: vi.fn(async () => allowed) });
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: true });
        expect(updater.getState()).toEqual({ phase: 'waiting-for-permission', fileUri: expect.stringMatching(/\.apk$/) });
        expect(d.openInstallPermissionSettings).toHaveBeenCalledTimes(1);
        allowed = true;
        await updater.start({ announcementDismissed: true });
        expect(d.launchInstaller).toHaveBeenCalledTimes(1);
    });

    test('serializes concurrent starts to one download', async () => {
        const d = deps();
        let resolveDownload!: (value: { bytes: number }) => void;
        d.download = vi.fn((): Promise<{ bytes: number }> => new Promise((resolve) => { resolveDownload = resolve; }));
        const updater = createAndroidUpdater(d);
        const first = updater.start({ announcementDismissed: true });
        const second = updater.start({ announcementDismissed: true });
        await vi.waitFor(() => expect(d.download).toHaveBeenCalledTimes(1));
        resolveDownload({ bytes: payload.size });
        await Promise.all([first, second]);
        expect(d.launchInstaller).toHaveBeenCalledTimes(1);
    });

    test('observes announcement dismissal that happens during an active download', async () => {
        const d = deps();
        let resolveDownload!: (value: { bytes: number }) => void;
        d.download = vi.fn((): Promise<{ bytes: number }> => new Promise((resolve) => { resolveDownload = resolve; }));
        const updater = createAndroidUpdater(d);
        const download = updater.start({ announcementDismissed: false });
        await vi.waitFor(() => expect(d.download).toHaveBeenCalledTimes(1));
        const dismissed = updater.start({ announcementDismissed: true });
        resolveDownload({ bytes: payload.size });
        await Promise.all([download, dismissed]);
        expect(d.launchInstaller).toHaveBeenCalledTimes(1);
    });

    test('times out native hash, APK inspection, and installer launch phases', async () => {
        for (const override of [
            { hashFile: vi.fn(() => new Promise<string>(() => {})) },
            { inspectApk: vi.fn(() => new Promise<never>(() => {})) },
            { launchInstaller: vi.fn(() => new Promise<void>(() => {})) },
        ]) {
            const d = deps(override);
            const updater = createAndroidUpdater(d, { downloadTimeoutMs: 5 });
            await updater.start({ announcementDismissed: true });
            expect(updater.getState()).toEqual({ phase: 'failed', retryOnNextStart: true });
            expect(d.remove).toHaveBeenCalledWith(expect.stringMatching(/\.apk$|\.partial$/));
        }
    });

    test('waits for an aborted download to pause before deleting its partial file', async () => {
        const events: string[] = [];
        let finishPause!: () => void;
        const paused = new Promise<void>((resolve) => { finishPause = resolve; });
        const d = deps({
            download: vi.fn((_url, _partial, signal) => new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    void paused.then(() => {
                        events.push('paused');
                        reject(new Error('aborted'));
                    });
                }, { once: true });
            })),
            remove: vi.fn(async () => { events.push('removed'); }),
        });
        const updater = createAndroidUpdater(d, { downloadTimeoutMs: 5 });
        const run = updater.start({ announcementDismissed: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(events).toEqual([]);
        finishPause();
        await run;
        expect(events.slice(0, 2)).toEqual(['paused', 'removed']);
    });

    test('can cancel an active run and retry installer after the system UI returns', async () => {
        const d = deps();
        const updater = createAndroidUpdater(d);
        await updater.start({ announcementDismissed: true });
        expect(updater.getState()).toEqual({ phase: 'waiting-for-permission', fileUri: expect.stringMatching(/\.apk$/) });
        await updater.start({ announcementDismissed: true });
        expect(d.launchInstaller).toHaveBeenCalledTimes(2);
        await updater.cancel();
        expect(d.remove).toHaveBeenCalledWith(expect.stringMatching(/\.apk$/));
        expect(updater.getState()).toEqual({ phase: 'idle' });

        d.download = vi.fn((_url, _partial, signal) => new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }));
        const retrying = createAndroidUpdater(d);
        const active = retrying.start({ announcementDismissed: true });
        await vi.waitFor(() => expect(d.download).toHaveBeenCalled());
        await retrying.cancel();
        await active;
        expect(retrying.getState()).toEqual({ phase: 'idle' });
    });
});
