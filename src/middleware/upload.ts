import multer from 'multer';
import { env } from '../config/env';
import { ApiError } from '../core/ApiError';

/**
 * Memory storage, not disk. The upload pipeline needs the bytes in hand to
 * hash them (for dedupe) and to hand them to sharp, and writing a temp file
 * first would mean a second read plus cleanup on every failure path.
 *
 * Bounded by MEDIA_MAX_UPLOAD_MB per file and MEDIA_MAX_FILES_PER_REQUEST, so
 * memory pressure stays predictable.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.storage.maxUploadBytes,
    files: env.storage.maxFilesPerRequest,
    fields: 20,
  },
  fileFilter: (_req, file, cb) => {
    if (!env.storage.allowedMime.includes(file.mimetype)) {
      cb(
        new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          `${file.mimetype} is not an accepted file type.`,
          { accepted: env.storage.allowedMime },
        ),
      );
      return;
    }
    cb(null, true);
  },
});
