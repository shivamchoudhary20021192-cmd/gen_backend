import { env } from '../../../config/env';
import { LocalDiskDriver } from './LocalDiskDriver';
import { S3Driver } from './S3Driver';
import type { StorageDriver } from './StorageDriver';

/**
 * Single place that decides which driver is live. Switching an installation
 * from local disk to S3 is STORAGE_DRIVER=s3 plus a `media_migrations` run to
 * copy the existing files and flip `media.disk`. No call site changes.
 */
function createDriver(): StorageDriver {
  switch (env.storage.driver) {
    case 'local':
      return new LocalDiskDriver();
    case 's3':
      return new S3Driver();
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${env.storage.driver}`);
  }
}

export const storage: StorageDriver = createDriver();
export { LocalDiskDriver, S3Driver };
export type { StorageDriver };
