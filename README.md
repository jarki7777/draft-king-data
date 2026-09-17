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
2. Enumerate the challenger, grandmaster and master ladders for a platform
   (default `euw1`) — the strongest signal per game sampled.
3. Sample their recent Ranked Solo/Duo matches, 10 per player, until the match
   budget is met. Games from earlier patches are discarded: they describe a
   balance state that no longer exists.
4. Count games and wins per champion **per role**, skipping remakes.
5. Judge each champion in the role it is played in most, requiring at least
   `MIN_GAMES` there. Below that it is omitted rather than guessed at.
6. Shrink each win rate toward its own role's mean, so a thin sample cannot
   reach the top band.
7. Assign a tier by percentile **within the role**: top 5% `S+`, next 15% `S`,
   next 25% `A`, next 40% `B`, bottom 15% `C`.

So `S` means "near the top of its own lane", not "top of a global list".
`tiers-detail.json` records each champion's games, raw win rate and shrunk win
rate, so a surprising tier can be traced back to its numbers.

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

Environment: `PLATFORM` (default `euw1`), `MATCH_BUDGET` (1500), `MIN_GAMES`
(30), `OUT` (`tiers.json`).

A full run is paced for Riot's strictest rate limit and takes around 40 minutes.

## What this does not cover

Only the tier baseline. Draft King's matchup table, synergies and per-champion
trait ratings are hand-tuned and stay that way — matchups in particular carry
more weight in scoring than tier does, so a weekly tier refresh keeps the model
*partly* current, not current.
