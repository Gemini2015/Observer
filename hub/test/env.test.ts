import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({});
    expect(env.OBSERVER_PORT).toBe(8787);
    expect(env.OBSERVER_DATA_DIR).toBe('./data');
    expect(env.OBSERVER_ADMIN_PASSWORD).toBe('observer');
    expect(env.NODE_ENV).toBe('development');
  });

  it('parses numbers and overrides', () => {
    const env = loadEnv({
      OBSERVER_PORT: '9999',
      OBSERVER_DATA_DIR: 'E:\\observer-data',
      OBSERVER_ADMIN_PASSWORD: 's3cret',
      NODE_ENV: 'test',
    });
    expect(env.OBSERVER_PORT).toBe(9999);
    expect(env.OBSERVER_DATA_DIR).toBe('E:\\observer-data');
    expect(env.OBSERVER_ADMIN_PASSWORD).toBe('s3cret');
  });

  it('rejects invalid port', () => {
    expect(() => loadEnv({ OBSERVER_PORT: '0' })).toThrow(/invalid environment/);
    expect(() => loadEnv({ OBSERVER_PORT: 'abc' })).toThrow(/invalid environment/);
  });

  it('rejects the default password in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(
      /OBSERVER_ADMIN_PASSWORD must be set in production/,
    );
  });
});
