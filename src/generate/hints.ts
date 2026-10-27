import { Faker, allLocales, en, type LocaleDefinition } from '@faker-js/faker';
import type { SeededRandom } from './rng.js';

export type HintValue = string | number | boolean | null;
export type GenerationHints = Record<string, HintValue | readonly HintValue[]>;

export const LOCALES = Object.keys(allLocales).filter((name) => name !== 'base');

export function isLocale(name: string): boolean {
  return LOCALES.includes(name);
}

export function createFaker(seed: number, locale = 'en'): Faker {
  const selected = (allLocales as Record<string, LocaleDefinition>)[locale];
  const faker = new Faker({ locale: selected && locale !== 'en' ? [selected, en] : [en] });
  faker.seed(seed);
  faker.setDefaultRefDate('2020-01-01T00:00:00.000Z');
  return faker;
}

export function hintedValue(
  name: string,
  type: string,
  faker: Faker,
  rng: SeededRandom,
): unknown | undefined {
  const normalized = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (type === 'string') {
    if (normalized === 'email' || normalized.endsWith('email'))
      return faker.internet.email().toLowerCase();
    if (normalized === 'firstname' || normalized === 'givenname') return faker.person.firstName();
    if (normalized === 'lastname' || normalized === 'familyname' || normalized === 'surname')
      return faker.person.lastName();
    if (normalized === 'fullname' || normalized === 'name' || normalized === 'username')
      return normalized === 'username' ? faker.internet.username() : faker.person.fullName();
    if (normalized === 'phone' || normalized === 'phonenumber' || normalized.endsWith('phone'))
      return faker.phone.number();
    if (normalized === 'createdat' || normalized === 'updatedat' || normalized === 'timestamp')
      return faker.date.recent({ days: 10 }).toISOString();
    if (normalized === 'avatarurl' || normalized === 'imageurl' || normalized === 'photo')
      return faker.image.urlLoremFlickr({ category: 'portrait' });
    if (normalized === 'country') return faker.location.country();
    if (normalized === 'city') return faker.location.city();
    if (normalized === 'url' || normalized.endsWith('url')) return faker.internet.url();
    if (normalized === 'status') return rng.pick(['active', 'pending', 'inactive']);
  }
  if (type === 'number' || type === 'integer') {
    if (normalized === 'price' || normalized.endsWith('price') || normalized === 'amount')
      return Number(faker.commerce.price({ min: 1, max: 999, dec: 2 }));
    if (normalized === 'age') return faker.number.int({ min: 18, max: 80 });
  }
  if (
    type === 'boolean' &&
    (normalized === 'active' || normalized === 'enabled' || normalized === 'verified')
  ) {
    return rng.bool();
  }
  return undefined;
}
