import * as React from 'react';

import { CHIMERA_POLICY } from './policy';
import { ChimeraConfig, fetchChimeraConfig } from './config';

export type StartupAnnouncementState = {
    settled: boolean;
    dismissed: boolean;
};

type Announcement = ChimeraConfig['announcement'];
type AnnouncementButton = { text: string; onPress: () => void | Promise<void> };

type StartupAnnouncementDependencies = {
    fetchConfig: () => Promise<ChimeraConfig | null>;
    show: (announcement: Announcement, onDismiss: () => void) => void;
    onStateChange?: (state: StartupAnnouncementState) => void;
};

export function createStartupAnnouncementOrchestrator({
    fetchConfig,
    show,
    onStateChange,
}: StartupAnnouncementDependencies) {
    let started = false;
    let state: StartupAnnouncementState = { settled: false, dismissed: false };

    const updateState = (nextState: StartupAnnouncementState) => {
        state = nextState;
        onStateChange?.(state);
    };

    return {
        getState: () => state,
        start: async () => {
            if (started) {
                return;
            }
            started = true;

            const config = await fetchConfig();
            if (!config?.announcement.enabled) {
                updateState({ settled: true, dismissed: false });
                return;
            }

            show(config.announcement, () => updateState({ settled: true, dismissed: true }));
        },
    };
}

export function createAnnouncementButtons(
    announcement: Announcement,
    onDismiss: () => void,
    openExternalUrl: (url: string) => Promise<void>,
): AnnouncementButton[] {
    const buttons: AnnouncementButton[] = [];
    if (announcement.linkButtonLabel && announcement.linkUrl) {
        buttons.push({
            text: announcement.linkButtonLabel,
            onPress: async () => {
                try {
                    await openExternalUrl(announcement.linkUrl!);
                } catch {
                    // Opening an optional external link must not keep startup blocked.
                } finally {
                    onDismiss();
                }
            },
        });
    }
    buttons.push({ text: announcement.primaryButtonLabel, onPress: onDismiss });
    return buttons;
}

async function showAnnouncement(announcement: Announcement, onDismiss: () => void): Promise<void> {
    const [{ Modal }, { openExternalUrl }] = await Promise.all([
        import('@/modal'),
        import('@/utils/openExternalUrl'),
    ]);
    Modal.alert(announcement.title, announcement.body, createAnnouncementButtons(announcement, onDismiss, openExternalUrl));
}

export function useStartupAnnouncement(): StartupAnnouncementState {
    const [state, setState] = React.useState<StartupAnnouncementState>({ settled: false, dismissed: false });

    React.useEffect(() => {
        if (!CHIMERA_POLICY.startupAnnouncement) {
            setState({ settled: true, dismissed: false });
            return;
        }

        const announcement = createStartupAnnouncementOrchestrator({
            fetchConfig: fetchChimeraConfig,
            show: showAnnouncement,
            onStateChange: setState,
        });
        void announcement.start();
    }, []);

    return state;
}
