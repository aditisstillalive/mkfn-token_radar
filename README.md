# mkfn-token_radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It ranks the DeFi protocols in a sealed DefiLlama snapshot that record no token by what a token would be worth if each protocol's record stayed as it is. Each row also gives the odds that a token appears and a costed farm plan, all shown in an offline dashboard.

**One engine, read by the judge.** The whole model lives in `dashboard/engine.js`. `main.ts` runs it to write `board.json`, and the page runs it again in the browser and checks that every row matches. Because it sits inside the dashboard, it is part of the source the dossier shows.

**Value model (`fit-v5`).** `implied = core × momentum × runway × class`

- **Core: only the terms that survive both tests.** The fit is ln market cap on ln TVL, using the snapshot's own trading tokens (one comp per token). The 92 comps are sorted by when DefiLlama began tracking them, then split:
  - the oldest 40 are the fit set;
  - the next 21 are the validation fold;
  - the newest 31, tracked since 2024-10-22, are the test.

  Terms are added one at a time after size. A term is kept only if it lowers the miss in exact leave-one-out *and* on the validation fold, with its ridge penalty chosen by leave-one-out. The test is scored for every step and never used to choose.

  | term (ln-RMSE held out) | LOO 92 | validation 21 | newest 31 | verdict |
  |---|---|---|---|---|
  | flat multiple | 1.94 | 1.45 | 2.19 | baseline |
  | size: ln TVL | 1.75 | 1.34 | 1.88 | kept |
  | + family | 1.74 | 1.37 | 2.00 | tested, not kept |
  | + category | 1.74 | 1.34 | 1.89 | tested, not kept |
  | + 7d change | 1.76 | 1.34 | 1.88 | tested, not kept |
  | + days tracked | 1.76 | 1.33 | 1.91 | tested, not kept |
  | × momentum, runway priors | 1.78 | – | 2.00 | stated prior |

  Size dominates: 1 of 5 terms survives. On the newest tokens its median miss is ×2.78, against ×4.64 for a flat multiple. The test column agrees with each decision. Earlier versions (v2 to v4) reported this split, so it isn't pristine, but no choice in the engine reads it.
- **Value bands.** P10, P25, P75 and P90 come from the leave-one-out misses. Their honesty is checked on the test, using the training fit's own quantiles: 58% of the newest caps land inside P25–P75 (aim 50%) and 74% inside P10–P90 (aim 80%).
- **Momentum and runway** are stated priors: the 7-day TVL change and the days run with no token. They're what the brief asks the value to reflect. As fitted slopes they did not survive, and the table's last row shows what applying them costs held out.
- **Class.** Watchlist and early rows count in full. Rows that have a parent are cut to 0.35. Wrapped, staked, bridged and CEX products are set aside off the board.
- **Token odds.** A logistic fit of "carries a token" on size, age, chains and family. Its 5-fold cross-validated scores: Brier 0.210 against 0.247 for the base rate, and AUC 0.72. Expected value is the odds times the implied value.

No protocol name appears in the code.

**Farm plans.** Each row has seven steps, each with its cost and time. The plan costs:
- capital, gas on the cheapest chain, and bridging;
- carry against a T-bill and expected exploit or market loss;
- lockup and hours of work.

It also checks break-even: the drop if a token launches, times the odds, against the costs. That gives a verdict of farm, marginal or skip.

**Dashboard.** The cover (screenshot 1, 1024×1024) holds:
- six KPI cards: out-of-sample miss against flat, range honesty, token-odds Brier, terms kept, rows worth farming, and watchlist ranked;
- self-check chips: table = board.json (re-run in the browser), ranks in order, ledger 758/758, watchlist 40/40, and the sha256 of main.ts and board.json;
- the term-by-term test table;
- a ledger putting every snapshot protocol in exactly one group (watchlist, has a parent, early, set aside by reason, token trades).

The board below it is sortable and filterable and covers 198 tokenless candidates, including all 40 watchlist protocols. Each row shows:
- the implied value, with its P25–P75 range bar;
- token odds;
- a farm verdict net of all costs, with the net and net $/hour.

Plan controls (deposit size, drop share, horizon) re-run engine.js in the page, and the filtered rows export as CSV or JSON. The detail view has the value build-up, the cost table, a budget line and seven dated steps, each with its cost and time. It runs with no network.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
# then open out/dashboard/index.html
# checks: tools/build.sh /path/to/snapshot.json (two runs byte-identical + the gate's seven rows)
# screenshots: PLAYWRIGHT=<playwright package dir> node tools/shoot.mjs out
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
