import { describe, expect, test } from 'vitest';

import { CHIMERA_POLICY } from './policy';

describe('CHIMERA_POLICY', () => {
    test('defines the exact product policy', () => {
        expect(CHIMERA_POLICY).toEqual({
            voice: false,
            pushNotifications: false,
            analytics: false,
            purchases: false,
            upstreamOta: false,
            remoteLogging: false,
            connectedAccounts: false,
            upstreamLinks: false,
            serverSelection: false,
            startupAnnouncement: true,
            invitationRegistration: true,
            androidSelfUpdate: true,
        });
    });

    test('is frozen at runtime', () => {
        expect(Object.isFrozen(CHIMERA_POLICY)).toBe(true);
        expect(() => {
            (CHIMERA_POLICY as { voice: boolean }).voice = true;
        }).toThrow();
        expect(CHIMERA_POLICY.voice).toBe(false);
    });
});
