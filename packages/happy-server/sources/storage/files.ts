import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'minio';
import * as crypto from 'crypto';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';

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
        return;
    }
    await s3client.bucketExists(s3bucket);
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
export async function deleteSessionAttachments(sessionId: string): Promise<void> {
    const prefix = `sessions/${sessionId}/attachments`;
    if (useLocalStorage) {
        const dir = path.join(localFilesDir, prefix);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        return;
    }

    // S3: list and delete all objects under the prefix
    const stream = s3client.listObjects(s3bucket, prefix + '/', true);
    const keys: string[] = await new Promise((resolve, reject) => {
        const collected: string[] = [];
        stream.on('data', (obj: { name: string }) => { if (obj.name) collected.push(obj.name); });
        stream.on('end', () => resolve(collected));
        stream.on('error', reject);
    });

    if (keys.length > 0) {
        await s3client.removeObjects(s3bucket, keys);
    }
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
