import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env';
import type { StorageDriver } from './StorageDriver';

/**
 * Writes under STORAGE_LOCAL_ROOT, which must sit OUTSIDE the web root — files
 * are served by an Express route that can 404 and set cache headers, never by
 * a static handler pointed at an upload folder.
 */
export class LocalDiskDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;
  private readonly baseUrl: string;

  constructor(root: string = env.storage.localRoot, baseUrl: string = env.storage.localBaseUrl) {
    // Normalised, so a root written with forward slashes on Windows still contains its own files.
    this.root = path.resolve(root);
    this.baseUrl = baseUrl;
  }

  /**
   * Resolves a storage key to an absolute path and refuses anything that
   * escapes the root. A key is attacker-influenced (it embeds a filename), so
   * `../../etc/passwd` has to be impossible, not merely unlikely.
   */
  private resolve(key: string): string {
    const normalised = path.normalize(key).replace(/^([/\\])+/, '');
    const full = path.resolve(this.root, normalised);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!full.startsWith(rootWithSep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/${key.replace(/^\/+/, '')}`;
  }

  /** Used by the file-serving route; not part of the driver interface. */
  absolutePath(key: string): string {
    return this.resolve(key);
  }
}
