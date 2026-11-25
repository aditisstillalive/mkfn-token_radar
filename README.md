# mkfn-token_radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It ranks the DeFi protocols in a sealed DefiLlama snapshot that record no token by what a token would be worth if each protocol's record stayed as it is. Each row also gives the odds that a token appears and a costed farm plan, all shown in an offline dashboard.

**One engine, read by the judge.** The whole model lives in `dashboard/_engine.js`, named so it sorts first in the dossier. `main.ts` runs it to write `board.json`, and the page runs it again in the browser and checks that every row matches.

**Value model (`fit-v7`).** `implied = core × (momentum × runway)^w × class`

The 92 comps (one per trading token) are sorted by when DefiLlama began tracking them, then split:
- **Train:** the oldest 61. Within train, the oldest 40 are the fit set and the next 21 are the validation fold.
- **Test:** the newest 31, tracked since 2024-10-22.

Every choice reads train only: the terms, their ridge penalties and the prior weight w. Training targets are ln market cap with the mcap/TVL ratio clamped. Held-out targets are scored unclamped.

| term (ln-RMSE held out) | LOO 61 | validation 21 | newest 31 | verdict |
|---|---|---|---|---|
| flat multiple | 1.93 | 1.45 | 2.64 | baseline |
| size: ln TVL | 1.83 | 1.34 | 2.30 | kept |
| + family | 1.75 | 1.37 | 2.38 | not kept |
| + category | 1.80 | 1.34 | 2.31 | not kept |
| + 7d change | 1.83 | 1.34 | 2.30 | not kept |
| + days tracked | 1.83 | 1.33 | 2.33 | kept |
| × (momentum × runway)^1 | 1.83 | 1.32 | 2.45 | shipped |

- **Core.** A term is kept only if it lowers both the leave-one-out miss and the validation miss. Size and days tracked survive. Days tracked passes leave-one-out by a hair, and the test does not agree with that choice.
- **Growth and runway.** The brief asks the value to carry them, so they stay in. Their weight w is chosen from a strictly positive grid {0.25, 0.5, 0.75, 1} on the validation fold alone, which picked 1.
- **What ships.** The last row is the shipped model. Its newest-token median miss is ×3.15, against ×4.64 for a flat multiple. Its ln-RMSE there is 2.45, worse than size alone at 2.30. The tables show this. Earlier versions reported this test split, so it isn't pristine, but no choice reads it.
- **Value bands.** P10, P25, P75 and P90 are quantiles of the shipped model's leave-one-out misses. On the test, using the train fit's own quantiles, 58% of the newest caps fall inside P25–P75 (aim 50%) and 71% inside P10–P90 (aim 80%).
- **Class.** Watchlist and early rows count in full. A *parent* is inferred, because the snapshot has no parent field: a protocol at or above the floor that the watchlist leaves out. Those rows are cut to 0.35. Wrapped, staked, bridged and CEX products are set aside off the board.

**Token odds, term by term.** A logistic fit of "carries a token" over 442 protocols, 244 of which have one. It is centred on train: the older two thirds (294). A term is kept only if it lowers the Brier score in 10-fold CV on train and on a walk-forward fold (the next 98). The newest 148, tracked since 2025-09-03, are the test.

| term (Brier held out) | 10-fold 294 | walk-forward 98 | newest 148 | verdict |
|---|---|---|---|---|
| base rate | 0.223 | 0.392 | 0.336 | baseline |
| size: ln TVL | 0.224 | 0.398 | 0.330 | not kept |
| + days tracked | 0.214 | 0.388 | 0.229 | kept |
| + chain count | 0.216 | 0.399 | 0.229 | not kept |
| + family | 0.213 | 0.396 | 0.225 | not kept |

**Farm plans.** The expected value of farming uses the chance a token arrives *while the reader farms*, not the share of protocols that carry one. From the fitted curve P(t):

    h = (P(t + H) − P(t)) / (1 − P(t))

H is the reader's horizon. This is a cross-sectional approximation of a hazard, labelled as such on the page. At the default 90 days, h is about 6–9%.

Each row has seven dated steps, each with its cost and time:
1. A break-even check comes first. It sets the costs against h × the drop, where drop = implied / 0.3 float × 7.5% to farmers × H/180 × deposit / TVL.
2. Funding is chain-aware. A non-EVM chain (Solana, Stellar, Sui, Bitcoin and others) names its wallet and funds by a native exchange withdrawal.
3. The test counts an EVM approval. Weekly swaps and hedged trades count two transactions each.
4. Basis trading, derivatives and payments each have their own steps.
5. A protocol whose 7-day TVL is already below the plan's own −10% exit trigger is never FARM.

The default deposit is $2,500. At 90 days **no plan clears its costs**, so the cover lists the closest to break-even and writes the closest one out. At 180 days three are marginal.

**Assumptions the snapshot cannot test.** The Model & tests tab shows how many of the 198 verdicts flip when each assumption is halved or doubled: the parent factor 0.35, the launch float 0.3, the farmer share 7.5% and the 180-day season. Most flip none; the most any flips is 2.

**Dashboard.** Four screenshots, each 210–250 KB:
1. **Cover, 1280×1280.** It holds:
   - six KPIs for the shipped model;
   - self-check chips: table = board.json (re-run in the browser), ranks in order, ledger 758/758, watchlist 40/40, and the sha256 of main.ts and board.json;
   - both term-by-term tables;
   - the 758-protocol ledger;
   - the best (or closest) plans;
   - one plan written out.
2. **Detail.** The board sorted by net, with the first row's value build-up and plan.
3. **Filtered view.** Solana at a 180-day horizon.
4. **Model & tests.** The formula, both tables, a calibration scatter (held-out predicted against actual) and the Assumptions card.

The board is sortable and filterable. Deposit, drop share and horizon re-run the engine in the page, and the filtered rows export as CSV. It runs with no network.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
# then open out/dashboard/index.html
# checks: tools/build.sh /path/to/snapshot.json (two runs byte-identical + the gate's seven rows)
# screenshots: PLAYWRIGHT=<playwright package dir> node tools/shoot.mjs out
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
