import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'minio';
import * as crypto from 'crypto';
import { onShutdown } from "@/utils/shutdown";

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';
let cleanupRetryShutdownRegistered = false;

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
    s3public = process.env.S3_PUBLIC_URL!;
}

export { s3client, s3bucket, s3host };

export async function loadFiles() {
    if (useLocalStorage) {
        fs.mkdirSync(localFilesDir, { recursive: true });
        const { reconcileAttachmentStorage } = await import('@/app/chimera/attachmentQuota');
        await reconcileAttachmentStorage(localFilesDir);
    } else {
        await s3client.bucketExists(s3bucket);
        const { reconcileS3AttachmentStorage } = await import("@/app/chimera/attachmentQuota");
        await reconcileS3AttachmentStorage();
    }
    const { attachmentCleanupService, startAttachmentCleanupRetry, stopAttachmentCleanupRetry } = await import("@/app/chimera/attachmentCleanup");
    await attachmentCleanupService.drainPending();
    startAttachmentCleanupRetry();
    if (!cleanupRetryShutdownRegistered) {
        cleanupRetryShutdownRegistered = true;
        onShutdown("attachment-cleanup-retry", async () => { stopAttachmentCleanupRetry(); });
    }
}

export function getPublicUrl(filePath: string) {
    if (useLocalStorage) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
        return `${baseUrl}/files/${filePath}`;
    }
    return `${s3public}/${filePath}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
}

export async function putLocalFileAtomic(filePath: string, data: Buffer, root = localFilesDir) {
    const fullPath = path.resolve(root, filePath);
    const rootPath = path.resolve(root) + path.sep;
    if (!fullPath.startsWith(rootPath)) throw new Error('Invalid local file path');
    const partialPath = `${fullPath}.${crypto.randomUUID()}.partial`;
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(partialPath, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(partialPath, fullPath);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.promises.unlink(partialPath).catch(() => undefined);
        throw error;
    }
}

/**
 * Delete all attachments for a session.
 * Local: removes the session attachments directory.
 * S3: deletes all objects with prefix "sessions/{sessionId}/attachments/".
 */
export type SessionAttachmentObject = { name: string; size: bigint };
export type SessionAttachmentInventory = { objects: SessionAttachmentObject[]; bytes: bigint };

type S3Client = {
    listObjects(bucket: string, prefix: string, recursive: boolean): NodeJS.EventEmitter;
    removeObjects(bucket: string, names: string[]): Promise<void> | NodeJS.EventEmitter | void;
};

function attachmentPrefix(sessionId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session attachment path");
    return `sessions/${sessionId}/attachments/`;
}

function isAttachmentName(name: string, prefix: string) {
    const suffix = name.slice(prefix.length);
    return name.startsWith(prefix) && suffix.length > 4 && !suffix.includes("/") && suffix.endsWith(".enc");
}

async function listS3Objects(client: S3Client, bucket: string, prefix: string): Promise<SessionAttachmentObject[]> {
    const stream = client.listObjects(bucket, prefix, true);
    return new Promise((resolve, reject) => {
        const objects: SessionAttachmentObject[] = [];
        stream.on("data", (object: { name?: string; size?: number }) => {
            if (!object.name || !Number.isSafeInteger(object.size) || object.size! < 0) {
                reject(new Error("Attachment storage listing failed"));
                return;
            }
            objects.push({ name: object.name, size: BigInt(object.size!) });
        });
        stream.once("end", () => resolve(objects));
        stream.once("error", () => reject(new Error("Attachment storage listing failed")));
    });
}

async function removeS3Objects(client: S3Client, bucket: string, names: string[]) {
    let result: Promise<void> | NodeJS.EventEmitter | void;
    try { result = client.removeObjects(bucket, names); }
    catch { throw new Error("Attachment deletion failed"); }
    if (result && typeof (result as Promise<void>).then === "function") {
        try { await result; } catch { throw new Error("Attachment deletion failed"); }
        return;
    }
    if (result && typeof (result as NodeJS.EventEmitter).once === "function") {
        await new Promise<void>((resolve, reject) => {
            const stream = result as NodeJS.EventEmitter;
            stream.once("end", resolve);
            stream.once("error", () => reject(new Error("Attachment deletion failed")));
        });
    }
}

export function createSessionAttachmentStorage(dependencies: { localRoot?: string; s3Client?: S3Client; s3Bucket?: string } = {}) {
    const root = dependencies.localRoot;
    const client = dependencies.s3Client;
    const bucket = dependencies.s3Bucket;
    const local = root !== undefined || (!client && useLocalStorage);
    const resolvedRoot = path.resolve(root ?? localFilesDir);

    const inventorySessionAttachments = async (sessionId: string): Promise<SessionAttachmentInventory> => {
        const prefix = attachmentPrefix(sessionId);
        if (local) {
            const directory = path.resolve(resolvedRoot, prefix);
            if (!directory.startsWith(resolvedRoot + path.sep)) throw new Error("Invalid session attachment path");
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
            catch (error: any) { if (error?.code === "ENOENT") return { objects: [], bytes: 0n }; throw error; }
            const objects: SessionAttachmentObject[] = [];
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(".enc")) continue;
                const info = await fs.promises.stat(path.join(directory, entry.name));
                objects.push({ name: `${prefix}${entry.name}`, size: BigInt(info.size) });
            }
            objects.sort((a, b) => a.name.localeCompare(b.name));
            return { objects, bytes: objects.reduce((total, object) => total + object.size, 0n) };
        }
        if (!client || !bucket) throw new Error("Attachment storage is not configured");
        const objects = (await listS3Objects(client, bucket, prefix)).filter((object) => isAttachmentName(object.name, prefix));
        return { objects, bytes: objects.reduce((total, object) => total + object.size, 0n) };
    };

    const deleteSessionAttachments = async (sessionId: string): Promise<void> => {
        const prefix = attachmentPrefix(sessionId);
        if (local) {
            const directory = path.resolve(resolvedRoot, prefix);
            if (!directory.startsWith(resolvedRoot + path.sep)) throw new Error("Invalid session attachment path");
            await fs.promises.rm(directory, { recursive: true, force: true });
            try {
                const remaining = await fs.promises.readdir(directory);
                if (remaining.length) throw new Error("Attachment deletion incomplete");
            } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
            return;
        }
        if (!client || !bucket) throw new Error("Attachment storage is not configured");
        const existing = await listS3Objects(client, bucket, prefix);
        if (existing.length) await removeS3Objects(client, bucket, existing.map((object) => object.name));
        if ((await listS3Objects(client, bucket, prefix)).length) throw new Error("Attachment deletion incomplete");
    };
    const inventoryAllSessionAttachments = async (): Promise<Array<SessionAttachmentObject & { sessionId: string }>> => {
        if (local) throw new Error("Attachment storage listing is not configured");
        if (!client || !bucket) throw new Error("Attachment storage is not configured");
        const objects = await listS3Objects(client, bucket, "sessions/");
        const result: Array<SessionAttachmentObject & { sessionId: string }> = [];
        for (const object of objects) {
            const match = /^sessions\/([A-Za-z0-9_-]+)\/attachments\/([^/]+\.enc)$/.exec(object.name);
            if (object.name.endsWith(".enc") && !match) throw new Error("Attachment storage listing failed");
            if (match) result.push({ ...object, sessionId: match[1] });
        }
        return result;
    };
    return { inventorySessionAttachments, deleteSessionAttachments, inventoryAllSessionAttachments };
}

const sessionAttachmentStorage = createSessionAttachmentStorage();
export const inventorySessionAttachments = sessionAttachmentStorage.inventorySessionAttachments;
export const deleteSessionAttachments = sessionAttachmentStorage.deleteSessionAttachments;
export const inventoryAllSessionAttachments = sessionAttachmentStorage.inventoryAllSessionAttachments;

export async function deleteAttachmentObject(name: string): Promise<void> {
    if (!/^sessions\/[A-Za-z0-9_-]+\/attachments\/[^/]+\.enc$/.test(name)) throw new Error("Invalid attachment path");
    if (useLocalStorage) {
        const fullPath = path.resolve(localFilesDir, name);
        if (!fullPath.startsWith(path.resolve(localFilesDir) + path.sep)) throw new Error("Invalid attachment path");
        await fs.promises.unlink(fullPath).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
        return;
    }
    await removeS3Objects(s3client, s3bucket, [name]);
    const remaining = await listS3Objects(s3client, s3bucket, name);
    if (remaining.some((object) => object.name === name)) throw new Error("Attachment deletion incomplete");
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
