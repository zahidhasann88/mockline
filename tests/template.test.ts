import { describe, expect, it } from 'vitest';
import { renderTemplate, type TemplateContext } from '../src/template.js';
import { makeServer } from './helpers.js';

const context: TemplateContext = {
  method: 'POST',
  url: new URL('http://mock.test/v1/pets/7?sort=name'),
  headers: { 'X-Trace': 'abc' },
  params: { petId: '7' },
  body: { name: 'Rex', age: 3, tags: ['a', 'b'], owner: { id: 9 } },
  now: new Date('2026-01-02T03:04:05.000Z'),
};

describe('response templates', () => {
  it('fills placeholders from the request and keeps types for whole values', () => {
    expect(
      renderTemplate(
        {
          id: '{{request.path.petId}}',
          name: '{{ request.body.name }}',
          age: '{{request.body.age}}',
          tags: '{{request.body.tags}}',
          firstTag: '{{request.body.tags.0}}',
          owner: '{{request.body.owner}}',
          summary: '{{request.method}} {{request.path}} by {{request.header.x-trace}}',
          sort: '{{request.query.sort}}',
          url: '{{request.url}}',
          at: '{{now}}',
          missing: '{{request.body.nope}}',
          inline: 'value={{request.body.nope}}',
          list: ['{{request.body.owner.id}}', 5],
          untouched: 'no placeholders',
        },
        context,
      ),
    ).toEqual({
      id: '7',
      name: 'Rex',
      age: 3,
      tags: ['a', 'b'],
      firstTag: 'a',
      owner: { id: 9 },
      summary: 'POST /v1/pets/7 by abc',
      sort: 'name',
      url: 'http://mock.test/v1/pets/7?sort=name',
      at: '2026-01-02T03:04:05.000Z',
      missing: null,
      inline: 'value=',
      list: [9, 5],
      untouched: 'no placeholders',
    });
    expect(renderTemplate('{{uuid}}', context)).toMatch(/^[0-9a-f-]{36}$/);
    expect(renderTemplate('{{request.body}}', context)).toEqual(context.body);
    expect(renderTemplate('{{unknown}}', context)).toBeNull();
  });

  it('renders override bodies, headers, rules and sequences', async () => {
    const server = await makeServer({
      config: {
        validate: 'off',
        overrides: {
          getPet: {
            body: { id: '{{request.path.petId}}', name: 'Pet {{request.path.petId}}' },
            headers: { 'x-pet': '{{request.path.petId}}' },
          },
          createPet: {
            rules: [
              {
                when: { location: 'body', name: 'name', op: 'eq', value: 'Rex' },
                response: { status: 201, body: { greeting: 'Hello {{request.body.name}}' } },
              },
            ],
            sequence: [{ status: 201, body: { echo: '{{request.body}}' } }],
          },
        },
      },
    });
    try {
      const pet = await fetch(`${server.url}/v1/pets/42`);
      expect(pet.headers.get('x-pet')).toBe('42');
      expect(await pet.json()).toEqual({ id: '42', name: 'Pet 42' });

      const post = (body: unknown): Promise<Response> =>
        fetch(`${server.url}/v1/pets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect(await (await post({ name: 'Rex' })).json()).toEqual({ greeting: 'Hello Rex' });
      expect(await (await post({ name: 'Milo', tag: 'cat' })).json()).toEqual({
        echo: { name: 'Milo', tag: 'cat' },
      });
    } finally {
      await server.close();
    }
  });
});
