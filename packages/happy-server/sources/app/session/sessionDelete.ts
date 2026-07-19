import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { attachmentCleanupService } from "@/app/chimera/attachmentCleanup";

export class SessionAttachmentBusyError extends Error {
    constructor() { super("Session attachment upload is in progress"); }
}

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string, dependencies: {
    inTx?: typeof inTx;
    afterTx?: typeof afterTx;
    allocateUserSeq?: typeof allocateUserSeq;
    emitUpdate?: typeof eventRouter.emitUpdate;
    process?: (id: string) => Promise<boolean>;
} = {}): Promise<boolean> {
    const runTransaction = dependencies.inTx ?? inTx;
    const registerAfterTransaction = dependencies.afterTx ?? afterTx;
    const nextSequence = dependencies.allocateUserSeq ?? allocateUserSeq;
    const emitUpdate = dependencies.emitUpdate ?? eventRouter.emitUpdate.bind(eventRouter);
    const process = dependencies.process ?? attachmentCleanupService.process;
    return await runTransaction(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            }
        });

        if (!session) {
            return false;
        }

        const reservations = await tx.chimeraAttachmentReservation.findMany({
            where: { accountId: ctx.uid, objectKey: { startsWith: `sessions/${sessionId}/attachments/` } },
        });
        if (reservations.some((reservation: any) => reservation.claimedAt)) {
            throw new SessionAttachmentBusyError();
        }
        for (const reservation of reservations) {
            const released = await tx.chimeraAttachmentReservation.deleteMany({ where: { id: reservation.id } });
            if (released.count) await tx.account.update({ where: { id: ctx.uid }, data: { attachmentReservedBytes: { decrement: reservation.bytes } } });
        }

        // Keep this ledger independent from Session so storage/accounting can finish after deletion.
        const cleanup = await tx.chimeraAttachmentCleanup.upsert({
            where: { sessionId },
            create: { sessionId, accountId: ctx.uid },
            update: {},
        });

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });

        // 2. Delete usage reports
        await tx.usageReport.deleteMany({
            where: { sessionId }
        });

        // 3. Delete access keys
        await tx.accessKey.deleteMany({
            where: { sessionId }
        });

        // 4. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });

        // Send notification and clean up storage after transaction commits
        registerAfterTransaction(tx, () => {
            void (async () => {
                const updSeq = await nextSequence(ctx.uid);
                const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));
                emitUpdate({ userId: ctx.uid, payload: updatePayload, recipientFilter: { type: 'user-scoped-only' } });
                await process(cleanup.id).catch(() => undefined);
            })();
        });

        return true;
    });
}
