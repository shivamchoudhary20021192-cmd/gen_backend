/**
 * Google Fonts, as theme settings use them (font_picker values are family
 * names). The css2 API refuses a whole request when one family is asked for
 * a weight it does not have, so each family is asked only for what it has.
 */

/** The families the theme editor offers, with the weights each one has. */
export const FONT_FAMILIES: Record<string, number[]> = {
  Inter: [400, 500, 600, 700],
  'DM Sans': [400, 500, 600, 700],
  Manrope: [400, 500, 600, 700],
  'Work Sans': [400, 500, 600, 700],
  'IBM Plex Sans': [400, 500, 600, 700],
  Poppins: [400, 500, 600, 700],
  'Nunito Sans': [400, 600, 700],
  Karla: [400, 500, 600, 700],
  'Space Grotesk': [400, 500, 600, 700],
  Outfit: [400, 500, 600, 700],
  Archivo: [400, 500, 600, 700, 800],
  Syne: [400, 500, 600, 700],
  'Playfair Display': [400, 500, 600, 700],
  'Cormorant Garamond': [400, 500, 600, 700],
  'Libre Baskerville': [400, 700],
  Lora: [400, 500, 600, 700],
  Fraunces: [400, 500, 600, 700],
  'EB Garamond': [400, 500, 600, 700],
  'DM Serif Display': [400],
  'Bebas Neue': [400],
};

export const FONT_OPTIONS = Object.keys(FONT_FAMILIES);

function familyParam(family: string): string {
  const weights = FONT_FAMILIES[family] ?? [400, 700];
  return `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights.join(';')}`;
}

/** One stylesheet URL for any number of families. */
export function googleFontsUrl(families: (string | null | undefined)[]): string {
  const unique = [...new Set(families.filter((family): family is string => typeof family === 'string' && family.length > 0))];
  return `https://fonts.googleapis.com/css2?${unique.map(familyParam).join('&')}&display=swap`;
}
