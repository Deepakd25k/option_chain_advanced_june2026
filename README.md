# Option Buyer Cockpit

Formula-backed intraday option-chain dashboard for Indian index option buyers. It is built as a dependency-free static website with a Vercel serverless API route for Upstox REST data.

## Current Trading Surface

- Market Structure Intelligence: one dynamic card detects opening location, highest single-strike PE/CE OI walls inside ATM ±11 strikes, confirmed ranges, support/resistance tests, and directional inventory pressure.
- A range is confirmed only from completed 5m candles: up to 100 points wide, at least 20 minutes old, with repeated upper/lower interaction and direction changes.
- Support, ATM, and resistance contracts show current OI/mid plus actual Open, 5m, 15m, and 30m OI and premium changes.
- Material OI plus delta-adjusted premium residual classifies concise writing, long buildup, short covering, and long-unwinding behavior inside the same card.
- Premium confirmation uses bid/ask midpoint, starting-delta adjustment, and common CE/PE volatility removal instead of raw LTP direction alone.
- Auto expiry fetch from Upstox option contracts; nearest expiry is selected automatically.
- Index selector includes NIFTY50, BANKNIFTY, FINNIFTY, and SENSEX.
- Timeframe matrix: 1m, 3m, 5m, 15m, 30m, and since-open comparison.
- Calibration Lab: browser-local session recorder, 3m/5m/10m outcome tracking, and threshold suggestions.
- Outcome Tracker and Formula Rulebook stay collapsed until opened.
- Mobile responsive layout.
- Neon Postgres session recorder: restores the open baseline and exact rolling windows after refresh or redeploy.

## Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Without credentials the app runs in demo mode.

## Use Live Upstox Data

Set the token as an environment variable. Do not paste the token into the browser.

Local `.env.local` option:

```text
UPSTOX_ACCESS_TOKEN=your_token
```

Then run:

```bash
npm run dev
```

Shell option:

```bash
UPSTOX_ACCESS_TOKEN=your_token npm run dev
```

On Vercel, add this environment variable:

```text
UPSTOX_ACCESS_TOKEN
```

## Persistent Session Database

Create a Neon Postgres database from the Vercel Marketplace, connect it to this project, and confirm Vercel has added:

```text
DATABASE_URL
```

No manual migration is required. The first server request creates `market_snapshots` automatically; the same SQL is also available in `db/schema.sql`.

During the 09:15-15:30 IST weekday session, every successful live option-chain request is saved in a 30-second idempotent bucket. On page load the dashboard restores the opening snapshots, latest 240 exact snapshots, and session-wide 5m spot OHLC reconstructed from the database.

Window rules are fixed:

```text
Open = current value - 09:15-09:20 opening median
5m   = current value - closest snapshot around current time minus 5 minutes
15m  = current value - closest snapshot around current time minus 15 minutes
30m  = current value - closest snapshot around current time minus 30 minutes
```

The rolling windows allow at most 45 seconds of timestamp difference. If a valid baseline is missing, the UI shows `Building` instead of reusing another timeframe.

### Pressure–Response Intelligence

The Market Structure card also compares material five-minute option inventory with the spot response:

- scans ATM ±3 strikes and keeps only contracts whose OI change and delta-adjusted premium residual are both material versus the ATM ±11 cross-section
- maps CE/PE buildup, writing, covering, and long exit into directional inventory without assigning an arbitrary weighted score
- compares directional spot displacement with the session median absolute 5m move to label release, partial response, or absorption
- tracks 15m max-OI wall migration, OI load across the next three strikes, and CE-to-PE inventory role reversal at a crossed strike

The narrative is an inferred market-mechanics explanation, not proof of an external news or event-driven cause.

### Session Memory & Tomorrow Playbook

After a completed market session, `/api/session/playbook` builds and stores a versioned post-market read from DB data:

- uses the last actual snapshot saved in each five-minute bucket; it does not interpolate or median-combine the playbook inputs
- resolves support and resistance with the same ATM ±11 highest single-strike PE/CE OI rule used by Market Structure Intelligence
- preserves the actual confirmed trailing range width when it is at most 100 points; without a qualified range it does not invent a choppy zone
- creates five conditional opening-location scenarios with explicit fresh-5m OI activation and invalidation rules
- stores a categorical fingerprint and reports only exact prior matches; it never creates a historical probability from insufficient samples

The card appears immediately below Formula Rulebook. It is a next-session preparation aid, not a guaranteed direction forecast.

### Recording While The Dashboard Is Closed

The protected endpoint `/api/cron/capture` records NIFTY50, BANKNIFTY, FINNIFTY, and SENSEX. Add this Vercel environment variable:

```text
CRON_SECRET=a-long-random-secret
```

Call the endpoint with `Authorization: Bearer <CRON_SECRET>` once per minute during market hours. Vercel Pro supports per-minute cron. Vercel Hobby only supports daily cron, so use an external minute scheduler or keep the dashboard open on Hobby. Do not add a per-minute cron expression to a Hobby project's `vercel.json`; Vercel will reject the deployment.

The browser calls:

```text
/api/upstox/option-chain
```

The serverless function calls Upstox:

```text
https://api.upstox.com/v2/option/chain
```

## Important Architecture Note

Vercel serverless functions are good for REST snapshots and polling. They are not ideal for a persistent broker WebSocket stream. This app is built to deploy cleanly on Vercel using REST polling first. A later production-grade live tick engine can be added as a separate always-on backend service.

## Calibration

The Calibration Lab v3 runs automatically while the dashboard is open:

- records unique live snapshots every 30 seconds only from 09:15-15:30 IST
- rejects unchanged/stale payloads and resets older calibration schemas
- tracks only stable directional Market Structure Intelligence states after two completed 5m confirmations
- permits one independent signal per setup with a five-minute global cooldown
- checks the nearest stored snapshot at exactly 3 minutes, 5 minutes, and 10 minutes
- evaluates an option buyer from entry ask to exit bid, with minimum-move, MFE, and MAE fields
- waits for all three checks before assigning Good, Mixed, or False
- requires 20 independent completed signals before suggesting a response threshold
- exports the full session as a JSON report with **Export Today's Calibration**

It does not auto-change trading thresholds. Statutory charges are not modeled; the bid-ask adjustment and minimum-net-move gate provide an execution buffer, not a brokerage statement.

## Strike Flow Classification

The Strike Flow Watch classifies only important strikes such as ATM, call wall, put wall, and the current best strike:

- premium up + OI up = long buildup
- premium down + OI up = writing / short buildup
- premium up + OI down = short covering
- premium down + OI down = long unwinding

Small changes are labeled as noise. A visible flow needs enough OI change, enough premium change, acceptable spread, liquidity, and direction context.

## Checks

```bash
npm run check
node --check src/app.js
node --check api/upstox/option-chain.js
node --check scripts/dev-server.js
```
