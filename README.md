# mkfn-token_radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aditisstillalive/mkfn-token_radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It ranks the DeFi protocols in a sealed DefiLlama snapshot that record no token by what a token would be worth if each protocol's record stayed as it is. Each one comes with a costed, step-by-step farm plan, shown in an offline dashboard.

**Model (`comps-v2`, `lib/model.ts`).** `implied = TVL × category multiple × size × momentum × runway × class`

- **Category multiple.** Market cap ÷ TVL of the snapshot's own trading tokens, one comp per token, with every product of a token merged. Tokens whose main product is a CEX, bridge, staking wrapper or versioned fork are left out. Category means are shrunk toward a family (vault managers, trading venues, credit, real-world assets, infrastructure) and then toward all comps.
- **Size.** A least-squares slope of the multiple on log TVL, fitted on the comps.
- **Momentum.** The 7-day TVL change, clamped, raised to the power 1.5.
- **Runway.** A saturating credit for days run with no token.
- **Class.** Protocols that pass the watchlist rule count in full. Ones above the floor but left off the watchlist (they have a parent protocol) are cut to 0.35. Wrapped, staked, bridged and CEX products are set aside off the board.

No protocol name appears in the code.

**Farm plans (`lib/farm.ts`).** Each plan has seven steps, each with its cost and time. The plan picks the cheapest chain the protocol is on, sizes a ticket to its TVL, sets an exit trigger from its 7-day change, and checks whether the estimated airdrop on that ticket covers the fees.

**Dashboard (`dashboard/`).** A sortable and filterable board covering 198 tokenless candidates and all 40 watchlist protocols. Each row opens a detail view with the value build-up, the comps behind its multiple, and the farm plan. It also has a set-aside list and a model & comps page. It runs with no network.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
# then open out/dashboard/index.html
# checks: tools/build.sh /path/to/snapshot.json (two runs byte-identical + the gate's seven rows)
# screenshots: PLAYWRIGHT=<playwright package dir> node tools/shoot.mjs out
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
