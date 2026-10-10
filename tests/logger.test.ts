import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('respects quiet mode while always reporting errors', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger({ quiet: true, verbose: true, color: false });
    logger.info('info');
    logger.warn('warning');
    logger.debug('debug');
    logger.error('failure');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('prints ordinary and verbose messages when enabled', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger({ quiet: false, verbose: true, color: false });
    logger.info('ready');
    logger.warn('heads up');
    logger.debug('details');
    logger.error('failure');
    expect(info).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
