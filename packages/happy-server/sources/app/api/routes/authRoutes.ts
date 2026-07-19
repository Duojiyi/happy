import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { inTx } from "@/storage/inTx";
import { loadChimeraServerConfig } from "@/app/chimera/config";
import { createAuthChallengeService, createAuthPayload, AuthChallengeError } from "@/app/chimera/authChallenge";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const signingPublicKey = z.string().min(1).max(128).regex(BASE64);

export function authRoutes(app: Fastify) {
    const challengeService = createAuthChallengeService({ config: loadChimeraServerConfig(process.env), db });

    app.post('/v1/auth/challenge', {
        schema: { body: z.object({ publicKey: signingPublicKey }).strict() }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        let publicKey: Uint8Array;
        try { publicKey = privacyKit.decodeBase64(request.body.publicKey); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
        if (publicKey.length !== tweetnacl.sign.publicKeyLength) return reply.code(401).send({ error: 'Unauthorized' });
        try {
            return reply.send(await challengeService.issue({ publicKey: request.body.publicKey, clientIp: request.ip }));
        } catch (error) {
            if (error instanceof AuthChallengeError && error.code === "RATE_LIMITED") return reply.code(429).send({ error: 'Too many requests' });
            throw error;
        }
    });

    app.post('/v1/auth', {
        schema: {
            body: z.object({
                challengeId: z.string().min(1).max(256),
                signature: z.string().min(1).max(256).regex(BASE64),
                invitation: z.string().min(1).max(256).optional(),
            }).strict()
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const result = await inTx(async (tx) => {
            const challenge = await challengeService.consume(request.body.challengeId, tx);
            if (!challenge) return null;
            try {
                const publicKey = privacyKit.decodeBase64(challenge.publicKey);
                const signature = privacyKit.decodeBase64(request.body.signature);
                if (publicKey.length !== tweetnacl.sign.publicKeyLength || signature.length !== tweetnacl.sign.signatureLength
                    || !tweetnacl.sign.detached.verify(createAuthPayload({ origin: challenge.origin, purpose: "chimera-account-auth", challengeId: challenge.challengeId, nonce: challenge.nonce, publicKey: challenge.publicKey, expiresAt: challenge.expiresAt.toISOString() }), signature, publicKey)) return null;
            } catch { return null; }
            return tx.account.findUnique({ where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(challenge.publicKey)) } });
        });
        if (!result) return reply.code(401).send({ error: 'Unauthorized' });
        return reply.send({ token: await auth.createToken(result.id) });
    });

    app.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.boolean().nullish()
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-request' }, `Terminal auth request - publicKey hex: ${publicKeyHex}`);

        const answer = await db.terminalAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex, supportsV2: request.body.supportsV2 ?? false }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!, { session: answer.id });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
        schema: {
            querystring: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.query.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: false });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        log({ module: 'auth-response' }, `Auth response endpoint hit - user: ${request.userId}, publicKey: ${request.body.publicKey.substring(0, 20)}...`);
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'auth-response' }, `Invalid public key length: ${publicKey.length}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-response' }, `Looking for auth request with publicKey hex: ${publicKeyHex}`);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            log({ module: 'auth-response' }, `Auth request not found for publicKey: ${publicKeyHex}`);
            // Let's also check what auth requests exist
            const allRequests = await db.terminalAuthRequest.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' }
            });
            log({ module: 'auth-response' }, `Recent auth requests in DB: ${JSON.stringify(allRequests.map(r => ({ id: r.id, publicKey: r.publicKey.substring(0, 20) + '...', hasResponse: !!r.response })))}`);
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (!authRequest.response) {
            await db.terminalAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });

    // Account auth request
    app.post('/v1/auth/account/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: privacyKit.encodeHex(publicKey) },
            update: {},
            create: { publicKey: privacyKit.encodeHex(publicKey) }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!);
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKey) }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (!authRequest.response) {
            await db.accountAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });

}
