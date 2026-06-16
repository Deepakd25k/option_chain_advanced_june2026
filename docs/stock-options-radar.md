# Stock Options Radar Blueprint

This feature is an educational scanner for NSE stock-option buying candidates. It ranks a liquid F&O stock watchlist and explains why a stock is a top pick, watch candidate, or learning-only candidate. It does not place trades.

## Verified Source Map

- NSE market timing reference: https://www.nseindia.com/market-data/market-timings
- NSE F&O underlyings reference: https://www.nseindia.com/products-services/equity-derivatives-list-underlyings-information
- NSE corporate announcements: https://www.nseindia.com/companies-listing/corporate-filings-announcements
- NSE sector/live market reference: https://www.nseindia.com/market-data/live-equity-market
- Broker/live market feed: Upstox option-chain, quote, instrument search, and candle APIs

## Morning Workflow

1. 09:15-09:20 IST is observation only.
2. 09:20-09:25 IST scanner ranks liquid F&O stocks.
3. A stock is interesting only when spot movement, sector benchmark, option liquidity, and option Greeks agree.
4. Manual chart confirmation is still required: opening high/low break, VWAP-style hold, and spread tightening.
5. One trade at a time for small capital. If lot cost is outside capital, the scanner marks it as learning/watch context only.

## Scoring Model

Total score is capped at 100:

```text
total =
  liquidity score  / 35
+ momentum score   / 30
+ sector score     / 15
+ option score     / 15
+ catalyst score   / 8
- risk penalty
```

Liquidity is intentionally the largest weight. Stock options can show a correct direction but still be untradeable because bid-ask spread and exit liquidity are poor.

## Data Used

For each stock:

- spot price, day open, previous close
- option-chain strikes, bid, ask, LTP, volume, OI, previous OI
- option Greeks: delta, gamma, theta, vega, IV
- sector index quote
- NSE corporate announcement context when reachable

The scanner uses premium turnover proxy:

```text
premium turnover proxy = option mid price x option volume
```

NSE notes that option-contract value is premium turnover in its market turnover context, so this is a useful liquidity lens.

## Movement Math

The scanner picks CE/PE only when the stock has a meaningful opening drive:

```text
gap %      = (spot - previous close) / previous close
intraday % = (spot - day open) / day open
relative % = stock intraday % - sector index %
```

The option premium sensitivity is explained by:

```text
option change ~= delta x spot change
              + 0.5 x gamma x spot change^2
              + vega x IV change
              - theta decay
```

In practice, the dashboard favors ATM or one-step ITM options with delta near 0.55 because far OTM stock options can look cheap but often fail on liquidity and spread.

## Rejection Rules

The scanner penalizes:

- no clear CE/PE direction
- wide bid-ask spread
- low option volume or OI
- weak sector alignment
- lot cost above selected capital
- missing option mid/quote

## Current MVP Limitation

The route starts from a curated liquid F&O stock watchlist instead of polling the full F&O universe every minute. Full-universe scanning should be added through a cached NSE/Upstox instrument master job to avoid rate-limit heavy browser polling.
