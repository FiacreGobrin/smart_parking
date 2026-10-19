import { describe, expect, it } from 'vitest';
import { generateCode, generatePassword, isNationalId, localPhone, normalizeRwPhone, usernameFrom } from '../../src/utils/identity.js';
import { passwordSchema } from '../../src/services/auth.js';

describe('normalizeRwPhone', () => {
  it.each([
    ['0788 123 456', '+250788123456'],
    ['+250 788 123 456', '+250788123456'],
    ['250788123456', '+250788123456'],
    ['788123456', '+250788123456'],
    ['0722-456-789', '+250722456789'],
  ])('%s -> %s', (input, out) => expect(normalizeRwPhone(input)).toBe(out));

  it('rejects numbers that are not Rwandan mobiles', () => {
    for (const bad of ['', null, '12345', '0188123456', '+254712345678', '07881234567']) expect(normalizeRwPhone(bad)).toBeNull();
  });
  it('formats for display', () => expect(localPhone('+250788123456')).toBe('0788 123 456'));
});

describe('national id', () => {
  it('requires exactly 16 digits', () => {
    expect(isNationalId('1199880012345678')).toBe(true);
    expect(isNationalId('119988001234567')).toBe(false);
    expect(isNationalId('11998800123456AB')).toBe(false);
  });
});

describe('credentials', () => {
  it('builds usernames like the design: initial + last name + first 4 phone digits', () => {
    expect(usernameFrom('Jean Uwase', '+250788123456')).toBe('juwase_0788');
    expect(usernameFrom('Aline Mukamana', '+250722456789')).toBe('amukamana_0722');
    expect(usernameFrom('Émile Nshuti Karera', '+250733111222')).toBe('ekarera_0733');
  });
  it('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
  it('generates passwords that satisfy the password policy', () => {
    for (let i = 0; i < 100; i++) {
      const pw = generatePassword();
      expect(passwordSchema.safeParse(pw).success).toBe(true);
      expect(pw).toMatch(/#\d{4}/);
    }
    expect(new Set(Array.from({ length: 50 }, generatePassword)).size).toBe(50);
  });
});
