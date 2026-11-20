// Farm plans: concrete steps, each with what it costs and how long it takes, built from the
// protocol's own record (its category, its chains, its TVL, its 7-day change and its tokenless age).
// No name is special-cased: the category picks the action, the chains pick where and at what gas.

import { K, type SnapshotProtocol } from './model.ts';

export interface FarmStep { do: string; cost: string; time: string }
export interface FarmPlan { chain: string; gasUsd: number; ticketUsd: number; costUsd: number; hours: number; stance: string; steps: FarmStep[] }

/** Typical USD cost of one contract interaction, by chain (late-2026 order of magnitude). */
const GAS: Record<string, number> = {
  Ethereum: 4, Bitcoin: 3, Tron: 1.5, Algorand: 0.01, Solana: 0.01, Sui: 0.02, Aptos: 0.01, Base: 0.05,
  Arbitrum: 0.08, Optimism: 0.05, Binance: 0.08, Polygon: 0.02, Avalanche: 0.1, Monad: 0.03, Sonic: 0.02,
  Hyperliquid: 0.02, 'Hyperliquid L1': 0.02, Ink: 0.03, Plasma: 0.01, Berachain: 0.05, Stellar: 0.01,
  Ripple: 0.01, Flare: 0.02, Katana: 0.03, Unichain: 0.03, Linea: 0.06, Scroll: 0.06, Mantle: 0.04,
  TON: 0.03, Starknet: 0.04, Near: 0.01, Cardano: 0.2, Bittensor: 0.01, Noble: 0.02, Osmosis: 0.02,
};
const DEFAULT_GAS = 0.25;

/** The cheapest of the chains the protocol's TVL is counted on: where a small farmer should start. */
export function farmChain(p: SnapshotProtocol): { chain: string; gas: number } {
  let best = { chain: p.chains[0] ?? 'Ethereum', gas: GAS[p.chains[0] ?? 'Ethereum'] ?? DEFAULT_GAS };
  for (const c of p.chains) {
    const g = GAS[c] ?? DEFAULT_GAS;
    if (g < best.gas) best = { chain: c, gas: g };
  }
  return best;
}

const usd = (x: number) => (x >= 100 ? `$${Math.round(x).toLocaleString('en-US')}` : `$${x.toFixed(2)}`);
const nice = (x: number) => {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * e;
};

type Action = { asset: string; act: (c: string) => string; extra: (c: string) => string; txs: number; mins: number; lock: string };

/** What farming looks like in each family of category. */
function action(cat: string | null): Action {
  const c = cat ?? '';
  if (/Risk Curators|Onchain Capital Allocator|Yield Aggregator|Options Vault|Liquidity Manager/.test(c))
    return { asset: 'USDC', act: (ch) => `Deposit USDC into the protocol's largest curated vault on ${ch} (through its own app or the lending market it curates); confirm the vault page names the protocol as curator before signing`, extra: () => `Add a second vault of the same curator on a different chain, since curator points programs tend to reward breadth across vaults`, txs: 2, mins: 15, lock: 'withdrawable any block, subject to vault liquidity' };
  if (/Dexs/.test(c))
    return { asset: 'a major pair (e.g. USDC + the chain\'s native asset)', act: (ch) => `Provide liquidity to the deepest pool on ${ch}, a concentrated range about +/-10% around spot so the position earns fees and volume points`, extra: () => `Make one swap a week through the protocol's router: many DEX points programs score swap volume separately from liquidity`, txs: 3, mins: 25, lock: 'none; impermanent loss is the cost of holding the range' };
  if (/Lending|CDP|Uncollateralized/.test(c))
    return { asset: 'ETH or USDC', act: (ch) => `Supply collateral on ${ch}, then borrow the protocol's stablecoin or USDC at a loan-to-value at least 25 points below liquidation`, extra: () => `Re-supply part of the borrow (one loop, no more), because supply and borrow both earn points and a single loop keeps liquidation risk bounded`, txs: 3, mins: 20, lock: 'repay to exit; watch the health factor' };
  if (/RWA|Stablecoin Wrapper|Dual-Token Stablecoin|CeDeFi|Basis Trading|Yield/.test(c))
    return { asset: 'USDC', act: (ch) => `Mint or subscribe to the protocol's yield-bearing token on ${ch}; finish its KYC or allow-listing first if the app asks (budget a day for approval)`, extra: () => `Deposit the minted token into one partner pool or lending market that the protocol lists, since composability boosts are common in these points programs`, txs: 2, mins: 30, lock: 'redemption can take T+1 to T+7 for RWA or basis products' };
  if (/Derivatives|Prediction Market|Interest Rate/.test(c))
    return { asset: 'USDC margin', act: (ch) => `Deposit USDC margin on ${ch} and trade small, hedged size (open and close, or a delta-neutral pair) to log volume without directional risk`, extra: () => `Deposit idle margin into the protocol's liquidity or insurance vault, which usually earns points between trades`, txs: 4, mins: 30, lock: 'margin withdrawable; vault exits may queue' };
  if (/Restaking|Staking Pool|Anchor BTC|Decentralized BTC|Collateral Markets/.test(c))
    return { asset: 'ETH or BTC', act: (ch) => `Stake or restake the base asset through the protocol on ${ch}, choosing the default operator set rather than a boosted, riskier one`, extra: () => `Delegate to a second operator or vault inside the protocol so your points do not depend on one operator`, txs: 2, mins: 20, lock: 'unbonding queues of 7 to 21 days are typical' };
  if (/Chain|Payments|Privacy|Governance Incentives|Insurance|Farm/.test(c))
    return { asset: 'stablecoins', act: (ch) => `Bridge stablecoins to ${ch} with the canonical bridge and use the protocol's core product (deposit, pay, cover or stake) at least once`, extra: (ch) => `Interact with two or three other apps on ${ch}: network-level programs reward breadth and recurring activity, not one big deposit`, txs: 4, mins: 40, lock: 'bridging back can take minutes to 7 days' };
  return { asset: 'USDC', act: (ch) => `Deposit into the protocol's main product on ${ch} and confirm the position shows in its dashboard`, extra: () => `Repeat a small interaction weekly so the address shows sustained use`, txs: 2, mins: 20, lock: 'check the app for withdrawal terms' };
}

/** The farm plan for one protocol; `estPer1k` is the model's airdrop estimate per $1,000 farmed. */
export function farmPlan(p: SnapshotProtocol, age: number | null, estPer1k: number): FarmPlan {
  const { chain, gas } = farmChain(p);
  const a = action(p.category);
  const ticket = Math.min(10_000, Math.max(250, nice(p.tvl_usd / 50_000)));
  const g = p.change_7d;
  const days = age ?? 0;
  const stance = age === null ? 'Age unknown: size as a long-dated farm.'
    : days < 180 ? `Only ${days} days tracked: early, the cheapest time to accrue points, and the riskiest.`
    : days < 730 ? `${days} days with no token: the usual window in which protocols launch one.`
    : `${days} days with no token: long-dated; it may never launch, so keep capital light.`;

  const bridge = chain === 'Ethereum' ? 0 : chain === 'Bitcoin' ? 5 : 1.5;
  const setupCost = bridge + gas * 2;
  const actCost = gas * a.txs;
  const extraCost = gas * 2 + (a.txs > 3 ? 1 : 0);
  const weekly = gas;
  const exitCost = gas * 2 + bridge;
  const weeks = Math.round(K.FARM_DAYS / 7);
  const total = setupCost + actCost + extraCost + weekly * weeks + exitCost;
  const ev = (estPer1k * ticket) / 1000;

  const trigger = g === null ? 'TVL falls 20% in a week' : `7-day TVL change goes below ${Math.min(-10, Math.round(g - 15))}% (it is ${g >= 0 ? '+' : ''}${g.toFixed(1)}% now)`;
  const steps: FarmStep[] = [
    { do: `Fund a fresh wallet on ${chain}${p.chains.length > 1 ? ` (the cheapest of its ${p.chains.length} chains)` : ''} with ${a.asset}, and bookmark the official app from DefiLlama's protocol page, not from search ads`, cost: `${usd(setupCost)} bridge and gas`, time: '15 min' },
    { do: `Test with $100 first: ${a.act(chain).replace(/^./, (m) => m.toLowerCase())}`, cost: `${usd(gas * a.txs)} gas`, time: `${a.mins} min` },
    { do: `Scale to the suggested ticket of ${usd(ticket)} once the test position shows up and can be withdrawn (${a.lock})`, cost: `${usd(actCost)} gas, ${usd(ticket)} capital at risk`, time: '10 min' },
    { do: a.extra(chain), cost: `${usd(extraCost)} gas`, time: '20 min' },
    { do: `Hold for ${K.FARM_DAYS} days and make one small interaction a week (claim, compound or top up) so the address shows sustained use; log each points snapshot`, cost: `${usd(weekly)} a week, ${usd(weekly * weeks)} in all`, time: `5 min a week for ${weeks} weeks` },
    { do: `Exit or cut to half if the ${trigger}, or if the team announces a snapshot has passed`, cost: `${usd(exitCost)} gas`, time: '15 min' },
    { do: `Break-even check: the model's airdrop estimate on this ticket is ${usd(ev)} against about ${usd(total)} in fees, so ${ev > total * 1.5 ? 'it is worth farming at this size' : ev > total ? 'it is marginal; farm only alongside other positions on the chain' : 'fees eat the estimate; farm it only with a larger ticket or skip it'}`, cost: 'none', time: '2 min' },
  ];
  const mins = 15 + a.mins + 10 + 20 + 5 * weeks + 15 + 2;
  return { chain, gasUsd: gas, ticketUsd: ticket, costUsd: Math.round(total * 100) / 100, hours: Math.round((mins / 60) * 10) / 10, stance, steps };
}

/** A step as one line for board.json: the action, then its cost and time. */
export function stepLine(s: FarmStep): string {
  return `${s.do}. Cost: ${s.cost}. Time: ${s.time}.`;
}
