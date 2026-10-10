import { describe, expect, it } from 'vitest';
import * as mockline from '../src/index.js';

describe('public programmatic API', () => {
  it('exports the typed server, config, spec, routing, generation, validation, and state surfaces', () => {
    expect(mockline.createMockServer).toBeTypeOf('function');
    expect(mockline.configSchema.parse({}).host).toBe('127.0.0.1');
    expect(mockline.defaultConfig.port).toBe(4010);
    expect(mockline.loadSpec).toBeTypeOf('function');
    expect(mockline.inspectSpec).toBeTypeOf('function');
    expect(mockline.summarizeSpec).toBeTypeOf('function');
    expect(mockline.createRouter).toBeTypeOf('function');
    expect(mockline.generateFromSchema).toBeTypeOf('function');
    expect(mockline.generateValue).toBeTypeOf('function');
    expect(mockline.validateRequest).toBeTypeOf('function');
    expect(mockline.ResourceStore).toBeTypeOf('function');
    expect(mockline.detectCollections).toBeTypeOf('function');
  });
});
