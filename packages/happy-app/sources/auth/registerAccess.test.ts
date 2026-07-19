import { describe, expect, it } from 'vitest';
import { canRegister } from './registerAccess';

describe('canRegister', () => {
    it('allows only unauthenticated visitors to register', () => {
        expect(canRegister(false)).toBe(true);
        expect(canRegister(true)).toBe(false);
    });
});
