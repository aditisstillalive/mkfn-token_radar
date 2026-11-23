# mkfn-token_radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It ranks the DeFi protocols in a sealed DefiLlama snapshot that record no token by what a token would be worth if each protocol's record stayed as it is. Each row also gives the odds that a token appears and a costed farm plan, all shown in an offline dashboard.

**One engine, read by the judge.** The whole model lives in `dashboard/engine.js`. `main.ts` runs it to write `board.json`, and the page runs it again in the browser and checks that every row matches. Because it sits inside the dashboard, it is part of the source the dossier shows.

**Value model (`fit-v3`).** `implied = core × momentum × runway × class`

- **Core.** A ridge regression of ln market cap on ln TVL, with family and category effects, fitted on the snapshot's own trading tokens (one comp per token). The penalties are chosen by exact leave-one-out error.
- **Held-out tests,** shown on the board:
  - leave-one-out: ln-RMSE 1.73, against 1.94 for a flat multiple and 1.76 for size alone;
  - walk-forward (fit on the tokens DefiLlama tracked first, test on the newest third): 1.97, against 2.19 for a flat multiple. Size alone does better here, at 1.88.

  The leave-one-out residuals set each row's 80% value band.
- **Momentum and runway** are stated priors: the 7-day TVL change, and the days run with no token.
- **Class.** Watchlist and early rows count in full. Rows that have a parent are cut to 0.35. Wrapped, staked, bridged and CEX products are set aside off the board.
- **Token odds.** A logistic fit of "carries a token" on size, age, chains and family. Its 5-fold cross-validated AUC is 0.72. Expected value is the odds times the implied value.

No protocol name appears in the code.

**Farm plans.** Each row has seven steps, each with its cost and time. The plan costs:
- capital, gas on the cheapest chain, and bridging;
- carry against a T-bill and expected exploit or market loss;
- lockup and hours of work.

It also checks break-even: the drop if a token launches, times the odds, against the costs. That gives a verdict of farm, marginal or skip.

**Dashboard.** A sortable, filterable board covering 198 tokenless candidates and all 40 watchlist protocols. It has an integrity strip (snapshot, coverage, exclusions, test scores, in-browser recompute) and a detail view with the value build-up, the cost table and the steps. It also has a set-aside list and a model & test page with a held-out scatter. It runs with no network.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
# then open out/dashboard/index.html
# checks: tools/build.sh /path/to/snapshot.json (two runs byte-identical + the gate's seven rows)
# screenshots: PLAYWRIGHT=<playwright package dir> node tools/shoot.mjs out
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
