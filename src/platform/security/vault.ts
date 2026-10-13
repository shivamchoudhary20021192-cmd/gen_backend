import crypto from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../core/logger';

/**
 * Encryption for secrets the platform must be able to read back: a merchant's
 * Twilio auth token, a Stripe secret key, an app's client secret (needed in the
 * clear to sign its webhooks). Hashing is not an option for these, so they are
 * sealed with AES-256-GCM.
 *
 *   vault:v2:<iv>:<tag>:<ciphertext>          (base64url parts)
 *
 * Keys are versioned. VAULT_KEYS lists every key still needed to open old
 * values; the active one seals new values. Rotation is: add a key, make it
 * active, run the re-seal job, drop the old key.
 *
 *   VAULT_KEYS=v1:<32 bytes base64>,v2:<32 bytes base64>
 *   VAULT_ACTIVE_KEY=v2
 *
 * Every value is sealed with associated data naming what it belongs to
 * (e.g. "integration:<public id>"). The ciphertext then only opens for that
 * row: copying one shop's sealed Stripe key into another shop's row yields an
 * authentication failure, not a working key.
 */

const PREFIX = 'vault';

interface Keyring {
  active: string;
  keys: Map<string, Buffer>;
}

function loadKeyring(): Keyring {
  const raw = (process.env.VAULT_KEYS ?? '').trim();
  const keys = new Map<string, Buffer>();

  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const version = entry.slice(0, separator);
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (!/^v\d+$/.test(version) || key.length !== 32) {
      throw new Error(`VAULT_KEYS entry "${version}" must be v<N>:<32 random bytes, base64>.`);
    }
    keys.set(version, key);
  }

  if (keys.size === 0) {
    if (env.isProd) {
      throw new Error(
        'VAULT_KEYS is required in production. Generate one with: ' +
          `node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    // Development only: a key derived from a constant, so a fresh checkout
    // works. Anything sealed with it is as good as plain text, which is fine
    // for test credentials and never acceptable for real ones.
    logger.warn('vault.development_key', { message: 'VAULT_KEYS is not set; using an insecure development key.' });
    keys.set('v0', crypto.createHash('sha256').update('veylog-development-vault-key').digest());
  }

  const active = (process.env.VAULT_ACTIVE_KEY ?? '').trim() || [...keys.keys()].sort().pop()!;
  if (!keys.has(active)) throw new Error(`VAULT_ACTIVE_KEY "${active}" is not in VAULT_KEYS.`);
  return { active, keys };
}

let keyring: Keyring | null = null;
function ring(): Keyring {
  keyring ??= loadKeyring();
  return keyring;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export const vault = {
  seal(plaintext: string, associatedData: string): string {
    const { active, keys } = ring();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(active)!, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, active, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
  },

  open(sealed: string, associatedData: string): string {
    const parts = sealed.split(':');
    if (parts.length !== 5 || parts[0] !== PREFIX) throw new VaultError('Not a vault value.');
    const [, version, ivPart, tagPart, dataPart] = parts;
    const key = ring().keys.get(version);
    if (!key) throw new VaultError(`Vault key ${version} is no longer available.`);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, tampered ciphertext, or sealed for a different row. All
      // three mean the same thing to the caller and none leak which.
      throw new VaultError('Secret could not be decrypted.');
    }
  },

  sealJson(value: unknown, associatedData: string): string {
    return this.seal(JSON.stringify(value), associatedData);
  },

  openJson<T>(sealed: string, associatedData: string): T {
    return JSON.parse(this.open(sealed, associatedData)) as T;
  },

  /** True when the value was sealed with a key other than the active one. */
  needsReseal(sealed: string): boolean {
    return sealed.split(':')[1] !== ring().active;
  },

  /** Enough of a secret to recognise it, never enough to use it. */
  hint(secret: string): string {
    const tail = secret.slice(-4);
    return secret.length <= 8 ? '••••' : `••••${tail}`;
  },

  /** Test hook: forget the loaded keys so the next call re-reads the environment. */
  reset(): void {
    keyring = null;
  },
};
