import { z } from 'zod';
import { RELAY_ORIGIN } from '@/chimera/product.generated';
import { decodeBase64 } from '@/encryption/base64';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;

const base64 = z.string().min(1).refine((value) => BASE64.test(value), 'Invalid base64');
const base64url = z.string().min(1).refine((value) => BASE64URL.test(value), 'Invalid base64url');

export const AuthChallengeResponseSchema = z.object({
    version: z.literal(2),
    origin: z.literal(RELAY_ORIGIN),
    purpose: z.literal('chimera-account-auth'),
    challengeId: z.string().min(1).max(256),
    nonce: base64url,
    publicKey: base64,
    expiresAt: z.string().datetime({ offset: true }),
}).strict();

export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponseSchema>;

export const AuthCompletionResponseSchema = z.object({
    token: z.string().min(1),
}).strict();

export type AuthCompletionResponse = z.infer<typeof AuthCompletionResponseSchema>;

export function parseAuthChallengeResponse(value: unknown, now = new Date()): AuthChallengeResponse {
    const challenge = AuthChallengeResponseSchema.parse(value);
    if (decodeBase64(challenge.nonce, 'base64url').length !== 16) {
        throw new Error('Challenge nonce must be 16 bytes');
    }

    const expiresAt = new Date(challenge.expiresAt).getTime();
    const nowMs = now.getTime();
    if (expiresAt <= nowMs || expiresAt > nowMs + 2 * 60 * 1000) {
        throw new Error('Challenge expiry is outside the allowed lifetime');
    }

    return challenge;
}

export function parseAuthCompletionResponse(value: unknown): AuthCompletionResponse {
    return AuthCompletionResponseSchema.parse(value);
}

export function createAuthPayload(input: AuthChallengeResponse): string {
    return [
        'chimera-auth-v2',
        input.origin,
        input.purpose,
        input.challengeId,
        input.nonce,
        input.publicKey,
        input.expiresAt,
    ].join('\n');
}
