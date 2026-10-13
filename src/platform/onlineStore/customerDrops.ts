/* eslint-disable @typescript-eslint/no-explicit-any */
import { Drop } from 'liquidjs';
import { cents, imageDrop } from './drops';
import {
  customerAccountRepository,
  type AccountCustomerRow,
  type AccountOrderItemRow,
  type AccountOrderRow,
  type AddressRow,
  type OrderAddressRow,
  type OrderEventRow,
  type OrderShipmentRow,
} from './customerAccount.repository';

/**
 * `customer`, `order` and `address` for the account templates — shaped like
 * Shopify's (money in cents, `order.name` "#…", `address.province_code`,
 * `customer.orders` paginated with {% paginate %}) so a theme's account pages
 * written against Shopify's docs work unchanged.
 */

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const sentence = (value: string) => value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Our payment states, as Shopify's financial_status. */
const FINANCIAL: Record<string, string> = {
  pending: 'pending',
  cod_pending: 'pending',
  authorized: 'authorized',
  paid: 'paid',
  cod_collected: 'paid',
  partially_refunded: 'partially_refunded',
  refunded: 'refunded',
  failed: 'voided',
  cancelled: 'voided',
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: 'Payment pending',
  cod_pending: 'Payment due on delivery',
  authorized: 'Authorized',
  paid: 'Paid',
  cod_collected: 'Paid on delivery',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  failed: 'Payment failed',
  cancelled: 'Cancelled',
};

const ORDER_LABELS: Record<string, string> = {
  pending: 'Order placed',
  confirmed: 'Confirmed',
  processing: 'Processing',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  rto: 'Returned to sender',
};

export interface AddressLike {
  id: number | null;
  first_name: string;
  last_name: string;
  name: string;
  company: string | null;
  address1: string;
  address2: string;
  street: string;
  city: string;
  province: string;
  province_code: string | null;
  zip: string;
  country: string;
  country_code: string;
  phone: string;
  landmark: string | null;
  default: boolean;
  url: string | null;
  summary: string;
}

export function addressDrop(row: AddressRow | OrderAddressRow | null, options: { id?: number; isDefault?: boolean } = {}): AddressLike | null {
  if (!row) return null;
  const address2 = [row.line2, row.landmark].filter(Boolean).join(', ');
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ');
  const id = options.id ?? (row as AddressRow).id ?? null;
  const summary = [row.line1, address2, row.city, `${row.state} ${row.pincode}`.trim(), countryName(row.country)].filter(Boolean).join(', ');
  return {
    id,
    first_name: row.first_name,
    last_name: row.last_name ?? '',
    name,
    company: null,
    address1: row.line1,
    address2: row.line2 ?? '',
    street: [row.line1, row.line2].filter(Boolean).join(', '),
    city: row.city,
    province: row.state,
    province_code: row.state_code,
    zip: row.pincode,
    country: countryName(row.country),
    country_code: row.country,
    phone: row.phone,
    landmark: row.landmark,
    default: options.isDefault ?? (row as AddressRow).is_default_shipping === 1,
    url: id && 'is_default_shipping' in row ? `/account/addresses/${id}` : null,
    summary,
  };
}

function lineItem(row: AccountOrderItemRow, fulfilment: ReturnType<typeof fulfilmentOf>) {
  const price = cents(row.unit_price) ?? 0;
  const original = Math.max(price, cents(row.unit_mrp) ?? 0);
  const total = cents(row.line_total) ?? price * row.quantity;
  const url = row.product_slug ? `/products/${row.product_slug}` : null;
  return {
    id: row.id,
    key: String(row.id),
    title: row.variant_title ? `${row.product_name} - ${row.variant_title}` : row.product_name,
    product_title: row.product_name,
    variant_title: row.variant_title,
    variant_id: row.variant_id,
    product_id: row.product_id,
    sku: row.sku,
    quantity: row.quantity,
    price,
    original_price: original,
    final_price: price,
    line_price: total,
    original_line_price: original * row.quantity,
    final_line_price: total,
    line_level_total_discount: cents(row.discount_amount) ?? 0,
    url,
    image: imageDrop(row.image_url, row.product_name),
    product: { title: row.product_name, url, handle: row.product_slug },
    variant: { id: row.variant_id, title: row.variant_title, sku: row.sku },
    fulfillment: row.fulfilled_quantity > 0 ? fulfilment : null,
    successfully_fulfilled_quantity: row.fulfilled_quantity,
    options_with_values: row.variant_title ? [{ name: 'Variant', value: row.variant_title }] : [],
    discount_allocations: [],
    properties: {},
    gift_card: false,
  };
}

function fulfilmentOf(shipment: OrderShipmentRow | undefined) {
  if (!shipment) return null;
  return {
    created_at: shipment.shipped_at,
    tracking_company: shipment.carrier_name,
    tracking_number: shipment.awb_number,
    tracking_numbers: shipment.awb_number ? [shipment.awb_number] : [],
    tracking_url: shipment.tracking_url,
    tracking_urls: shipment.tracking_url ? [shipment.tracking_url] : [],
    status: shipment.status,
    status_label: sentence(shipment.status),
  };
}

export class OrderDrop extends Drop {
  private details: Promise<{ items: any[]; shipping: AddressLike | null; billing: AddressLike | null; fulfillments: any[]; events: any[] }> | null = null;

  constructor(
    private readonly row: AccountOrderRow,
    private readonly preloaded: { items?: AccountOrderItemRow[] } = {},
  ) {
    super();
  }

  /** Items, addresses, shipments and history: loaded once, the first time any is asked for. */
  private load() {
    this.details ??= (async () => {
      const [items, addresses, shipments, events] = await Promise.all([
        this.preloaded.items ?? customerAccountRepository.orderItems([this.row.id]),
        customerAccountRepository.orderAddresses(this.row.id),
        customerAccountRepository.orderShipments(this.row.id),
        customerAccountRepository.orderEvents(this.row.id),
      ]);
      const latest = fulfilmentOf(shipments[shipments.length - 1]);
      const shipping = addressDrop(addresses.find((address) => address.address_type === 'shipping') ?? null, { id: 0, isDefault: false });
      const billing = addressDrop(addresses.find((address) => address.address_type === 'billing') ?? null, { id: 0, isDefault: false }) ?? shipping;
      return {
        items: items.map((item) => lineItem(item, latest)),
        shipping,
        billing,
        fulfillments: shipments.map((shipment) => fulfilmentOf(shipment)),
        events: events.map((event: OrderEventRow) => ({
          type: event.status_type,
          status: event.to_status,
          label: event.status_type === 'order' ? (ORDER_LABELS[event.to_status] ?? sentence(event.to_status)) : event.status_type === 'payment' ? (PAYMENT_LABELS[event.to_status] ?? sentence(event.to_status)) : sentence(event.to_status),
          note: event.note,
          created_at: event.created_at,
        })),
      };
    })();
    return this.details;
  }

  get id() {
    return this.row.public_id;
  }
  get name() {
    return `#${this.row.order_number}`;
  }
  get order_number() {
    return this.row.order_number;
  }
  get order_name() {
    return this.row.order_number;
  }
  get created_at() {
    return this.row.placed_at ?? this.row.created_at;
  }
  get processed_at() {
    return this.created_at;
  }
  get currency() {
    return this.row.currency;
  }
  get customer_url() {
    return `/account/orders/${this.row.public_id}`;
  }
  get cancelled() {
    return this.row.order_status === 'cancelled';
  }
  get cancelled_at() {
    return this.row.cancelled_at;
  }
  get cancel_reason() {
    return this.row.cancel_reason;
  }
  get cancel_reason_label() {
    return this.row.cancel_reason;
  }
  get financial_status() {
    return FINANCIAL[this.row.payment_status] ?? 'pending';
  }
  get financial_status_label() {
    return PAYMENT_LABELS[this.row.payment_status] ?? sentence(this.row.payment_status);
  }
  get fulfillment_status() {
    return this.row.fulfillment_status === 'partially_fulfilled' ? 'partial' : this.row.fulfillment_status;
  }
  get fulfillment_status_label() {
    return sentence(this.row.fulfillment_status);
  }
  /** The order's own progress ("Shipped"), which says more than Shopify's two statuses. */
  get status() {
    return this.row.order_status;
  }
  get status_label() {
    return ORDER_LABELS[this.row.order_status] ?? sentence(this.row.order_status);
  }
  get payment_method() {
    return this.row.payment_method === 'cod' ? 'Cash on delivery' : this.row.payment_method ? sentence(this.row.payment_method) : null;
  }
  get transactions() {
    return this.row.payment_method ? [{ gateway: this.row.payment_method, gateway_display_name: this.payment_method, kind: 'sale', status: this.financial_status }] : [];
  }
  get estimated_delivery() {
    if (!this.row.estimated_delivery_from || ['delivered', 'cancelled', 'returned', 'rto'].includes(this.row.order_status)) return null;
    return { from: this.row.estimated_delivery_from, to: this.row.estimated_delivery_to };
  }
  get delivered_at() {
    return this.row.delivered_at;
  }
  get item_count() {
    return Number(this.row.item_count);
  }
  get note() {
    return this.row.customer_note;
  }
  get subtotal_price() {
    return cents(this.row.subtotal);
  }
  get line_items_subtotal_price() {
    return cents(this.row.subtotal);
  }
  get total_discounts() {
    return cents(this.row.discount_total);
  }
  get shipping_price() {
    return cents(Number(this.row.shipping_total) + Number(this.row.cod_fee));
  }
  get tax_price() {
    return cents(this.row.tax_total);
  }
  get total_price() {
    return cents(this.row.grand_total);
  }
  get total_net_amount() {
    return cents(this.row.grand_total);
  }
  get discount_applications() {
    return Number(this.row.discount_total) > 0
      ? [{ title: this.row.coupon_code ?? 'Discount', total_allocated_amount: cents(this.row.discount_total), type: this.row.coupon_code ? 'discount_code' : 'automatic', value_type: 'fixed_amount' }]
      : [];
  }
  get shipping_methods() {
    return [{ title: Number(this.row.cod_fee) > 0 ? 'Shipping (incl. cash on delivery fee)' : 'Shipping', price: this.shipping_price }];
  }
  /** Prices included the tax (as Indian MRPs do): the total is not goods + delivery + tax. */
  get taxes_included() {
    const beforeTax = Number(this.row.subtotal) - Number(this.row.discount_total) + Number(this.row.shipping_total) + Number(this.row.cod_fee);
    return Number(this.row.tax_total) > 0 && Math.abs(beforeTax - Number(this.row.grand_total)) < 0.01;
  }
  get tax_lines() {
    return Number(this.row.tax_total) > 0 ? [{ title: 'Tax', price: cents(this.row.tax_total), rate: null }] : [];
  }
  get line_items() {
    return this.load().then((details) => details.items);
  }
  get shipping_address() {
    return this.load().then((details) => details.shipping);
  }
  get billing_address() {
    return this.load().then((details) => details.billing);
  }
  get fulfillments() {
    return this.load().then((details) => details.fulfillments);
  }
  /** Customer-visible history, oldest first. */
  get timeline() {
    return this.load().then((details) => details.events);
  }
}

export class CustomerDrop extends Drop {
  private addressList: Promise<AddressLike[]> | null = null;

  constructor(private readonly row: AccountCustomerRow) {
    super();
  }

  private loadAddresses() {
    this.addressList ??= customerAccountRepository.addresses(this.row.id).then((rows) => rows.map((row) => addressDrop(row)!));
    return this.addressList;
  }

  get id() {
    return this.row.public_id;
  }
  get first_name() {
    return this.row.first_name ?? '';
  }
  get last_name() {
    return this.row.last_name ?? '';
  }
  get name() {
    return [this.row.first_name, this.row.last_name].filter(Boolean).join(' ') || this.phone;
  }
  get email() {
    return this.row.email;
  }
  get phone() {
    return `${this.row.country_code}${this.row.phone}`;
  }
  get has_account() {
    return true;
  }
  get accepts_marketing() {
    return this.row.accepts_email_marketing === 1;
  }
  get email_marketing_consent() {
    return { state: this.row.accepts_email_marketing === 1 ? 'subscribed' : 'not_subscribed' };
  }
  get orders_count() {
    return this.row.orders_count;
  }
  get total_spent() {
    return cents(this.row.total_spent);
  }
  get tags() {
    return [];
  }
  get tax_exempt() {
    return false;
  }
  get created_at() {
    return this.row.created_at;
  }
  get addresses() {
    return this.loadAddresses();
  }
  get addresses_count() {
    return this.loadAddresses().then((list) => list.length);
  }
  get default_address() {
    return this.loadAddresses().then((list) => list.find((address) => address.default) ?? list[0] ?? null);
  }
  /** For {% form 'customer_address', customer.new_address %}. */
  get new_address() {
    return { id: null, first_name: this.row.first_name ?? '', last_name: this.row.last_name ?? '', phone: this.row.phone, country_code: null };
  }
  get orders() {
    return this.pageOfOrders(20, 1).then((result) => result.items);
  }
  get last_order() {
    return this.pageOfOrders(1, 1).then((result) => result.items[0] ?? null);
  }

  /** {% paginate customer.orders by 10 %} */
  async paginateProperty(property: string, pageSize: number, page: number) {
    if (property === 'orders') return this.pageOfOrders(pageSize, page);
    if (property === 'addresses') {
      const list = await this.loadAddresses();
      return { items: list.slice((page - 1) * pageSize, page * pageSize), total: list.length };
    }
    return { items: [], total: 0 };
  }

  private async pageOfOrders(pageSize: number, page: number) {
    const [rows, total] = await Promise.all([
      customerAccountRepository.orders(this.row.id, pageSize, (page - 1) * pageSize),
      customerAccountRepository.countOrders(this.row.id),
    ]);
    const items = await customerAccountRepository.orderItems(rows.map((row) => row.id));
    return { items: rows.map((row) => new OrderDrop(row, { items: items.filter((item) => item.order_id === row.id) })), total };
  }
}

export async function loadCustomer(customerId: number): Promise<CustomerDrop | null> {
  const row = await customerAccountRepository.customer(customerId);
  if (!row || row.status !== 'active') return null;
  return new CustomerDrop(row);
}

export async function loadOrder(customerId: number, reference: string): Promise<OrderDrop | null> {
  const row = await customerAccountRepository.order(customerId, reference);
  return row ? new OrderDrop(row) : null;
}

// ── the theme editor's sample customer ─────────────────────────────────────

/**
 * Who the account pages show in the theme editor, where nobody is signed in:
 * a made-up customer with a couple of orders, so the merchant can style the
 * pages without being handed a real shopper's details.
 */
export function sampleCustomer(currency: string) {
  const address: AddressLike = {
    id: 1,
    first_name: 'Asha',
    last_name: 'Rao',
    name: 'Asha Rao',
    company: null,
    address1: '14 Lake View Road',
    address2: 'Flat 3B',
    street: '14 Lake View Road, Flat 3B',
    city: 'Bengaluru',
    province: 'Karnataka',
    province_code: 'KA',
    zip: '560001',
    country: 'India',
    country_code: 'IN',
    phone: '+919800000000',
    landmark: null,
    default: true,
    url: '/account/addresses/1',
    summary: '14 Lake View Road, Flat 3B, Bengaluru, Karnataka 560001, India',
  };
  const line = (title: string, price: number, quantity: number) => ({
    id: title.length,
    key: title,
    title,
    product_title: title,
    variant_title: null,
    quantity,
    price,
    original_price: price,
    final_price: price,
    line_price: price * quantity,
    original_line_price: price * quantity,
    final_line_price: price * quantity,
    line_level_total_discount: 0,
    url: '/collections/all',
    image: null,
    product: { title, url: '/collections/all' },
    variant: { title: null },
    fulfillment: null,
    options_with_values: [],
    discount_allocations: [],
    properties: {},
  });
  const order = (number: string, status: string, statusLabel: string, items: ReturnType<typeof line>[], daysAgo: number) => {
    const subtotal = items.reduce((sum, item) => sum + item.final_line_price, 0);
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    return {
      id: number,
      name: `#${number}`,
      order_number: number,
      created_at: date,
      processed_at: date,
      currency,
      customer_url: '/account/orders/sample',
      cancelled: false,
      financial_status: 'paid',
      financial_status_label: 'Paid',
      fulfillment_status: status === 'delivered' ? 'fulfilled' : 'unfulfilled',
      fulfillment_status_label: status === 'delivered' ? 'Fulfilled' : 'Unfulfilled',
      status,
      status_label: statusLabel,
      payment_method: 'Card',
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      line_items: items,
      subtotal_price: subtotal,
      line_items_subtotal_price: subtotal,
      total_discounts: 0,
      shipping_price: 0,
      tax_price: 0,
      total_price: subtotal,
      discount_applications: [],
      shipping_methods: [{ title: 'Standard shipping', price: 0 }],
      tax_lines: [],
      shipping_address: address,
      billing_address: address,
      fulfillments: [],
      estimated_delivery: status === 'delivered' ? null : { from: new Date(Date.now() + 2 * 86_400_000), to: new Date(Date.now() + 4 * 86_400_000) },
      timeline: [
        { type: 'order', status: 'pending', label: 'Order placed', note: null, created_at: date },
        ...(status === 'delivered' ? [{ type: 'order', status: 'delivered', label: 'Delivered', note: null, created_at: new Date(date.getTime() + 3 * 86_400_000) }] : []),
      ],
    };
  };
  const orders = [
    order('SAMPLE1002', 'shipped', 'Shipped', [line('Sample product', 129900, 1), line('Another product', 49900, 2)], 2),
    order('SAMPLE1001', 'delivered', 'Delivered', [line('Sample product', 129900, 1)], 30),
  ];
  return {
    customer: {
      id: 'sample',
      first_name: 'Asha',
      last_name: 'Rao',
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '+919800000000',
      has_account: true,
      accepts_marketing: true,
      orders_count: orders.length,
      total_spent: orders.reduce((sum, entry) => sum + entry.total_price, 0),
      tags: [],
      addresses: [address],
      addresses_count: 1,
      default_address: address,
      new_address: { id: null, first_name: 'Asha', last_name: 'Rao', phone: '9800000000', country_code: null },
      orders,
      last_order: orders[0],
    },
    order: orders[0],
  };
}
