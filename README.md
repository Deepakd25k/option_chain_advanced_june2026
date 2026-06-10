# Option Buyer Cockpit

Formula-backed intraday option-chain dashboard for Indian index option buyers. It is built as a dependency-free static website with a Vercel serverless API route for Upstox REST data.

## What It Adds Beyond A Normal OI Dashboard

- Decision card: market state, premium mode, best side, confidence, and reasons.
- Auto expiry fetch from Upstox option contracts; nearest expiry is selected automatically.
- Index selector includes NIFTY50, BANKNIFTY, FINNIFTY, and SENSEX.
- Move-left meter: ATM straddle versus day-open move.
- Premium response: actual option premium move versus expected delta move.
- Strike finder: formula gates for spread, liquidity, delta, response, IV, straddle, OI context, and theta.
- Timeframe matrix: 1m, 3m, 5m, 15m, 30m, and since-open comparison.
- Event read: since-open and since-current-signal context.
- Advanced edge: trap detector, OI wall shift detector, and signal journal.
- Strike Flow Watch: covering, writing, long buildup, and long unwinding on ATM/wall/best strikes with confidence filters.
- Calibration Lab: browser-local session recorder, 3m/5m/10m outcome tracking, and threshold suggestions.
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

During the 09:15-15:30 IST weekday session, every successful live option-chain request is saved in a 30-second idempotent bucket. On page load the dashboard restores today's first snapshot plus the latest 240 snapshots.

Window rules are fixed:

```text
Open = current value - first saved value of today's session
5m   = current value - closest snapshot around current time minus 5 minutes
15m  = current value - closest snapshot around current time minus 15 minutes
30m  = current value - closest snapshot around current time minus 30 minutes
```

The rolling windows allow at most 45 seconds of timestamp difference. If a valid baseline is missing, the UI shows `Building` instead of reusing another timeframe.

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

The Calibration Lab runs automatically while the dashboard is open:

- records session snapshots in browser `localStorage`
- tracks new CE/PE decision signals
- checks outcomes after 3 minutes, 5 minutes, and 10 minutes
- suggests a premium-response threshold from completed samples
- exports the full session as a JSON report with **Export Today's Calibration**

It does not auto-change trading thresholds. Suggestions are shown for review so real-money logic stays under manual control.

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
