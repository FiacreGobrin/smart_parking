import { describe, expect, it } from 'vitest';
import { isPlausiblePlate, matchPlateFormat, normalizePlate } from '../../src/utils/plate.js';

describe('normalizePlate', () => {
  it.each([
    ['RAB 123 C', 'RAB123C'],
    ['rab-123-c', 'RAB123C'],
    ['  rab123c ', 'RAB123C'],
    ['RAB.123/C', 'RAB123C'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('normalizes %j -> %j', (input, expected) => {
    expect(normalizePlate(input)).toBe(expected);
  });
});

describe('matchPlateFormat', () => {
  it('recognizes Rwandan formats', () => {
    expect(matchPlateFormat('RAB123C')).toBe('Rwanda standard');
    expect(matchPlateFormat('RE123A')).toBe('Rwanda motorcycle');
    expect(matchPlateFormat('GR123RW')).toBe('Rwanda government');
    expect(matchPlateFormat('CD1234')).toBe('Rwanda diplomatic');
  });
  it('returns null (not an error) for foreign plates', () => {
    expect(matchPlateFormat('KCA123B')).toBeNull();
    expect(matchPlateFormat('UBA123X')).toBeNull();
  });
  it('supports operator-configured formats and ignores broken patterns', () => {
    const formats = [{ name: 'broken', pattern: '([' }, { name: 'Custom', pattern: '^ZZ\\d+$' }];
    expect(matchPlateFormat('ZZ99', formats)).toBe('Custom');
  });
});

describe('isPlausiblePlate', () => {
  it('rejects too short or too long values', () => {
    expect(isPlausiblePlate('AB')).toBe(false);
    expect(isPlausiblePlate('A'.repeat(13))).toBe(false);
    expect(isPlausiblePlate('RAB123C')).toBe(true);
  });
});
