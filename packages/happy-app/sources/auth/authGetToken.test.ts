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

function validChallenge(overrides: Record<string, unknown> = {}) {
    return {
        version: 2,
        origin: 'https://39.98.68.173',
        purpose: 'chimera-account-auth',
        challengeId: 'challenge-id',
        nonce: 'AAECAwQFBgcICQoLDA0ODw',
        publicKey: 'AQID',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides,
    };
}

describe('authGetToken', () => {
    beforeEach(() => {
        post.mockReset();
        crypto_sign_detached.mockClear();
    });

    it('signs a server-issued canonical challenge and sends an invitation only on registration', async () => {
        const challenge = validChallenge();
        post
            .mockResolvedValueOnce({ data: challenge })
            .mockResolvedValueOnce({ data: { token: 'token' } });

        await expect(authGetToken(new Uint8Array(32), 'invite-code')).resolves.toBe('token');

        expect(post).toHaveBeenNthCalledWith(1, 'https://39.98.68.173/v1/auth/challenge', { publicKey: 'AQID' }, { headers: { 'X-Happy-Client': 'client-id' } });
        expect(crypto_sign_detached).toHaveBeenCalledWith(
            new TextEncoder().encode(`chimera-auth-v2\nhttps://39.98.68.173\nchimera-account-auth\nchallenge-id\nAAECAwQFBgcICQoLDA0ODw\nAQID\n${challenge.expiresAt}`),
            expect.any(Uint8Array),
        );
        expect(post).toHaveBeenNthCalledWith(2, 'https://39.98.68.173/v1/auth', {
            challengeId: 'challenge-id',
            signature: 'BwgJ',
            invitation: 'invite-code',
        }, { headers: { 'X-Happy-Client': 'client-id' } });
    });

    it('does not send an invitation when restoring an existing account', async () => {
        post
            .mockResolvedValueOnce({ data: validChallenge() })
            .mockResolvedValueOnce({ data: { token: 'token' } });

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('token');

        expect(post.mock.calls[1][1]).not.toHaveProperty('invitation');
    });

    it('zeroes the derived private key after authentication', async () => {
        const privateKey = new Uint8Array([4, 5, 6]);
        crypto_sign_seed_keypair.mockReturnValueOnce({
            publicKey: new Uint8Array([1, 2, 3]),
            privateKey,
        });
        post
            .mockResolvedValueOnce({ data: validChallenge() })
            .mockResolvedValueOnce({ data: { token: 'token' } });

        await authGetToken(new Uint8Array(32));

        expect([...privateKey]).toEqual([0, 0, 0]);
    });

    it('rejects a challenge for a different public key', async () => {
        post.mockResolvedValueOnce({ data: validChallenge({ publicKey: 'BAUG' }) });

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow('public key');
        expect(post).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a missing token', {}],
        ['an empty token', { token: '' }],
        ['a non-string token', { token: 123 }],
        ['an unexpected field', { token: 'token', extra: true }],
    ])('rejects a completion response with %s', async (_name, completion) => {
        post
            .mockResolvedValueOnce({ data: validChallenge() })
            .mockResolvedValueOnce({ data: completion });

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow();
    });
});
