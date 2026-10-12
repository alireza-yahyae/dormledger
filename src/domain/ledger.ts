import type { Allocation } from './allocation.ts';

export type LedgerExpense = {
  id: string; total: number; payerId: string; allocations: Allocation[];
  status: 'active' | 'cancelled'; date?: string;
};
export type LedgerSettlement = { id: string; fromId: string; toId: string; amount: number; status: 'confirmed' | 'pending' | 'cancelled' };

/** net = paid − allocated (+ settlements: payer of a settlement gains credit, recipient loses). Derived purely from records. */
export function computeBalances(memberIds: string[], expenses: LedgerExpense[], settlements: LedgerSettlement[] = []): Map<string, number> {
  const net = new Map<string, number>(memberIds.map((m) => [m, 0]));
  const add = (id: string, d: number) => net.set(id, (net.get(id) ?? 0) + d);
  for (const e of expenses) {
    if (e.status !== 'active') continue;
    const sum = e.allocations.reduce((a, x) => a + x.amount, 0);
    if (sum !== e.total) throw new Error(`Expense ${e.id}: allocations ${sum} != total ${e.total}`);
    add(e.payerId, e.total);
    for (const a of e.allocations) add(a.memberId, -a.amount);
  }
  for (const s of settlements) {
    if (s.status !== 'confirmed') continue;
    add(s.fromId, s.amount);
    add(s.toId, -s.amount);
  }
  return net;
}
