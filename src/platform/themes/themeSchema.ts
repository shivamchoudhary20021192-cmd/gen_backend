/**
 * The shapes a theme's JSON and schema take — identical to Shopify's, so a
 * theme developer's knowledge (and most of their code) carries straight over.
 *
 *   sections/<type>.liquid   {% schema %} { name, settings, blocks, presets, … } {% endschema %}
 *   templates/<type>.json    { sections: { id: { type, settings, blocks, block_order } }, order: [ids] }
 *   sections/<group>.json    the same, plus { type: 'header' | 'footer' | …, name }
 *   config/settings_schema.json   [ { name, settings: [...] } ]
 *   config/settings_data.json     { current: { …values }, presets: { name: { …values } } }
 */

export type SettingValue = string | number | boolean | null | string[] | Record<string, unknown>;

export interface SettingDefinition {
  type: string;
  id?: string;
  label?: string;
  default?: SettingValue;
  info?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  content?: string;
}

export interface BlockDefinition {
  type: string;
  name: string;
  limit?: number;
  settings?: SettingDefinition[];
}

export interface SectionPreset {
  name: string;
  category?: string;
  settings?: Record<string, SettingValue>;
  blocks?: { type: string; settings?: Record<string, SettingValue> }[];
}

export interface SectionSchema {
  name: string;
  tag?: string;
  class?: string;
  limit?: number;
  settings?: SettingDefinition[];
  blocks?: BlockDefinition[];
  max_blocks?: number;
  presets?: SectionPreset[];
  default?: SectionPreset;
  enabled_on?: { templates?: string[]; groups?: string[] };
  disabled_on?: { templates?: string[]; groups?: string[] };
}

export interface TemplateBlock {
  type: string;
  settings?: Record<string, SettingValue>;
  disabled?: boolean;
}

export interface TemplateSection {
  type: string;
  settings?: Record<string, SettingValue>;
  blocks?: Record<string, TemplateBlock>;
  block_order?: string[];
  disabled?: boolean;
  custom_css?: string[];
}

export interface JsonTemplate {
  /** A layout other than theme.liquid, or false for none. */
  layout?: string | false;
  wrapper?: string;
  sections: Record<string, TemplateSection>;
  order: string[];
}

export interface SectionGroup extends JsonTemplate {
  type: string;
  name: string;
}

const SCHEMA_TAG = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;

export class ThemeSchemaError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ThemeSchemaError';
  }
}

/** The {% schema %} of a section, parsed; null when the section has none. */
export function extractSchema(source: string, file = 'section'): SectionSchema | null {
  const match = SCHEMA_TAG.exec(source);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as SectionSchema;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') throw new Error('the schema needs a "name"');
    return parsed;
  } catch (error) {
    throw new ThemeSchemaError(`invalid {% schema %}: ${error instanceof Error ? error.message : String(error)}`, file);
  }
}

/** The values a setting list gives when nothing is saved. */
export function settingDefaults(settings: SettingDefinition[] | undefined): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const setting of settings ?? []) {
    if (!setting.id) continue;
    out[setting.id] = setting.default ?? (setting.type === 'checkbox' ? false : null);
  }
  return out;
}

export function parseJsonTemplate(source: string, file: string): JsonTemplate {
  let parsed: unknown;
  try {
    // Shopify's JSON templates may begin with a /* comment */ banner.
    parsed = JSON.parse(source.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  } catch (error) {
    throw new ThemeSchemaError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`, file);
  }
  const template = parsed as JsonTemplate;
  if (!template || typeof template !== 'object' || typeof template.sections !== 'object' || !Array.isArray(template.order)) {
    throw new ThemeSchemaError('a JSON template needs "sections" and "order"', file);
  }
  return template;
}

/**
 * The problems with a JSON template: unknown section types, blocks a section
 * does not declare, ids in `order` that do not exist. What the editor and
 * the code editor refuse to save.
 */
export function validateTemplate(template: JsonTemplate, schemas: Map<string, SectionSchema | null>, file: string): string[] {
  const problems: string[] = [];
  for (const id of template.order) if (!template.sections[id]) problems.push(`"order" names "${id}", which is not in "sections"`);
  if (Object.keys(template.sections).length > 25) problems.push('a template holds at most 25 sections');
  for (const [id, section] of Object.entries(template.sections)) {
    if (!schemas.has(section.type)) {
      problems.push(`section "${id}" is of type "${section.type}", and sections/${section.type}.liquid does not exist`);
      continue;
    }
    const schema = schemas.get(section.type);
    const declared = new Set((schema?.blocks ?? []).map((block) => block.type));
    const blocks = section.blocks ?? {};
    if (schema?.max_blocks !== undefined && Object.keys(blocks).length > schema.max_blocks) problems.push(`section "${id}" has more than ${schema.max_blocks} blocks`);
    for (const [blockId, block] of Object.entries(blocks)) {
      if (!declared.has(block.type) && !(declared.has('@app') && block.type.startsWith('shopify://apps/'))) problems.push(`block "${blockId}" in "${id}" is of type "${block.type}", which ${section.type} does not declare`);
    }
    for (const blockId of section.block_order ?? []) if (!blocks[blockId]) problems.push(`"block_order" of "${id}" names "${blockId}", which is not in its blocks`);
  }
  return problems.map((problem) => `${file}: ${problem}`);
}

/** A section's settings: defaults under saved values. */
export function resolveSettings(definitions: SettingDefinition[] | undefined, saved: Record<string, SettingValue> | undefined): Record<string, SettingValue> {
  return { ...settingDefaults(definitions), ...(saved ?? {}) };
}

/** "templates/product.alternate.json" → { type: 'product', suffix: 'alternate' }. */
export function templateName(file: string): { type: string; suffix: string | null } {
  const name = file.replace(/^templates\//, '').replace(/\.(json|liquid)$/, '');
  const [type, ...rest] = name.split('.');
  return { type, suffix: rest.length ? rest.join('.') : null };
}

/** A new id for a section or block added in the editor, like Shopify's. */
export function newId(type: string): string {
  return `${type.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}_${Math.random().toString(36).slice(2, 8)}`;
}
