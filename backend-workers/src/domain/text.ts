/**
 * .NET string semantics the C# domain relies on, so validation and normalisation give byte-identical results.
 *
 * `char.IsWhiteSpace` (used by `string.Trim()` and `string.IsNullOrWhiteSpace`) is Unicode Zs/Zl/Zp plus U+0009–U+000D
 * and U+0085. JavaScript's `trim()` differs: it also strips U+FEFF and does not strip U+0085.
 */
const DOTNET_WHITESPACE =
  '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const LEADING = new RegExp(`^[${DOTNET_WHITESPACE}]+`);
const TRAILING = new RegExp(`[${DOTNET_WHITESPACE}]+$`);
const ONLY_WHITESPACE = new RegExp(`^[${DOTNET_WHITESPACE}]*$`);

/** `string.Trim()`. */
export function trimDotnet(value: string): string {
  return value.replace(LEADING, '').replace(TRAILING, '');
}

/** `string.IsNullOrWhiteSpace(value)`. */
export function isNullOrWhiteSpace(value: string | null | undefined): value is null | undefined | '' {
  return value === null || value === undefined || ONLY_WHITESPACE.test(value);
}

/**
 * `string.ToLowerInvariant()`: a 1:1 simple case mapping per UTF-16 unit. JavaScript's `toLowerCase()` additionally
 * applies SpecialCasing (U+0130 → "i̇", two units) and the final-sigma rule (Σ → ς at the end of a word); .NET does not.
 */
export function toLowerInvariant(value: string): string {
  let result = '';
  for (const char of value) {
    if (char === 'İ') {
      result += char; // .NET's invariant culture leaves "İ" unchanged
    } else if (char === 'Σ') {
      result += 'σ';
    } else {
      const lower = char.toLowerCase();
      result += lower.length === char.length ? lower : char;
    }
  }

  return result;
}
