# draft-king-data

Champion tier data for Draft King, recomputed weekly from real ranked games.

This repo is public so the app can read `tiers.json` without shipping a token.
It holds data and one script — no app code.

## What the app does with it

Draft King fetches `tiers.json` when its cached copy is more than 7 days old,
validates it, and overlays the tiers on the ones bundled in the build. Users get
fresh tiers without reinstalling anything.

A feed is **rejected whole** if it is an unknown version, has a nonsense patch or
timestamp, carries an invalid tier, covers fewer than 100 champions, or puts
everything in fewer than 3 tiers. Rejected or unreachable means the app keeps its
bundled tiers, so a bad publish here degrades to "slightly stale", never to
"broken recommendations". Champions missing from the feed keep their bundled tier
individually, which is what happens to a champion too new or too rare to have a
sample.

## How tiers are computed

1. Take the current patch from Data Dragon.
2. Gather players. By default the challenger, grandmaster and master ladders —
   the strongest play, though a meta that differs from everyone else's.
   Setting `RANK_TIERS` (e.g. `GOLD,PLATINUM`) walks those ranked ladders
   instead, which is the meta your own games are actually against.
3. Sample their Ranked Solo/Duo matches from the last `MATCH_WINDOW_DAYS` days
   until the match budget is met. The window matters: without it, most of a
   mid-ladder sample is games from the previous patch, fetched and thrown away.
   `gameVersion` still has the last word on what counts.
4. Count games and wins per champion **per role**, plus bans per champion,
   skipping remakes.
5. Judge each champion in the role it is played in most, requiring at least
   `MIN_GAMES` there. Below that it is omitted rather than guessed at.
6. Shrink each win rate toward its own role's mean, so a thin sample cannot
   reach the top band.
7. Add presence — pick rate in the role plus ban rate — at a small weight.
   This corrects win rate's blind spot: a champion picked in 0.5% of games at
   54% is a specialist pick whose win rate belongs to its dedicated players,
   while one picked or banned constantly is respected by everyone.
8. Assign a tier by percentile **within the role**: top 5% `S+`, next 15% `S`,
   next 25% `A`, next 40% `B`, bottom 15% `C`.

So `S` means "near the top of its own lane", not "top of a global list".
`tiers-detail.json` records each champion's games, raw and shrunk win rate,
pick rate, ban rate and composite score, so a surprising tier can be traced
back to its numbers.

## Setup

The workflow needs one secret: `RIOT_API_KEY`.

Development keys from the Riot developer portal expire every 24 hours, which a
weekly job cannot use. Register an application there for a **Personal** key
(persistent, free, approval is a form) and add it under
Settings → Secrets and variables → Actions.

Until that secret exists the workflow fails on purpose, with a clear message,
rather than publishing anything.

## Running it locally

```bash
node update-tiers.cjs --self-test          # no network, checks the maths
RIOT_API_KEY=RGAPI-... node update-tiers.cjs
```

Environment:

| Variable | Default | Notes |
|---|---|---|
| `PLATFORM` | `euw1` | Platform route; the regional match route follows from it |
| `RANK_TIERS` | *(empty)* | Empty or `HIGH_ELO` for master+, else e.g. `GOLD,PLATINUM` |
| `MATCH_BUDGET` | `1500` | Usable matches to aggregate |
| `MIN_GAMES` | `30` | Games in its main role before a champion is tiered |
| `MATCH_WINDOW_DAYS` | `7` | Only sample games this recent |
| `REQUEST_INTERVAL_MS` | `1250` | Dev-key safe; a Personal key can run ~150 |
| `MAX_REQUESTS` | `12000` | Hard ceiling, so a thin sample can't run forever |
| `OUT` | `tiers.json` | Output path |

At `REQUEST_INTERVAL_MS=150` a full run takes roughly 5–10 minutes. On a
development key it is closer to 40, and dev keys expire every 24 hours.

## What this does not cover

Only the tier baseline. Draft King's matchup table, synergies and per-champion
trait ratings are hand-tuned and stay that way — matchups in particular carry
more weight in scoring than tier does, so a weekly tier refresh keeps the model
*partly* current, not current.
