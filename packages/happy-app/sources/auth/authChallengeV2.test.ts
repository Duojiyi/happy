import { describe, expect, it } from 'vitest';
import { createAuthPayload, parseAuthChallengeResponse } from './authChallengeV2';

describe('authChallengeV2', () => {
    it('creates the exact canonical challenge payload', () => {
        expect(createAuthPayload({
            version: 2,
            origin: 'https://39.98.68.173',
            purpose: 'chimera-account-auth',
            challengeId: 'challenge-id',
            nonce: 'base64url-nonce',
            publicKey: 'base64-public-key',
            expiresAt: '2026-07-19T10:00:00.000Z',
        })).toBe('chimera-auth-v2\nhttps://39.98.68.173\nchimera-account-auth\nchallenge-id\nbase64url-nonce\nbase64-public-key\n2026-07-19T10:00:00.000Z');
    });

    it.each([
        ['origin', { origin: 'https://example.com' }],
        ['purpose', { purpose: 'different-purpose' }],
        ['base64url nonce', { nonce: 'not valid!' }],
        ['base64 public key', { publicKey: 'not valid!' }],
        ['expiry', { expiresAt: 'not-a-date' }],
        ['unexpected field', { unexpected: true }],
    ])('rejects an invalid %s server response', (_name, mutation) => {
        expect(() => parseAuthChallengeResponse({
            version: 2,
            origin: 'https://39.98.68.173',
            purpose: 'chimera-account-auth',
            challengeId: 'challenge-id',
            nonce: 'YWJjZA',
            publicKey: 'YWJjZA==',
            expiresAt: '2026-07-19T10:00:00.000Z',
            ...mutation,
        })).toThrow();
    });

    it('rejects a nonce that does not decode to 16 bytes', () => {
        expect(() => parseAuthChallengeResponse({
            version: 2,
            origin: 'https://39.98.68.173',
            purpose: 'chimera-account-auth',
            challengeId: 'challenge-id',
            nonce: 'YWJjZA',
            publicKey: 'YWJjZA==',
            expiresAt: '2026-07-19T10:01:00.000Z',
        }, new Date('2026-07-19T10:00:00.000Z'))).toThrow();
    });

    it.each([
        ['expired', '2026-07-19T09:59:59.999Z'],
        ['more than two minutes away', '2026-07-19T10:02:00.001Z'],
    ])('rejects a %s challenge expiry', (_name, expiresAt) => {
        expect(() => parseAuthChallengeResponse({
            version: 2,
            origin: 'https://39.98.68.173',
            purpose: 'chimera-account-auth',
            challengeId: 'challenge-id',
            nonce: 'AAECAwQFBgcICQoLDA0ODw',
            publicKey: 'YWJjZA==',
            expiresAt,
        }, new Date('2026-07-19T10:00:00.000Z'))).toThrow();
    });
});
