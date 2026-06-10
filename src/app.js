(function () {
  const WINDOWS = [
    { key: "60", label: "1m", seconds: 60 },
    { key: "180", label: "3m", seconds: 180 },
    { key: "300", label: "5m", seconds: 300 },
    { key: "900", label: "15m", seconds: 900 },
    { key: "1800", label: "30m", seconds: 1800 },
    { key: "open", label: "Open", seconds: null }
  ];
  const CALIBRATION_VERSION = 2;
  const CALIBRATION_INTERVAL_MS = 30 * 1000;
  const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
  const OUTCOME_TOLERANCE_MS = 45 * 1000;

  const state = {
    history: [],
    candles5m: [],
    paused: false,
    timer: null,
    atmFlowRange: clamp(Number(localStorage.getItem("atm_flow_range") || 0), 0, 3),
    stable: {
      key: null,
      since: null,
      confirmations: 0
    },
    signalStartSnapshot: null,
    pressureRead: null,
    calibration: loadCalibrationState(),
    recorder: {
      configured: null,
      snapshotCount: 0,
      firstSavedAt: null,
      lastSavedAt: null,
      message: "Checking database"
    }
  };

  const el = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindElements();
    restoreControls();
    bindEvents();
    await loadExpiries();
    await hydrateSessionHistory();
    await refresh();
    scheduleNext();
  }

  function bindElements() {
    [
      "sourceLine", "recorderStatus", "refreshButton", "pauseButton", "symbolSelect", "expiryInput",
      "activeWindow", "refreshInterval", "spotPressureCard", "pressureHeadline", "pressureContext",
      "pressureState", "pressurePeState", "pressurePeOi", "pressurePePremium",
      "pressureAtmResponse", "pressureTrigger", "pressureInvalidation", "pressureCandleNote", "matrixTable",
      "atmFlowRange", "atmFlowSummaryChips", "atmFlowTable",
      "exportCalibration", "clearCalibration", "calibrationGrid", "outcomeTable"
    ].forEach((id) => {
      el[id] = document.getElementById(id);
    });
  }

  function restoreControls() {
    el.symbolSelect.value = localStorage.getItem("instrument_key") || "NSE_INDEX|Nifty 50";
    el.expiryInput.dataset.preferred = localStorage.getItem("expiry_date") || "auto";
    el.activeWindow.value = "300";
    localStorage.setItem("active_window", "300");
    el.refreshInterval.value = localStorage.getItem("refresh_interval") || "20000";
  }

  function bindEvents() {
    el.refreshButton.addEventListener("click", refresh);
    el.pauseButton.addEventListener("click", togglePause);
    el.atmFlowRange.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (!button) return;
      state.atmFlowRange = clamp(Number(button.dataset.range), 0, 3);
      localStorage.setItem("atm_flow_range", String(state.atmFlowRange));
      updateAtmFlowRangeButtons();
      const latest = lastSnapshot();
      if (latest) renderAtmFlowWatch(latest);
    });
    el.exportCalibration.addEventListener("click", exportCalibration);
    el.clearCalibration.addEventListener("click", clearCalibration);
    el.symbolSelect.addEventListener("change", async () => {
      localStorage.setItem("instrument_key", el.symbolSelect.value);
      resetSessionState();
      await loadExpiries();
      await hydrateSessionHistory();
      await refresh();
      scheduleNext();
    });
    el.expiryInput.addEventListener("change", async () => {
      localStorage.setItem("expiry_date", el.expiryInput.value);
      resetSessionState();
      await hydrateSessionHistory();
      await refresh();
      scheduleNext();
    });
    [el.symbolSelect, el.expiryInput, el.activeWindow, el.refreshInterval].forEach((control) => {
      control.addEventListener("change", () => {
        localStorage.setItem("active_window", el.activeWindow.value);
        localStorage.setItem("refresh_interval", el.refreshInterval.value);
        if (control === el.activeWindow || control === el.refreshInterval) refresh();
        scheduleNext();
      });
    });
  }

  function resetSessionState() {
    state.history = [];
    state.candles5m = [];
    state.stable = { key: null, since: null, confirmations: 0 };
    state.signalStartSnapshot = null;
    state.recorder.snapshotCount = 0;
    state.recorder.firstSavedAt = null;
    state.recorder.lastSavedAt = null;
    state.calibration = freshCalibrationState();
    saveCalibrationState();
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
        expiry_date: el.expiryInput.value || "auto"
      });
      const response = await fetch(`/api/upstox/option-chain?${params.toString()}`, {
        cache: "no-store"
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to fetch option-chain data");
      }
      const snapshot = normalizeSnapshot(payload);
      state.candles5m = normalizeFiveMinuteCandles(payload.candles5m, snapshot.time);
      if (payload.expiry && payload.expiry !== el.expiryInput.value) {
        ensureExpiryOption(payload.expiry);
        el.expiryInput.value = payload.expiry;
        localStorage.setItem("expiry_date", payload.expiry);
      }
      addSnapshot(snapshot);
      updateRecorderFromSave(payload.recorder, snapshot.time);
      render();
      setSource(`${payload.source === "live" ? "Live Upstox REST" : "Demo mode"} · ${formatTime(snapshot.time)} · ${state.history.length} loaded`);
    } catch (error) {
      setSource(`Data error: ${error.message}`);
      if (!state.history.length) {
        const snapshot = normalizeSnapshot(makeEmergencyDemo());
        addSnapshot(snapshot);
        render();
      }
    }
  }

  async function hydrateSessionHistory() {
    if (!el.expiryInput.value || el.expiryInput.value === "auto") {
      updateRecorderStatus({ configured: null, message: "Waiting for expiry" });
      return;
    }

    try {
      updateRecorderStatus({ configured: null, message: "Loading session" });
      const params = new URLSearchParams({
        instrument_key: el.symbolSelect.value,
        expiry_date: el.expiryInput.value
      });
      const response = await fetch(`/api/session/history?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        updateRecorderStatus({ configured: payload.configured, message: payload.error });
        throw new Error(payload.error || "Unable to restore session history");
      }

      state.history = [];
      (payload.snapshots || []).forEach((storedPayload) => {
        addSnapshot(normalizeSnapshot(storedPayload));
      });
      updateRecorderStatus({
        configured: payload.configured,
        snapshotCount: number(payload.snapshotCount),
        firstSavedAt: payload.firstSavedAt,
        lastSavedAt: payload.lastSavedAt,
        message: payload.configured ? "Session restored" : payload.reason
      });
      if (state.history.length) {
        setSource(`Restored ${state.history.length} DB snapshots · ${payload.snapshotCount} saved today`);
      }
    } catch (error) {
      updateRecorderStatus({
        configured: state.recorder.configured,
        message: error.message
      });
    }
  }

  function updateRecorderFromSave(recorder, snapshotTime) {
    if (!recorder) return;
    const savedCount = recorder.inserted ? state.recorder.snapshotCount + 1 : state.recorder.snapshotCount;
    updateRecorderStatus({
      configured: recorder.configured,
      snapshotCount: savedCount,
      firstSavedAt: state.recorder.firstSavedAt || (recorder.inserted ? recorder.capturedAt || snapshotTime : null),
      lastSavedAt: recorder.saved ? recorder.capturedAt || snapshotTime : state.recorder.lastSavedAt,
      message: recorder.saved ? "Recording" : recorder.reason
    });
  }

  function updateRecorderStatus(next) {
    state.recorder = { ...state.recorder, ...next };
    if (!el.recorderStatus) return;
    const { configured, snapshotCount, lastSavedAt, message } = state.recorder;
    const active = configured && lastSavedAt;
    el.recorderStatus.className = `recorder-pill ${active ? "active" : configured === false ? "off" : ""}`;
    el.recorderStatus.textContent = active
      ? `DB ${snapshotCount} · ${formatTime(new Date(lastSavedAt).getTime())}`
      : configured === false
        ? "DB setup needed"
        : "DB checking";
    el.recorderStatus.title = message || "Server session recorder status";
  }

  async function loadExpiries() {
    try {
      el.expiryInput.disabled = true;
      el.expiryInput.innerHTML = '<option value="auto">Loading...</option>';
      const params = new URLSearchParams({ instrument_key: el.symbolSelect.value });
      const response = await fetch(`/api/upstox/expiries?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to fetch expiries");
      }
      const expiries = Array.isArray(payload.expiries) ? payload.expiries : [];
      if (!expiries.length) {
        throw new Error("No expiries returned");
      }
      const preferred = el.expiryInput.dataset.preferred || localStorage.getItem("expiry_date") || "auto";
      const selected = expiries.includes(preferred) ? preferred : expiries[0];
      el.expiryInput.innerHTML = expiries.map((expiry, index) => (
        `<option value="${expiry}">${expiry}${index === 0 ? " · nearest" : ""}</option>`
      )).join("");
      el.expiryInput.value = selected;
      localStorage.setItem("expiry_date", selected);
      setSource(`${payload.source === "live" ? "Live" : "Demo"} expiries loaded · ${selected}`);
    } catch (error) {
      el.expiryInput.innerHTML = '<option value="auto">Auto</option>';
      el.expiryInput.value = "auto";
      localStorage.setItem("expiry_date", "auto");
      setSource(`Expiry auto mode: ${error.message}`);
    } finally {
      el.expiryInput.disabled = false;
      el.expiryInput.dataset.preferred = el.expiryInput.value;
    }
  }

  function ensureExpiryOption(expiry) {
    const exists = Array.from(el.expiryInput.options).some((option) => option.value === expiry);
    if (!exists) {
      const option = document.createElement("option");
      option.value = expiry;
      option.textContent = `${expiry} · resolved`;
      el.expiryInput.appendChild(option);
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
    const cutoff = Date.now() - 8 * 60 * 60 * 1000;
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

  function normalizeFiveMinuteCandles(candles, referenceTime) {
    if (!Array.isArray(candles)) return [];
    return candles
      .map((candle) => ({
        start: new Date(candle[0]).getTime(),
        end: new Date(candle[0]).getTime() + 5 * 60 * 1000,
        open: number(candle[1]),
        high: number(candle[2]),
        low: number(candle[3]),
        close: number(candle[4]),
        source: "Upstox 5m OHLC"
      }))
      .filter((candle) => Number.isFinite(candle.start) && candle.end <= referenceTime && candle.close > 0)
      .sort((a, b) => a.start - b.start)
      .slice(-24);
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
    const pressureRead = buildFiveMinutePressure(latest);
    state.pressureRead = pressureRead;
    const calibrationSnapshotAdded = recordCalibrationSnapshot(latest, active, pressureRead);
    if (calibrationSnapshotAdded) {
      createPressureCalibrationSignal(pressureRead, latest);
      updateSignalOutcomes(latest);
    }
    saveCalibrationState();
    renderSpotPressure(latest, pressureRead);
    renderAtmFlowWatch(latest);
    renderMatrix();
    renderCalibrationLab();
    renderOutcomeTable();
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

  function renderSpotPressure(latest, pressureRead) {
    const read = pressureRead || buildFiveMinutePressure(latest);
    el.spotPressureCard.dataset.tone = read.tone;
    el.pressureHeadline.textContent = read.headline;
    el.pressureContext.textContent = read.context;
    el.pressureState.className = `pressure-state ${read.tone}`;
    el.pressureState.textContent = read.state;
    el.pressurePeState.textContent = read.peState;
    el.pressurePeOi.textContent = read.peOi === null ? "Building" : compact(read.peOi);
    el.pressurePeOi.className = read.peOi > 0 ? "positive" : read.peOi < 0 ? "negative" : "";
    el.pressurePePremium.textContent = read.pePremium === null ? "Building" : signed(read.pePremium);
    el.pressurePePremium.className = read.pePremium < 0 ? "positive" : read.pePremium > 0 ? "negative" : "";
    el.pressureAtmResponse.textContent = read.atmResponse;
    el.pressureTrigger.textContent = read.trigger ? price(read.trigger) : "Building";
    el.pressureInvalidation.textContent = read.invalidation ? price(read.invalidation) : "Building";
    el.pressureCandleNote.textContent = read.note;
  }

  function buildFiveMinutePressure(latest) {
    const exactCandles = state.candles5m;
    const candles = exactCandles.length ? exactCandles : buildSnapshotFiveMinuteCandles(latest.time);
    const source = exactCandles.length ? "Upstox completed 5m OHLC" : "DB snapshot 5m fallback";
    if (candles.length < 3) {
      return emptyPressureRead(`Need ${3 - candles.length} more completed 5m candle${candles.length === 2 ? "" : "s"}`, source);
    }

    const recent = candles.slice(-6);
    const zone = Math.max(5, latest.atmStraddle * 0.03);
    const floorRead = findDefendedFloor(recent, zone);
    if (!floorRead) {
      return emptyPressureRead("No price zone has two completed 5m tests yet", source);
    }

    const last = recent[recent.length - 1];
    const heldCandles = recent.filter((candle) => candle.start >= floorRead.firstTouch.start);
    const heldMinutes = Math.max(5, Math.round((last.end - floorRead.firstTouch.start) / 60000));
    const invalidation = floorRead.floor - zone;
    const closesBelow = heldCandles.filter((candle) => candle.close < invalidation);
    const lastTwo = heldCandles.slice(-2);
    const breakdownConfirmed = lastTwo.length === 2 && lastTwo.every((candle) => candle.close < invalidation);
    const breakdownWatch = !breakdownConfirmed && last.close < invalidation;
    const swept = last.low < invalidation && last.close >= floorRead.floor;
    const priorForTrigger = heldCandles.length > 1 ? heldCandles.slice(-4, -1) : heldCandles;
    const trigger = priorForTrigger.length ? Math.max(...priorForTrigger.map((candle) => candle.high)) : 0;

    const baselineSnapshot = findSnapshotNear(floorRead.firstTouch.start);
    const completedSnapshot = findSnapshotNear(last.end);
    const pe = buildPePressure(baselineSnapshot, completedSnapshot);
    const floorHeld = heldMinutes >= 10 && closesBelow.length === 0;
    const upsideTriggered = floorHeld && pe.state === "Strong" && trigger && last.close > trigger;

    let stateLabel = "PRICE HOLDING";
    let tone = "holding";
    let headline = `${price(floorRead.floor)} ke neeche ${heldMinutes}m se 5m close nahi`;
    let note = "Forming 5m candle is not used for confirmation";

    if (breakdownConfirmed && pe.bearishConfirmation) {
      stateLabel = "BREAKDOWN CONFIRMED";
      tone = "negative";
      headline = `${price(invalidation)} ke neeche two completed 5m closes`;
      note = "Price close and PE premium pressure both confirm failure";
    } else if (breakdownWatch) {
      stateLabel = "BREAKDOWN WATCH";
      tone = "warn";
      headline = `${price(invalidation)} ke neeche first 5m close; second close pending`;
      note = "Single close cannot confirm breakdown";
    } else if (swept) {
      stateLabel = pe.state === "Strong" ? "SWEEP RECLAIMED" : "SWEEP · OI WAIT";
      tone = pe.state === "Strong" ? "positive" : "warn";
      headline = `${price(last.low)} sweep hua, ${price(floorRead.floor)} ke upar 5m close`;
      note = "Wick below the zone was reclaimed on a completed candle";
    } else if (upsideTriggered) {
      stateLabel = "UPSIDE TRIGGERED";
      tone = "positive";
      headline = `${price(floorRead.floor)} floor held and ${price(trigger)} trigger closed above`;
      note = "Floor, PE writing and price trigger are aligned";
    } else if (floorHeld && pe.state === "Strong") {
      stateLabel = "UPSIDE PRESSURE";
      tone = "positive";
    } else if (!floorHeld) {
      stateLabel = "FLOOR BUILDING";
      tone = "building";
    }

    return {
      state: stateLabel,
      tone,
      headline,
      context: `${floorRead.tests} defended tests · ${source} · ${pe.strikeText}`,
      peState: pe.state,
      peOi: pe.oiChange,
      pePremium: pe.premiumChange,
      atmResponse: pe.response,
      trigger,
      invalidation,
      note
    };
  }

  function emptyPressureRead(headline, source) {
    return {
      state: "BUILDING",
      tone: "building",
      headline,
      context: `${source} · completed candles only`,
      peState: "History building",
      peOi: null,
      pePremium: null,
      atmResponse: "Waiting",
      trigger: 0,
      invalidation: 0,
      note: "Forming 5m candle is not used for confirmation"
    };
  }

  function findDefendedFloor(candles, zone) {
    const candidates = candles.map((candle) => {
      const near = candles.filter((item) => Math.abs(item.low - candle.low) <= zone);
      if (near.length < 2) return null;
      const sweeps = candles.filter((item) => item.low < candle.low - zone && item.close >= candle.low);
      const touches = [...new Map([...near, ...sweeps].map((item) => [item.start, item])).values()]
        .sort((a, b) => a.start - b.start);
      return {
        floor: median(near.map((item) => item.low)),
        tests: touches.length,
        nearTests: near.length,
        firstTouch: touches[0],
        lastTouch: touches[touches.length - 1]
      };
    }).filter(Boolean);

    return candidates.sort((a, b) => (
      b.nearTests - a.nearTests
      || b.tests - a.tests
      || b.lastTouch.start - a.lastTouch.start
    ))[0] || null;
  }

  function buildPePressure(baseline, current) {
    if (!baseline || !current || baseline === current) {
      return {
        state: "History building",
        response: "Waiting",
        oiChange: null,
        premiumChange: null,
        bearishConfirmation: false,
        strikeText: "PE history building"
      };
    }

    const atmIndex = baseline.rows.findIndex((row) => row.strike === baseline.atmStrike);
    const strikes = [baseline.atmStrike];
    if (atmIndex > 0) strikes.push(baseline.rows[atmIndex - 1].strike);
    const paired = strikes.map((strike) => ({
      baseline: baseline.rows.find((row) => row.strike === strike),
      current: current.rows.find((row) => row.strike === strike)
    })).filter((pair) => pair.baseline && pair.current);

    if (!paired.length) {
      return {
        state: "Strike history missing",
        response: "Waiting",
        oiChange: null,
        premiumChange: null,
        bearishConfirmation: false,
        strikeText: "same-strike PE history missing"
      };
    }

    const oiChange = sum(paired, (pair) => pair.current.pe.oi - pair.baseline.pe.oi);
    const premiumChange = sum(paired, (pair) => pair.current.pe.ltp - pair.baseline.pe.ltp);
    const baselineIndex = Math.max(0, atmIndex - 3);
    const universe = baseline.rows.slice(baselineIndex, Math.min(baseline.rows.length, atmIndex + 4))
      .map((row) => {
        const currentRow = current.rows.find((item) => item.strike === row.strike);
        return currentRow ? {
          oi: currentRow.pe.oi - row.pe.oi,
          premium: currentRow.pe.ltp - row.pe.ltp
        } : null;
      }).filter(Boolean);
    const oiAbs = universe.map((item) => Math.abs(item.oi));
    const premiumAbs = universe.map((item) => Math.abs(item.premium));
    const oiCenter = median(oiAbs);
    const premiumCenter = median(premiumAbs);
    const oiThreshold = Math.max(50000, (oiCenter + 1.5 * median(oiAbs.map((value) => Math.abs(value - oiCenter)))) * Math.sqrt(paired.length));
    const premiumThreshold = Math.max(1, (premiumCenter + median(premiumAbs.map((value) => Math.abs(value - premiumCenter)))) * Math.sqrt(paired.length));
    const strongWriting = oiChange >= oiThreshold && premiumChange <= -premiumThreshold;
    const developingWriting = oiChange > 0 && premiumChange < 0;
    const bearishConfirmation = premiumChange >= premiumThreshold && (oiChange > 0 || oiChange <= -oiThreshold);

    return {
      state: strongWriting ? "Strong" : developingWriting ? "Developing" : bearishConfirmation ? "Under risk" : "Mixed",
      response: strongWriting ? "Confirming" : developingWriting ? "Early" : bearishConfirmation ? "Not confirming" : "Neutral",
      oiChange,
      premiumChange,
      bearishConfirmation,
      strikeText: `${paired.map((pair) => price(pair.baseline.strike, 0)).join(" + ")} PE`
    };
  }

  function findSnapshotNear(time) {
    const nearest = state.history.reduce((best, snapshot) => {
      const distance = Math.abs(snapshot.time - time);
      return !best || distance < best.distance ? { snapshot, distance } : best;
    }, null);
    return nearest && nearest.distance <= 75 * 1000 ? nearest.snapshot : null;
  }

  function buildSnapshotFiveMinuteCandles(referenceTime) {
    const currentBucket = Math.floor(referenceTime / 300000) * 300000;
    const groups = new Map();
    state.history.forEach((snapshot) => {
      const start = Math.floor(snapshot.time / 300000) * 300000;
      if (start >= currentBucket) return;
      if (!groups.has(start)) groups.set(start, []);
      groups.get(start).push(snapshot);
    });
    return [...groups.entries()].map(([start, snapshots]) => {
      snapshots.sort((a, b) => a.time - b.time);
      return {
        start,
        end: start + 300000,
        open: snapshots[0].spot,
        high: Math.max(...snapshots.map((snapshot) => snapshot.spot)),
        low: Math.min(...snapshots.map((snapshot) => snapshot.spot)),
        close: snapshots[snapshots.length - 1].spot,
        source: "DB snapshot 5m fallback"
      };
    }).filter((candle) => candle.close > 0).sort((a, b) => a.start - b.start).slice(-24);
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

  function renderAtmFlowWatch(latest) {
    updateAtmFlowRangeButtons();
    const atmIndex = latest.rows.findIndex((row) => row.strike === latest.atmStrike);
    const range = state.atmFlowRange;
    const start = Math.max(0, atmIndex - range);
    const end = Math.min(latest.rows.length, atmIndex + range + 1);
    const rows = latest.rows.slice(start, end);
    const windows = atmFlowWindows();
    const models = windows.map((windowItem) => {
      const older = getOlderSnapshot(windowItem.seconds);
      const flowRows = rows.map((row) => buildAtmFlowRow(latest, older, row));
      return {
        ...windowItem,
        available: Boolean(older && older !== latest),
        rows: flowRows,
        summary: summarizeAtmFlow(flowRows)
      };
    });
    el.atmFlowSummaryChips.innerHTML = models.map((model) => `
      <div class="atm-flow-chip ${model.summary.tone}" title="${escapeHtml(model.summary.reason)}">
        <span>${model.label}</span>
        <strong>${escapeHtml(model.summary.bias)}</strong>
        <em>CE ${compact(model.summary.ceOiTotal)} / PE ${compact(model.summary.peOiTotal)}</em>
      </div>
    `).join("");

    const tbody = el.atmFlowTable.querySelector("tbody");
    tbody.innerHTML = rows.map((row, index) => {
      const isAtm = row.strike === latest.atmStrike;
      return `
      <tr class="${isAtm ? "atm-row" : ""}">
        <td class="strike-cell"><strong>${price(row.strike, 0)}</strong>${isAtm ? '<span class="atm-badge">ATM</span>' : ""}</td>
        ${models.map((model) => atmFlowCell(model.rows[index])).join("")}
      </tr>
    `;
    }).join("");
  }

  function renderPreSignalLine(models) {
    const preSignal = buildPreSignalRead(models);
    el.preSignalLine.className = `pre-signal-line ${preSignal.tone}`;
    el.preSignalLine.innerHTML = `
      <span>Pre-Signal</span>
      <strong>${escapeHtml(preSignal.state)} · ${preSignal.confidence}%</strong>
      <em>${escapeHtml(preSignal.agreement)} · ${escapeHtml(preSignal.reason)} · ${escapeHtml(preSignal.trigger)}</em>
    `;
  }

  function buildPreSignalRead(models) {
    const scored = models.filter((model) => model.available).map((model) => ({
      label: model.label,
      direction: model.summary.bias,
      score: model.summary.score,
      reason: model.summary.reason
    }));
    if (scored.length < 3) {
      return {
        state: "Building History",
        confidence: 0,
        agreement: `${scored.length}/5 windows ready`,
        reason: "waiting for exact rolling baselines",
        trigger: "Trigger: at least 3 valid windows",
        tone: "muted"
      };
    }
    const bullish = scored.filter((item) => item.direction === "Bullish").length;
    const bearish = scored.filter((item) => item.direction === "Bearish").length;
    const mixed = scored.length - bullish - bearish;
    const totalScore = sum(scored, (item) => item.score);
    const dominant = bullish > bearish ? "Bullish" : bearish > bullish ? "Bearish" : "Mixed";
    const dominantCount = Math.max(bullish, bearish);
    const agreement = dominant === "Mixed"
      ? `${mixed}/${scored.length} mixed`
      : `${dominantCount}/${scored.length} ${dominant.toLowerCase()}`;
    const confidence = clamp(Math.round((dominantCount / scored.length) * 60 + Math.min(Math.abs(totalScore), 18) * 2), 0, 95);
    const latest = scored.find((item) => item.label === "5m") || scored[0];
    const reason = latest ? latest.reason : "flow building";

    if (dominant === "Bullish" && dominantCount >= 3) {
      return {
        state: "Bullish Build",
        confidence,
        agreement,
        reason,
        trigger: "Trigger: CE response + price hold",
        tone: "positive"
      };
    }

    if (dominant === "Bearish" && dominantCount >= 3) {
      return {
        state: "Bearish Build",
        confidence,
        agreement,
        reason,
        trigger: "Trigger: PE response + support break",
        tone: "negative"
      };
    }

    return {
      state: "Mixed / Wait",
      confidence,
      agreement,
      reason,
      trigger: "Trigger: wait for flow alignment",
      tone: "muted"
    };
  }

  function updateAtmFlowRangeButtons() {
    el.atmFlowRange.querySelectorAll("button[data-range]").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.range) === state.atmFlowRange);
    });
  }

  function atmFlowWindows() {
    return [
      { key: "open", label: "Open", seconds: null },
      { key: "300", label: "5m", seconds: 300 },
      { key: "600", label: "10m", seconds: 600 },
      { key: "900", label: "15m", seconds: 900 },
      { key: "1800", label: "30m", seconds: 1800 }
    ];
  }

  function atmFlowCell(item) {
    return `
      <td class="atm-flow-cell">
        <div class="flow-line ${item.ce.tone}">
          <span>CE ${flowCode(item.ce)}</span>
          <strong>${compact(item.ce.oiChange)}</strong>
          <em>${signed(item.ce.priceChange)}</em>
        </div>
        <div class="flow-line ${item.pe.tone}">
          <span>PE ${flowCode(item.pe)}</span>
          <strong>${compact(item.pe.oiChange)}</strong>
          <em>${signed(item.pe.priceChange)}</em>
        </div>
      </td>
    `;
  }

  function buildAtmFlowRow(latest, older, row) {
    const olderRow = older ? older.rows.find((item) => item.strike === row.strike) : null;
    return {
      strike: row.strike,
      isAtm: row.strike === latest.atmStrike,
      ce: classifyAtmSideFlow(row.ce, olderRow ? olderRow.ce : null, "CE"),
      pe: classifyAtmSideFlow(row.pe, olderRow ? olderRow.pe : null, "PE")
    };
  }

  function classifyAtmSideFlow(option, olderOption, side) {
    if (!option || !olderOption || option === olderOption) {
      return {
        side,
        title: "Building",
        shortTitle: "Build",
        tone: "neutral",
        score: 0,
        priceChange: 0,
        oiChange: 0
      };
    }

    const priceChange = option.ltp - olderOption.ltp;
    const oiChange = option.oi - olderOption.oi;
    const enoughOi = Math.abs(oiChange) >= Math.max(25000, olderOption.oi * 0.008);
    const enoughPrice = Math.abs(priceChange) >= Math.max(0.5, option.ltp * 0.004);
    const spreadOk = option.spreadPct <= 0.03;
    const liquid = option.volume >= 15000 || option.oi >= 75000;
    const flow = nameOptionFlow(side, priceChange, oiChange);
    const score = flowScore(side, flow.title);

    if (!enoughOi || !enoughPrice || !spreadOk || !liquid) {
      return {
        side,
        title: "Noise / wait",
        shortTitle: "Noise",
        tone: "neutral",
        score: 0,
        priceChange,
        oiChange
      };
    }

    return {
      side,
      title: flow.title,
      shortTitle: shortFlowTitle(flow.title),
      tone: flow.tone,
      score,
      priceChange,
      oiChange
    };
  }

  function summarizeAtmFlow(rows) {
    const ceOiTotal = sum(rows, (row) => row.ce.oiChange);
    const peOiTotal = sum(rows, (row) => row.pe.oiChange);
    const cePremTotal = sum(rows, (row) => row.ce.priceChange);
    const pePremTotal = sum(rows, (row) => row.pe.priceChange);
    const score = sum(rows, (row) => row.ce.score + row.pe.score);
    const ceCounts = countFlowTitles(rows.map((row) => row.ce));
    const peCounts = countFlowTitles(rows.map((row) => row.pe));
    const ceReason = dominantFlowText("CE", ceCounts);
    const peReason = dominantFlowText("PE", peCounts);

    if (score >= 4) {
      return {
        title: "ATM Flow: Bullish PE pressure",
        tone: "positive",
        bias: "Bullish",
        score,
        reason: `${peReason}; ${ceReason}`,
        ceOiTotal,
        peOiTotal,
        cePremTotal,
        pePremTotal
      };
    }

    if (score <= -4) {
      return {
        title: "ATM Flow: Bearish CE pressure",
        tone: "negative",
        bias: "Bearish",
        score,
        reason: `${ceReason}; ${peReason}`,
        ceOiTotal,
        peOiTotal,
        cePremTotal,
        pePremTotal
      };
    }

    return {
      title: "ATM Flow: Mixed / wait",
      tone: "muted",
      bias: "Mixed",
      score,
      reason: `${ceReason}; ${peReason}`,
      ceOiTotal,
      peOiTotal,
      cePremTotal,
      pePremTotal
    };
  }

  function flowScore(side, title) {
    if (title.includes("long buildup")) return side === "CE" ? 2 : -2;
    if (title.includes("writing")) return side === "CE" ? -2 : 2;
    if (title.includes("short covering")) return side === "CE" ? 2 : -2;
    if (title.includes("long unwinding")) return side === "CE" ? -1 : 1;
    return 0;
  }

  function shortFlowTitle(title) {
    if (title.includes("long buildup")) return "Long build";
    if (title.includes("writing")) return "Writing";
    if (title.includes("short covering")) return "Covering";
    if (title.includes("long unwinding")) return "Unwind";
    return "Neutral";
  }

  function flowCode(flow) {
    if (flow.shortTitle === "Long build") return "LB";
    if (flow.shortTitle === "Covering") return "C";
    if (flow.shortTitle === "Writing") return "W";
    if (flow.shortTitle === "Unwind") return "U";
    if (flow.shortTitle === "Noise") return "N";
    if (flow.shortTitle === "Build") return "…";
    return "N";
  }

  function countFlowTitles(flows) {
    return flows.reduce((counts, flow) => {
      counts[flow.shortTitle] = (counts[flow.shortTitle] || 0) + 1;
      return counts;
    }, {});
  }

  function dominantFlowText(side, counts) {
    const entries = Object.entries(counts)
      .filter(([name]) => name !== "Noise" && name !== "Build")
      .sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `${side}: no clean flow`;
    return `${side}: ${entries.slice(0, 2).map(([name, count]) => `${count} ${name}`).join(", ")}`;
  }

  function renderMatrix() {
    const rows = [
      { label: "Price", getter: (m) => signed(m.spotChange) },
      { label: "ATM Straddle", getter: (m) => signed(m.straddleChange) },
      { label: "ATM IV", getter: (m) => signed(m.ivChange) },
      { label: "PCR", getter: (m) => signed(m.pcrChange) },
      { label: "Call Chg OI", getter: (m) => compact(m.callOiChange) },
      { label: "Put Chg OI", getter: (m) => compact(m.putOiChange) },
      { label: "Net Chg OI", getter: (m) => compact(m.putOiChange - m.callOiChange) },
      { label: "CE Response", getter: (m) => ratio(premiumResponse("CE", pickCandidateStrike(lastSnapshot(), "CE"), m.seconds)) },
      { label: "PE Response", getter: (m) => ratio(premiumResponse("PE", pickCandidateStrike(lastSnapshot(), "PE"), m.seconds)) }
    ];
    const tbody = el.matrixTable.querySelector("tbody");
    tbody.innerHTML = rows.map((row) => `
      <tr>
        <td>${row.label}</td>
        ${WINDOWS.map((windowItem) => {
          const metrics = getWindowMetrics(windowItem.key);
          const value = metrics.available ? row.getter(metrics) : "Building";
          const tone = value.startsWith("-") ? "negative" : value === "0.00" || value === "Building" ? "" : "positive";
          return `<td class="${tone}">${value}</td>`;
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

  function renderAdvancedEdge(latest, active, decision) {
    const trap = detectTrap(latest, active, decision);
    const wallShift = detectWallShift(latest, active);
    const journalRead = readJournalQuality();
    const cards = [
      {
        label: "Trap Detector",
        value: trap.title,
        tone: trap.tone,
        copy: trap.copy,
        facts: trap.facts
      },
      {
        label: "OI Wall Shift",
        value: wallShift.title,
        tone: wallShift.tone,
        copy: wallShift.copy,
        facts: wallShift.facts
      },
      {
        label: "Replay Journal",
        value: journalRead.title,
        tone: journalRead.tone,
        copy: journalRead.copy,
        facts: journalRead.facts
      }
    ];

    el.advancedEdgeGrid.innerHTML = cards.map((card) => `
      <div class="advanced-card ${card.tone}">
        <div>
          <p>${card.label}</p>
          <strong>${card.value}</strong>
        </div>
        <p>${escapeHtml(card.copy)}</p>
        <div class="fact-list">
          ${card.facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}
        </div>
      </div>
    `).join("");
  }

  function detectTrap(latest, active, decision) {
    const spotMove = Math.abs(active.spotChange);
    const best = decision.best;
    const sideWallBlocked = best.side === "CE"
      ? latest.walls.callWall && latest.walls.callWall.strike >= latest.spot && latest.walls.callWall.strike - latest.spot <= 35 && active.callOiChange > 0
      : latest.walls.putWall && latest.walls.putWall.strike <= latest.spot && latest.spot - latest.walls.putWall.strike <= 35 && active.putOiChange > 0;
    const weakPremium = best.response < 0.45;
    const decay = active.straddleChange < -3 || active.ivChange < -0.5;
    const trapRisk = spotMove >= 16 && weakPremium && decay;
    const hardTrap = trapRisk && sideWallBlocked;

    if (hardTrap) {
      return {
        title: "High trap risk",
        tone: "bad",
        copy: "Price is moving, but premium confirmation is weak while a nearby OI wall is still active.",
        facts: [
          `Spot move ${signed(active.spotChange)}`,
          `${best.side} response ${ratio(best.response)}`,
          `Straddle ${signed(active.straddleChange)}`,
          `IV ${signed(active.ivChange)}`
        ]
      };
    }

    if (trapRisk) {
      return {
        title: "Premium not confirming",
        tone: "warn",
        copy: "Directional movement exists, but option premium and volatility are not fully supporting fresh buying.",
        facts: [
          `Spot move ${signed(active.spotChange)}`,
          `${best.side} response ${ratio(best.response)}`,
          `Decay check ${decay ? "active" : "clear"}`
        ]
      };
    }

    return {
      title: "No major trap",
      tone: "good",
      copy: "No formula-backed buyer trap is active in the selected window.",
      facts: [
        `Spot move ${signed(active.spotChange)}`,
        `${best.side} response ${ratio(best.response)}`,
        `Wall block ${sideWallBlocked ? "yes" : "no"}`
      ]
    };
  }

  function detectWallShift(latest, active) {
    const older = getOlderSnapshot(active.seconds);
    const open = getOlderSnapshot(null);
    const callShift = older && older.walls.callWall && latest.walls.callWall
      ? latest.walls.callWall.strike - older.walls.callWall.strike
      : 0;
    const putShift = older && older.walls.putWall && latest.walls.putWall
      ? latest.walls.putWall.strike - older.walls.putWall.strike
      : 0;
    const callOpenShift = open && open.walls.callWall && latest.walls.callWall
      ? latest.walls.callWall.strike - open.walls.callWall.strike
      : 0;
    const putOpenShift = open && open.walls.putWall && latest.walls.putWall
      ? latest.walls.putWall.strike - open.walls.putWall.strike
      : 0;

    const bothUp = callShift > 0 && putShift > 0;
    const bothDown = callShift < 0 && putShift < 0;
    const bullish = callShift > 0 || putShift > 0;
    const bearish = callShift < 0 || putShift < 0;

    if (bothUp) {
      return {
        title: "Walls shifting up",
        tone: "good",
        copy: "Support and resistance are migrating higher in the selected window, supporting bullish structure.",
        facts: wallFacts(latest, callShift, putShift, callOpenShift, putOpenShift)
      };
    }

    if (bothDown) {
      return {
        title: "Walls shifting down",
        tone: "bad",
        copy: "Support and resistance are migrating lower, warning against aggressive CE buying.",
        facts: wallFacts(latest, callShift, putShift, callOpenShift, putOpenShift)
      };
    }

    if (bullish || bearish) {
      return {
        title: bullish ? "Partial bullish shift" : "Partial bearish shift",
        tone: "warn",
        copy: "Only one side of the OI structure shifted. Treat this as mixed until price and premium confirm.",
        facts: wallFacts(latest, callShift, putShift, callOpenShift, putOpenShift)
      };
    }

    return {
      title: "Walls stable",
      tone: "neutral",
      copy: "Major OI walls are not migrating in the selected window.",
      facts: wallFacts(latest, callShift, putShift, callOpenShift, putOpenShift)
    };
  }

  function wallFacts(latest, callShift, putShift, callOpenShift, putOpenShift) {
    return [
      `Call wall ${latest.walls.callWall ? price(latest.walls.callWall.strike, 0) : "--"} (${signed(callShift)})`,
      `Put wall ${latest.walls.putWall ? price(latest.walls.putWall.strike, 0) : "--"} (${signed(putShift)})`,
      `Open shift C ${signed(callOpenShift)} / P ${signed(putOpenShift)}`
    ];
  }

  function renderStrikeFlowWatch(latest, active, decision) {
    const rows = importantFlowRows(latest, decision);
    const flows = rows.flatMap((item) => [
      classifyOptionFlow(latest, active, item.strike, "CE", item.label),
      classifyOptionFlow(latest, active, item.strike, "PE", item.label)
    ]);

    const ranked = flows
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);

    el.strikeFlowGrid.innerHTML = ranked.map((flow) => `
      <div class="flow-card ${flow.tone}">
        <header>
          <span>${escapeHtml(flow.context)}</span>
          <strong>${flow.side} ${price(flow.strike, 0)}</strong>
        </header>
        <h3>${escapeHtml(flow.title)}</h3>
        <p>${escapeHtml(flow.meaning)}</p>
        <div class="fact-list">
          <span>Prem ${signed(flow.priceChange)}</span>
          <span>OI ${compact(flow.oiChange)}</span>
          <span>Spread ${pct(flow.spreadPct)}</span>
          <span>${flow.confidence}% conf</span>
        </div>
      </div>
    `).join("");
  }

  function importantFlowRows(latest, decision) {
    const strikes = [
      { strike: latest.atmStrike, label: "ATM" },
      latest.walls.callWall ? { strike: latest.walls.callWall.strike, label: "Call Wall" } : null,
      latest.walls.putWall ? { strike: latest.walls.putWall.strike, label: "Put Wall" } : null,
      decision.best && decision.best.strike ? { strike: decision.best.strike, label: "Best Strike" } : null
    ].filter(Boolean);

    const seen = new Set();
    return strikes.filter((item) => {
      if (seen.has(item.strike)) return false;
      seen.add(item.strike);
      return latest.rows.some((row) => row.strike === item.strike);
    });
  }

  function classifyOptionFlow(latest, active, strike, side, context) {
    const older = getOlderSnapshot(active.seconds);
    const row = latest.rows.find((item) => item.strike === strike);
    const olderRow = older ? older.rows.find((item) => item.strike === strike) : null;
    const option = row ? (side === "CE" ? row.ce : row.pe) : null;
    const olderOption = olderRow ? (side === "CE" ? olderRow.ce : olderRow.pe) : null;

    if (!row || !olderRow || !option || !olderOption || older === latest) {
      return neutralFlow(strike, side, context, "Building flow history");
    }

    const priceChange = option.ltp - olderOption.ltp;
    const oiChange = option.oi - olderOption.oi;
    const oiChangePct = olderOption.oi ? Math.abs(oiChange) / olderOption.oi : 0;
    const enoughOi = Math.abs(oiChange) >= Math.max(50000, olderOption.oi * 0.015);
    const enoughPrice = Math.abs(priceChange) >= Math.max(0.75, option.ltp * 0.006);
    const spreadOk = option.spreadPct > 0 && option.spreadPct <= 0.025;
    const activeVolume = option.volume >= 25000 || option.oi >= 100000;
    const directionAligned = side === "CE" ? active.spotChange >= -8 : active.spotChange <= 8;
    const confidence = Math.round([
      enoughOi,
      enoughPrice,
      spreadOk,
      activeVolume,
      directionAligned
    ].filter(Boolean).length / 5 * 100);

    const flow = nameOptionFlow(side, priceChange, oiChange);
    const lowSignal = confidence < 60 || !enoughOi || !enoughPrice || !spreadOk || !activeVolume;
    if (lowSignal) {
      return {
        strike,
        side,
        context,
        title: "Noise / wait",
        meaning: `${flow.title} pattern is visible, but change size or confidence is not strong enough.`,
        tone: "neutral",
        confidence,
        priceChange,
        oiChange,
        oiChangePct,
        spreadPct: option.spreadPct
      };
    }

    return {
      strike,
      side,
      context,
      title: flow.title,
      meaning: flow.meaning,
      tone: flow.tone,
      confidence,
      priceChange,
      oiChange,
      oiChangePct,
      spreadPct: option.spreadPct
    };
  }

  function nameOptionFlow(side, priceChange, oiChange) {
    if (priceChange > 0 && oiChange > 0) {
      return {
        title: `${side} long buildup`,
        meaning: "Premium and OI both increased, showing fresh aggressive participation.",
        tone: side === "CE" ? "good" : "bad"
      };
    }
    if (priceChange < 0 && oiChange > 0) {
      return {
        title: `${side} writing / short buildup`,
        meaning: "OI increased while premium fell, suggesting writers are pressing this strike.",
        tone: side === "CE" ? "bad" : "good"
      };
    }
    if (priceChange > 0 && oiChange < 0) {
      return {
        title: `${side} short covering`,
        meaning: "Premium rose while OI fell, suggesting short writers are exiting.",
        tone: side === "CE" ? "good" : "bad"
      };
    }
    if (priceChange < 0 && oiChange < 0) {
      return {
        title: `${side} long unwinding`,
        meaning: "Premium and OI both fell, showing long-side exit or fading participation.",
        tone: side === "CE" ? "bad" : "good"
      };
    }
    return {
      title: `${side} neutral flow`,
      meaning: "No clear buildup, covering, writing, or unwinding pattern.",
      tone: "neutral"
    };
  }

  function neutralFlow(strike, side, context, meaning) {
    return {
      strike,
      side,
      context,
      title: "Building",
      meaning,
      tone: "neutral",
      confidence: 0,
      priceChange: 0,
      oiChange: 0,
      oiChangePct: 0,
      spreadPct: 0
    };
  }

  function freshCalibrationState() {
    return {
      version: CALIBRATION_VERSION,
      sessionDate: istSessionDate(Date.now()),
      snapshots: [],
      signals: [],
      lastActionState: null,
      ignored: {
        nonLive: 0,
        outsideSession: 0,
        stale: 0,
        cooldown: 0,
        nonActionable: 0
      }
    };
  }

  function loadCalibrationState() {
    try {
      const raw = localStorage.getItem("option_cockpit_calibration");
      if (!raw) return freshCalibrationState();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CALIBRATION_VERSION || parsed.sessionDate !== istSessionDate(Date.now())) {
        return freshCalibrationState();
      }
      return {
        version: CALIBRATION_VERSION,
        sessionDate: parsed.sessionDate,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
        signals: Array.isArray(parsed.signals) ? parsed.signals : [],
        lastActionState: parsed.lastActionState || null,
        ignored: {
          nonLive: number(parsed.ignored && parsed.ignored.nonLive),
          outsideSession: number(parsed.ignored && parsed.ignored.outsideSession),
          stale: number(parsed.ignored && parsed.ignored.stale),
          cooldown: number(parsed.ignored && parsed.ignored.cooldown),
          nonActionable: number(parsed.ignored && parsed.ignored.nonActionable)
        }
      };
    } catch (error) {
      return freshCalibrationState();
    }
  }

  function saveCalibrationState() {
    try {
      localStorage.setItem("option_cockpit_calibration", JSON.stringify(state.calibration));
    } catch (error) {
      state.calibration.snapshots = state.calibration.snapshots.slice(-300);
      state.calibration.signals = state.calibration.signals.slice(0, 50);
    }
  }

  function clearCalibration() {
    state.calibration = freshCalibrationState();
    saveCalibrationState();
    renderCalibrationLab();
    renderOutcomeTable();
  }

  function exportCalibration() {
    const payload = buildCalibrationExport();
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `option-cockpit-calibration-${payload.sessionDate}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function buildCalibrationExport() {
    const completed = state.calibration.signals.filter((signal) => signal.result !== "Pending");
    const good = completed.filter((signal) => signal.result === "Good").length;
    const mixed = completed.filter((signal) => signal.result === "Mixed").length;
    const falseSignals = completed.filter((signal) => signal.result === "False").length;
    const hitRate = completed.length ? good / completed.length : 0;
    const responseSuggestion = suggestResponseThreshold(completed);
    return {
      app: "Option Buyer Cockpit",
      version: "calibration-v2",
      exportedAt: new Date().toISOString(),
      sessionDate: state.calibration.sessionDate,
      instrumentKey: el.symbolSelect.value,
      expiryDate: el.expiryInput.value,
      activeWindow: el.activeWindow.value,
      summary: {
        recordedSnapshots: state.calibration.snapshots.length,
        trackedSignals: state.calibration.signals.length,
        completedSignals: completed.length,
        goodSignals: good,
        mixedSignals: mixed,
        falseSignals,
        hitRate,
        suggestedResponseGate: responseSuggestion.value,
        suggestionNote: responseSuggestion.copy,
        ignored: state.calibration.ignored
      },
      signals: state.calibration.signals,
      snapshots: state.calibration.snapshots
    };
  }

  function recordCalibrationSnapshot(latest, active, pressureRead) {
    if (latest.source !== "live") {
      state.calibration.ignored.nonLive += 1;
      return false;
    }
    if (!isMarketSessionIst(latest.time)) {
      state.calibration.ignored.outsideSession += 1;
      return false;
    }

    const lastRecorded = state.calibration.snapshots[state.calibration.snapshots.length - 1];
    if (lastRecorded && latest.time - lastRecorded.time < CALIBRATION_INTERVAL_MS) {
      return false;
    }

    const fingerprint = calibrationFingerprint(latest);
    if (lastRecorded && lastRecorded.fingerprint === fingerprint) {
      state.calibration.ignored.stale += 1;
      return false;
    }

    state.calibration.snapshots.push({
      time: latest.time,
      fingerprint,
      spot: latest.spot,
      atmStrike: latest.atmStrike,
      atmStraddle: latest.atmStraddle,
      atmIv: latest.atmIv,
      pcr: latest.pcr,
      callOi: latest.callOi,
      putOi: latest.putOi,
      callWall: latest.walls.callWall ? latest.walls.callWall.strike : null,
      putWall: latest.walls.putWall ? latest.walls.putWall.strike : null,
      pressureState: pressureRead.state,
      pressureTone: pressureRead.tone,
      pressureTrigger: pressureRead.trigger,
      pressureInvalidation: pressureRead.invalidation,
      peOiChange: pressureRead.peOi,
      pePremiumChange: pressureRead.pePremium,
      spotChange: active.spotChange,
      straddleChange: active.straddleChange,
      ivChange: active.ivChange
    });
    state.calibration.snapshots = state.calibration.snapshots.slice(-900);
    return true;
  }

  function createPressureCalibrationSignal(pressureRead, latest) {
    const side = pressureRead.state === "UPSIDE TRIGGERED"
      ? "CE"
      : pressureRead.state === "BREAKDOWN CONFIRMED"
        ? "PE"
        : null;
    if (!side) {
      state.calibration.lastActionState = null;
      state.calibration.ignored.nonActionable += 1;
      return;
    }

    if (state.calibration.lastActionState === pressureRead.state) {
      state.calibration.ignored.cooldown += 1;
      return;
    }

    const setupLevel = side === "CE" ? pressureRead.trigger : pressureRead.invalidation;
    const setupKey = `${latest.instrumentKey}:${latest.expiry}:${side}:${price(setupLevel, 0)}`;
    const lastSignal = state.calibration.signals[0];
    const setupAlreadyTracked = state.calibration.signals.some((signal) => signal.setupKey === setupKey);
    if (setupAlreadyTracked || (lastSignal && latest.time - lastSignal.time < SIGNAL_COOLDOWN_MS)) {
      state.calibration.ignored.cooldown += 1;
      return;
    }

    const strike = pickCandidateStrike(latest, side);
    const row = latest.rows.find((item) => item.strike === strike);
    const option = row ? (side === "CE" ? row.ce : row.pe) : null;
    if (!option || !option.ltp) return;
    const entryAsk = option.ask || option.ltp;
    const entryBid = option.bid || option.ltp;
    const spread = Math.max(0, entryAsk - entryBid);
    const minimumNetMove = Math.max(1, entryAsk * 0.01, spread * 1.5);

    state.calibration.signals.unshift({
      id: `${latest.time}:${side}:${strike}`,
      setupKey,
      time: latest.time,
      side,
      strike,
      setup: pressureRead.state,
      response: premiumResponse(side, strike, 300),
      spot: latest.spot,
      optionLtp: option.ltp,
      entryBid,
      entryAsk,
      spread,
      minimumNetMove,
      quoteSource: option.ask && option.bid ? "bid-ask" : "ltp-fallback",
      atmIv: latest.atmIv,
      atmStraddle: latest.atmStraddle,
      reason: pressureRead.note,
      checks: {
        "180": null,
        "300": null,
        "600": null
      },
      result: "Pending"
    });
    state.calibration.lastActionState = pressureRead.state;
    state.calibration.signals = state.calibration.signals.slice(0, 100);
  }

  function updateSignalOutcomes(latest) {
    if (!isMarketSessionIst(latest.time)) return;
    for (const signal of state.calibration.signals) {
      for (const seconds of [180, 300, 600]) {
        const key = String(seconds);
        if (signal.checks[key] || latest.time - signal.time < seconds * 1000) {
          continue;
        }

        const targetTime = signal.time + seconds * 1000;
        const outcomeSnapshot = findOutcomeSnapshot(targetTime);
        if (!outcomeSnapshot) continue;
        const row = outcomeSnapshot.rows.find((item) => item.strike === signal.strike);
        if (!row) continue;
        const option = signal.side === "CE" ? row.ce : row.pe;
        const exitBid = option.bid || option.ltp;
        const optionMove = option.ltp - signal.optionLtp;
        const netOptionMove = exitBid - signal.entryAsk;
        const spotMove = signal.side === "CE" ? outcomeSnapshot.spot - signal.spot : signal.spot - outcomeSnapshot.spot;
        const ivMove = outcomeSnapshot.atmIv - signal.atmIv;
        const straddleMove = outcomeSnapshot.atmStraddle - signal.atmStraddle;
        const path = state.history.filter((snapshot) => snapshot.time >= signal.time && snapshot.time <= outcomeSnapshot.time)
          .map((snapshot) => snapshot.rows.find((item) => item.strike === signal.strike))
          .filter(Boolean)
          .map((pathRow) => {
            const pathOption = signal.side === "CE" ? pathRow.ce : pathRow.pe;
            return (pathOption.bid || pathOption.ltp) - signal.entryAsk;
          });
        const mfe = path.length ? Math.max(...path) : netOptionMove;
        const mae = path.length ? Math.min(...path) : netOptionMove;
        const passed = netOptionMove >= signal.minimumNetMove && spotMove > 0;
        signal.checks[key] = {
          targetTime,
          observedAt: outcomeSnapshot.time,
          optionMove,
          netOptionMove,
          exitBid,
          spotMove,
          ivMove,
          straddleMove,
          mfe,
          mae,
          passed
        };
      }
      signal.result = summarizeSignalResult(signal);
    }
  }

  function summarizeSignalResult(signal) {
    const checks = Object.values(signal.checks).filter(Boolean);
    if (checks.length < 3) return "Pending";
    const wins = checks.filter((check) => check.passed).length;
    if (wins >= 2) return "Good";
    if (wins === 1) return "Mixed";
    return "False";
  }

  function renderCalibrationLab() {
    const report = buildCalibrationReport();
    el.calibrationGrid.innerHTML = report.map((card) => `
      <div class="calibration-card ${card.tone}">
        <p>${card.label}</p>
        <strong>${card.value}</strong>
        <span>${escapeHtml(card.copy)}</span>
      </div>
    `).join("");
  }

  function buildCalibrationReport() {
    const signals = state.calibration.signals;
    const completed = signals.filter((signal) => signal.result !== "Pending");
    const good = completed.filter((signal) => signal.result === "Good").length;
    const falseSignals = completed.filter((signal) => signal.result === "False").length;
    const hitRate = completed.length ? good / completed.length : 0;
    const responseSuggestion = suggestResponseThreshold(completed);
    const nonLiveIgnored = state.calibration.ignored.nonLive;
    const staleIgnored = state.calibration.ignored.stale;
    const outsideIgnored = state.calibration.ignored.outsideSession;
    const qualityGood = nonLiveIgnored === 0 && staleIgnored === 0 && outsideIgnored === 0;

    return [
      {
        label: "Recorded Snapshots",
        value: String(state.calibration.snapshots.length),
        tone: state.calibration.snapshots.length >= 30 ? "good" : "neutral",
        copy: "Unique live snapshots, every 30s, only during 09:15-15:30 IST."
      },
      {
        label: "Independent Signals",
        value: String(signals.length),
        tone: signals.length >= 5 ? "good" : "warn",
        copy: `${completed.length} completed · ${signals.length - completed.length} pending · 5m cooldown.`
      },
      {
        label: "Signal Hit Rate",
        value: completed.length ? pct(hitRate) : "--",
        tone: hitRate >= 0.6 ? "good" : hitRate >= 0.4 ? "warn" : "bad",
        copy: `${good} good · ${falseSignals} false after bid-ask adjusted 3m/5m/10m checks.`
      },
      {
        label: "Suggested Response Gate",
        value: responseSuggestion.value,
        tone: responseSuggestion.tone,
        copy: responseSuggestion.copy
      },
      {
        label: "Recorder Quality",
        value: qualityGood ? "Clean" : "Filtered",
        tone: qualityGood ? "good" : "warn",
        copy: `${nonLiveIgnored} demo · ${staleIgnored} stale · ${outsideIgnored} outside-session ignored.`
      }
    ];
  }

  function suggestResponseThreshold(completed) {
    if (completed.length < 20) {
      return {
        value: "Collect data",
        tone: "neutral",
        copy: "Need at least 20 independent completed signals before a threshold suggestion."
      };
    }

    const thresholds = [0.45, 0.55, 0.65, 0.75, 0.85];
    const ranked = thresholds.map((threshold) => {
      const sample = completed.filter((signal) => signal.response >= threshold);
      const wins = sample.filter((signal) => signal.result === "Good").length;
      return {
        threshold,
        count: sample.length,
        rate: sample.length ? wins / sample.length : 0
      };
    }).filter((item) => item.count >= 10).sort((a, b) => b.rate - a.rate || b.count - a.count);

    if (!ranked.length) {
      return {
        value: "More samples",
        tone: "warn",
        copy: "Not enough completed signals above any response threshold yet."
      };
    }

    const best = ranked[0];
    return {
      value: `>${ratio(best.threshold)}`,
      tone: best.rate >= 0.6 ? "good" : "warn",
      copy: `${pct(best.rate)} hit rate from ${best.count} completed samples. Suggest only, not auto-applied.`
    };
  }

  function renderOutcomeTable() {
    const tbody = el.outcomeTable.querySelector("tbody");
    tbody.innerHTML = state.calibration.signals.slice(0, 14).map((signal) => `
      <tr>
        <td>${formatTime(signal.time)}</td>
        <td>${escapeHtml(signal.side)}</td>
        <td>${price(signal.strike, 0)}</td>
        <td>${escapeHtml(signal.setup || "Pressure trigger")}</td>
        <td>${outcomeCell(signal.checks["180"])}</td>
        <td>${outcomeCell(signal.checks["300"])}</td>
        <td>${outcomeCell(signal.checks["600"])}</td>
        <td>${resultTag(signal.result)}</td>
      </tr>
    `).join("");
  }

  function outcomeCell(check) {
    if (!check) return '<span class="muted">Pending</span>';
    const tone = check.passed ? "positive" : "negative";
    return `<span class="${tone}" title="MFE ${signed(check.mfe)} · MAE ${signed(check.mae)}">${signed(check.netOptionMove)} net / ${signed(check.spotMove)} spot</span>`;
  }

  function resultTag(result) {
    const tone = result === "Good" ? "good" : result === "Mixed" ? "warn" : result === "False" ? "bad" : "neutral";
    return `<span class="tag ${tone}">${result}</span>`;
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

  function flowBadge(flow) {
    const tone = flow.tone === "neutral" ? "muted" : flow.tone;
    return `<span class="tag ${tone}" title="${escapeHtml(flow.title)}">${escapeHtml(flow.shortTitle)}</span>`;
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
    if (!latest || !older || older === latest) {
      return emptyMetrics(key);
    }
    return diffSnapshots(latest, older, key === "open" ? null : Number(key));
  }

  function diffSnapshots(latest, older, seconds) {
    const olderAtCurrentStrike = older.rows.find((row) => row.strike === latest.atmStrike);
    const olderStraddle = olderAtCurrentStrike
      ? olderAtCurrentStrike.ce.ltp + olderAtCurrentStrike.pe.ltp
      : older.atmStraddle;
    const olderIv = olderAtCurrentStrike
      ? average([olderAtCurrentStrike.ce.iv, olderAtCurrentStrike.pe.iv])
      : older.atmIv;
    return {
      seconds,
      available: true,
      spotChange: latest.spot - older.spot,
      straddleChange: latest.atmStraddle - olderStraddle,
      ivChange: latest.atmIv - olderIv,
      pcrChange: latest.pcr - older.pcr,
      callOiChange: latest.callOi - older.callOi,
      putOiChange: latest.putOi - older.putOi
    };
  }

  function emptyMetrics(seconds) {
    return {
      seconds,
      available: false,
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
    if (!seconds) {
      const opening = state.history[0];
      if (state.recorder.configured && !isOpeningSnapshot(opening)) return null;
      return opening;
    }
    const latest = lastSnapshot();
    const toleranceMs = 45 * 1000;
    const requiredSpanMs = seconds * 1000;
    if (!latest || latest.time - state.history[0].time < requiredSpanMs - toleranceMs) return null;
    const target = latest.time - requiredSpanMs;
    const nearest = state.history.reduce((best, snapshot) => {
      const distance = Math.abs(snapshot.time - target);
      if (!best || distance < best.distance) return { snapshot, distance };
      return best;
    }, null);
    return nearest && nearest.distance <= toleranceMs ? nearest.snapshot : null;
  }

  function isOpeningSnapshot(snapshot) {
    if (!snapshot) return false;
    const parts = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(snapshot.time)).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return minute >= 9 * 60 + 15 && minute <= 9 * 60 + 18;
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
    if (instrumentKey.includes("SENSEX")) return "SENSEX";
    if (instrumentKey.includes("Bank")) return "BANKNIFTY";
    if (instrumentKey.includes("Fin")) return "FINNIFTY";
    return "NIFTY";
  }

  function calibrationFingerprint(snapshot) {
    const atmIndex = snapshot.rows.findIndex((row) => row.strike === snapshot.atmStrike);
    const nearby = snapshot.rows.slice(Math.max(0, atmIndex - 1), atmIndex + 2);
    return [
      price(snapshot.spot),
      price(snapshot.atmStraddle),
      price(snapshot.atmIv, 3),
      snapshot.callOi,
      snapshot.putOi,
      ...nearby.flatMap((row) => [
        row.strike,
        price(row.ce.ltp), row.ce.oi, row.ce.volume,
        price(row.pe.ltp), row.pe.oi, row.pe.volume
      ])
    ].join("|");
  }

  function findOutcomeSnapshot(targetTime) {
    const candidates = state.history.filter((snapshot) => (
      snapshot.source === "live"
      && snapshot.time >= targetTime
      && snapshot.time <= targetTime + OUTCOME_TOLERANCE_MS
      && isMarketSessionIst(snapshot.time)
    ));
    return candidates.sort((a, b) => Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime))[0] || null;
  }

  function isMarketSessionIst(time) {
    const parts = istParts(time);
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
    const minute = parts.hour * 60 + parts.minute;
    return minute >= 9 * 60 + 15 && minute <= 15 * 60 + 30;
  }

  function istSessionDate(time) {
    const parts = istParts(time);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }

  function istParts(time) {
    const values = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    }).formatToParts(new Date(time)).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      weekday: values.weekday
    };
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

  function median(values) {
    const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!filtered.length) return 0;
    const middle = Math.floor(filtered.length / 2);
    return filtered.length % 2 ? filtered[middle] : (filtered[middle - 1] + filtered[middle]) / 2;
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
