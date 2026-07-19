import { describe, expect, test, vi } from 'vitest';

import type { ChimeraConfig } from './config';
import { createAnnouncementButtons, createStartupAnnouncementOrchestrator } from './useStartupAnnouncement';

const enabledConfig: ChimeraConfig = {
    announcement: {
        enabled: true,
        title: 'Service notice',
        body: 'Read this first.',
        primaryButtonLabel: 'Got it',
        linkButtonLabel: null,
        linkUrl: null,
    },
    androidUpdateManifestPath: '/downloads/chimera-update.json',
};

describe('startup announcement orchestration', () => {
    test('shows an enabled announcement at most once in a mounted runtime and exposes dismissal state', async () => {
        let dismiss: (() => void) | undefined;
        const show = vi.fn((_config: ChimeraConfig['announcement'], onDismiss: () => void) => { dismiss = onDismiss; });
        const announcement = createStartupAnnouncementOrchestrator({ fetchConfig: async () => enabledConfig, show });

        await announcement.start();
        await announcement.start();
        expect(show).toHaveBeenCalledTimes(1);
        expect(announcement.getState()).toEqual({ settled: false, dismissed: false });

        dismiss?.();
        expect(announcement.getState()).toEqual({ settled: true, dismissed: true });
    });

    test('shows again in a new mounted runtime without persisting a dismissal', async () => {
        const show = vi.fn();
        await createStartupAnnouncementOrchestrator({ fetchConfig: async () => enabledConfig, show }).start();
        await createStartupAnnouncementOrchestrator({ fetchConfig: async () => enabledConfig, show }).start();

        expect(show).toHaveBeenCalledTimes(2);
    });

    test('silently settles without a modal when config is disabled or unavailable', async () => {
        const show = vi.fn();
        const disabled = { ...enabledConfig, announcement: { ...enabledConfig.announcement, enabled: false } };

        const disabledAnnouncement = createStartupAnnouncementOrchestrator({ fetchConfig: async () => disabled, show });
        await disabledAnnouncement.start();
        expect(disabledAnnouncement.getState()).toEqual({ settled: true, dismissed: false });

        const unavailableAnnouncement = createStartupAnnouncementOrchestrator({ fetchConfig: async () => null, show });
        await unavailableAnnouncement.start();
        expect(unavailableAnnouncement.getState()).toEqual({ settled: true, dismissed: false });
        expect(show).not.toHaveBeenCalled();
    });

    test('settles when either the primary or optional link button is pressed', async () => {
        const onDismiss = vi.fn();
        const announcement = { ...enabledConfig.announcement, linkButtonLabel: 'Learn more', linkUrl: 'https://chimera.example' };
        const primaryButtons = createAnnouncementButtons(announcement, onDismiss, vi.fn());
        primaryButtons.at(-1)?.onPress?.();
        expect(onDismiss).toHaveBeenCalledOnce();

        const openExternalUrl = vi.fn().mockReturnValue(new Promise<void>(() => {}));
        const linkButtons = createAnnouncementButtons(announcement, onDismiss, openExternalUrl);
        linkButtons[0]?.onPress?.();
        expect(openExternalUrl).toHaveBeenCalledWith('https://chimera.example');
        expect(onDismiss).toHaveBeenCalledTimes(2);
    });

    test('does not show or update state after cancellation during an in-flight fetch', async () => {
        let resolveConfig: (value: ChimeraConfig) => void = () => {};
        const fetchConfig = vi.fn(() => new Promise<ChimeraConfig>((resolve) => { resolveConfig = resolve; }));
        const show = vi.fn();
        const onStateChange = vi.fn();
        const announcement = createStartupAnnouncementOrchestrator({ fetchConfig, show, onStateChange });

        const start = announcement.start();
        announcement.cancel();
        resolveConfig(enabledConfig);
        await start;

        expect(show).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
    });

    test('only the current overlapping mount shows after an older mount is cancelled', async () => {
        let resolveFirst: (value: ChimeraConfig) => void = () => {};
        const first = createStartupAnnouncementOrchestrator({
            fetchConfig: () => new Promise<ChimeraConfig>((resolve) => { resolveFirst = resolve; }),
            show: vi.fn(),
        });
        const currentShow = vi.fn();
        const current = createStartupAnnouncementOrchestrator({ fetchConfig: async () => enabledConfig, show: currentShow });

        const firstStart = first.start();
        first.cancel();
        await current.start();
        resolveFirst(enabledConfig);
        await firstStart;

        expect(currentShow).toHaveBeenCalledOnce();
    });
});
