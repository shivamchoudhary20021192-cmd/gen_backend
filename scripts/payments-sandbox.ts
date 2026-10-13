/**
 * Runs the stand-in Razorpay on a fixed port and keeps it there.
 *
 *   npm run sandbox:payments        # gateway on 4020
 *   RAZORPAY_KEY_ID=rzp_test_smoke1234567 \
 *   RAZORPAY_KEY_SECRET=smoke_key_secret_value \
 *   RAZORPAY_WEBHOOK_SECRET=smoke_webhook_secret_value \
 *   RAZORPAY_API_BASE=http://127.0.0.1:4020/v1 \
 *   node dist/src/server.js
 *
 * For driving the storefront in a browser, where the real Razorpay Checkout
 * overlay cannot be reached. `smoke:payments` does not need this — it starts
 * its own copy.
 *
 * Test infrastructure. Never run this anywhere money is real.
 */
import { FakeRazorpay } from './fake-razorpay';

const PORT = Number(process.env.FAKE_RAZORPAY_PORT ?? 4020);
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? 'rzp_test_smoke1234567';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? 'smoke_key_secret_value';

async function main(): Promise<void> {
  const gateway = new FakeRazorpay({ keyId: KEY_ID, keySecret: KEY_SECRET, port: PORT });
  await gateway.start();

  process.stdout.write(
    [
      '',
      'Stand-in Razorpay is listening.',
      '',
      `  API base   ${gateway.baseUrl}`,
      `  key id     ${KEY_ID}`,
      `  control    POST http://127.0.0.1:${PORT}/__control/pay  { "order_id": "order_..." }`,
      '',
      'Start the API against it with RAZORPAY_API_BASE set to the API base above.',
      '',
    ].join('\n'),
  );

  const stop = async (): Promise<void> => {
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
