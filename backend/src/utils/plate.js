// License plate handling. Normalization is deliberately format-agnostic so that
// "RAB 123 C", "rab-123-c" and "RAB123C" all match the same vehicle.

export function normalizePlate(input) {
  if (input == null) return '';
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Default patterns; operators can override them through the `plate.formats` system setting.
// Rwanda: private "RAB 123 C", government "GR 123 RW", diplomatic "CD 12 34", motorcycles "RE 123 A".
export const DEFAULT_PLATE_FORMATS = [
  { name: 'Rwanda standard', pattern: '^R[A-Z]{2}\\d{3}[A-Z]$' },
  { name: 'Rwanda motorcycle', pattern: '^RE\\d{3}[A-Z]$' },
  { name: 'Rwanda government', pattern: '^GR\\d{3}[A-Z]{0,2}$' },
  { name: 'Rwanda diplomatic', pattern: '^(CD|CMD|UN)\\d{2,4}$' },
  { name: 'Rwanda police/military', pattern: '^(RNP|RDF)\\d{3,4}[A-Z]?$' },
];

// Returns the matching format name, or null. A null result is NOT a rejection:
// foreign and custom plates are accepted and flagged as "unrecognized format".
export function matchPlateFormat(normalized, formats = DEFAULT_PLATE_FORMATS) {
  for (const f of formats) {
    try {
      if (new RegExp(f.pattern).test(normalized)) return f.name;
    } catch {
      // ignore an invalid operator-supplied pattern
    }
  }
  return null;
}

export function isPlausiblePlate(normalized) {
  return normalized.length >= 3 && normalized.length <= 12;
}
