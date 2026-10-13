/**
 * Indian state codes and the GST split that depends on them.
 *
 * Under GST, whether a sale is taxed as CGST+SGST or as IGST is decided by one
 * comparison: the place of supply against the supplier's state. Same state and
 * the tax splits in half between centre and state; different state and the whole
 * amount is IGST. Getting this wrong is not cosmetic — it is a wrong tax
 * invoice, and it is wrong on every order shipped outside the warehouse state.
 *
 * The codes are the GSTIN prefixes, which is why they are strings: '07' is
 * Delhi and '7' is nothing.
 */
export const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  haryana: '06',
  delhi: '07',
  'new delhi': '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  puducherry: '34',
  pondicherry: '34',
  'andaman and nicobar islands': '35',
  telangana: '36',
  'andhra pradesh': '37',
  ladakh: '38',
};

/**
 * Resolves a state name to its GST code.
 *
 * Customers type state names, not codes, so this has to be forgiving about
 * case, spacing and the "&" people use for "and". It returns null rather than
 * guessing — an invoice with a made-up place of supply is worse than one that
 * refuses to issue.
 */
export function stateCodeFor(state: string | null | undefined): string | null {
  if (!state) return null;
  const normalised = state
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ');
  return STATE_CODES[normalised] ?? null;
}

export function stateNameFor(code: string | null | undefined): string | null {
  if (!code) return null;
  const entry = Object.entries(STATE_CODES).find(([, value]) => value === code);
  if (!entry) return null;
  return entry[0].replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface GstSplit {
  /** True when supplier and place of supply are the same state. */
  intraState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Splits a tax amount across CGST/SGST or IGST.
 *
 * When the place of supply is unknown the sale is treated as intra-state,
 * because the warehouse state is where an unidentified buyer is presumed to be
 * — and under-collecting IGST on an inter-state sale is the error that costs
 * money later. Callers that care should refuse to issue rather than rely on
 * this, which is why `intraState` is returned rather than hidden.
 */
export function splitGst(taxAmount: number, sellerStateCode: string | null, placeOfSupply: string | null): GstSplit {
  const intraState = !placeOfSupply || !sellerStateCode || placeOfSupply === sellerStateCode;
  const rounded = Number(taxAmount.toFixed(2));
  if (intraState) {
    // Halves must add back to the whole: 0.01 lost per line becomes a rupee
    // over a hundred lines, and the invoice then fails to foot.
    const half = Number((rounded / 2).toFixed(2));
    return { intraState: true, cgst: half, sgst: Number((rounded - half).toFixed(2)), igst: 0 };
  }
  return { intraState: false, cgst: 0, sgst: 0, igst: rounded };
}

/** Indian rupees, with the lakh grouping, for documents rather than the UI. */
export function rupees(amount: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
}

/**
 * "One thousand five hundred and forty-seven rupees only" — required in words
 * on an Indian tax invoice.
 */
export function amountInWords(amount: number): string {
  const ones = [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  ];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  const twoDigit = (n: number): string => {
    if (n < 20) return ones[n];
    const t = tens[Math.floor(n / 10)];
    const o = ones[n % 10];
    return o ? `${t}-${o}` : t;
  };

  const threeDigit = (n: number): string => {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    const parts: string[] = [];
    if (hundred) parts.push(`${ones[hundred]} hundred`);
    if (rest) parts.push(twoDigit(rest));
    return parts.join(' and ');
  };

  const whole = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - whole) * 100);

  if (whole === 0 && paise === 0) return 'Zero rupees only';

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigit(crore)} crore`);
  if (lakh) parts.push(`${threeDigit(lakh)} lakh`);
  if (thousand) parts.push(`${threeDigit(thousand)} thousand`);
  if (rest) parts.push(threeDigit(rest));

  let words = parts.join(' ');
  words = words.charAt(0).toUpperCase() + words.slice(1);

  if (paise > 0) return `${words} rupees and ${twoDigit(paise)} paise only`;
  return `${words} rupees only`;
}
