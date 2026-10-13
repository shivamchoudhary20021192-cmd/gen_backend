/**
 * Options and variants, planned before anything is written.
 *
 * A product has up to three options (Size, Colour, Material), each with its
 * values, and one variant per combination that is actually sold — up to 2,048,
 * Shopify's limit. A product with no options has exactly one variant, "Default
 * Title". Everything here is pure: it checks what the admin sent, puts it in
 * order and names things; catalog.service.ts turns the plan into rows.
 */

export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 2048;
/** While the classic tables carry the projection, names must fit their columns. */
export const OPTION_NAME_MAX = 50;
export const VALUE_NAME_MAX = 80;
export const DEFAULT_TITLE = 'Default Title';
export const DEFAULT_OPTIONS_KEY = 'default';

export type DisplayStyle = 'dropdown' | 'buttons' | 'swatches';

export interface OptionValueInput {
  id?: number | null;
  name: string;
  swatch_color?: string | null;
  swatch_media_id?: number | null;
  linked_metaobject_id?: number | null;
}

export interface OptionInput {
  id?: number | null;
  name: string;
  display_style?: DisplayStyle;
  linked_metaobject_type?: string | null;
  values: OptionValueInput[];
}

export interface PlannedValue extends OptionValueInput {
  name: string;
  position: number;
}

export interface PlannedOption extends Omit<OptionInput, 'values'> {
  name: string;
  position: number;
  display_style: DisplayStyle;
  values: PlannedValue[];
}

export interface VariantLike {
  id?: number | null;
  option_values?: string[] | null;
}

export type Planned<V> = V & { option_values: string[]; title: string; position: number };

export type FieldErrors = Record<string, string[]>;

function push(errors: FieldErrors, path: string, message: string) {
  (errors[path] ??= []).push(message);
}

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

export function planOptions(input: OptionInput[] | undefined | null): { options: PlannedOption[]; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const options: PlannedOption[] = [];
  const list = input ?? [];
  if (list.length > MAX_OPTIONS) push(errors, 'options', `A product can have at most ${MAX_OPTIONS} options.`);
  for (const [index, option] of list.slice(0, MAX_OPTIONS).entries()) {
    const name = (option.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) push(errors, `options.${index}.name`, 'Name the option, e.g. Size.');
    else if (name.length > OPTION_NAME_MAX) push(errors, `options.${index}.name`, `At most ${OPTION_NAME_MAX} characters.`);
    else if (options.some((other) => same(other.name, name))) push(errors, `options.${index}.name`, `There is already an option called ${name}.`);
    const values: PlannedValue[] = [];
    for (const [valueIndex, value] of (option.values ?? []).entries()) {
      const valueName = (value.name ?? '').trim().replace(/\s+/g, ' ');
      if (!valueName) continue;
      const path = `options.${index}.values.${valueIndex}`;
      if (valueName.length > VALUE_NAME_MAX) push(errors, path, `At most ${VALUE_NAME_MAX} characters.`);
      else if (values.some((other) => same(other.name, valueName))) push(errors, path, `${valueName} is listed twice.`);
      else if (value.swatch_color && !/^#[0-9a-fA-F]{6}$/.test(value.swatch_color)) push(errors, `${path}.swatch_color`, 'Use a colour like #1A2B3C.');
      else values.push({ ...value, name: valueName, swatch_color: value.swatch_color ? value.swatch_color.toLowerCase() : null, position: values.length + 1 });
    }
    if (values.length === 0) push(errors, `options.${index}.values`, `Add at least one value to ${name || 'the option'}.`);
    if (values.length > MAX_VARIANTS) push(errors, `options.${index}.values`, `An option can have at most ${MAX_VARIANTS} values.`);
    options.push({
      id: option.id ?? null,
      name,
      position: index + 1,
      display_style: option.display_style ?? (values.some((value) => value.swatch_color || value.swatch_media_id) ? 'swatches' : 'buttons'),
      linked_metaobject_type: option.linked_metaobject_type ?? null,
      values,
    });
  }
  return { options, errors };
}

export function variantTitle(values: string[]): string {
  return values.length ? values.join(' / ') : DEFAULT_TITLE;
}

export function optionsKey(valueIds: number[]): string {
  return valueIds.length ? valueIds.join('-') : DEFAULT_OPTIONS_KEY;
}

/** Every combination of the options' values, in option order — "create all variants". */
export function combinations(options: Pick<PlannedOption, 'values'>[]): string[][] {
  if (options.length === 0) return [[]];
  return options.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value.name])),
    [[]],
  );
}

/**
 * Checks the variants against the options: each names one value of every
 * option (by name, any case), no two are the same combination, and there is at
 * least one. Values come back spelled as the option spells them.
 */
export function planVariants<V extends VariantLike>(options: PlannedOption[], input: V[] | undefined | null): { variants: Planned<V>[]; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const variants: Planned<V>[] = [];
  const list = input ?? [];
  if (list.length === 0) push(errors, 'variants', 'A product needs at least one variant.');
  if (list.length > MAX_VARIANTS) push(errors, 'variants', `A product can have at most ${MAX_VARIANTS.toLocaleString('en-IN')} variants.`);
  if (options.length === 0 && list.length > 1) push(errors, 'variants', 'Without options a product has one variant. Add an option (e.g. Size) to sell more than one.');
  const combos = new Set<string>();
  for (const [index, variant] of list.slice(0, MAX_VARIANTS).entries()) {
    const given = (variant.option_values ?? []).map((value) => String(value ?? '').trim());
    if (given.length !== options.length) {
      push(errors, `variants.${index}.option_values`, options.length ? `Choose a value for each option: ${options.map((option) => option.name).join(', ')}.` : 'This product has no options.');
      continue;
    }
    const canonical: string[] = [];
    let valid = true;
    for (const [position, option] of options.entries()) {
      const match = option.values.find((value) => same(value.name, given[position]));
      if (!match) {
        push(errors, `variants.${index}.option_values`, `${given[position] || 'An empty value'} is not a value of ${option.name}.`);
        valid = false;
        break;
      }
      canonical.push(match.name);
    }
    if (!valid) continue;
    const key = canonical.map((value) => value.toLowerCase()).join('\u0000');
    if (combos.has(key)) {
      push(errors, `variants.${index}.option_values`, `${variantTitle(canonical)} is listed twice.`);
      continue;
    }
    combos.add(key);
    variants.push({ ...variant, option_values: canonical, title: variantTitle(canonical), position: variants.length + 1 });
  }
  return { variants, errors };
}

export function skuPart(text: string, max: number): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * A readable SKU for a variant that has none: the handle, then each value —
 * CLASSIC-TEE-RED-M — made unique against `taken` (upper-cased SKUs already in
 * use) with -2, -3…
 */
export function suggestSku(handle: string, values: string[], taken: Set<string>): string {
  const head = skuPart(handle, 24) || 'SKU';
  const tail = values.map((value) => skuPart(value, 10)).filter(Boolean);
  const base = [head, ...tail].join('-').slice(0, 58);
  let candidate = base;
  for (let n = 2; taken.has(candidate.toUpperCase()); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate.toUpperCase());
  return candidate;
}
