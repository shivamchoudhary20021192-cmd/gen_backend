import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { twilioSignature } from '../../src/platform/integrations/providers/twilio';
import { verifyStripeSignature } from '../../src/platform/integrations/providers/payments';
import { assertAcceptableUrl, isPrivateAddress, UnsafeTargetError } from '../../src/platform/security/safeHttp';
import { vault, VaultError } from '../../src/platform/security/vault';
import { signWebhook, verifyWebhookSignature } from '../../src/platform/webhooks/signing';
import { checkoutSignature, verifyCheckoutSignature } from '../../src/modules/payments/gateway/signatures';

describe('vault', () => {
  it('round-trips, and binds the ciphertext to its context', () => {
    const sealed = vault.seal('sk_live_secret', 'integration:1:abc');
    assert.notEqual(sealed, 'sk_live_secret');
    assert.equal(vault.open(sealed, 'integration:1:abc'), 'sk_live_secret');
    // Copied into another shop's row, it does not open.
    assert.throws(() => vault.open(sealed, 'integration:2:abc'), VaultError);
  });

  it('detects tampering', () => {
    const sealed = vault.seal('value', 'ctx');
    const parts = sealed.split(':');
    const data = Buffer.from(parts[4], 'base64url');
    data[0] ^= 0xff;
    parts[4] = data.toString('base64url');
    assert.throws(() => vault.open(parts.join(':'), 'ctx'), VaultError);
  });

  it('never produces the same ciphertext twice', () => {
    assert.notEqual(vault.seal('same', 'ctx'), vault.seal('same', 'ctx'));
  });
});

describe('outbound webhook signatures', () => {
  it('verifies the exact bytes and nothing else', () => {
    const body = JSON.stringify({ id: 1, total: '10.00' });
    const header = signWebhook(body, 'whsec_test');
    assert.equal(verifyWebhookSignature(body, 'whsec_test', header), true);
    assert.equal(verifyWebhookSignature(body.replace('10.00', '1.00'), 'whsec_test', header), false);
    assert.equal(verifyWebhookSignature(body, 'another_secret', header), false);
    assert.equal(verifyWebhookSignature(body, 'whsec_test', undefined), false);
  });
});

describe('provider signatures', () => {
  it('Twilio: HMAC-SHA1 over URL + sorted params, and any change breaks it', () => {
    const url = 'https://api.example.com/integrations/inbound/shop/conn';
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered', To: '+15550100' };
    const signature = twilioSignature('token', url, params);
    const expected = crypto.createHmac('sha1', 'token').update(`${url}MessageSidSM123MessageStatusdeliveredTo+15550100`).digest('base64');
    assert.equal(signature, expected);
    assert.notEqual(twilioSignature('token', url, { ...params, MessageStatus: 'failed' }), signature);
  });

  it('Stripe: accepts a fresh signed payload, refuses stale or forged ones', () => {
    const body = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const v1 = crypto.createHmac('sha256', 'whsec_x').update(`${t}.`).update(body).digest('hex');
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec_x', 300, now), true);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${v1}`, 'whsec_x', 300, now + 3_600_000), false);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)}`, 'whsec_x', 300, now), false);
    assert.equal(verifyStripeSignature(Buffer.from('{}'), `t=${t},v1=${v1}`, 'whsec_x', 300, now), false);
  });

  it('Razorpay checkout: HMAC of "order|payment" under the key secret', () => {
    const signature = checkoutSignature('order_1', 'pay_1', 'secret');
    assert.equal(verifyCheckoutSignature({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1', signature }, 'secret'), true);
    assert.equal(verifyCheckoutSignature({ razorpayOrderId: 'order_2', razorpayPaymentId: 'pay_1', signature }, 'secret'), false);
  });
});

describe('SSRF protection', () => {
  it('recognises private, loopback and link-local addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('refuses non-https, embedded credentials and internal hostnames', () => {
    assert.throws(() => assertAcceptableUrl('http://example.com/hook', false), UnsafeTargetError);
    assert.throws(() => assertAcceptableUrl('https://user:pass@example.com/hook', false), UnsafeTargetError);
    assert.throws(() => assertAcceptableUrl('https://localhost/hook', false), UnsafeTargetError);
    assert.throws(() => assertAcceptableUrl('https://169.254.169.254/latest/meta-data', false), UnsafeTargetError);
    assert.equal(assertAcceptableUrl('https://hooks.example.com/orders', false).hostname, 'hooks.example.com');
  });
});

describe('S3 Signature V4', () => {
  it('matches the AWS documentation known-answer vector (GET object with Range)', async () => {
    const { signV4 } = await import('../../src/modules/media/storage/S3Driver');
    // From "Signature Calculations for the Authorization Header: Example GET Object".
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});
