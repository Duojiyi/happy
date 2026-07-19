import { z } from 'zod';
import { RELAY_ORIGIN } from '@/chimera/product.generated';

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

export function parseAuthChallengeResponse(value: unknown): AuthChallengeResponse {
    return AuthChallengeResponseSchema.parse(value);
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
