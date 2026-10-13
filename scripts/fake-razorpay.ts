import http from 'node:http';
import crypto from 'node:crypto';

/**
 * A stand-in Razorpay, for testing the parts that must not be guessed.
 *
 * The signature maths, the amount check, the replay handling and the paid/failed
 * state machine are all deterministic, and all of them are the difference
 * between "an order is paid" and "someone said it was". They deserve a test
 * that runs on every change, not one that needs live sandbox credentials and an
 * internet connection.
 *
 * It implements the four calls the adapter makes, with Razorpay's response
 * shapes and its Basic auth. It is a test double and nothing else: it is never
 * imported by `src/`, and it signs with whatever secret the suite gives it.
 */

export interface FakeRazorpayOptions {
  keyId: string;
  keySecret: string;
  port?: number;
}

interface FakeOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed';
  method: string;
  captured: boolean;
  fee: number;
  tax: number;
  card?: { network: string; last4: string; issuer: string };
  error_code?: string | null;
  error_description?: string | null;
}

export class FakeRazorpay {
  readonly orders = new Map<string, FakeOrder>();
  readonly payments = new Map<string, FakePayment>();
  readonly refunds = new Map<string, { id: string; payment_id: string; amount: number; status: string }>();

  /** Set to make the next call fail, so the failure paths can be exercised. */
  failNextRefund: string | null = null;
  failNextOrderCreate = false;

  private server: http.Server | null = null;
  private readonly expectedAuth: string;
  private counter = 0;

  constructor(private readonly options: FakeRazorpayOptions) {
    this.expectedAuth = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64')}`;
  }

  get baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('fake razorpay is not listening');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}${this.counter}`;
  }

  /** Simulates a shopper paying the given gateway order. */
  pay(
    orderId: string,
    overrides: Partial<Pick<FakePayment, 'amount' | 'status' | 'method' | 'captured'>> = {},
  ): FakePayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake razorpay has no order ${orderId}`);
    const payment: FakePayment = {
      id: this.id('pay'),
      order_id: orderId,
      amount: overrides.amount ?? order.amount,
      currency: order.currency,
      status: overrides.status ?? 'captured',
      method: overrides.method ?? 'upi',
      captured: overrides.captured ?? (overrides.status ?? 'captured') === 'captured',
      fee: 200,
      tax: 36,
    };
    if (payment.method === 'card') {
      payment.card = { network: 'Visa', last4: '1111', issuer: 'HDFC' };
    }
    if (payment.status === 'failed') {
      payment.error_code = 'BAD_REQUEST_ERROR';
      payment.error_description = 'Payment failed at the bank.';
    }
    this.payments.set(payment.id, payment);
    return payment;
  }

  /** The webhook body Razorpay would send for a payment. */
  webhookBody(event: string, payment: FakePayment): string {
    return JSON.stringify({
      entity: 'event',
      event,
      contains: ['payment'],
      payload: { payment: { entity: { ...payment, entity: 'payment' } } },
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  refundWebhookBody(event: string, refundId: string, status: string): string {
    const refund = this.refunds.get(refundId);
    return JSON.stringify({
      entity: 'event',
      event,
      contains: ['refund'],
      payload: {
        refund: {
          entity: {
            id: refundId,
            entity: 'refund',
            payment_id: refund?.payment_id ?? null,
            amount: refund?.amount ?? 0,
            status,
            acquirer_data: { arn: '10000000000000' },
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          this.route(req, res, body);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { description: String(error) } }));
        }
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    /**
     * A control endpoint the real Razorpay does not have.
     *
     * The browser test cannot drive Razorpay's hosted overlay, so its stub asks
     * here for a payment against a gateway order — which makes the payment real
     * as far as the rest of the system is concerned, rather than a forged id
     * the server would then (correctly) fail to fetch. Unauthenticated because
     * it is a test double, and it exists nowhere near `src/`.
     */
    if (req.method === 'POST' && (req.url ?? '').startsWith('/__control/pay')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const parsedControl = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      try {
        const payment = this.pay(String(parsedControl.order_id), {
          method: typeof parsedControl.method === 'string' ? parsedControl.method : 'upi',
        });
        send(200, { payment_id: payment.id });
      } catch (error) {
        send(400, { error: { description: String(error) } });
      }
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      });
      res.end();
      return;
    }

    // Razorpay authenticates with HTTP Basic on every call. Checking it here
    // means the suite would catch an adapter that forgot the header.
    if (req.headers.authorization !== this.expectedAuth) {
      send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
      return;
    }

    const url = (req.url ?? '').replace(/^\/v1/, '');
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (req.method === 'POST' && url === '/orders') {
      if (this.failNextOrderCreate) {
        this.failNextOrderCreate = false;
        send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Order creation refused.' } });
        return;
      }
      const amount = Number(parsed.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be a positive integer' } });
        return;
      }
      const order: FakeOrder = {
        id: this.id('order'),
        amount,
        currency: String(parsed.currency ?? 'INR'),
        receipt: String(parsed.receipt ?? ''),
        status: 'created',
      };
      this.orders.set(order.id, order);
      send(200, { ...order, entity: 'order', attempts: 0, notes: parsed.notes ?? {} });
      return;
    }

    const paymentFetch = url.match(/^\/payments\/([^/]+)$/);
    if (req.method === 'GET' && paymentFetch) {
      const payment = this.payments.get(paymentFetch[1]);
      if (!payment) {
        send(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
        return;
      }
      send(200, { ...payment, entity: 'payment' });
      return;
    }

    const refundCall = url.match(/^\/payments\/([^/]+)\/refund$/);
    if (req.method === 'POST' && refundCall) {
      if (this.failNextRefund) {
        const description = this.failNextRefund;
        this.failNextRefund = null;
        send(400, { error: { code: 'BAD_REQUEST_ERROR', description } });
        return;
      }
      const refund = {
        id: this.id('rfnd'),
        payment_id: refundCall[1],
        amount: Number(parsed.amount),
        status: 'pending',
      };
      this.refunds.set(refund.id, refund);
      send(200, { ...refund, entity: 'refund', speed_requested: 'normal', acquirer_data: {} });
      return;
    }

    send(404, { error: { code: 'BAD_REQUEST_ERROR', description: `no fake route for ${req.method} ${url}` } });
  }
}
