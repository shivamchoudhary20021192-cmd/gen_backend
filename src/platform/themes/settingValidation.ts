import type { SettingDefinition, SectionSchema, JsonTemplate } from './themeSchema';

/**
 * Checks a setting's value against its definition, the way Shopify's theme
 * editor and Asset API refuse a value a section could not render: a colour
 * that is not a colour, a range outside its bounds, a select option the
 * schema does not offer. Returns a message, or null when the value is fine.
 */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HANDLE = /^[a-z0-9][a-z0-9-_]{0,254}$/i;

export function settingProblem(definition: SettingDefinition, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const label = definition.label ?? definition.id ?? 'setting';
  switch (definition.type) {
    case 'color':
    case 'color_background':
      return typeof value === 'string' && (HEX.test(value) || /^(rgba?|hsla?|linear-gradient|radial-gradient)\(/.test(value)) ? null : `${label} must be a colour like #1A1A1A`;
    case 'range':
    case 'number': {
      const number = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(number)) return `${label} must be a number`;
      if (definition.min !== undefined && number < definition.min) return `${label} must be at least ${definition.min}`;
      if (definition.max !== undefined && number > definition.max) return `${label} must be at most ${definition.max}`;
      return null;
    }
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${label} must be true or false`;
    case 'select':
    case 'radio':
      return (definition.options ?? []).some((option) => option.value === value) ? null : `${label} is not one of the options`;
    case 'text':
    case 'inline_richtext':
      return typeof value === 'string' && value.length <= 1000 ? null : `${label} must be text of at most 1000 characters`;
    case 'textarea':
    case 'richtext':
    case 'html':
    case 'liquid':
      return typeof value === 'string' && value.length <= 50_000 ? null : `${label} is too long`;
    case 'url':
      return typeof value === 'string' && value.length <= 2000 && /^(\/|https?:\/\/|mailto:|tel:|#)/.test(value) ? null : `${label} must be a link`;
    case 'video_url':
      return typeof value === 'string' && /^https:\/\//.test(value) ? null : `${label} must be a YouTube or Vimeo link`;
    case 'image_picker':
      return (typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && (/^\d+$/.test(value) || /^https?:\/\//.test(value)))
        ? null
        : `${label} must be an image from the media library`;
    case 'font_picker':
      return typeof value === 'string' && /^[\w\s-]{2,60}$/.test(value) ? null : `${label} must be a font`;
    case 'collection':
    case 'product':
    case 'page':
    case 'blog':
    case 'article':
    case 'link_list':
      return typeof value === 'string' && HANDLE.test(value) ? null : `${label} must be a handle`;
    case 'collection_list':
    case 'product_list':
      return Array.isArray(value) && value.length <= 50 && value.every((entry) => typeof entry === 'string' && HANDLE.test(entry)) ? null : `${label} must be a list of handles`;
    default:
      return null;
  }
}

/** Problems with every setting of a section instance and its blocks. */
export function sectionSettingProblems(template: JsonTemplate, schemas: Map<string, SectionSchema | null>, file: string): string[] {
  const problems: string[] = [];
  for (const [id, section] of Object.entries(template.sections)) {
    const schema = schemas.get(section.type);
    if (!schema) continue;
    const byId = new Map((schema.settings ?? []).filter((setting) => setting.id).map((setting) => [setting.id!, setting]));
    for (const [key, value] of Object.entries(section.settings ?? {})) {
      const definition = byId.get(key);
      const problem = definition ? settingProblem(definition, value) : null;
      if (problem) problems.push(`${file}: section "${id}": ${problem}`);
    }
    const blocks = new Map((schema.blocks ?? []).map((block) => [block.type, block]));
    for (const [blockId, block] of Object.entries(section.blocks ?? {})) {
      const definitions = new Map((blocks.get(block.type)?.settings ?? []).filter((setting) => setting.id).map((setting) => [setting.id!, setting]));
      for (const [key, value] of Object.entries(block.settings ?? {})) {
        const definition = definitions.get(key);
        const problem = definition ? settingProblem(definition, value) : null;
        if (problem) problems.push(`${file}: block "${blockId}" in "${id}": ${problem}`);
      }
    }
  }
  return problems;
}
