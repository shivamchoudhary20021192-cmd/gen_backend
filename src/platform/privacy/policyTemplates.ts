import type { PolicyKind } from './policies';

/**
 * "Create from template": a first draft of each policy, filled in from the
 * store's details, for the merchant to read, adapt and publish.
 *
 * Written for a store selling from India, which is where most of these stores
 * are, and for the places it may sell to:
 *
 *   India   Digital Personal Data Protection Act 2023 (notice, consent, the
 *           rights of a data principal, a grievance contact, the Data
 *           Protection Board); Consumer Protection (E-Commerce) Rules 2020
 *           (seller details, a grievance officer who acknowledges within 48
 *           hours and resolves within a month; return, refund, exchange and
 *           delivery terms displayed); CGST Act s.36 (records kept 72 months).
 *   EU/UK   GDPR / UK GDPR: controller, purposes and legal bases, recipients,
 *           transfers, retention, rights, the right to complain.
 *   US      CCPA/CPRA and other state laws: categories, the right to know,
 *           delete, correct and opt out of sale or sharing; GPC honoured.
 *
 * A draft is not advice: the admin says so next to the button. Anything the
 * store's details cannot supply is left as a [bracketed] placeholder.
 */

export interface PolicyContext {
  shopName: string;
  legalName: string;
  address: string | null;
  gstin: string | null;
  email: string | null;
  phone: string | null;
  supportHours: string | null;
  countryCode: string;
  storeUrl: string;
  privacyEmail: string | null;
  grievanceName: string | null;
  grievanceEmail: string | null;
  grievancePhone: string | null;
  responseDays: number;
  requestUrl: string;
  choicesUrl: string;
  today: string;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const or = (value: string | null | undefined, placeholder: string) => (value && value.trim() ? esc(value.trim()) : `[${placeholder}]`);

function grievanceBlock(c: PolicyContext): string {
  return `<p><strong>Grievance Officer:</strong> ${or(c.grievanceName, 'name and designation')}<br>
Email: ${or(c.grievanceEmail ?? c.privacyEmail ?? c.email, 'email address')}<br>
Phone: ${or(c.grievancePhone ?? c.phone, 'phone number')}<br>
Address: ${or(c.address, 'postal address')}</p>`;
}

function privacy(c: PolicyContext): string {
  const contact = or(c.privacyEmail ?? c.email, 'privacy email address');
  const india = c.countryCode === 'IN';
  return `<p><em>Last updated: ${esc(c.today)}</em></p>
<p>This privacy policy explains how ${or(c.legalName, 'legal name')} ("we", "us"), which operates ${esc(c.shopName)} at <a href="${esc(c.storeUrl)}">${esc(c.storeUrl)}</a>, collects, uses and shares your personal data when you visit the store, buy from it or contact us, and the choices and rights you have. ${india ? 'For the Digital Personal Data Protection Act 2023, we are the Data Fiduciary and you are the Data Principal.' : ''} Under the GDPR we are the data controller.</p>

<h2>Who we are</h2>
<p>${or(c.legalName, 'legal name')}<br>${or(c.address, 'registered address')}<br>Email: ${contact}${c.phone ? `<br>Phone: ${esc(c.phone)}` : ''}</p>

<h2>What we collect</h2>
<ul>
<li><strong>What you give us:</strong> your name, phone number, email address, delivery and billing addresses, the details of your orders, messages you send us, reviews you write, and preferences you share with us.</li>
<li><strong>Payment:</strong> payments are processed by our payment providers. We receive confirmation of the payment and limited details such as the method used; we do not see or store your full card number.</li>
<li><strong>What your device tells us:</strong> your IP address, browser and device type, the pages you view and how you arrived — some of it through cookies, as described below.</li>
<li><strong>From others:</strong> delivery status from our shipping partners and fraud checks from our payment providers.</li>
</ul>

<h2>Why we use it, and on what basis</h2>
<ul>
<li><strong>Taking, delivering and supporting your orders, returns and refunds, and your account</strong> — performing our contract with you${india ? '; the purpose you gave the data for (DPDP s.7(a))' : ''}.</li>
<li><strong>Keeping the store and your account secure, and preventing fraud</strong> — our legitimate interests${india ? '; legitimate uses under DPDP s.7' : ''}.</li>
<li><strong>Keeping tax and accounting records, and answering lawful requests</strong> — legal obligation.</li>
<li><strong>Marketing emails, SMS and WhatsApp messages</strong> — your consent, which you can withdraw at any time (the unsubscribe link in every message, or your account).</li>
<li><strong>Analytics, remembering your preferences, and advertising cookies</strong> — your consent, where the law requires it (see Cookies).</li>
</ul>

<h2>Cookies</h2>
<p>Strictly necessary cookies keep the store working — your cart, checkout, signing in, security, and remembering your cookie choices — and are always on. Analytics, preferences and marketing cookies are used only with your consent where the law requires consent, and you can accept all, reject all, or choose each kind in the cookie banner. You can change your mind at any time with the <strong>Cookie preferences</strong> link at the bottom of every page.</p>

<h2>Who we share it with</h2>
<p>We share personal data only as needed to run the store: our e-commerce platform and hosting providers, payment providers, delivery partners, and messaging providers that send our emails, SMS and WhatsApp messages, each bound to use it only for us; professional advisers; and authorities where the law requires. If our business is sold or reorganised, the data may pass to the new owner under this policy.</p>
<p><strong>Sale or sharing (US residents):</strong> we do not sell personal data for money. Some advertising cookies may count as "selling" or "sharing" under US state laws. You can opt out on our <a href="${esc(c.choicesUrl)}">Your privacy choices</a> page, and we treat a Global Privacy Control signal from your browser as an opt-out.</p>

<h2>International transfers</h2>
<p>Our providers may process data outside the country you live in. Where that happens we rely on the safeguards the law requires, such as standard contractual clauses${india ? ', and we do not transfer data to any country the Government of India has restricted' : ''}.</p>

<h2>How long we keep it</h2>
<p>We keep your data only as long as we need it for the purposes above: your account while it is open; order, invoice and tax records for as long as tax law requires${india ? ' (in India, at least 72 months from the due date of the annual GST return, under CGST Act s.36)' : ''}; marketing preferences until you withdraw consent; and a record of the consents you gave, as proof. After that we delete or anonymise it.</p>

<h2>Your rights</h2>
<p>Depending on where you live, you have the right to:</p>
<ul>
<li>know what personal data we hold about you and get a copy of it, including in a machine-readable format;</li>
<li>have it corrected, completed or updated;</li>
<li>have it erased, where we are not required to keep it;</li>
<li>withdraw your consent at any time — as easily as you gave it — without affecting what was done before;</li>
<li>object to or restrict some uses of it (GDPR);</li>
<li>opt out of the sale or sharing of your data and of targeted advertising (US state laws);</li>
${india ? '<li>nominate someone to exercise your rights if you die or become unable to (DPDP s.14);</li>' : ''}
<li>have a grievance about how we handle your data addressed.</li>
</ul>
<p>To exercise any of these, use our <a href="${esc(c.requestUrl)}">privacy request form</a>, the privacy section of your account, or email ${contact}. We confirm the request is yours before acting on it and respond within ${c.responseDays} days. We will not treat you differently for exercising your rights.</p>

<h2>Grievances and complaints</h2>
${grievanceBlock(c)}
<p>We acknowledge a grievance within 48 hours and resolve it within one month.${india ? ' If you are not satisfied with our response, you may complain to the Data Protection Board of India.' : ''} If you are in the EU or the UK, you may also complain to your data protection authority.</p>

<h2>Children</h2>
<p>The store is not directed at children${india ? ' (anyone under 18, for the DPDP Act)' : ''}. We do not knowingly collect their data without verifiable consent from a parent or guardian; if you believe we have, contact us and we will delete it.</p>

<h2>Security</h2>
<p>We protect your data with reasonable technical and organisational safeguards, including encryption in transit, access controls and regular review. No method is perfectly secure; if a breach affects you, we will tell you and the authorities as the law requires.</p>

<h2>Changes</h2>
<p>We may update this policy. The date at the top says when it last changed; if a change is significant, we will tell you and, where your consent is needed, ask for it again.</p>`;
}

function terms(c: PolicyContext): string {
  const india = c.countryCode === 'IN';
  return `<p><em>Last updated: ${esc(c.today)}</em></p>
<h2>Overview</h2>
<p>This website is operated by ${or(c.legalName, 'legal name')} ("we", "us"). By visiting ${esc(c.shopName)} or buying from it, you agree to these terms. Please read them before using the store.</p>
<h2>Using the store</h2>
<p>You must be old enough to enter a contract where you live${india ? ' (18 in India)' : ''}. You agree not to use the store for anything unlawful, to interfere with its security, or to misuse its content.</p>
<h2>Products and prices</h2>
<p>We describe and picture products as accurately as we can, but colours and details can vary by screen. Prices and availability can change without notice. We may limit quantities and may refuse or cancel an order — for example if a price was shown in error — and will refund anything paid.</p>
<h2>Orders and payment</h2>
<p>An order is accepted when we confirm it. You agree to give accurate contact, billing and delivery details. Payments are processed by our payment providers under their terms.</p>
<h2>Delivery, returns and refunds</h2>
<p>Delivery is covered by our <a href="/policies/shipping-policy">shipping policy</a>, and returns, exchanges and refunds by our <a href="/policies/refund-policy">refund policy</a>.</p>
<h2>Your content</h2>
<p>If you post a review, comment or other content, you confirm it is yours and lawful, and you let us display it in connection with the store. We may remove content that breaks these terms.</p>
<h2>Personal data</h2>
<p>How we handle your personal data is set out in our <a href="/policies/privacy-policy">privacy policy</a>.</p>
<h2>Third-party links and tools</h2>
<p>The store may link to or use services run by others. We are not responsible for their content or practices.</p>
<h2>Liability</h2>
<p>Nothing in these terms limits rights you have as a consumer that cannot be limited by law. Otherwise, to the extent the law allows, we are not liable for indirect or consequential loss, and our liability for an order is limited to the amount you paid for it.</p>
<h2>Governing law</h2>
<p>These terms are governed by the laws of ${india ? 'India, and the courts at [city] have jurisdiction' : '[country]'}, without depriving you of the protection of the laws of the country you live in.</p>
<h2>Changes</h2>
<p>We may update these terms; the version on this page when you place an order applies to it.</p>
<h2>Contact</h2>
<p>${or(c.legalName, 'legal name')}, ${or(c.address, 'address')}. Email: ${or(c.email, 'email address')}.</p>`;
}

function refund(c: PolicyContext): string {
  const india = c.countryCode === 'IN';
  return `<p><em>Last updated: ${esc(c.today)}</em></p>
<h2>Returns</h2>
<p>You can return most items within <strong>[30] days</strong> of delivery. Items must be unused, in their original packaging, with proof of purchase.</p>
<p>For hygiene and safety, we cannot accept returns of opened or used personal-care, cosmetic and intimate products, or of gift cards, unless they arrived damaged, defective or not as described.</p>
<h2>Damaged, defective or wrong items</h2>
<p>If something arrives damaged, defective or wrong, tell us within <strong>[48 hours]</strong> of delivery with photos, and we will replace it or refund you in full, including delivery charges.</p>
<h2>How to start a return</h2>
<p>Contact us at ${or(c.email, 'email address')}${c.phone ? ` or ${esc(c.phone)}` : ''} with your order number. We will tell you how and where to send it; items sent back without asking first cannot be accepted.</p>
<h2>Exchanges</h2>
<p>The quickest way to get something different is to return the item and, once the return is accepted, place a new order.</p>
<h2>Refunds</h2>
<p>We will tell you once we have inspected your return. Approved refunds go to your original payment method within <strong>[7] working days</strong>; your bank may take a few more days to show it.${india ? ' Orders paid cash on delivery are refunded to a UPI ID or bank account you give us.' : ''}</p>
${india ? '<p>This policy is displayed as the Consumer Protection (E-Commerce) Rules 2020 require. Questions or complaints go to our grievance officer — see our <a href="/policies/contact-information">contact information</a>.</p>' : ''}`;
}

function shipping(c: PolicyContext): string {
  const india = c.countryCode === 'IN';
  return `<p><em>Last updated: ${esc(c.today)}</em></p>
<h2>Processing</h2>
<p>Orders are packed and handed to our delivery partner within <strong>[1–2] working days</strong>. Orders placed on weekends or public holidays are processed the next working day.</p>
<h2>Delivery charges and times</h2>
<p>Delivery charges and the estimated delivery date are shown at checkout before you pay. Typical delivery takes <strong>[3–7] working days</strong>${india ? ' within India' : ''}, depending on where you are.</p>
${india ? '<h2>Cash on delivery</h2><p>Cash on delivery is available on eligible orders and pin codes, as shown at checkout; a fee may apply.</p>' : ''}
<h2>Tracking</h2>
<p>We email or message you a tracking link when your order ships.</p>
<h2>International orders</h2>
<p>Where we ship abroad, import duties and taxes may be charged by the destination country. Where they are collected at checkout, the amount is shown before you pay.</p>
<h2>Problems with delivery</h2>
<p>If your order is late, lost or arrives damaged, contact us at ${or(c.email, 'email address')} and we will sort it out.</p>`;
}

function contact(c: PolicyContext): string {
  return `<p><strong>Trade name:</strong> ${esc(c.shopName)}<br>
<strong>Legal name:</strong> ${or(c.legalName, 'legal name')}<br>
<strong>Address:</strong> ${or(c.address, 'registered address')}<br>
<strong>Email:</strong> ${or(c.email, 'email address')}<br>
<strong>Phone:</strong> ${or(c.phone, 'phone number')}${c.supportHours ? ` (${esc(c.supportHours)})` : ''}<br>
${c.gstin ? `<strong>GSTIN:</strong> ${esc(c.gstin)}<br>` : c.countryCode === 'IN' ? '<strong>GSTIN:</strong> [GSTIN]<br>' : '<strong>Tax / VAT number:</strong> [number]<br>'}
</p>
<h2>Grievance officer</h2>
${grievanceBlock(c)}
<p>We acknowledge every complaint within 48 hours and resolve it within one month of receiving it.</p>`;
}

function legalNotice(c: PolicyContext): string {
  return `<p><strong>Operator:</strong> ${or(c.legalName, 'legal name')}<br>
<strong>Address:</strong> ${or(c.address, 'registered address')}<br>
<strong>Represented by:</strong> [name of director or authorised representative]<br>
<strong>Company registration:</strong> [registration number and registry]<br>
<strong>Tax / VAT number:</strong> ${c.gstin ? esc(c.gstin) : '[number]'}<br>
<strong>Email:</strong> ${or(c.email, 'email address')}<br>
<strong>Phone:</strong> ${or(c.phone, 'phone number')}</p>
<p>Consumers in the EU can use the European Commission's online dispute resolution platform at <a href="https://ec.europa.eu/consumers/odr">ec.europa.eu/consumers/odr</a>.</p>`;
}

export function policyTemplate(kind: PolicyKind, context: PolicyContext): string {
  switch (kind) {
    case 'privacy':
      return privacy(context);
    case 'terms':
      return terms(context);
    case 'refund':
      return refund(context);
    case 'shipping':
      return shipping(context);
    case 'contact':
      return contact(context);
    case 'legal_notice':
      return legalNotice(context);
  }
}
