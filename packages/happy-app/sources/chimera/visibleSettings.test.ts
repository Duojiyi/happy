import { describe, expect, it } from 'vitest';
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
});
