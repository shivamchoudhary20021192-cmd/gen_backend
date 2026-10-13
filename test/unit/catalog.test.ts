import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkValidations, checkValue, fromStored, parseType, toStored } from '../../src/modules/catalog/fieldTypes';
import { planOptions, planVariants, suggestSku } from '../../src/modules/catalog/options';

// Products (new): the pure planning and field-value rules. Nothing here touches a database.

describe('catalog options and variants', () => {
  const size = { name: ' Size ', values: [{ name: 'S' }, { name: 'M' }, { name: '  ' }] };
  const colour = { name: 'Colour', values: [{ name: 'Red', swatch_color: '#FF0000' }, { name: 'Blue' }] };

  it('trims names, drops empty values, numbers positions and picks swatches when a value has one', () => {
    const { options, errors } = planOptions([size, colour]);
    assert.deepEqual(errors, {});
    assert.equal(options[0].name, 'Size');
    assert.deepEqual(options[0].values.map((value) => [value.name, value.position]), [['S', 1], ['M', 2]]);
    assert.equal(options[1].display_style, 'swatches');
    assert.equal(options[1].values[0].swatch_color, '#ff0000');
  });

  it('refuses a fourth option, a repeated option name and a repeated value', () => {
    assert.ok(planOptions([size, colour, { name: 'Fit', values: [{ name: 'Slim' }] }, { name: 'Cut', values: [{ name: 'A' }] }]).errors.options);
    assert.ok(planOptions([size, { name: 'size', values: [{ name: 'X' }] }]).errors['options.1.name']);
    assert.ok(planOptions([{ name: 'Size', values: [{ name: 'S' }, { name: 's' }] }]).errors['options.0.values.1']);
  });

  it('matches variant values in any case, spells them as the option does, and titles them', () => {
    const { options } = planOptions([size, colour]);
    const { variants, errors } = planVariants(options, [{ option_values: ['s', 'red'] }, { option_values: ['M', 'Blue'] }]);
    assert.deepEqual(errors, {});
    assert.deepEqual(variants[0].option_values, ['S', 'Red']);
    assert.equal(variants[0].title, 'S / Red');
    assert.equal(variants[1].position, 2);
  });

  it('refuses a combination twice, an unknown value, and a second variant without options', () => {
    const { options } = planOptions([size]);
    assert.ok(planVariants(options, [{ option_values: ['S'] }, { option_values: ['s'] }]).errors['variants.1.option_values']);
    assert.ok(planVariants(options, [{ option_values: ['XL'] }]).errors['variants.0.option_values']);
    assert.ok(planVariants([], [{ option_values: [] }, { option_values: [] }]).errors.variants);
  });

  it('suggests readable SKUs, unique against those taken', () => {
    const taken = new Set(['LINEN-SHIRT-S-RED']);
    assert.equal(suggestSku('linen-shirt', ['S', 'Red'], taken), 'LINEN-SHIRT-S-RED-2');
    assert.equal(suggestSku('linen-shirt', ['Crème'], taken), 'LINEN-SHIRT-CREME');
  });
});

describe('catalog field values', () => {
  it('knows Shopify’s type names and which can be lists', () => {
    assert.deepEqual(parseType('list.single_line_text_field'), { base: 'single_line_text_field', list: true });
    assert.equal(parseType('list.boolean'), null);
    assert.equal(parseType('single_line_text'), null);
  });

  it('holds a text field with choices to those choices', () => {
    const rules = { choices: ['Cotton', 'Linen'] };
    assert.deepEqual(checkValue('single_line_text_field', rules, 'Linen'), { ok: true, value: 'Linen' });
    assert.equal(checkValue('single_line_text_field', rules, 'Plastic').ok, false);
  });

  it('treats an empty value as clearing the field', () => {
    assert.deepEqual(checkValue('number_integer', {}, ''), { ok: true, value: null });
    assert.deepEqual(checkValue('list.single_line_text_field', {}, []), { ok: true, value: null });
  });

  it('checks numbers, dates, colours and money', () => {
    assert.equal(checkValue('number_integer', { min: 1, max: 10 }, 11).ok, false);
    assert.equal(checkValue('number_integer', {}, 'many').ok, false);
    assert.equal(checkValue('date', {}, '2026-02-30').ok, false);
    assert.deepEqual(checkValue('color', {}, '#ABC'), { ok: true, value: '#aabbcc' });
    assert.deepEqual(checkValue('money', { currency_code: 'INR' }, { amount: '120.5', currency_code: 'inr' }), { ok: true, value: { amount: '120.50', currency_code: 'INR' } });
  });

  it('stores a measurement in its base unit, so 1 kg sorts above 900 g, and reads it back', () => {
    const checked = checkValue('weight', {}, { value: 1, unit: 'kg' });
    assert.ok(checked.ok);
    const stored = toStored('weight', checked.value);
    assert.equal(stored.value_number, 1000);
    assert.ok((toStored('weight', { value: 900, unit: 'g' }).value_number ?? 0) < (stored.value_number ?? 0));
    assert.deepEqual(fromStored('weight', { ...stored, value_datetime: null }), { value: 1, unit: 'kg' });
  });

  it('round-trips a list and a reference through the stored columns', () => {
    const list = toStored('list.single_line_text_field', ['Cold wash', 'Line dry']);
    assert.deepEqual(fromStored('list.single_line_text_field', { ...list, value_datetime: null }), ['Cold wash', 'Line dry']);
    const ref = toStored('product_reference', 42);
    assert.equal(fromStored('product_reference', { ...ref, value_datetime: null }), 42);
  });

  it('keeps only the rules a type has', () => {
    const checked = checkValidations('number_integer', { min: 1, choices: ['a'] });
    assert.ok(checked.ok);
    assert.deepEqual(checked.validations, { min: 1 });
  });
});
