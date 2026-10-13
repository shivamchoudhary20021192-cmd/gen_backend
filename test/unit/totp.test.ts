import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  matchTotp,
  normaliseRecoveryCode,
  otpauthUrl,
  totp,
  totpStep,
} from '../../src/core/totp';

// RFC 6238 Appendix B: SHA-1, the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches every RFC 6238 SHA-1 test vector', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      assert.equal(totp(RFC_SECRET, seconds * 1000, 8), expected, `T=${seconds}`);
      // Apps show the last six digits of the same truncation.
      assert.equal(totp(RFC_SECRET, seconds * 1000), expected.slice(-6), `T=${seconds}, 6 digits`);
    }
  });

  it('matches RFC 4226 HOTP vectors for the first counters', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((counter) => hotp(secret, counter)),
      ['755224', '287082', '359152', '969429', '338314'],
    );
  });

  it('base32 round-trips and tolerates what people paste', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    const encoded = base32Encode(bytes);
    assert.deepEqual(base32Decode(encoded), bytes);
    assert.deepEqual(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 ')), bytes);
    assert.throws(() => base32Decode('not base32!'));
  });

  it('a generated secret is 160 bits', () => {
    assert.equal(base32Decode(generateTotpSecret()).length, 20);
    assert.notEqual(generateTotpSecret(), generateTotpSecret());
  });

  it('accepts the current step and one either side, and says which', () => {
    const now = 1_700_000_000_000;
    const secret = generateTotpSecret();
    const step = totpStep(now);
    assert.equal(matchTotp(secret, totp(secret, now), now), step);
    assert.equal(matchTotp(secret, totp(secret, now - 30_000), now), step - 1);
    assert.equal(matchTotp(secret, totp(secret, now + 30_000), now), step + 1);
    assert.equal(matchTotp(secret, totp(secret, now - 90_000), now), null);
    assert.equal(matchTotp(secret, totp(secret, now + 90_000), now), null);
  });

  it('refuses anything that is not six digits', () => {
    const now = Date.now();
    const secret = generateTotpSecret();
    const code = totp(secret, now);
    assert.equal(matchTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now), totpStep(now));
    assert.equal(matchTotp(secret, code.slice(1), now), null);
    assert.equal(matchTotp(secret, `${code}0`, now), null);
    assert.equal(matchTotp(secret, 'abcdef', now), null);
    assert.equal(matchTotp(secret, '', now), null);
  });

  it('builds an otpauth URI authenticator apps read', () => {
    const url = new URL(otpauthUrl('Veylog', 'ana@example.com', 'JBSWY3DPEHPK3PXP'));
    assert.equal(url.protocol, 'otpauth:');
    assert.equal(url.host, 'totp');
    assert.equal(decodeURIComponent(url.pathname), '/Veylog:ana@example.com');
    assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
    assert.equal(url.searchParams.get('issuer'), 'Veylog');
    assert.equal(url.searchParams.get('digits'), '6');
    assert.equal(url.searchParams.get('period'), '30');
  });
});

describe('recovery codes', () => {
  it('are ten distinct, unambiguous 5-5 codes', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) {
      assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
      assert.doesNotMatch(code, /[01ilo]/);
    }
  });

  it('normalise case, spacing and the dash, and reject anything else', () => {
    assert.equal(normaliseRecoveryCode('ABCDE-FGHJK'), 'abcde-fghjk');
    assert.equal(normaliseRecoveryCode(' abcde fghjk '), 'abcde-fghjk');
    assert.equal(normaliseRecoveryCode('abcdefghjk'), 'abcde-fghjk');
    assert.equal(normaliseRecoveryCode('abcde-fghj'), null);
    assert.equal(normaliseRecoveryCode('123456'), null);
  });
});
