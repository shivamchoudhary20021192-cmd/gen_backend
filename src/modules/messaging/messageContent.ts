/**
 * The words themselves: what a body refers to, what it costs to send, and what
 * it looks like once filled in.
 *
 * Kept away from the database and the providers because all three screens —
 * the template editor, the campaign review step and the one-to-one composer —
 * need exactly this and nothing else, and because it is the only part of
 * messaging that can be reasoned about without a connection.
 */

/** `{{first_name}}`, with optional dots for `{{order.number}}`. */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Every distinct placeholder in a body, in the order it first appears. */
export function extractVariables(...texts: (string | null | undefined)[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!found.includes(match[1])) found.push(match[1]);
    }
  }
  return found;
}

/**
 * `{{name}}` → the value.
 *
 * An unknown placeholder is left visible rather than blanked. A message reading
 * "Hi {{first_name}}" is embarrassing; a message reading "Hi ," looks broken and
 * is harder to trace back to the template that caused it.
 */
export function render(template: string, variables: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : whole,
  );
}

/** Fills every placeholder with something, for a preview that reads like a message. */
export function renderPreview(
  template: string,
  variables: Record<string, string>,
  fallback: (key: string) => string,
): string {
  return template.replace(PLACEHOLDER, (_whole, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key) && variables[key] !== ''
      ? variables[key]
      : fallback(key),
  );
}

// ── what an SMS actually costs ───────────────────────────────────────────────
//
// An SMS is billed per segment, not per message, and the segment size depends on
// the alphabet. Plain English fits GSM-03.38 at 160 characters; one curly
// apostrophe, one rupee sign or one emoji forces UCS-2 and the limit drops to 70
// — which is how a template that looked like one message bills as three. The
// editor has to say so before it is sent forty thousand times.

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** These cost two GSM characters each. */
const GSM_EXTENDED = '^{}\\[~]|€';

export interface SmsInfo {
  encoding: 'GSM-7' | 'UCS-2';
  characters: number;
  /** GSM characters, counting the extended ones twice. */
  billedUnits: number;
  segments: number;
  perSegment: number;
  /** The first character that forced UCS-2, so the editor can point at it. */
  unsupportedCharacter: string | null;
}

export function smsInfo(body: string): SmsInfo {
  let unicode = false;
  let unsupported: string | null = null;
  let units = 0;

  for (const character of body) {
    if (GSM_BASIC.includes(character)) {
      units += 1;
    } else if (GSM_EXTENDED.includes(character)) {
      units += 2;
    } else {
      unicode = true;
      if (unsupported === null) unsupported = character;
    }
  }

  const characters = [...body].length;
  if (unicode) {
    const perSegment = characters <= 70 ? 70 : 67;
    return {
      encoding: 'UCS-2',
      characters,
      billedUnits: characters,
      segments: characters === 0 ? 0 : Math.ceil(characters / perSegment),
      perSegment,
      unsupportedCharacter: unsupported,
    };
  }

  const perSegment = units <= 160 ? 160 : 153;
  return {
    encoding: 'GSM-7',
    characters,
    billedUnits: units,
    segments: units === 0 ? 0 : Math.ceil(units / perSegment),
    perSegment,
    unsupportedCharacter: null,
  };
}

/**
 * The limits each channel actually enforces.
 *
 * WhatsApp's body limit is 1024 characters and its header 60; an email subject
 * over about 70 is truncated by every mobile client. Numbers, not opinions.
 */
export const CHANNEL_LIMITS = {
  sms: { body: 1600, subject: 0, header: 0 },
  whatsapp: { body: 1024, subject: 0, header: 60 },
  email: { body: 200_000, subject: 150, header: 0 },
  push: { body: 240, subject: 65, header: 0 },
} as const;
