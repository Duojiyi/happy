import { EventEmitter } from "node:events";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionAttachmentStorage } from "./files";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function localRoot() {
    const root = join(tmpdir(), `happy-files-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    return root;
}

describe("session attachment cleanup storage", () => {
    it("inventories only encrypted top-level attachments with exact local bytes", async () => {
        const root = await localRoot();
        const directory = join(root, "sessions", "s1", "attachments");
        await mkdir(join(directory, "nested"), { recursive: true });
        await Promise.all([
            writeFile(join(directory, "a.enc"), Buffer.alloc(7)),
            writeFile(join(directory, "b.enc"), Buffer.alloc(11)),
            writeFile(join(directory, "upload.partial"), Buffer.alloc(13)),
            writeFile(join(directory, "plain.txt"), Buffer.alloc(17)),
            writeFile(join(directory, "nested", "c.enc"), Buffer.alloc(19)),
        ]);
        const storage = createSessionAttachmentStorage({ localRoot: root });
        await expect(storage.inventorySessionAttachments("s1")).resolves.toEqual({
            objects: [
                { name: "sessions/s1/attachments/a.enc", size: 7n },
                { name: "sessions/s1/attachments/b.enc", size: 11n },
            ],
            bytes: 18n,
        });
    });

    it("handles empty and repeated local deletion without escaping the storage root", async () => {
        const root = await localRoot();
        const storage = createSessionAttachmentStorage({ localRoot: root });
        await expect(storage.deleteSessionAttachments("empty")).resolves.toBeUndefined();
        await mkdir(join(root, "sessions", "s1", "attachments"), { recursive: true });
        await writeFile(join(root, "sessions", "s1", "attachments", "a.enc"), Buffer.alloc(3));
        await storage.deleteSessionAttachments("s1");
        await expect(storage.inventorySessionAttachments("s1")).resolves.toEqual({ objects: [], bytes: 0n });
        await expect(storage.deleteSessionAttachments("s1")).resolves.toBeUndefined();
        await expect(storage.inventorySessionAttachments("..\\outside")).rejects.toThrow("Invalid session attachment path");
    });

    it("uses S3 names and sizes, and ignores non-attachments", async () => {
        const client = fakeS3([
            { name: "sessions/s1/attachments/a.enc", size: 7 },
            { name: "sessions/s1/attachments/b.enc", size: 11 },
            { name: "sessions/s1/attachments/c.partial", size: 13 },
            { name: "sessions/s1/attachments/nested/d.enc", size: 17 },
        ]);
        const storage = createSessionAttachmentStorage({ s3Client: client, s3Bucket: "bucket" });
        await expect(storage.inventorySessionAttachments("s1")).resolves.toEqual({
            objects: [
                { name: "sessions/s1/attachments/a.enc", size: 7n },
                { name: "sessions/s1/attachments/b.enc", size: 11n },
            ], bytes: 18n,
        });
    });

    it("fails S3 deletion when a partial removal reports an async error", async () => {
        const client = fakeS3([{ name: "sessions/s1/attachments/a.enc", size: 7 }], new Error("remove failed"));
        const storage = createSessionAttachmentStorage({ s3Client: client, s3Bucket: "bucket" });
        await expect(storage.deleteSessionAttachments("s1")).rejects.toThrow("Attachment deletion failed");
    });

    it("fails S3 deletion when objects remain after removal", async () => {
        const client = fakeS3([{ name: "sessions/s1/attachments/a.enc", size: 7 }], undefined, true);
        const storage = createSessionAttachmentStorage({ s3Client: client, s3Bucket: "bucket" });
        await expect(storage.deleteSessionAttachments("s1")).rejects.toThrow("Attachment deletion incomplete");
    });

    it("fails closed on invalid S3 object metadata", async () => {
        const client = fakeS3([{ name: "sessions/s1/attachments/a.enc", size: Number.NaN }]);
        const storage = createSessionAttachmentStorage({ s3Client: client, s3Bucket: "bucket" });
        await expect(storage.inventoryAllSessionAttachments()).rejects.toThrow("Attachment storage listing failed");
    });
});

function fakeS3(objects: Array<{ name: string; size: number }>, removeError?: Error, retain = false) {
    return {
        listObjects: () => {
            const stream = new EventEmitter();
            queueMicrotask(() => { for (const object of objects) stream.emit("data", object); stream.emit("end"); });
            return stream;
        },
        removeObjects: () => {
            const stream = new EventEmitter();
            queueMicrotask(() => {
                if (removeError) stream.emit("error", removeError);
                else { if (!retain) objects.splice(0); stream.emit("end"); }
            });
            return stream;
        },
    };
}
