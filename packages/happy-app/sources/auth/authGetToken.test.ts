import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post, crypto_sign_seed_keypair, crypto_sign_detached } = vi.hoisted(() => ({
    post: vi.fn(),
    crypto_sign_seed_keypair: vi.fn(() => ({
        publicKey: new Uint8Array([1, 2, 3]),
        privateKey: new Uint8Array([4, 5, 6]),
    })),
    crypto_sign_detached: vi.fn(() => new Uint8Array([7, 8, 9])),
}));

vi.mock('axios', () => ({ default: { post } }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { crypto_sign_seed_keypair, crypto_sign_detached } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://39.98.68.173' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'client-id' }));

import { authGetToken } from './authGetToken';

describe('authGetToken', () => {
    beforeEach(() => {
        post.mockReset();
        crypto_sign_detached.mockClear();
    });

    it('signs a server-issued canonical challenge and sends an invitation only on registration', async () => {
        post
            .mockResolvedValueOnce({ data: {
                version: 2,
                origin: 'https://39.98.68.173',
                purpose: 'chimera-account-auth',
                challengeId: 'challenge-id',
                nonce: 'YWJjZA',
                publicKey: 'AQID',
                expiresAt: '2026-07-19T10:00:00.000Z',
            } })
            .mockResolvedValueOnce({ data: { token: 'token' } });

        await expect(authGetToken(new Uint8Array(32), 'invite-code')).resolves.toBe('token');

        expect(post).toHaveBeenNthCalledWith(1, 'https://39.98.68.173/v1/auth/challenge', { publicKey: 'AQID' }, { headers: { 'X-Happy-Client': 'client-id' } });
        expect(crypto_sign_detached).toHaveBeenCalledWith(
            new TextEncoder().encode('chimera-auth-v2\nhttps://39.98.68.173\nchimera-account-auth\nchallenge-id\nYWJjZA\nAQID\n2026-07-19T10:00:00.000Z'),
            new Uint8Array([4, 5, 6]),
        );
        expect(post).toHaveBeenNthCalledWith(2, 'https://39.98.68.173/v1/auth', {
            challengeId: 'challenge-id',
            signature: 'BwgJ',
            invitation: 'invite-code',
        }, { headers: { 'X-Happy-Client': 'client-id' } });
    });

    it('rejects a challenge for a different public key', async () => {
        post.mockResolvedValueOnce({ data: {
            version: 2,
            origin: 'https://39.98.68.173',
            purpose: 'chimera-account-auth',
            challengeId: 'challenge-id',
            nonce: 'YWJjZA',
            publicKey: 'BAUG',
            expiresAt: '2026-07-19T10:00:00.000Z',
        } });

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow('public key');
        expect(post).toHaveBeenCalledTimes(1);
    });
});
