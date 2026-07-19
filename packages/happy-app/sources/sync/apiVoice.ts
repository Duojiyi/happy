import type { VoiceConversationResponse, VoiceUsageResponse } from '@slopus/happy-wire';
import { AuthCredentials } from '@/auth/tokenStorage';

export type { VoiceConversationResponse, VoiceUsageResponse };

export async function fetchVoiceCredentials(
    _credentials: AuthCredentials,
    _sessionId: string
): Promise<VoiceConversationResponse> {
    throw new Error('Voice is unavailable in this product');
}

export async function fetchVoiceUsage(
    _credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    throw new Error('Voice is unavailable in this product');
}
