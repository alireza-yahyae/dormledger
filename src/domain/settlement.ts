export type Transfer = { fromId: string; toId: string; amount: number };

/** Greedy matching of largest debtor with largest creditor. Deterministic (ties by id). Not guaranteed minimal in transfer count. */
export function proposeTransfers(balances: Map<string, number>): Transfer[] {
  let sum = 0;
  for (const v of balances.values()) sum += v;
  if (sum !== 0) throw new Error('Balances do not sum to zero');
  const cmp = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  const cred = [...balances].filter(([, v]) => v > 0).sort(cmp);
  const debt = [...balances].filter(([, v]) => v < 0).map(([k, v]): [string, number] => [k, -v]).sort(cmp);
  const out: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i][1], cred[j][1]);
    out.push({ fromId: debt[i][0], toId: cred[j][0], amount: amt });
    debt[i][1] -= amt; cred[j][1] -= amt;
    if (debt[i][1] === 0) i++;
    if (cred[j][1] === 0) j++;
  }
  return out;
}
