import { describe, expect, it, vi } from "vitest";
import { sessionDelete } from "./sessionDelete";

function statefulTransaction() {
    const state = { sessions: new Set(["s1"]), cleanups: [] as Array<{ id: string; sessionId: string }>, callbacks: [] as Array<() => void> };
    const inTx = async (fn: any) => {
        const sessions = new Set(state.sessions);
        const cleanups = state.cleanups.map((row) => ({ ...row }));
        const callbacks: Array<() => void> = [];
        const tx: any = {
            session: { findFirst: async ({ where }: any) => sessions.has(where.id) && where.accountId === "u1" ? { id: where.id } : null, delete: async ({ where }: any) => { sessions.delete(where.id); } },
            sessionMessage: { deleteMany: async () => ({ count: 0 }) }, usageReport: { deleteMany: async () => ({ count: 0 }) }, accessKey: { deleteMany: async () => ({ count: 0 }) },
            chimeraAttachmentReservation: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
            account: { update: async () => undefined },
            chimeraAttachmentCleanup: { upsert: async ({ where, create }: any) => { const existing = cleanups.find((row) => row.sessionId === where.sessionId); if (existing) return existing; const row = { id: `c${cleanups.length + 1}`, sessionId: create.sessionId }; cleanups.push(row); return row; } },
            callbacks,
        };
        const result = await fn(tx);
        state.sessions = sessions; state.cleanups = cleanups; state.callbacks = callbacks;
        return result;
    };
    return { state, inTx };
}

describe("sessionDelete cleanup ledger transaction boundary", () => {
    it("does not persist a ledger or delete the session when its transaction rolls back", async () => {
        const fixture = statefulTransaction();
        const rollback = async (_fn: any) => { throw new Error("rollback"); };
        await expect((sessionDelete as any)({ uid: "u1" }, "s1", { inTx: rollback })).rejects.toThrow("rollback");
        expect(fixture.state.sessions.has("s1")).toBe(true);
        expect(fixture.state.cleanups).toEqual([]);
    });

    it("creates one ledger in the same committed transaction as session deletion", async () => {
        const fixture = statefulTransaction();
        const process = vi.fn(async () => undefined);
        await expect((sessionDelete as any)({ uid: "u1" }, "s1", { inTx: fixture.inTx, afterTx: (tx: any, cb: any) => tx.callbacks.push(cb), allocateUserSeq: async () => 1, emitUpdate: () => undefined, process })).resolves.toBe(true);
        expect(fixture.state.sessions.has("s1")).toBe(false);
        expect(fixture.state.cleanups).toEqual([{ id: "c1", sessionId: "s1" }]);
    });

    it("keeps the committed ledger when after-transaction cleanup fails", async () => {
        const fixture = statefulTransaction();
        const process = vi.fn(async () => { throw new Error("cleanup"); });
        await (sessionDelete as any)({ uid: "u1" }, "s1", { inTx: fixture.inTx, afterTx: (tx: any, cb: any) => tx.callbacks.push(cb), allocateUserSeq: async () => 1, emitUpdate: () => undefined, process });
        for (const callback of fixture.state.callbacks) callback();
        await Promise.resolve();
        expect(fixture.state.cleanups).toHaveLength(1);
    });

    it("does not create another ledger for missing or repeated deletion", async () => {
        const fixture = statefulTransaction();
        const deps: any = { inTx: fixture.inTx, afterTx: (tx: any, cb: any) => tx.callbacks.push(cb), allocateUserSeq: async () => 1, emitUpdate: () => undefined, process: async () => undefined };
        await (sessionDelete as any)({ uid: "u1" }, "s1", deps);
        await expect((sessionDelete as any)({ uid: "u1" }, "s1", deps)).resolves.toBe(false);
        await expect((sessionDelete as any)({ uid: "u1" }, "missing", deps)).resolves.toBe(false);
        expect(fixture.state.cleanups).toHaveLength(1);
    });
});
