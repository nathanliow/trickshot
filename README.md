# Trickshot

Rebuild any Solana token from the chain and replay what a wallet did on it — as
a chart you can record and post.

Two ways in. Give it a **mint** and it reconstructs the price history as
candles and ranks who made and lost the most. Give it a **wallet** and it lists
every token that wallet has traded, then plays its buys and sells back on the
bars with its PnL stepping alongside.

Live: **[trickshot-memes.vercel.app](https://trickshot-memes.vercel.app)**

## Run it

    cp .env.example .env.local     # add HELIUS_API_KEY
    npm install
    npm run dev

One key is all it needs, on a paid Helius plan — `getTransactionsForAddress`,
`searchAssets` and the wallet-identity endpoint are not on the free tier.
Everything else is optional.

Results are cached in `.trickshot-cache/`, so a second look is quick. Set
`SUPABASE_URL` and `SUPABASE_KEY` and the cache moves there instead, which is
what a deployment reads from.

## Two kinds of request, and why they differ

The asymmetry runs through everything, so it is worth stating plainly.

**A mint alone** means "draw this token's whole life" — every bar from launch to
now. MEASURED, that is 26,000–55,000 Helius credits and a few minutes, and
nothing the visitor supplies bounds it. So it is **owner-only**: a mint the site
has not built answers "not on this site yet — try your wallet".

**A mint and a wallet** is bounded by that wallet's own trading history — a
call or two, and a chart drawn only for the window it traded in. Usually a few
hundred credits. So that path is **open**, and it is how the catalogue grows.

A wallet replay leaves a `window` row behind: enough to replay that wallet
again instantly, not enough to be a token page. It never reaches the gallery,
because its chart covers one wallet's span and nobody has ranked the traders.

## Indexing a token properly

    npm run index -- <mint>                    chart only
    npm run index -- <mint> --top 10           …board, and replays for its top and bottom 10
    npm run index -- <mint> --wallets <a>,<b>  …and linked wallets for these
    npm run index -- <mint> --include <a>      pin a wallet onto the board
    npm run index -- <mint> --update           re-read every ranked wallet

`--top` is the one worth using. Alongside the board it pre-builds the replays
its ranked wallets will want, because a wallet's chart is drawn at ITS bar width
and only the token's own was built — on one 27-day token the board sits at
7,200s bars while wallets off it wanted 28,800s. Without the pre-build every
name on the board is a minute's wait the first time it is clicked.

## Letting the site build things

A deployment with `TRICKSHOT_READONLY=1` and a read-only key serves what the
owner indexed and builds nothing. Turning that off is what makes it self-serve,
and it needs the rest of this section first — the flag was the only thing
standing between an anonymous request and a fifty-thousand-credit build.

    psql < scripts/migrate.sql     # or paste it into the Supabase SQL editor

Then set, at minimum:

    TRICKSHOT_OWNER_TOKEN=   board refreshes, graphs, /api/usage. UNSET MEANS NOBODY.
    CRON_SECRET=             the queue worker. UNSET MEANS IT REFUSES EVERYONE.
    HELIUS_DAILY_CREDITS=    a ceiling on the day. 0 disables it.

What bounds a visitor, checked in this order:

| | default | stops |
| --- | --- | --- |
| `TRICKSHOT_DISABLE_BUILDS` | off | everything, without a redeploy |
| `HELIUS_DAILY_CREDITS` | 0 (off) | cost — one runaway build |
| `MAX_BUILDS_PER_DAY` | 300 | volume — many ordinary ones |
| `VISITOR_BUILDS_PER_IP` | 20 | one person grinding a long wallet |
| `VISITOR_BUILDS_PER_WALLET` | 20 | one wallet farmed from many IPs |
| `MAX_CONCURRENT_BUILDS` | 3 | everyone arriving at once |
| `VISITOR_MAX_CREDITS` | 10,000 | one request that turns out expensive |

The last one is a pre-flight, not a stopwatch. Before drawing anything the
window is priced by counting signatures — ten credits a thousand — and refused
if it comes out too dear. That replaced attempting the build and letting a
ceiling kill it part-way, which MEASURED cost 4,342 credits to learn one fact
and kept nothing, because a gap is only stored once it completes.

Anything refused that way is queued instead, and `/api/cron/build` drains it
once a minute — one build per tick, deduped by mint, so ten people wanting the
same token is one build. `vercel.json` schedules it; per-minute crons need a
Vercel Pro plan.

`/api/usage` reports the day against those limits. Owner-only.

## What is in scripts/migrate.sql

Sections 1 and 2 are additive and safe to run against a live database — every
statement is `if not exists` or `create or replace`. Section 3 is row-level
security, left commented out, with the queries to check what you already have.

- **`trickshot_cache`** — the blob store. Everything built lives here.
- **`trickshot_counters`** + `trickshot_bump` — rate limits and the credit
  ceiling. Counting has to be atomic: two instances reading "1" and both
  writing "2" is exactly the case a limit exists to catch.
- **`trickshot_tokens`** + `trickshot_remember` — the catalogue. It began as one
  JSON row that every request loaded in full and every build rewrote; at six
  hundred tokens that is ~200KB a request and a lost-update race.
- **`trickshot_jobs`** + `trickshot_enqueue`/`trickshot_claim` — the build
  queue. Same problem, worse consequence: a dropped enqueue is somebody waiting
  on a page that never updates.

Without it the app falls back to JSON blobs and per-process counters. That is
correct for `next dev` and one long-lived server, and too loose for serverless —
each instance counts its own share.

## How it uses Helius

Five things, one key.

**`getTransactionsForAddress`** does the heavy lifting. Two details make the
project possible at all:

- `filters.blockTime` reaches a window days old directly instead of paging back
  to it, so a month-old token costs a few hundred calls rather than millions.
- `filters.tokenTransfer.mint` returns only the transactions that actually
  traded the token. Ask a busy pool for a five-minute window and you get 11,085
  transactions; ask with this filter and you get the 310 that were swaps — every
  one of them, and nothing else.

Point it at the **pool**, not the mint. A mint's transactions are mostly bots
referencing it without trading; a pool's are trades. Everything else depends on
that.

**Standard RPC** — `getTokenLargestAccounts`, `getMultipleAccounts`,
`getTokenSupply` — finds the pools and the holders.

**DAS** (`getAsset`, `getTokenAccounts`) gives token names, artwork, and the full
holder list. Use the `cdn_uri` it returns for images: token art is hosted
wherever its creator put it and plenty of those hosts refuse to serve it to
anyone else.

**Wallet Identity** (`/v1/wallet/batch-identity`) puts names to addresses where
it knows them — exchanges, protocols, a few thousand known traders. A hundred
credits per REQUEST, not per address, so a single-wallet lookup costs what a
batch of a hundred does — which is why answers are cached, misses included.

**`searchAssets`** answers "what has this wallet traded", which nothing else
here asks. The first version paged transfers and was wrong in a way only a real
wallet showed: MEASURED on one, two thousand transfers cost 200 credits and
turned up ONE token, because 1,999 of them were USDC inside a two-hour window.
The same wallet's token accounts are 329 mints in one call at ten credits.
Holdings are not trades, though, so each row is checked for an actual swap
before it is offered — an airdrop nobody touched replays as an empty chart.

Prices come from **balances**, never from decoding instructions. A swap is two
balances moving in opposite directions inside one pool and the transaction
states both, so it works for venues no decoder knows — and a wallet's own token
delta cannot double-count a swap routed through three pools.

The only thing not from Helius is **SOL/USD by the minute**, from Binance's
public price mirror. A USD figure needs the SOL price at the time of the trade,
and Helius has no price history.

## What it does not do

Worth knowing before trusting a number.

- **The chart is one book.** A token trades on many pools at slightly different
  prices, so candles come from the busiest. A wallet's PnL counts every venue,
  because that path reads the wallet rather than a pool.
- **Long spans are sampled.** Past a few thousand swaps a bar is priced from
  trades spread across it. The prices are real trades; the volume is an estimate.
  The page says which a chart is.
- **The trader board is a shortlist.** Every figure shown is exact — each wallet
  is read in full — but a wallet that was never nominated is absent.
- **Fills are priced at the bar's mark**, not the exact execution price. The
  payer is often not the holder, so there is no reliable SOL leg on the wallet.
- **Transferred tokens have no cost basis.** They count toward a position and not
  toward profit.
- **A linked wallet is inference**, from funding and timing. Not proof of common
  ownership, and nothing is combined unless you ask.

## Layout

    src/app/api/          history · board · tokens · wallet · jobs · usage · cron
    src/server/pool       which book to read, and its vaults
    src/server/candles    windows to bars, priced from balances
    src/server/positions  PnL, and the replay curve
    src/server/wallet     what a wallet has held, from its token accounts
    src/server/estimate   what a window will cost, before drawing it
    src/server/queue      tokens too dear to draw on demand
    src/server/budget     what a visitor may start, and the day's ceiling
    src/server/meter      what every request spent, counted at the wrappers
    src/server/limit      one rate ceiling for the process
    src/server/graph      a wallet's counterparties
    src/server/store      anything built, kept between requests
    src/components        the chart, the replay, the boards
    src/lib/record        the replay, recorded to MP4
    src/lib/sound         a till on a sell, a fanfare every $20K

The reasoning behind each decision — and the measurements that forced it — is in
the comments, next to the code it explains.
