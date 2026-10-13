/**
 * The seam that makes "local now, S3 later" a config change rather than a
 * refactor. Nothing above this interface ever builds a filesystem path or a
 * URL by hand — callers hold a `storage_key` and ask the driver.
 */
export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
}
