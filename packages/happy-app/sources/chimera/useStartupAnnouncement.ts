import * as React from 'react';

import { CHIMERA_POLICY } from './policy';
import { ChimeraConfig, fetchChimeraConfig } from './config';

export type StartupAnnouncementState = {
    settled: boolean;
    dismissed: boolean;
};

type Announcement = ChimeraConfig['announcement'];
type AnnouncementButton = { text: string; onPress: () => void };

type StartupAnnouncementDependencies = {
    fetchConfig: (signal: AbortSignal) => Promise<ChimeraConfig | null>;
    show: (announcement: Announcement, onDismiss: () => void, signal: AbortSignal) => void;
    onStateChange?: (state: StartupAnnouncementState) => void;
};

export function createStartupAnnouncementOrchestrator({
    fetchConfig,
    show,
    onStateChange,
}: StartupAnnouncementDependencies) {
    let started = false;
    let cancelled = false;
    const controller = new AbortController();
    let state: StartupAnnouncementState = { settled: false, dismissed: false };

    const updateState = (nextState: StartupAnnouncementState) => {
        if (cancelled) {
            return;
        }
        state = nextState;
        onStateChange?.(state);
    };

    return {
        getState: () => state,
        cancel: () => {
            cancelled = true;
            controller.abort();
        },
        start: async () => {
            if (started) {
                return;
            }
            started = true;

            let config: ChimeraConfig | null;
            try {
                config = await fetchConfig(controller.signal);
            } catch {
                if (!cancelled) {
                    // A missing config cannot block the updater; treat the startup gate as complete.
                    updateState({ settled: true, dismissed: true });
                }
                return;
            }
            if (cancelled) {
                return;
            }
            if (!config?.announcement.enabled) {
                updateState({ settled: true, dismissed: true });
                return;
            }

            show(config.announcement, () => updateState({ settled: true, dismissed: true }), controller.signal);
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
            onPress: () => {
                onDismiss();
                try {
                    void openExternalUrl(announcement.linkUrl!).catch(() => {});
                } catch {
                    // Opening an optional external link must not keep startup blocked.
                }
            },
        });
    }
    buttons.push({ text: announcement.primaryButtonLabel, onPress: onDismiss });
    return buttons;
}

async function showAnnouncement(announcement: Announcement, onDismiss: () => void, signal: AbortSignal): Promise<void> {
    const [{ Modal }, { openExternalUrl }] = await Promise.all([
        import('@/modal'),
        import('@/utils/openExternalUrl'),
    ]);
    if (!signal.aborted) {
        Modal.alert(announcement.title, announcement.body, createAnnouncementButtons(announcement, onDismiss, openExternalUrl));
    }
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
        return announcement.cancel;
    }, []);

    return state;
}
