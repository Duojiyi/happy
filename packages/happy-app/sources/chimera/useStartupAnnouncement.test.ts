import { describe, expect, test, vi } from 'vitest';

import type { ChimeraConfig } from './config';
import { createStartupAnnouncementOrchestrator } from './useStartupAnnouncement';

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
});
