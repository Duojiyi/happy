import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { visibleSettings } from './visibleSettings';

describe('visibleSettings', () => {
    it('exposes only the private-client settings', () => {
        expect(visibleSettings.map((setting) => setting.id)).toEqual([
            'terminal-connect',
            'machines',
            'account',
            'appearance',
            'agent-defaults',
            'features',
        ]);
    });

    it('keeps connected accounts and changelog unavailable through direct routes', () => {
        const accountRoute = readFileSync(new URL('../app/(app)/settings/account.tsx', import.meta.url), 'utf8');
        const changelogRoute = readFileSync(new URL('../app/(app)/changelog.tsx', import.meta.url), 'utf8');
        const authenticatedLayout = readFileSync(new URL('../app/(app)/_layout.tsx', import.meta.url), 'utf8');

        expect(accountRoute).not.toContain('connectedServices');
        expect(accountRoute).not.toContain('disconnectGitHub');
        expect(changelogRoute).toContain('return <Redirect href="/settings" />;');
        expect(authenticatedLayout).not.toContain('name="changelog"');
    });
});
