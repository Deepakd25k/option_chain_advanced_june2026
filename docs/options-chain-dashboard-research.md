# Options Chain Dashboard Research

Purpose: build a custom Upstox-powered dashboard for intraday Indian index option buying, especially Nifty 50, that explains what the market is doing through data instead of only showing a normal option-chain table.

This is research and system design, not trading advice. The dashboard should support decisions, enforce discipline, and show probabilistic evidence. It should not pretend to predict the market with certainty.

## 1. Market Structure Baseline

As of 2026-06-09:

- NSE derivatives contracts expiring on or after 2025-09-01 use Tuesday as expiry day. Monthly contracts expire on the last Tuesday of the month.
- Nifty weekly lot size moved from 75 to 65 from the 2026-01-06 weekly expiry.
- Nifty options trade during normal equity derivatives market hours, generally 09:15 to 15:30 IST on trading days.

Why this matters:

- Expiry day gamma is now a Tuesday problem for Nifty.
- Expected move, theta decay, and strike selection must use the correct days-to-expiry and intraday time-to-expiry.
- P&L should be computed using the current lot size from contract metadata instead of hardcoded values.

## 2. Upstox Data Feasibility

### REST endpoints

Use REST for discovery, snapshots, recovery, and historical candles.

- Option contracts: `GET /v2/option/contract`
- Put/call option chain: `GET /v2/option/chain`
- Instrument search: `GET /v2/instruments/search`
- Historical candles V3: `GET /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to_date}/{from_date}`

The option-chain endpoint provides strike-wise:

- expiry
- PCR
- strike price
- underlying spot price
- CE and PE instrument keys
- LTP
- volume
- OI
- previous OI
- bid price and quantity
- ask price and quantity
- Greeks: delta, gamma, theta, vega, IV, POP

### WebSocket

Use WebSocket for live tick-level market behavior.

Important Upstox V3 modes:

- `ltpc`: LTP and close price
- `option_greeks`: Greeks only
- `full`: LTPC, 5-level market depth, metadata, Greeks
- `full_d30`: LTPC, 30-level depth, metadata, Greeks

The live dashboard should not poll the full option chain every second. It should:

- fetch chain snapshot at startup
- choose relevant strikes around ATM
- subscribe to spot, futures, India VIX, ATM and nearby option instruments
- rebuild candles, straddle, OI deltas, and premium behavior from stream updates
- periodically refresh REST snapshots to catch missed state and OI corrections

### Rate-limit implication

Standard APIs have limits, so the system should avoid noisy polling. WebSocket should be the primary intraday feed. REST should be used for initialization, fallback, and periodic reconciliation.

## 3. What The Dashboard Must Answer

For an option buyer, the real question is not only "Nifty up or down?" The dashboard must answer:

1. Direction: is the market trying to trend, reverse, or stay range-bound?
2. Move left: how much movement is still priced versus how much has already happened?
3. Premium behavior: if spot moves, will the chosen option premium actually expand?
4. Strike quality: which strike has enough delta, liquidity, low spread, and acceptable theta?
5. Timing: is this the right phase of the day to buy premium, or will theta/IV crush eat it?
6. Invalidations: what data change proves the idea is wrong?

## 4. Core Metrics

### ATM detection

ATM strike = nearest strike to current underlying spot or futures.

Use futures price as an optional alternate anchor because option pricing often follows futures more closely than spot. Dashboard should show both.

### ATM straddle

ATM straddle premium:

```text
atm_straddle = atm_call_ltp + atm_put_ltp
```

Implied range to expiry:

```text
upper_range = atm_strike + atm_straddle
lower_range = atm_strike - atm_straddle
expected_move_pct = atm_straddle / underlying_price
```

Intraday "move left":

```text
move_used = abs(current_price - session_open)
move_left_vs_straddle = atm_straddle - move_used
```

Interpretation:

- If price has moved a lot but straddle has not expanded, premium buyers may still struggle.
- If price is breaking a range and straddle starts expanding, option buying conditions improve.
- If straddle is collapsing while price is flat, avoid random OTM buying.

### Premium response score

This is critical for "market move karega to premium move karega bhi ya nahi?"

For each candidate strike:

```text
premium_velocity = change(option_ltp) / time
spot_velocity = change(underlying_price) / time
realized_delta_response = change(option_ltp) / change(underlying_price)
delta_gap = realized_delta_response - theoretical_delta
```

Interpretation:

- Positive aligned premium velocity confirms the option is responding.
- If spot moves in favor but option premium does not, IV crush, low delta, spread, or poor timing is likely.
- If premium response is better than theoretical delta, IV expansion or gamma participation may be helping.

### Intrinsic and time value

For calls:

```text
intrinsic = max(0, underlying_price - strike)
time_value = option_ltp - intrinsic
```

For puts:

```text
intrinsic = max(0, strike - underlying_price)
time_value = option_ltp - intrinsic
```

Buyer insight:

- Deep OTM options are mostly time value and need fast movement.
- ITM options have better delta but higher capital.
- ATM/near-ATM usually gives the best mix of delta, gamma, liquidity, and response for intraday buying.

### OI and change in OI

Upstox gives current OI and previous OI, so:

```text
change_in_oi = oi - prev_oi
```

But OI can be misleading intraday. Treat it as positioning pressure, not truth.

Basic strike interpretation:

- High call OI above price can act as resistance.
- High put OI below price can act as support.
- Rising OI at a strike means fresh positions are being added, but option chain alone does not prove whether they are fresh shorts or fresh longs.

To classify buildup, combine option price change with OI change:

```text
price_up + oi_up = long buildup or aggressive buying interest
price_down + oi_up = short buildup or writing pressure
price_up + oi_down = short covering
price_down + oi_down = long unwinding
```

This classification must be shown with confidence levels, because option price can be distorted by IV and bid-ask spread.

### Volume and liquidity

Volume measures today's trading activity. OI measures outstanding contracts. Both are needed.

Liquidity filters:

```text
spread = ask_price - bid_price
spread_pct = spread / mid_price
depth_score = bid_qty + ask_qty
volume_oi_ratio = volume / max(oi, 1)
```

Strike should be rejected or warned when:

- bid-ask spread is wide
- volume is low
- OI is low
- option is far OTM with poor premium response
- depth is too thin near expected entry size

### PCR

PCR from OI:

```text
pcr_oi = total_put_oi / total_call_oi
```

PCR from volume:

```text
pcr_volume = total_put_volume / total_call_volume
```

Use PCR as a sentiment and positioning heat map, not a standalone signal.

Dashboard should show:

- overall PCR
- near-ATM PCR
- intraday PCR trend
- PCR divergence versus price

Useful examples:

- Price rising while put OI builds and call OI unwinds can support bullish continuation.
- Price rising while call OI builds aggressively above spot may warn of resistance.
- Extreme PCR after a fast fall may show fear, but it can also reverse quickly on short covering.

### IV, skew, and IV crush

IV is the market-implied expectation of future movement embedded in option premium.

Dashboard should compute:

- ATM IV
- CE IV vs PE IV at same strike
- IV skew across strikes
- IV change over last 1, 3, 5, 15 minutes
- IV expansion/contraction against spot movement

Buyer insight:

- Long options need direction plus enough IV stability or expansion.
- Buying after IV spikes can lose money even if direction is right.
- On expiry day, a small pause can destroy OTM premiums due to theta and IV compression.

### Greeks for strike selection

Use Upstox Greeks as primary values and optionally compute sanity-check Greeks later.

For option buying:

- Delta: how much option premium should move for spot movement.
- Gamma: how fast delta improves or worsens. Highest near ATM and near expiry.
- Theta: time decay cost. Hurts buyers.
- Vega: sensitivity to IV. Important when IV expands or crushes.

Candidate strike rules:

- Directional scalp: prefer delta around 0.45 to 0.65 if liquid.
- Momentum breakout: ATM or slightly ITM often better than cheap far OTM.
- Very fast expiry move: near ATM high-gamma strike can work, but only with strict stop.
- Avoid far OTM when expected move left is low or premium response is weak.

## 5. Market State Engine

The dashboard should classify the current state every few seconds:

### Range-bound

Conditions:

- ATM straddle declining or flat
- price inside VWAP/range bands
- OI walls stable above and below
- premium response weak

Actionable output:

- "Buying premium has poor edge unless range breaks with IV expansion."

### Bullish continuation

Conditions:

- price above VWAP and opening range
- put OI increasing below spot
- call OI unwinding at nearby resistance or price crossing call wall with premium expansion
- CE premium velocity positive
- ATM straddle stable or expanding

Actionable output:

- show top CE strikes ranked by response, liquidity, delta, spread, and theta.

### Bearish continuation

Conditions:

- price below VWAP and opening range
- call OI increasing above spot
- put OI unwinding at nearby support or price crossing put wall with premium expansion
- PE premium velocity positive
- ATM straddle stable or expanding

Actionable output:

- show top PE strikes ranked by response, liquidity, delta, spread, and theta.

### Reversal / trap risk

Conditions:

- price breaks level but option premium fails to expand
- IV contracts on breakout
- large opposite-side OI wall remains intact
- futures/spot divergence
- straddle declines during directional push

Actionable output:

- "Move visible in index, but premium not confirming."

## 6. Strike Selection Score

Each strike should get a transparent score, not a black-box buy signal.

Suggested components:

```text
strike_score =
  liquidity_score * 0.20
  + spread_score * 0.15
  + delta_score * 0.20
  + premium_response_score * 0.25
  + theta_efficiency_score * 0.10
  + oi_context_score * 0.10
```

Reject conditions override score:

- spread_pct too high
- no live bid or ask
- volume too low
- no premium response despite favorable spot move
- option is outside expected move without strong momentum
- theta per minute too high for current expected move

Dashboard should show why a strike is ranked:

- "Best CE: 23400 CE because delta 0.52, spread 0.6 percent, premium response 1.2x expected delta, IV stable, near resistance breakout."
- "Avoid 23600 CE: cheap, but delta 0.18 and poor response."

## 7. Screens To Build

### A. Market Read Panel

One-line state:

- Trend
- Range
- Premium buying condition
- Expected move left
- nearest support and resistance by OI
- expiry risk level

### B. Straddle And Expected Move

Charts:

- ATM straddle over time
- spot/futures over time
- implied range bands
- move used vs move left
- straddle expansion or compression signal

### C. Option Chain Intelligence Table

Strike rows around ATM:

- CE/PE LTP
- bid/ask spread
- volume
- OI
- change in OI
- IV
- delta/gamma/theta/vega
- premium response
- buildup classification
- support/resistance labels

### D. Strike Finder

Shows top candidate strikes for CE and PE:

- score
- reason
- risk warnings
- suggested invalidation level
- expected premium move for 20/40/60 point Nifty move

### E. Premium Behavior Lab

For selected option:

- option LTP vs spot
- theoretical delta move vs actual premium move
- IV change
- theta decay estimate
- spread and depth

### F. OI Heatmap

Visual heatmap:

- call OI wall
- put OI wall
- change in OI
- intraday OI migration
- max pain can be shown but must be labeled low-confidence for intraday buying

### G. Alerts

Examples:

- "ATM straddle expanding with spot breakout."
- "CE premium not responding to bullish move."
- "IV crush detected after gap."
- "Nearby call wall crossed with call OI unwinding."
- "Spread widened. Strike quality deteriorated."

## 8. Data Architecture

Recommended stack:

- Backend: Python FastAPI
- Live data: Upstox WebSocket V3
- Snapshot/recovery: Upstox REST
- Storage: PostgreSQL plus TimescaleDB if available, or SQLite for first prototype
- Frontend: React or Next.js dashboard
- Charts: lightweight-charts or Recharts
- State engine: Python service with metric snapshots every 1 second

Pipeline:

1. Authenticate Upstox.
2. Fetch Nifty option contracts for current expiry.
3. Fetch option-chain snapshot.
4. Detect ATM and select strike universe, for example ATM +/- 10 strikes.
5. Subscribe to underlying, futures, India VIX, and selected option instrument keys.
6. Normalize ticks into a common event schema.
7. Build rolling windows: 10 sec, 30 sec, 1 min, 3 min, 5 min, 15 min.
8. Compute metrics and state.
9. Store ticks and computed snapshots.
10. Serve dashboard over WebSocket/SSE.

## 9. Backtesting And Validation

Before using live signals, we need validation.

Minimum tests:

- Replay historical intraday option candles where available.
- Compare option premium response against spot movement.
- Track false breakouts where premium failed to confirm.
- Track days where ATM straddle expanded versus collapsed.
- Measure strike score outcome: did ranked strike move better than ATM, ITM, and OTM alternatives?

Metrics:

- premium response hit rate
- average favorable excursion
- average adverse excursion
- slippage from bid-ask spread
- time-in-trade sensitivity
- theta drag per minute
- IV expansion/decay contribution

## 10. Biggest Risks And Guardrails

Risks:

- OI interpretation can be wrong without participant-level data.
- Greeks from broker APIs may lag or differ from self-calculated values.
- REST snapshots may not match streaming state perfectly.
- Expiry day option prices can move violently and decay violently.
- A cheap OTM option can look attractive but fail to respond.
- Direction can be right while option trade loses due to IV crush or theta.

Guardrails:

- Never show a strike without liquidity/spread warnings.
- Always show premium confirmation separately from direction.
- Keep "signal confidence" separate from "trade recommendation."
- Store all decisions and inputs for review.
- Prefer evidence labels: confirmed, mixed, weak, invalidated.

## 11. MVP Build Order

Phase 1: Data foundation

- Upstox auth
- option contracts fetch
- option-chain snapshot
- live WebSocket subscription
- normalized tick storage

Phase 2: Core analytics

- ATM detection
- straddle and expected move
- OI/change-in-OI table
- IV and Greeks table
- spread/liquidity filters

Phase 3: Option buyer intelligence

- premium response score
- strike selection score
- market state engine
- alerts

Phase 4: Validation

- replay mode
- session reports
- signal outcome tracking
- parameter tuning

Phase 5: Execution support, optional later

- watchlist only first
- paper trade journal
- manual order helper
- automated execution only after validation and regulatory checks

## 12. Sources Checked

- Upstox Put/Call Option Chain API: https://upstox.com/developer/api-documentation/get-pc-option-chain/
- Upstox Option Contracts API: https://upstox.com/developer/api-documentation/get-option-contracts/
- Upstox Market Data Feed V3: https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- Upstox Instrument Search API: https://upstox.com/developer/api-documentation/instrument-search/
- Upstox Historical Candle Data V3: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
- Upstox Rate Limits: https://upstox.com/developer/api-documentation/rate-limiting/
- NSE circular on Tuesday expiry: https://nsearchives.nseindia.com/content/circulars/FAOP68589.pdf
- NSE circular on revised index lot sizes: https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf
- SEBI draft/master material mentioning weekly benchmark index option rules: https://www.sebi.gov.in/sebi_data/commondocs/may-2026/Annexure-%20A_p.pdf
- NISM Equity Derivatives FAQ: https://www.nism.ac.in/wp-content/uploads/2021/02/Equity-Derivatives-FAQ-document-1.pdf
- CME implied volatility and straddle explanation: https://www.cmegroup.com/education/articles-and-reports/implied-volatility
