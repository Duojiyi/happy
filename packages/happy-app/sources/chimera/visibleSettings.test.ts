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

    it('uses Chimera branding throughout production navigation and recovery', () => {
        const headerLogo = readFileSync(new URL('../components/HeaderLogo.tsx', import.meta.url), 'utf8');
        const homeHeader = readFileSync(new URL('../components/HomeHeader.tsx', import.meta.url), 'utf8');
        const restoreRoute = readFileSync(new URL('../app/(app)/restore/index.tsx', import.meta.url), 'utf8');

        expect(headerLogo).toContain("icon-monochrome.png");
        expect(homeHeader).toContain("icon-monochrome.png");
        expect(`${headerLogo}\n${homeHeader}`).not.toContain('logo-black.png');
        expect(homeHeader).toContain('PRODUCT_NAME');
        expect(homeHeader).not.toContain("t('sidebar.sessionsTitle')");
        expect(restoreRoute).toContain('Open Chimera on your mobile device');
        expect(restoreRoute).not.toContain('Open Happy');
    });

    it('does not expose analytics controls for the disabled integration', () => {
        const accountRoute = readFileSync(new URL('../app/(app)/settings/account.tsx', import.meta.url), 'utf8');
        const featuresRoute = readFileSync(new URL('../app/(app)/settings/features.tsx', import.meta.url), 'utf8');

        for (const route of [accountRoute, featuresRoute]) {
            expect(route).not.toContain('analyticsOptOut');
            expect(route).not.toMatch(/settings(?:Account|Features)\.(?:disableAnalytics|analytics)/);
        }
    });
});
