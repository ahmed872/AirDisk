const ARABIC_INDIC_ZERO = 0x0660; // ٠
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0; // ۰ (Persian/Urdu)

/**
 * Converts Arabic-Indic and Extended Arabic-Indic digits to ASCII, and the
 * Arabic decimal/thousands separators to '.' and ','. Everything else is kept.
 * Users on Arabic keyboards type ٠١٢٣ — the system must accept them everywhere.
 */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) out += String(cp - ARABIC_INDIC_ZERO);
    else if (cp >= EXTENDED_ARABIC_INDIC_ZERO && cp <= EXTENDED_ARABIC_INDIC_ZERO + 9) out += String(cp - EXTENDED_ARABIC_INDIC_ZERO);
    else if (ch === '٫') out += '.'; // ARABIC DECIMAL SEPARATOR
    else if (ch === '٬') out += ','; // ARABIC THOUSANDS SEPARATOR
    else out += ch;
  }
  return out;
}
