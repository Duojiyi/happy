import { describe, expect, it, vi } from 'vitest';
import { loadFontsWithFallback } from './fontLoading';

describe('loadFontsWithFallback', () => {
    it('waits for successful font loading', async () => {
        const load = vi.fn().mockResolvedValue(undefined);
        const warn = vi.fn();

        await expect(loadFontsWithFallback(load, warn)).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
    });

    it('continues boot when font loading times out', async () => {
        const timeout = new Error('12000ms timeout exceeded');
        const warn = vi.fn();

        await expect(loadFontsWithFallback(() => Promise.reject(timeout), warn)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith('Font loading failed; continuing with fallback fonts.', timeout);
    });
});
