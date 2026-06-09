(function () {
  const WINDOWS = [
    { key: "60", label: "1m", seconds: 60 },
    { key: "180", label: "3m", seconds: 180 },
    { key: "300", label: "5m", seconds: 300 },
    { key: "900", label: "15m", seconds: 900 },
    { key: "1800", label: "30m", seconds: 1800 },
    { key: "open", label: "Open", seconds: null }
  ];

  const state = {
    history: [],
    paused: false,
    timer: null,
    stable: {
      key: null,
      since: null,
      confirmations: 0
    },
    signalStartSnapshot: null
  };

  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindElements();
    restoreControls();
    bindEvents();
    refresh();
    scheduleNext();
  }

  function bindElements() {
    [
      "sourceLine", "refreshButton", "pauseButton", "symbolSelect", "expiryInput",
      "activeWindow", "refreshInterval", "decisionTitle", "decisionCopy",
      "stabilityPill", "marketState", "premiumMode", "bestSide",
      "confidenceScore", "decisionReasons", "moveLeftLabel", "spotPill",
      "moveMeter", "moveUsedText", "straddleText", "atmStrike", "atmIv",
      "atmStraddle", "pcrValue", "matrixTable", "strikeFinder",
      "straddleChart", "ivChart", "pcrChart", "straddleDelta", "ivDelta",
      "pcrDelta", "eventGrid", "chainTable"
    ].forEach((id) => {
      el[id] = document.getElementById(id);
    });
  }

  function restoreControls() {
    const today = new Date();
    const isoDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
    el.expiryInput.value = localStorage.getItem("expiry_date") || isoDate;
    el.symbolSelect.value = localStorage.getItem("instrument_key") || "NSE_INDEX|Nifty 50";
    el.activeWindow.value = localStorage.getItem("active_window") || "300";
    el.refreshInterval.value = localStorage.getItem("refresh_interval") || "20000";
  }

  function bindEvents() {
    el.refreshButton.addEventListener("click", refresh);
    el.pauseButton.addEventListener("click", togglePause);
    [el.symbolSelect, el.expiryInput, el.activeWindow, el.refreshInterval].forEach((control) => {
      control.addEventListener("change", () => {
        localStorage.setItem("instrument_key", el.symbolSelect.value);
        localStorage.setItem("expiry_date", el.expiryInput.value);
        localStorage.setItem("active_window", el.activeWindow.value);
        localStorage.setItem("refresh_interval", el.refreshInterval.value);
        if (control === el.symbolSelect || control === el.expiryInput) {
          state.history = [];
          state.stable = { key: null, since: null, confirmations: 0 };
          state.signalStartSnapshot = null;
        }
        refresh();
        scheduleNext();
      });
    });
  }

  function togglePause() {
    state.paused = !state.paused;
    el.pauseButton.textContent = state.paused ? "▶" : "Ⅱ";
    el.pauseButton.title = state.paused ? "Resume live refresh" : "Pause live refresh";
    scheduleNext();
  }

  function scheduleNext() {
    if (state.timer) {
      clearTimeout(state.timer);
    }
    if (state.paused) {
      return;
    }
    state.timer = setTimeout(async () => {
      await refresh();
      scheduleNext();
    }, Number(el.refreshInterval.value));
  }

  async function refresh() {
    try {
      setSource("Refreshing option chain...");
      const params = new URLSearchParams({
        instrument_key: el.symbolSelect.value,
        expiry_date: el.expiryInput.value
      });
      const response = await fetch(`/api/upstox/option-chain?${params.toString()}`, {
        cache: "no-store"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to fetch option-chain data");
      }
      const snapshot = normalizeSnapshot(payload);
      addSnapshot(snapshot);
      render();
      setSource(`${payload.source === "live" ? "Live Upstox REST" : "Demo mode"} · ${formatTime(snapshot.time)} · ${state.history.length} snapshots`);
    } catch (error) {
      setSource(`Data error: ${error.message}`);
      if (!state.history.length) {
        const snapshot = normalizeSnapshot(makeEmergencyDemo());
        addSnapshot(snapshot);
        render();
      }
    }
  }

  function setSource(message) {
    el.sourceLine.textContent = message;
  }

  function addSnapshot(snapshot) {
    const last = state.history[state.history.length - 1];
    if (!last || snapshot.time - last.time > 750) {
      state.history.push(snapshot);
    } else {
      state.history[state.history.length - 1] = snapshot;
    }
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    state.history = state.history.filter((item) => item.time >= cutoff);
  }

  function normalizeSnapshot(payload) {
    const rowsSource = Array.isArray(payload.data) ? payload.data : [];
    const generatedAt = payload.generatedAt ? new Date(payload.generatedAt).getTime() : Date.now();
    const rows = rowsSource
      .map(normalizeRow)
      .filter((row) => Number.isFinite(row.strike))
      .sort((a, b) => a.strike - b.strike);

    const spot = number(payload.underlying && payload.underlying.spot)
      || firstNumber(rowsSource, ["underlying_spot_price", "underlyingSpotPrice", "underlying_spot"])
      || 0;

    const atm = rows.reduce((best, row) => {
      if (!best) return row;
      return Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best;
    }, null);

    const callOi = sum(rows, (row) => row.ce.oi);
    const putOi = sum(rows, (row) => row.pe.oi);
    const callOiChange = sum(rows, (row) => row.ce.oi - row.ce.prevOi);
    const putOiChange = sum(rows, (row) => row.pe.oi - row.pe.prevOi);
    const dayOpen = number(payload.underlying && payload.underlying.dayOpen)
      || (state.history[0] && state.history[0].spot)
      || spot;

    return {
      source: payload.source || "demo",
      time: generatedAt,
      expiry: payload.expiry || el.expiryInput.value,
      instrumentKey: payload.instrumentKey || el.symbolSelect.value,
      spot,
      dayOpen,
      rows,
      atm,
      atmStrike: atm ? atm.strike : 0,
      atmStraddle: atm ? atm.ce.ltp + atm.pe.ltp : 0,
      atmIv: atm ? average([atm.ce.iv, atm.pe.iv]) : 0,
      pcr: callOi ? putOi / callOi : 0,
      callOi,
      putOi,
      callOiChange,
      putOiChange,
      walls: findWalls(rows, spot)
    };
  }

  function normalizeRow(row) {
    const ce = normalizeSide(row.call_options || row.callOption || row.ce || row.CE || {});
    const pe = normalizeSide(row.put_options || row.putOption || row.pe || row.PE || {});
    return {
      strike: number(row.strike_price) || number(row.strikePrice) || number(row.strike),
      rawPcr: number(row.pcr),
      ce,
      pe
    };
  }

  function normalizeSide(side) {
    const market = side.market_data || side.marketData || side.market || side;
    const greeks = side.option_greeks || side.optionGreeks || side.greeks || {};
    const ltp = number(market.ltp) || number(market.last_price) || number(market.lastPrice);
    const bid = number(market.bid_price) || number(market.bidPrice) || number(market.bid);
    const ask = number(market.ask_price) || number(market.askPrice) || number(market.ask);
    const mid = bid && ask ? (bid + ask) / 2 : ltp;
    const spreadPct = mid ? Math.max(0, ask - bid) / mid : 0;
    return {
      instrumentKey: side.instrument_key || side.instrumentKey || "",
      ltp,
      bid,
      ask,
      bidQty: number(market.bid_qty) || number(market.bidQty) || number(market.bid_quantity),
      askQty: number(market.ask_qty) || number(market.askQty) || number(market.ask_quantity),
      volume: number(market.volume),
      oi: number(market.oi) || number(market.open_interest) || number(market.openInterest),
      prevOi: number(market.prev_oi) || number(market.prevOi) || number(market.previous_oi) || number(market.previousOpenInterest),
      delta: Math.abs(number(greeks.delta)),
      gamma: number(greeks.gamma),
      theta: Math.abs(number(greeks.theta)),
      vega: number(greeks.vega),
      iv: number(greeks.iv),
      spreadPct
    };
  }

  function findWalls(rows, spot) {
    const callWall = rows
      .filter((row) => row.strike >= spot)
      .reduce((best, row) => (!best || row.ce.oi > best.oi ? { strike: row.strike, oi: row.ce.oi } : best), null);
    const putWall = rows
      .filter((row) => row.strike <= spot)
      .reduce((best, row) => (!best || row.pe.oi > best.oi ? { strike: row.strike, oi: row.pe.oi } : best), null);
    return { callWall, putWall };
  }

  function render() {
    const latest = lastSnapshot();
    if (!latest) return;
    const active = getWindowMetrics(el.activeWindow.value);
    const decision = buildDecision(latest, active);
    renderDecision(decision, latest, active);
    renderMoveMeter(latest);
    renderMatrix();
    renderStrikeFinder(latest, active);
    renderCharts();
    renderEvents(latest, active, decision);
    renderChain(latest, active);
  }

  function buildDecision(latest, active) {
    const ceStrike = pickCandidateStrike(latest, "CE");
    const peStrike = pickCandidateStrike(latest, "PE");
    const ce = scoreSide(latest, active, "CE", ceStrike);
    const pe = scoreSide(latest, active, "PE", peStrike);
    const movePct = moveLeftPct(latest);
    const straddleFalling = active.straddleChange < -3;
    const ivFalling = active.ivChange < -0.6;
    const nearCallWall = latest.walls.callWall && latest.walls.callWall.strike - latest.spot <= 35;
    const nearPutWall = latest.walls.putWall && latest.spot - latest.walls.putWall.strike <= 35;

    let marketState = "Mixed";
    if (active.spotChange > 18 && active.putOiChange >= 0 && active.callOiChange <= 0) {
      marketState = "Bullish continuation";
    } else if (active.spotChange < -18 && active.callOiChange >= 0 && active.putOiChange <= 0) {
      marketState = "Bearish continuation";
    } else if (Math.abs(active.spotChange) < 12 && straddleFalling) {
      marketState = "Range / premium decay";
    } else if (active.spotChange > 18 && active.callOiChange > 0) {
      marketState = "Recovery into resistance";
    } else if (active.spotChange < -18 && active.putOiChange > 0) {
      marketState = "Drop into support";
    }

    const hardAvoid = movePct < 0.2 || (straddleFalling && ivFalling && ce.response < 0.45 && pe.response < 0.45);
    const best = ce.confidence >= pe.confidence ? ce : pe;
    const opposite = best.side === "CE" ? pe : ce;
    let premiumMode = "Wait";
    if (hardAvoid) {
      premiumMode = "Avoid fresh buying";
    } else if (best.tradeable && best.confidence >= 70) {
      premiumMode = "Tradeable";
    } else if (best.confidence >= 55 && best.response >= 0.55) {
      premiumMode = "Building";
    } else {
      premiumMode = "Weak";
    }

    const key = `${premiumMode}:${best.side}:${marketState}`;
    updateStability(key);
    if (!state.signalStartSnapshot || state.stable.confirmations <= 1) {
      state.signalStartSnapshot = latest;
    }

    const confidence = hardAvoid ? Math.min(42, best.confidence) : best.confidence;
    const title = premiumMode === "Tradeable"
      ? `${best.side} setup confirmed, ${best.strike} preferred`
      : premiumMode === "Avoid fresh buying"
        ? "No-trade condition is stronger than buy condition"
        : `${best.side} bias ${premiumMode.toLowerCase()}, wait for confirmation`;

    const copy = makeDecisionCopy({
      premiumMode,
      marketState,
      best,
      opposite,
      latest,
      active,
      movePct,
      nearCallWall,
      nearPutWall
    });

    return {
      title,
      copy,
      marketState,
      premiumMode,
      bestSide: hardAvoid ? "No fresh buy" : best.side,
      best,
      opposite,
      confidence,
      reasons: buildReasons(best, opposite, active, latest, movePct, straddleFalling, ivFalling),
      stability: { ...state.stable }
    };
  }

  function scoreSide(latest, active, side, strike) {
    const row = latest.rows.find((item) => item.strike === strike) || latest.atm;
    const option = side === "CE" ? row.ce : row.pe;
    const response = premiumResponse(side, strike, active.seconds);
    const favorableSpot = side === "CE" ? active.spotChange > 8 : active.spotChange < -8;
    const spreadOk = option.spreadPct > 0 && option.spreadPct <= 0.02;
    const liquid = option.volume >= 25000 || option.oi >= 100000;
    const deltaUsable = option.delta >= 0.35 && option.delta <= 0.75;
    const deltaIdeal = option.delta >= 0.45 && option.delta <= 0.65;
    const responseOk = response >= 0.55;
    const thetaOk = option.ltp ? option.theta / option.ltp < 0.18 : false;
    const straddleOk = active.straddleChange >= -3;
    const ivOk = active.ivChange >= -0.6;
    const oiContext = side === "CE"
      ? active.putOiChange >= 0 || active.callOiChange < 0
      : active.callOiChange >= 0 || active.putOiChange < 0;

    const checks = [
      { label: "direction", pass: favorableSpot },
      { label: "spread", pass: spreadOk },
      { label: "liquidity", pass: liquid },
      { label: "delta", pass: deltaUsable },
      { label: "premium response", pass: responseOk },
      { label: "straddle", pass: straddleOk },
      { label: "IV", pass: ivOk },
      { label: "OI context", pass: oiContext },
      { label: "theta", pass: thetaOk }
    ];
    const passed = checks.filter((check) => check.pass).length;
    const confidence = Math.round((passed / checks.length) * 100);
    const tradeable = spreadOk && liquid && deltaUsable && responseOk && straddleOk && ivOk && favorableSpot;

    return {
      side,
      strike,
      row,
      option,
      response,
      checks,
      confidence,
      tradeable,
      deltaIdeal
    };
  }

  function makeDecisionCopy(input) {
    const { premiumMode, marketState, best, latest, active, movePct, nearCallWall, nearPutWall } = input;
    if (premiumMode === "Avoid fresh buying") {
      return `Avoid fresh premium buying. Move-left is ${pct(movePct)}, ATM straddle change is ${signed(active.straddleChange)}, IV change is ${signed(active.ivChange)}, and premium response is not strong enough for clean risk.`;
    }
    const wallText = nearCallWall
      ? `near call wall ${latest.walls.callWall.strike}`
      : nearPutWall
        ? `near put wall ${latest.walls.putWall.strike}`
        : "away from immediate OI wall";
    return `${marketState}. ${best.side} ${best.strike} has response ratio ${ratio(best.response)} with ${best.confidence}% formula alignment. Current context is ${wallText}; entry should wait for stability plus price confirmation.`;
  }

  function buildReasons(best, opposite, active, latest, movePct, straddleFalling, ivFalling) {
    const items = [
      {
        tone: best.tradeable ? "good" : "warn",
        text: `${best.side} ${best.strike}: ${best.checks.filter((check) => check.pass).length}/${best.checks.length} formula gates passed`
      },
      {
        tone: best.response >= 0.7 ? "good" : best.response >= 0.45 ? "warn" : "bad",
        text: `Premium response: ${ratio(best.response)} actual move versus expected delta move`
      },
      {
        tone: movePct >= 0.6 ? "good" : movePct >= 0.3 ? "warn" : "bad",
        text: `Move left: ${pct(movePct)} of ATM straddle after day-open move`
      },
      {
        tone: straddleFalling ? "bad" : "good",
        text: `ATM straddle change in selected window: ${signed(active.straddleChange)}`
      },
      {
        tone: ivFalling ? "bad" : "good",
        text: `ATM IV change in selected window: ${signed(active.ivChange)}`
      },
      {
        tone: opposite.confidence > best.confidence - 8 ? "warn" : "good",
        text: `Opposite side alignment: ${opposite.side} ${opposite.confidence}%`
      },
      {
        tone: "warn",
        text: `Call wall ${latest.walls.callWall ? latest.walls.callWall.strike : "--"} · Put wall ${latest.walls.putWall ? latest.walls.putWall.strike : "--"}`
      }
    ];
    return items;
  }

  function updateStability(key) {
    const now = Date.now();
    if (state.stable.key === key) {
      state.stable.confirmations += 1;
    } else {
      state.stable = { key, since: now, confirmations: 1 };
    }
  }

  function renderDecision(decision, latest) {
    el.decisionTitle.textContent = decision.title;
    el.decisionCopy.textContent = decision.copy;
    el.marketState.textContent = decision.marketState;
    el.premiumMode.textContent = decision.premiumMode;
    el.bestSide.textContent = decision.bestSide;
    el.confidenceScore.textContent = `${decision.confidence}%`;

    const stableSeconds = decision.stability.since ? Math.floor((Date.now() - decision.stability.since) / 1000) : 0;
    const stableGood = stableSeconds >= 30 && decision.stability.confirmations >= 3;
    el.stabilityPill.textContent = stableGood ? `Stable ${stableSeconds}s` : `Building ${stableSeconds}s`;
    el.stabilityPill.className = `status-pill ${stableGood ? "good" : "neutral"}`;
    el.spotPill.textContent = `${labelForInstrument(latest.instrumentKey)} ${price(latest.spot)}`;

    el.decisionReasons.innerHTML = decision.reasons.map((reason) => `
      <div class="rule">
        <span class="rule-dot ${reason.tone}"></span>
        <span>${escapeHtml(reason.text)}</span>
      </div>
    `).join("");
  }

  function renderMoveMeter(latest) {
    const moveUsed = Math.abs(latest.spot - latest.dayOpen);
    const left = Math.max(0, latest.atmStraddle - moveUsed);
    const pctLeft = moveLeftPct(latest);
    el.moveLeftLabel.textContent = `${price(left)} points left`;
    el.moveMeter.style.width = `${Math.round(pctLeft * 100)}%`;
    el.moveUsedText.textContent = `Used ${price(moveUsed)}`;
    el.straddleText.textContent = `Straddle ${price(latest.atmStraddle)}`;
    el.atmStrike.textContent = price(latest.atmStrike, 0);
    el.atmIv.textContent = `${price(latest.atmIv)}%`;
    el.atmStraddle.textContent = price(latest.atmStraddle);
    el.pcrValue.textContent = ratio(latest.pcr);
  }

  function renderMatrix() {
    const rows = [
      { label: "Price", getter: (m) => signed(m.spotChange) },
      { label: "ATM Straddle", getter: (m) => signed(m.straddleChange) },
      { label: "ATM IV", getter: (m) => signed(m.ivChange) },
      { label: "PCR", getter: (m) => signed(m.pcrChange) },
      { label: "Call OI", getter: (m) => compact(m.callOiChange) },
      { label: "Put OI", getter: (m) => compact(m.putOiChange) },
      { label: "CE Response", getter: (m) => ratio(premiumResponse("CE", pickCandidateStrike(lastSnapshot(), "CE"), m.seconds)) },
      { label: "PE Response", getter: (m) => ratio(premiumResponse("PE", pickCandidateStrike(lastSnapshot(), "PE"), m.seconds)) }
    ];
    const tbody = el.matrixTable.querySelector("tbody");
    tbody.innerHTML = rows.map((row) => `
      <tr>
        <td>${row.label}</td>
        ${WINDOWS.map((windowItem) => {
          const metrics = getWindowMetrics(windowItem.key);
          const value = row.getter(metrics);
          return `<td class="${value.startsWith("-") ? "negative" : value === "0.00" ? "" : "positive"}">${value}</td>`;
        }).join("")}
      </tr>
    `).join("");
  }

  function renderStrikeFinder(latest, active) {
    const ce = scoreSide(latest, active, "CE", pickCandidateStrike(latest, "CE"));
    const pe = scoreSide(latest, active, "PE", pickCandidateStrike(latest, "PE"));
    el.strikeFinder.innerHTML = [ce, pe].map((item) => {
      const passed = item.checks.filter((check) => check.pass).length;
      const failed = item.checks.filter((check) => !check.pass).map((check) => check.label).slice(0, 3);
      const tone = item.tradeable ? "good" : item.confidence >= 55 ? "warn" : "bad";
      return `
        <div class="strike-card">
          <header>
            <strong>${item.side} ${item.strike}</strong>
            <span class="tag ${tone}">${item.confidence}%</span>
          </header>
          <div class="score-line"><span style="width:${item.confidence}%"></span></div>
          <p>${passed}/${item.checks.length} gates passed · response ${ratio(item.response)} · delta ${ratio(item.option.delta)} · spread ${pct(item.option.spreadPct)}</p>
          <p>${failed.length ? `Needs improvement: ${failed.join(", ")}` : "All critical gates are aligned."}</p>
        </div>
      `;
    }).join("");
  }

  function renderCharts() {
    const series = state.history.slice(-80);
    const active = getWindowMetrics(el.activeWindow.value);
    el.straddleDelta.textContent = signed(active.straddleChange);
    el.ivDelta.textContent = signed(active.ivChange);
    el.pcrDelta.textContent = signed(active.pcrChange);
    renderLine(el.straddleChart, series.map((snap) => snap.atmStraddle), "#e8b65b");
    renderLine(el.ivChart, series.map((snap) => snap.atmIv), "#35bdd2");
    renderLine(el.pcrChart, series.map((snap) => snap.pcr), "#8b7cf6");
  }

  function renderLine(container, values, color) {
    if (!values.length) {
      container.innerHTML = "";
      return;
    }
    const width = 420;
    const height = 150;
    const padding = 12;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const points = values.map((value, index) => {
      const x = values.length === 1 ? padding : padding + (index / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / span) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    container.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#303744" />
        <polyline fill="none" stroke="${color}" stroke-width="3" points="${points}" />
      </svg>
    `;
  }

  function renderEvents(latest, active, decision) {
    const sinceOpen = getWindowMetrics("open");
    const sinceSignal = state.signalStartSnapshot ? diffSnapshots(latest, state.signalStartSnapshot, null) : active;
    const cards = [
      {
        label: "Since Open",
        value: signed(sinceOpen.spotChange),
        copy: `Straddle ${signed(sinceOpen.straddleChange)}, IV ${signed(sinceOpen.ivChange)}, PCR ${signed(sinceOpen.pcrChange)}`
      },
      {
        label: "Since Signal",
        value: signed(sinceSignal.spotChange),
        copy: `Stable key: ${decision.stability.key || "--"}`
      },
      {
        label: "Call Wall",
        value: latest.walls.callWall ? price(latest.walls.callWall.strike, 0) : "--",
        copy: latest.walls.callWall ? `${compact(latest.walls.callWall.oi)} OI above/near spot` : "No wall in loaded strikes"
      },
      {
        label: "Put Wall",
        value: latest.walls.putWall ? price(latest.walls.putWall.strike, 0) : "--",
        copy: latest.walls.putWall ? `${compact(latest.walls.putWall.oi)} OI below/near spot` : "No wall in loaded strikes"
      }
    ];
    el.eventGrid.innerHTML = cards.map((card) => `
      <div class="event-card">
        <p>${card.label}</p>
        <strong>${card.value}</strong>
        <p>${escapeHtml(card.copy)}</p>
      </div>
    `).join("");
  }

  function renderChain(latest, active) {
    const atmIndex = latest.rows.findIndex((row) => row.strike === latest.atmStrike);
    const start = Math.max(0, atmIndex - 6);
    const rows = latest.rows.slice(start, start + 13);
    const tbody = el.chainTable.querySelector("tbody");
    tbody.innerHTML = rows.map((row) => {
      const ceResp = premiumResponse("CE", row.strike, active.seconds);
      const peResp = premiumResponse("PE", row.strike, active.seconds);
      const ceChange = optionPriceChange("CE", row.strike, active.seconds);
      const peChange = optionPriceChange("PE", row.strike, active.seconds);
      const isAtm = row.strike === latest.atmStrike;
      return `
        <tr class="${isAtm ? "atm-row" : ""}">
          <td>${compact(row.ce.oi)}</td>
          <td>${changeCell(ceChange)}</td>
          <td>${price(row.ce.ltp)}</td>
          <td>${ratio(row.ce.delta)}</td>
          <td>${responseTag(ceResp)}</td>
          <td>${pct(row.ce.spreadPct)}</td>
          <td class="strike-cell"><strong>${price(row.strike, 0)}</strong>${isAtm ? '<span class="atm-badge">ATM</span>' : ""}</td>
          <td>${pct(row.pe.spreadPct)}</td>
          <td>${responseTag(peResp)}</td>
          <td>${ratio(row.pe.delta)}</td>
          <td>${price(row.pe.ltp)}</td>
          <td>${changeCell(peChange)}</td>
          <td>${compact(row.pe.oi)}</td>
        </tr>
      `;
    }).join("");
  }

  function responseTag(value) {
    const tone = value >= 0.7 ? "good" : value >= 0.45 ? "warn" : "bad";
    return `<span class="tag ${tone}">${ratio(value)}</span>`;
  }

  function changeCell(value) {
    const numeric = number(value);
    const tone = numeric > 0.05 ? "positive" : numeric < -0.05 ? "negative" : "flat";
    return `<span class="price-change ${tone}">${signed(numeric)}</span>`;
  }

  function pickCandidateStrike(latest, side) {
    if (!latest || !latest.rows.length) return 0;
    const candidates = latest.rows
      .map((row) => {
        const option = side === "CE" ? row.ce : row.pe;
        const deltaDistance = Math.abs(option.delta - 0.52);
        const spreadPenalty = option.spreadPct * 10;
        const distancePenalty = Math.abs(row.strike - latest.spot) / Math.max(latest.atmStraddle, 1);
        return { strike: row.strike, score: deltaDistance + spreadPenalty + distancePenalty };
      })
      .sort((a, b) => a.score - b.score);
    return candidates[0] ? candidates[0].strike : latest.atmStrike;
  }

  function premiumResponse(side, strike, seconds) {
    const latest = lastSnapshot();
    if (!latest) return 0;
    const older = getOlderSnapshot(seconds);
    if (!older || older === latest) return 0;
    const latestRow = latest.rows.find((row) => row.strike === strike);
    const olderRow = older.rows.find((row) => row.strike === strike);
    if (!latestRow || !olderRow) return 0;
    const latestOption = side === "CE" ? latestRow.ce : latestRow.pe;
    const olderOption = side === "CE" ? olderRow.ce : olderRow.pe;
    const spotMove = side === "CE" ? latest.spot - older.spot : older.spot - latest.spot;
    const premiumMove = latestOption.ltp - olderOption.ltp;
    const expected = Math.max(0, spotMove) * Math.max(latestOption.delta || olderOption.delta, 0.05);
    if (expected <= 0) return 0;
    return clamp(premiumMove / expected, 0, 2);
  }

  function optionPriceChange(side, strike, seconds) {
    const latest = lastSnapshot();
    const older = getOlderSnapshot(seconds);
    if (!latest || !older || older === latest) return 0;
    const latestRow = latest.rows.find((row) => row.strike === strike);
    const olderRow = older.rows.find((row) => row.strike === strike);
    if (!latestRow || !olderRow) return 0;
    const latestOption = side === "CE" ? latestRow.ce : latestRow.pe;
    const olderOption = side === "CE" ? olderRow.ce : olderRow.pe;
    return latestOption.ltp - olderOption.ltp;
  }

  function getWindowMetrics(key) {
    const latest = lastSnapshot();
    const older = getOlderSnapshot(key === "open" ? null : Number(key));
    if (!latest || !older) {
      return emptyMetrics(key);
    }
    return diffSnapshots(latest, older, key === "open" ? null : Number(key));
  }

  function diffSnapshots(latest, older, seconds) {
    return {
      seconds,
      spotChange: latest.spot - older.spot,
      straddleChange: latest.atmStraddle - older.atmStraddle,
      ivChange: latest.atmIv - older.atmIv,
      pcrChange: latest.pcr - older.pcr,
      callOiChange: latest.callOi - older.callOi,
      putOiChange: latest.putOi - older.putOi
    };
  }

  function emptyMetrics(seconds) {
    return {
      seconds,
      spotChange: 0,
      straddleChange: 0,
      ivChange: 0,
      pcrChange: 0,
      callOiChange: 0,
      putOiChange: 0
    };
  }

  function getOlderSnapshot(seconds) {
    if (!state.history.length) return null;
    if (!seconds) return state.history[0];
    const target = Date.now() - seconds * 1000;
    let older = state.history[0];
    for (const snapshot of state.history) {
      if (snapshot.time <= target) {
        older = snapshot;
      } else {
        break;
      }
    }
    return older;
  }

  function lastSnapshot() {
    return state.history[state.history.length - 1] || null;
  }

  function moveLeftPct(snapshot) {
    if (!snapshot.atmStraddle) return 0;
    const moveUsed = Math.abs(snapshot.spot - snapshot.dayOpen);
    return clamp((snapshot.atmStraddle - moveUsed) / snapshot.atmStraddle, 0, 1);
  }

  function labelForInstrument(instrumentKey) {
    if (instrumentKey.includes("Bank")) return "BANKNIFTY";
    if (instrumentKey.includes("Fin")) return "FINNIFTY";
    return "NIFTY";
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function firstNumber(rows, keys) {
    for (const row of rows) {
      for (const key of keys) {
        const value = number(row[key]);
        if (value) return value;
      }
    }
    return 0;
  }

  function sum(rows, getter) {
    return rows.reduce((total, row) => total + number(getter(row)), 0);
  }

  function average(values) {
    const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
    return filtered.length ? filtered.reduce((total, value) => total + value, 0) / filtered.length : 0;
  }

  function price(value, decimals = 2) {
    return number(value).toLocaleString("en-IN", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function signed(value) {
    const numeric = number(value);
    const sign = numeric > 0 ? "+" : "";
    return `${sign}${price(numeric)}`;
  }

  function ratio(value) {
    return number(value).toFixed(2);
  }

  function pct(value) {
    return `${(number(value) * 100).toFixed(0)}%`;
  }

  function compact(value) {
    const numeric = number(value);
    const abs = Math.abs(numeric);
    const sign = numeric < 0 ? "-" : "";
    if (abs >= 10000000) return `${sign}${(abs / 10000000).toFixed(2)}Cr`;
    if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)}L`;
    if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
    return `${sign}${abs.toFixed(0)}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, number(value)));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function makeEmergencyDemo() {
    return {
      source: "demo",
      generatedAt: new Date().toISOString(),
      instrumentKey: "NSE_INDEX|Nifty 50",
      expiry: el.expiryInput.value,
      underlying: { spot: 23245, dayOpen: 23125 },
      data: []
    };
  }
})();
