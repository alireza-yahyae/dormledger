import { MAX_AMOUNT } from './money.ts';

export type Allocation = { memberId: string; amount: number };
export type AllocResult = { ok: true; allocations: Allocation[] } | { ok: false; error: string };

const isAmt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= MAX_AMOUNT;

/** Equal split. Remainder (total % n) goes one unit each to the first members in sorted-ID order (deterministic). */
export function equalAllocation(total: number, participantIds: string[]): AllocResult {
  if (!isAmt(total)) return { ok: false, error: 'مبلغ نامعتبر است' };
  if (participantIds.length === 0) return { ok: false, error: 'حداقل یک شریک انتخاب کنید' };
  if (new Set(participantIds).size !== participantIds.length) return { ok: false, error: 'شرکت‌کننده تکراری است' };
  const ids = [...participantIds].sort();
  const base = Math.floor(total / ids.length);
  const rem = total % ids.length;
  if (base === 0) return { ok: false, error: 'مبلغ برای این تعداد شریک کافی نیست' };
  return { ok: true, allocations: ids.map((memberId, i) => ({ memberId, amount: base + (i < rem ? 1 : 0) })) };
}

/** Custom exact shares. Never adjusts user input; rejects if sum != total. */
export function customAllocation(total: number, shares: Allocation[]): AllocResult & { remaining?: number } {
  if (!isAmt(total)) return { ok: false, error: 'مبلغ نامعتبر است' };
  if (shares.length === 0) return { ok: false, error: 'حداقل یک شریک انتخاب کنید' };
  const seen = new Set<string>();
  let sum = 0;
  for (const s of shares) {
    if (seen.has(s.memberId)) return { ok: false, error: 'شرکت‌کننده تکراری است' };
    seen.add(s.memberId);
    if (!isAmt(s.amount)) return { ok: false, error: 'سهم هر نفر باید عدد مثبت باشد' };
    sum += s.amount;
  }
  const remaining = total - sum;
  if (remaining !== 0) return { ok: false, error: remaining > 0 ? 'مجموع سهم‌ها کمتر از مبلغ کل است' : 'مجموع سهم‌ها بیشتر از مبلغ کل است', remaining };
  return { ok: true, allocations: shares.map((s) => ({ ...s })), remaining: 0 };
}
