import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/util/password.js';

describe('password', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('uses a random salt per hash', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('rejects malformed stored values', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt:1:2')).toBe(false);
  });
});
