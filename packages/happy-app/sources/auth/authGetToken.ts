import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getHappyClientId } from "@/sync/apiSocket";
import sodium from '@/encryption/libsodium.lib';
import { createAuthPayload, parseAuthChallengeResponse, parseAuthCompletionResponse } from './authChallengeV2';

export async function authGetToken(secret: Uint8Array, inviteCode?: string) {
    const API_ENDPOINT = getServerUrl();
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    const headers = {
        'X-Happy-Client': getHappyClientId(),
    };
    const challengeResponse = await axios.post(`${API_ENDPOINT}/v1/auth/challenge`, {
        publicKey: encodeBase64(keypair.publicKey),
    }, { headers });
    const challenge = parseAuthChallengeResponse(challengeResponse.data);
    if (challenge.publicKey !== encodeBase64(keypair.publicKey)) {
        throw new Error('Challenge public key does not match the requested key');
    }
    const signature = sodium.crypto_sign_detached(
        new TextEncoder().encode(createAuthPayload(challenge)),
        keypair.privateKey,
    );
    const response = await axios.post(`${API_ENDPOINT}/v1/auth`, {
        challengeId: challenge.challengeId,
        signature: encodeBase64(signature),
        ...(inviteCode ? { invitation: inviteCode } : {}),
    }, {
        headers: {
            'X-Happy-Client': getHappyClientId(),
        }
    });
    return parseAuthCompletionResponse(response.data).token;
}
