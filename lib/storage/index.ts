import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

/**
 * BYO artifact storage (ARD §12): any S3-compatible endpoint, configured by
 * env. Content-addressed keys make the store dumb by design. A local-fs
 * driver backs dev and tests; nothing above this interface knows which
 * driver is active.
 *
 * Env (S3 driver): STORAGE_S3_ENDPOINT (optional for AWS), STORAGE_S3_REGION,
 * STORAGE_S3_BUCKET, STORAGE_S3_PREFIX, STORAGE_S3_ACCESS_KEY_ID,
 * STORAGE_S3_SECRET_ACCESS_KEY.
 * Env (fs driver): STORAGE_FS_DIR (default .storage/).
 */

export interface ObjectStorage {
  /** Store content under its sha256; returns { key, hash }. Idempotent. */
  putContent(content: Buffer | string, kind: string): Promise<{ key: string; hash: string }>;
  put(key: string, content: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Append one JSONL line (used for the event mirror / offline archive). */
  appendJsonl(key: string, line: object): Promise<void>;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class FsStorage implements ObjectStorage {
  constructor(private root: string) {}

  private full(key: string) {
    return path.join(this.root, key);
  }

  async putContent(content: Buffer | string, kind: string) {
    const hash = sha256(content);
    const key = `${kind}/${hash.slice(0, 2)}/${hash}`;
    await this.put(key, content);
    return { key, hash };
  }

  async put(key: string, content: Buffer | string) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }

  async get(key: string) {
    try {
      return await fs.readFile(this.full(key));
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async appendJsonl(key: string, line: object) {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(line) + '\n');
  }
}

export class S3Storage implements ObjectStorage {
  private client: S3Client;
  constructor(
    private bucket: string,
    private prefix: string,
    opts: {
      endpoint?: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  ) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: Boolean(opts.endpoint), // MinIO/R2 compatibility
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  private full(key: string) {
    return this.prefix ? `${this.prefix.replace(/\/$/, '')}/${key}` : key;
  }

  async putContent(content: Buffer | string, kind: string) {
    const hash = sha256(content);
    const key = `${kind}/${hash.slice(0, 2)}/${hash}`;
    await this.put(key, content);
    return { key, hash };
  }

  async put(key: string, content: Buffer | string, contentType = 'application/octet-stream') {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        Body: typeof content === 'string' ? Buffer.from(content) : content,
        ContentType: contentType,
      })
    );
  }

  async get(key: string) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) })
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (e: any) {
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  /**
   * S3 has no append: the JSONL mirror writes one object per line under
   * `<key>/<seq or timestamp>.json` instead. `aws s3 sync` still yields a
   * complete offline archive; the per-request chain orders it.
   */
  async appendJsonl(key: string, line: object) {
    const stamped = `${key.replace(/\.jsonl$/, '')}/${Date.now()}-${sha256(
      JSON.stringify(line)
    ).slice(0, 8)}.json`;
    await this.put(stamped, JSON.stringify(line), 'application/json');
  }
}

let cached: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (cached) return cached;
  if (process.env.STORAGE_S3_BUCKET) {
    cached = new S3Storage(
      process.env.STORAGE_S3_BUCKET,
      process.env.STORAGE_S3_PREFIX ?? 'vobo',
      {
        endpoint: process.env.STORAGE_S3_ENDPOINT,
        region: process.env.STORAGE_S3_REGION ?? 'us-east-1',
        accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY ?? '',
      }
    );
  } else {
    cached = new FsStorage(process.env.STORAGE_FS_DIR ?? '.storage');
  }
  return cached;
}

/** Test seam. */
export function setStorage(storage: ObjectStorage | null) {
  cached = storage;
}
