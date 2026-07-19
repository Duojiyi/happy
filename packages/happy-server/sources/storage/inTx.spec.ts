import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

let database: any;
vi.mock("@/storage/db", () => ({ get db() { return database; } }));

function serializationFailure() {
    return new Prisma.PrismaClientKnownRequestError("scheduled serialization conflict", {
        code: "P2034",
        clientVersion: "test",
    });
}

describe("inTx serializable retry contract", () => {
    it("replays the losing callback after a scheduled P2034 and preserves Serializable isolation", async () => {
        const attempts: string[] = [];
        const transactionOptions: any[] = [];
        let transactionCalls = 0;
        database = {
            $transaction: async (callback: any, options: any) => {
                transactionCalls++;
                transactionOptions.push(options);
                const result = await callback({ attempt: transactionCalls });
                if (transactionCalls === 1) throw serializationFailure();
                return result;
            },
        };
        vi.resetModules();
        const { inTx } = await import("./inTx");

        await expect(inTx(async (tx: any) => {
            attempts.push(`read-${tx.attempt}`);
            attempts.push(`write-${tx.attempt}`);
            return tx.attempt;
        })).resolves.toBe(2);

        expect(transactionCalls).toBe(2);
        expect(attempts).toEqual(["read-1", "write-1", "read-2", "write-2"]);
        expect(transactionOptions).toEqual([
            { isolationLevel: "Serializable", timeout: 10000 },
            { isolationLevel: "Serializable", timeout: 10000 },
        ]);
    });
});
