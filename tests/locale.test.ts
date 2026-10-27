import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { generateValue } from '../src/generate/schema.js';
import { LOCALES } from '../src/generate/hints.js';
import type { JsonSchema } from '../src/types.js';
import { makeServer } from './helpers.js';

const person: JsonSchema = {
  type: 'object',
  required: ['firstName', 'lastName', 'city', 'country'],
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    city: { type: 'string' },
    country: { type: 'string' },
  },
};

describe('generation locale', () => {
  it('keeps English output by default and changes it for other locales', () => {
    const english = generateValue(person, { seed: 7 });
    expect(generateValue(person, { seed: 7, locale: 'en' })).toEqual(english);
    const german = generateValue(person, { seed: 7, locale: 'de' });
    expect(german).not.toEqual(english);
    expect(generateValue(person, { seed: 7, locale: 'de' })).toEqual(german);
    expect(generateValue(person, { seed: 7, locale: 'ja' })).not.toEqual(german);
  });

  it('validates the locale name', () => {
    expect(LOCALES).toEqual(expect.arrayContaining(['en', 'de', 'fr', 'ja', 'pt_BR']));
    expect(LOCALES).not.toContain('base');
    expect(configSchema.parse({ generation: { locale: 'fr' } }).generation.locale).toBe('fr');
    expect(() => configSchema.parse({ generation: { locale: 'klingon' } })).toThrow(
      /must be a faker locale/,
    );
  });

  it('uses the locale in server responses', async () => {
    const english = await makeServer({ seed: 3, config: { validate: 'off', prefer: 'generate' } });
    const german = await makeServer({
      seed: 3,
      config: { validate: 'off', prefer: 'generate', generation: { locale: 'de' } },
    });
    try {
      const [a, b] = await Promise.all([
        fetch(`${english.url}/v1/pets/1`).then((response) => response.json()),
        fetch(`${german.url}/v1/pets/1`).then((response) => response.json()),
      ]);
      expect(b).not.toEqual(a);
    } finally {
      await Promise.all([english.close(), german.close()]);
    }
  });
});
