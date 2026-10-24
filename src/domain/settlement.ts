export type Transfer = { fromId: string; toId: string; amount: number };

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cmp = (a: [string, number], b: [string, number]) => b[1] - a[1] || byId(a[0], b[0]);

/** Greedy matching of the largest debtor with the largest creditor. Deterministic (ties by id). */
function greedy(entries: [string, number][]): Transfer[] {
  const cred = entries.filter(([, v]) => v > 0).sort(cmp);
  const debt = entries.filter(([, v]) => v < 0).map(([k, v]): [string, number] => [k, -v]).sort(cmp);
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

/** Above this many non-zero balances the exact search (2^n) is skipped and the greedy plan is used. */
export const MAX_EXACT = 14;

/** Splits the non-zero balances into the MAXIMUM number of groups that each sum to zero (bitmask DP). */
function zeroSumGroups(nz: [string, number][]): [string, number][][] {
  const n = nz.length, N = 1 << n;
  const sum = new Float64Array(N), dp = new Int8Array(N), pick = new Int8Array(N);
  for (let m = 1; m < N; m++) {
    sum[m] = sum[m & (m - 1)] + nz[31 - Math.clz32(m & -m)][1];
    let best = -1, bi = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) { const d = dp[m ^ (1 << i)]; if (d > best) { best = d; bi = i; } }
    dp[m] = best + (sum[m] === 0 ? 1 : 0);
    pick[m] = bi;
  }
  // The removal chain is an ordering of members; every prefix whose sum is zero closes one group.
  const order: number[] = [];
  for (let m = N - 1; m; m ^= 1 << pick[m]) order.push(pick[m]);
  order.reverse();
  const groups: [string, number][][] = [];
  let cur: [string, number][] = [], run = 0;
  for (const i of order) { cur.push(nz[i]); run += nz[i][1]; if (run === 0) { groups.push(cur); cur = []; } }
  return groups;
}

/**
 * Suggested transfers that zero every balance using the fewest payments: a group of k people needs k-1 transfers,
 * so the more independent zero-sum groups, the fewer payments. Exact for up to MAX_EXACT non-zero balances,
 * greedy beyond that. Deterministic.
 */
export function proposeTransfers(balances: Map<string, number>): Transfer[] {
  let sum = 0;
  for (const v of balances.values()) sum += v;
  if (sum !== 0) throw new Error('Balances do not sum to zero');
  const nz = [...balances].filter(([, v]) => v !== 0).sort(([a], [b]) => byId(a, b));
  if (!nz.length) return [];
  if (nz.length > MAX_EXACT) return greedy(nz);
  const groups = zeroSumGroups(nz).map((g) => g.sort(([a], [b]) => byId(a, b))).sort((a, b) => byId(a[0][0], b[0][0]));
  return groups.flatMap(greedy);
}

/**
 * Rounds every balance to a multiple of `unit` while keeping the total at exactly zero (largest-remainder method),
 * so the suggested transfers are round numbers. `unit` <= 1 returns the balances unchanged.
 */
export function roundBalances(balances: Map<string, number>, unit: number): Map<string, number> {
  let total = 0;
  for (const v of balances.values()) total += v;
  if (!(unit > 1) || total !== 0) return new Map(balances);
  const down = new Map<string, number>(), rem: [string, number][] = [];
  let sumDown = 0;
  for (const id of [...balances.keys()].sort(byId)) {
    const v = balances.get(id)!, r = ((v % unit) + unit) % unit; // exact integer arithmetic, also for negatives
    down.set(id, v - r + 0); rem.push([id, r]); sumDown += v - r; // `+ 0` turns -0 into 0
  }
  const k = Math.round(-sumDown / unit);
  rem.sort((a, b) => b[1] - a[1] || byId(a[0], b[0]));
  for (let i = 0; i < k; i++) down.set(rem[i][0], down.get(rem[i][0])! + unit);
  return down;
}
