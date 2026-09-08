import Handlebars from 'handlebars';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHandlebarsHelpers, renderTemplate } from './handlebars-helpers';

describe('handlebars helpers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerHandlebarsHelpers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['add', 5, 3, '8'],
    ['sub', 5, 3, '2'],
    ['mul', 5, 3, '15'],
    ['div', 10, 4, '2.5'],
    ['mod', 10, 4, '2'],
  ])('renders the %s arithmetic helper', (helper, left, right, expected) => {
    expect(Handlebars.compile(`{{${helper} left right}}`)({ left, right })).toBe(expected);
  });

  it.each(['add', 'sub', 'mul', 'div', 'mod'])(
    'returns zero and warns when %s receives invalid numeric input',
    (helper) => {
      expect(Handlebars.compile(`{{${helper} left right}}`)({ left: 'bad', right: 2 })).toBe('0');
      expect(console.warn).toHaveBeenCalled();
    }
  );

  it('guards division and modulo by zero', () => {
    expect(Handlebars.compile('{{div 10 0}}')({})).toBe('0');
    expect(Handlebars.compile('{{mod 10 0}}')({})).toBe('0');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('renders string helpers with nested composition', () => {
    expect(renderTemplate('{{uppercase (replace name "-" "_")}}', { name: 'daily-summary' })).toBe(
      'DAILY_SUMMARY'
    );
    expect(renderTemplate('{{lowercase name}}', { name: 'AGENT MEMORY' })).toBe('agent memory');
  });

  it.each([
    ['eq', 2, 2, 'true'],
    ['neq', 2, 3, 'true'],
    ['gt', 3, 2, 'true'],
    ['lt', 2, 3, 'true'],
    ['gte', 3, 3, 'true'],
    ['lte', 3, 3, 'true'],
  ])('renders the %s comparison helper', (helper, left, right, expected) => {
    expect(Handlebars.compile(`{{${helper} left right}}`)({ left, right })).toBe(expected);
  });

  it('keeps equality strict while numeric comparisons coerce numbers', () => {
    expect(Handlebars.compile('{{eq value "5"}}')({ value: 5 })).toBe('false');
    expect(Handlebars.compile('{{gte value 5}}')({ value: '5' })).toBe('true');
  });

  it('supports defaults, JSON and explicit false values', () => {
    expect(renderTemplate('{{default missing "fallback"}}', {})).toBe('fallback');
    expect(renderTemplate('{{{json value}}}', { value: { enabled: true } })).toContain(
      '"enabled": true'
    );
    expect(
      renderTemplate('{{#if (isDefined enabled)}}present={{enabled}}{{else}}absent{{/if}}', {
        enabled: false,
      })
    ).toBe('present=false');
  });

  it('renders current Session-shaped context and built-in loops', () => {
    const result = renderTemplate(
      '{{session.title}}:{{#each session.tags}}{{uppercase this}} {{/each}}',
      {
        session: {
          title: 'Daily review',
          tags: ['memory', 'skills'],
        },
      }
    );
    expect(result).toBe('Daily review:MEMORY SKILLS ');
  });

  it('is self-sufficient and idempotent', () => {
    expect(() => registerHandlebarsHelpers()).not.toThrow();
    expect(() => registerHandlebarsHelpers()).not.toThrow();
    expect(
      renderTemplate('{{add usage.input usage.output}}', { usage: { input: 3, output: 4 } })
    ).toBe('7');
  });

  it('returns an empty string by default when rendering fails', () => {
    const template = '{{missingHelper value}}';
    expect(renderTemplate(template, { value: 1 })).toBe('');
    expect(console.error).toHaveBeenCalled();
  });

  it('can preserve the raw template for user-facing previews', () => {
    const template = '{{missingHelper value}}';
    expect(renderTemplate(template, { value: 1 }, { onError: 'raw' })).toBe(template);
  });

  it.each([
    ['', {}],
    [undefined, {}],
    [null, {}],
  ])('returns an empty string for empty or non-string templates', (template, context) => {
    expect(renderTemplate(template as unknown as string, context)).toBe('');
  });
});
