// Money parsing/formatting. Amounts are stored as integers in HUNDREDTHS of a toman (2 decimal places).
export const SCALE = 100;
export const MAX_AMOUNT = 1_000_000_000_000 * SCALE; // 10^12 toman safety cap

export function normalizeDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[٬،,\u066C\u200c\u200f\u200e\s]/g, '');
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/** Parses a toman amount typed by a person (up to 2 decimals, "." or "٫") into hundredths. */
export function parseAmount(input: string): ParseResult {
  if (typeof input !== 'string') return { ok: false, error: 'مبلغ نامعتبر است' };
  const s = normalizeDigits(input).replace(/[٫\/]/g, '.');
  if (s === '') return { ok: false, error: 'مبلغ را وارد کنید' };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'مبلغ باید عدد مثبت با حداکثر ۲ رقم اعشار باشد' };
  const [i, f = ''] = s.split('.');
  const n = Number(i) * SCALE + Number((f + '00').slice(0, 2));
  return validMinor(n);
}

/** Validates an amount that is already in hundredths of a toman. */
export function validMinor(n: number): ParseResult {
  if (!Number.isSafeInteger(n) || n > MAX_AMOUNT) return { ok: false, error: 'مبلغ بیش از حد مجاز است' };
  if (n <= 0) return { ok: false, error: 'مبلغ باید بزرگ‌تر از صفر باشد' };
  return { ok: true, value: n };
}

const NF = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2 });
/** Formats an amount in hundredths of a toman (e.g. 3333 -> «۳۳٫۳۳ تومان»). */
export function formatToman(n: number): string {
  return NF.format(n / SCALE) + ' تومان';
}
