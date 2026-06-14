(function () {
  const WINDOWS = [
    { key: "60", label: "1m", seconds: 60 },
    { key: "180", label: "3m", seconds: 180 },
    { key: "300", label: "5m", seconds: 300 },
    { key: "600", label: "10m", seconds: 600 },
    { key: "900", label: "15m", seconds: 900 },
    { key: "1800", label: "30m", seconds: 1800 },
    { key: "open", label: "Open", seconds: null }
  ];
  const CALIBRATION_VERSION = 3;
  const CALIBRATION_INTERVAL_MS = 30 * 1000;
  const SIGNAL_COOLDOWN_MS = 5 * 60 * 1000;
  const OUTCOME_TOLERANCE_MS = 45 * 1000;
  const API_TIMEOUT_MS = 12 * 1000;
  const EVENT_TOAST_MS = 60 * 1000;
  const EVENT_STORAGE_VERSION = 2;
  const EVENT_MAX_ITEMS = 80;
  const WALL_SCAN_STRIKES = 11;
  const IMMEDIATE_WALL_STRIKES = 11;
  const MAX_CONFIRMED_RANGE_POINTS = 100;
  const STRUCTURE_WINDOWS = [
    { key: "open", label: "Open", seconds: null },
    { key: "300", label: "5m", seconds: 300 },
    { key: "600", label: "10m", seconds: 600 },
    { key: "900", label: "15m", seconds: 900 },
    { key: "1800", label: "30m", seconds: 1800 }
  ];

  const state = {
    history: [],
    candles5m: [],
    paused: false,
    timer: null,
    sessionHydrated: false,
    stable: {
      key: null,
      since: null,
      confirmations: 0
    },
    signalStartSnapshot: null,
    structureRead: null,
    resistanceMemory: null,
    resistanceMemoryReason: "Loading five-session DB history",
    resistanceMemoryKey: null,
    resistanceMemoryLastChecked: 0,
    nearestExpiry: null,
    fifteenOutlook: null,
    outlookLastBucket: null,
    sessionPlaybook: null,
    playbookLastChecked: 0,
    eventTape: freshEventTapeState(),
    structureStability: {
      key: null,
      since: null,
      windows: 0,
      lastWindowEnd: null
    },
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
    await loadSessionPlaybook();
    scheduleNext();
  }

  function bindElements() {
    [
      "sourceLine", "recorderStatus", "refreshButton", "pauseButton", "symbolSelect", "expiryInput",
      "activeWindow", "refreshInterval", "marketStructureCard", "structureHeadline", "structureOrigin",
      "structureState", "structureLocation", "structureQualification", "structureAnalytics", "structureTable", "structureEvidence", "structureDecision",
      "expectedMoveShell", "expectedMoveLower", "expectedMoveUpper", "expectedMoveLowerRead", "expectedMoveUpperRead", "expectedMoveMeta",
      "fifteenOutlook", "outlookState", "outlookStage", "outlookAgreement", "outlookAgreementRead",
      "outlookTarget", "outlookTargetRead", "outlookInvalidation", "outlookInvalidationRead", "outlookGates",
      "structureLevels", "structureStability", "pressureHeadline", "pressureVerdict", "pressureMetrics",
      "pressureNarrative", "matrixTable",
      "exportCalibration", "clearCalibration", "calibrationGrid", "outcomeTable", "sessionMemoryCard",
      "memoryHeadline", "memoryMeta", "memoryStatus", "memoryLearning", "memoryMapTitle",
      "memoryHistory", "memoryScenarios", "memoryFooter", "eventCenterButton", "eventUnreadCount",
      "resistanceMemoryCard", "resistanceMemoryHeadline", "resistanceMemoryMeta", "resistanceMemoryState",
      "resistanceMemoryStrip", "resistanceMemoryGrid", "resistanceMemoryTimeline", "resistanceMemoryVerdict",
      "resistanceMemoryMeaning", "resistanceMemoryInvalidation",
      "eventToastStack", "eventDrawerBackdrop", "eventDrawer", "eventDrawerClose", "eventDrawerSummary", "eventTape"
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
    el.exportCalibration.addEventListener("click", exportCalibration);
    el.clearCalibration.addEventListener("click", clearCalibration);
    el.eventCenterButton.addEventListener("click", openEventDrawer);
    el.eventDrawerClose.addEventListener("click", closeEventDrawer);
    el.eventDrawerBackdrop.addEventListener("click", closeEventDrawer);
    el.symbolSelect.addEventListener("change", async () => {
      localStorage.setItem("instrument_key", el.symbolSelect.value);
      resetSessionState();
      await loadExpiries();
      await hydrateSessionHistory();
      await refresh();
      await loadSessionPlaybook();
      scheduleNext();
    });
    el.expiryInput.addEventListener("change", async () => {
      localStorage.setItem("expiry_date", el.expiryInput.value);
      resetSessionState();
      await hydrateSessionHistory();
      await refresh();
      await loadSessionPlaybook();
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
    state.sessionHydrated = false;
    state.stable = { key: null, since: null, confirmations: 0 };
    state.structureRead = null;
    state.resistanceMemory = null;
    state.resistanceMemoryReason = "Loading five-session DB history";
    state.resistanceMemoryKey = null;
    state.resistanceMemoryLastChecked = 0;
    state.fifteenOutlook = null;
    state.outlookLastBucket = null;
    state.sessionPlaybook = null;
    state.playbookLastChecked = 0;
    state.eventTape = freshEventTapeState();
    state.structureStability = { key: null, since: null, windows: 0, lastWindowEnd: null };
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
      const liveCandles = normalizeFiveMinuteCandles(payload.candles5m, snapshot.time);
      if (liveCandles.length) state.candles5m = liveCandles;
      if (payload.expiry && payload.expiry !== el.expiryInput.value) {
        ensureExpiryOption(payload.expiry);
        el.expiryInput.value = payload.expiry;
        localStorage.setItem("expiry_date", payload.expiry);
      }
      addSnapshot(snapshot);
      updateRecorderFromSave(payload.recorder, snapshot.time);
      render();
      maybeLoadResistanceMemory(snapshot);
      maybeRefreshSessionPlaybook(snapshot.time);
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

  async function loadResistanceMemory() {
    const latest = lastSnapshot();
    if (!latest || !latest.expiry || latest.expiry === "auto") return;
    const step = Math.max(1, inferStrikeStep(latest.rows));
    const key = `${latest.instrumentKey}:${latest.expiry}:${Math.round(latest.spot / step)}`;
    state.resistanceMemoryKey = key;
    state.resistanceMemoryLastChecked = Date.now();
    try {
      const params = new URLSearchParams({
        instrument_key: latest.instrumentKey,
        expiry_date: latest.expiry,
        spot: String(latest.spot)
      });
      const response = await fetch(`/api/session/resistance-memory?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || payload.reason || "Unable to load resistance memory");
      state.resistanceMemory = payload.ready ? payload.memory : null;
      state.resistanceMemoryReason = payload.reason || "";
    } catch (error) {
      state.resistanceMemory = null;
      state.resistanceMemoryReason = error.name === "TimeoutError" ? "Resistance memory request timed out" : error.message;
    }
    renderResistanceMemory(latest);
  }

  function maybeLoadResistanceMemory(latest) {
    const step = Math.max(1, inferStrikeStep(latest.rows));
    const key = `${latest.instrumentKey}:${latest.expiry}:${Math.round(latest.spot / step)}`;
    if (state.resistanceMemoryKey === key && Date.now() - state.resistanceMemoryLastChecked < 5 * 60 * 1000) return;
    loadResistanceMemory();
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
      const response = await fetch(`/api/session/history?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      const payload = await response.json();
      if (!response.ok) {
        updateRecorderStatus({ configured: payload.configured, message: payload.error });
        throw new Error(payload.error || "Unable to restore session history");
      }

      state.history = [];
      (payload.snapshots || []).forEach((storedPayload) => {
        addSnapshot(normalizeSnapshot(storedPayload));
      });
      state.candles5m = normalizeFiveMinuteCandles(payload.candles5m, Date.now());
      state.sessionHydrated = state.history.length > 0;
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
        message: error.name === "TimeoutError" ? "Database history request timed out" : error.message
      });
    }
  }

  async function loadSessionPlaybook() {
    state.playbookLastChecked = Date.now();
    try {
      const params = new URLSearchParams({ instrument_key: el.symbolSelect.value });
      const response = await fetch(`/api/session/playbook?${params.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load session playbook");
      state.sessionPlaybook = payload.ready ? payload.playbook : null;
      renderSessionPlaybook(payload.reason || "");
    } catch (error) {
      state.sessionPlaybook = null;
      renderSessionPlaybook(error.name === "TimeoutError" ? "Playbook request timed out" : error.message);
    }
  }

  function maybeRefreshSessionPlaybook(time) {
    if (isMarketSessionIst(time)) return;
    if (Date.now() - state.playbookLastChecked < 5 * 60 * 1000) return;
    loadSessionPlaybook();
  }

  function renderSessionPlaybook(reason = "") {
    const playbook = state.sessionPlaybook;
    if (!playbook) {
      el.memoryHeadline.textContent = "Waiting for a completed DB session";
      el.memoryMeta.textContent = reason || "Exact post-market learning will appear after the session closes.";
      el.memoryStatus.textContent = "BUILDING";
      el.memoryStatus.className = "memory-status building";
      el.memoryLearning.innerHTML = [
        ["Today learned", "Completed session required"],
        ["Why it moved", "Exact wall flow required"],
        ["What was not proven", "No inference yet"]
      ].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
      el.memoryScenarios.innerHTML = "";
      el.memoryHistory.textContent = "Historical memory building";
      el.memoryFooter.textContent = "No direction is assigned before fresh 5m OI confirms or rejects the inherited levels.";
      return;
    }

    const closing = playbook.closing;
    const memory = playbook.historicalMemory;
    const quality = playbook.dataQuality;
    el.memoryHeadline.textContent = `${playbook.sessionDate} close · ${price(closing.support.strike, 0)} support · ${price(closing.resistance.strike, 0)} resistance`;
    const gapText = quality.missingBuckets
      ? `${quality.missingBuckets} missing 5m buckets ignored · longest ${quality.longestGapMinutes}m`
      : "no missing 5m buckets";
    el.memoryMeta.textContent = `${quality.exactFiveMinuteSnapshots} observed 5m snapshots · ${quality.observedCoveragePct}% coverage · ${gapText} · expiry ${playbook.expiryDate}`;
    const memoryStatus = quality.status === "PARTIAL" ? "PARTIAL DATA" : quality.status === "GAP-AWARE" ? "GAP-AWARE" : memory.evidence;
    el.memoryStatus.textContent = memoryStatus;
    el.memoryStatus.className = `memory-status ${memoryStatus === "CALIBRATABLE" ? "ready" : memoryStatus === "GAP-AWARE" ? "gap-aware" : "building"}`;
    el.memoryLearning.innerHTML = [
      ["Today learned", playbook.story.learning],
      ["Why it moved", playbook.story.driver],
      ["What was not proven", playbook.story.failed]
    ].map(([label, value]) => `
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
    el.memoryMapTitle.textContent = closing.confirmedRange
      ? `Actual choppy enclosure ${price(closing.confirmedRange.low, 0)}–${price(closing.confirmedRange.high, 0)} · ${price(closing.confirmedRange.width, 0)} pts`
      : "No choppy range pre-assigned · opening OI must establish one";
    el.memoryHistory.textContent = `${memory.exactMatchCount} exact pattern match${memory.exactMatchCount === 1 ? "" : "es"} / ${memory.reviewedSessions} stored sessions`;
    el.memoryScenarios.innerHTML = playbook.scenarios.map((scenario) => `
      <article class="memory-scenario ${scenario.key}">
        <span>${escapeHtml(scenario.zone)}</span>
        <strong>${escapeHtml(scenario.title)}</strong>
        <p>${escapeHtml(scenario.read)}</p>
        <dl>
          <dt>Activate</dt><dd>${escapeHtml(scenario.activation)}</dd>
          <dt>Invalid</dt><dd>${escapeHtml(scenario.invalidation)}</dd>
        </dl>
      </article>
    `).join("");
    const matchDates = memory.exactMatchDates.length ? ` Exact prior dates: ${memory.exactMatchDates.join(", ")}.` : " No exact prior fingerprint is stored yet.";
    const legacyNote = memory.excludedLegacySessions ? ` ${memory.excludedLegacySessions} older-formula session${memory.excludedLegacySessions === 1 ? " was" : "s were"} excluded from exact matching.` : "";
    const gapRule = quality.status === "GAP-AWARE" ? " Missing intervals were excluded from deltas and range detection; no values were filled or interpolated." : "";
    const majorContext = closing.majorSupport && closing.majorResistance
      ? ` Major walls: PE ${price(closing.majorSupport.strike, 0)}, CE ${price(closing.majorResistance.strike, 0)}.`
      : "";
    el.memoryFooter.textContent = `Formula ${playbook.formulaVersion}. Levels use the same nearest-11-strike max-OI rule as Market Structure Intelligence.${majorContext}${gapRule}${matchDates}${legacyNote}`;
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
    const checkingMessages = ["Checking database", "Loading session", "Waiting for expiry"];
    const checking = configured === null && checkingMessages.includes(message);
    const closed = configured === true && message === "Outside NSE/BSE cash session";
    const ready = configured === true && !active;
    const unavailable = configured === null && !checking;
    el.recorderStatus.className = `recorder-pill ${active || ready ? "active" : configured === false || unavailable ? "off" : ""}`;
    el.recorderStatus.textContent = active
      ? `DB ${snapshotCount} · ${formatTime(new Date(lastSavedAt).getTime())}`
      : configured === false
        ? "DB setup needed"
        : closed
          ? "DB ready · market closed"
          : ready
            ? "DB ready · no data today"
            : checking
              ? "DB checking"
              : "DB unavailable";
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
      state.nearestExpiry = expiries[0];
      const selected = expiries.includes(preferred) ? preferred : expiries[0];
      el.expiryInput.innerHTML = expiries.map((expiry, index) => (
        `<option value="${expiry}">${expiry}${index === 0 ? " · nearest" : ""}</option>`
      )).join("");
      el.expiryInput.value = selected;
      localStorage.setItem("expiry_date", selected);
      setSource(`${payload.source === "live" ? "Live" : "Demo"} expiries loaded · ${selected}`);
    } catch (error) {
      state.nearestExpiry = null;
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
    const previousClose = number(payload.underlying && payload.underlying.previousClose)
      || (state.history[0] && state.history[0].previousClose)
      || 0;

    return {
      source: payload.source || "demo",
      time: generatedAt,
      expiry: payload.expiry || el.expiryInput.value,
      instrumentKey: payload.instrumentKey || el.symbolSelect.value,
      spot,
      dayOpen,
      previousClose,
      future: normalizeFuture(payload.future),
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

  function normalizeFuture(future) {
    if (!future || typeof future !== "object") return null;
    const volume = number(future.volume);
    const oi = number(future.oi);
    if (!future.instrumentKey && !volume && !oi) return null;
    return {
      instrumentKey: future.instrumentKey || future.instrument_key || "",
      symbol: future.symbol || future.tradingSymbol || future.trading_symbol || "Index future",
      expiry: future.expiry || "",
      ltp: number(future.ltp || future.lastPrice || future.last_price),
      volume,
      oi,
      timestamp: future.timestamp || null
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
      mid,
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
      .slice(-75);
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
    const structureRead = stabilizeStructureRead(buildMarketStructureRead(latest), latest);
    state.structureRead = structureRead;
    const calibrationSnapshotAdded = recordCalibrationSnapshot(latest, active, structureRead);
    if (calibrationSnapshotAdded) {
      createStructureCalibrationSignal(structureRead, latest);
      updateSignalOutcomes(latest);
    }
    saveCalibrationState();
    renderMarketStructure(structureRead);
    renderFifteenMinuteOutlook(latest, structureRead);
    renderResistanceMemory(latest);
    updateStructureEventTape(structureRead, latest);
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

  function renderMarketStructure(read) {
    el.marketStructureCard.dataset.tone = read.tone;
    el.structureHeadline.textContent = read.headline;
    el.structureOrigin.textContent = read.origin;
    el.structureState.className = `structure-state ${read.tone}`;
    el.structureState.textContent = read.state;
    el.structureLocation.innerHTML = [
      `<span>Spot <strong>${price(read.spot)}</strong></span>`,
      `<span>Immediate Support <strong>${read.support ? `${price(read.support, 0)} · ${compact(read.supportWall.oi)}` : "Building"}</strong></span>`,
      `<span>Immediate Resistance <strong>${read.resistance ? `${price(read.resistance, 0)} · ${compact(read.resistanceWall.oi)}` : "Building"}</strong></span>`,
      `<span>Major OI Walls <strong>PE ${read.majorSupportWall ? price(read.majorSupportWall.strike, 0) : "--"} · CE ${read.majorResistanceWall ? price(read.majorResistanceWall.strike, 0) : "--"}</strong></span>`,
      `<span>${read.microRange ? `Range <strong>${price(read.microRange.width, 0)} pts · ${read.microRange.minutes}m</strong>` : "Range <strong>Not confirmed</strong>"}</span>`
    ].join("");
    renderExpectedMove(lastSnapshot(), read);
    renderStructureQualification(read);
    renderPressureResponse(read.pressure);
    renderStructureAnalytics(read);
    el.structureTable.innerHTML = `
      <div class="structure-table-head">
        <span>Contract</span>${STRUCTURE_WINDOWS.map((item) => `<span>${item.label}</span>`).join("")}
      </div>
      ${read.contracts.map(structureContractRow).join("")}
    `;
    el.structureEvidence.innerHTML = read.evidence.map((item) => `
      <div class="structure-evidence-item ${item.tone}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.value)}</strong>
      </div>
    `).join("");
    el.structureDecision.textContent = read.decision;
    el.structureLevels.textContent = read.trigger
      ? `Trigger ${price(read.trigger)} · Invalid ${price(read.invalidation)}`
      : "Trigger and invalidation will appear after a directional structure qualifies";
    el.structureStability.textContent = read.stability.windows
      ? `${read.stability.restored ? "DB restored · " : ""}Stable ${read.stability.windows} completed 5m window${read.stability.windows === 1 ? "" : "s"}`
      : "Completed 5m confirmation building";
  }

  function renderExpectedMove(latest, structureRead) {
    const expectedMoveApi = globalThis.ExpectedMove;
    const isCurrentExpiry = Boolean(state.nearestExpiry && latest.expiry === state.nearestExpiry);
    if (!expectedMoveApi || !isCurrentExpiry) {
      el.expectedMoveShell.dataset.tone = "building";
      el.expectedMoveLower.textContent = "--";
      el.expectedMoveUpper.textContent = "--";
      el.expectedMoveLowerRead.textContent = "Available only on the nearest current expiry";
      el.expectedMoveUpperRead.textContent = "Select the expiry marked nearest";
      el.expectedMoveMeta.textContent = `Current expiry only${state.nearestExpiry ? ` · ${state.nearestExpiry}` : " · expiry resolving"}`;
      return;
    }

    const opening = openingBaselineSnapshots(latest);
    const openingIv = opening.map((snapshot) => snapshot.atmIv).filter((value) => value > 0);
    if (opening.length < 3 || openingIv.length < 3) {
      el.expectedMoveShell.dataset.tone = "building";
      el.expectedMoveLower.textContent = "--";
      el.expectedMoveUpper.textContent = "--";
      el.expectedMoveLowerRead.textContent = "Need 3 exact 09:15–09:20 snapshots";
      el.expectedMoveUpperRead.textContent = "No later snapshot will replace the open baseline";
      el.expectedMoveMeta.textContent = `Building ${latest.expiry} one-session IV range`;
      return;
    }

    const sessionOpen = median(opening.map((snapshot) => snapshot.spot));
    const atmIv = median(openingIv);
    const move = expectedMoveApi.calculateSessionExpectedMove(sessionOpen, atmIv);
    if (!move) return;

    const step = inferStrikeStep(latest.rows);
    const lower = expectedMoveApi.classifyBoundary(move.lower, structureRead.support, step, "lower");
    const upper = expectedMoveApi.classifyBoundary(move.upper, structureRead.resistance, step, "upper");
    el.expectedMoveShell.dataset.tone = lower.state === "confluence" || upper.state === "confluence" ? "confluence" : "ready";
    el.expectedMoveLower.textContent = price(move.lower, 0);
    el.expectedMoveUpper.textContent = price(move.upper, 0);
    el.expectedMoveLowerRead.textContent = expectedBoundaryText(lower, structureRead.support, "lower");
    el.expectedMoveUpperRead.textContent = expectedBoundaryText(upper, structureRead.resistance, "upper");
    el.expectedMoveMeta.textContent = `${latest.expiry} · Open ${price(move.anchor, 0)} · ATM IV ${price(move.atmIvPct, 2)}% · ±${price(move.distance, 0)} pts · open × IV × √(1/365)`;
  }

  function expectedBoundaryText(read, wall, kind) {
    if (!wall || read.state === "unavailable") return `${kind === "upper" ? "CE resistance" : "PE support"} building`;
    const level = price(wall, 0);
    if (read.state === "confluence") {
      return kind === "upper"
        ? `${level} CE wall overlap · breakout needs withdrawal + 2 completed 5m closes above`
        : `${level} PE wall overlap · breakdown needs withdrawal + 2 completed 5m closes below`;
    }
    if (read.state === "wall-inside") {
      return kind === "upper"
        ? `${level} CE wall is inside the expected range · test may arrive before upper limit`
        : `${level} PE wall is inside the expected range · test may arrive before lower limit`;
    }
    return kind === "upper"
      ? `${level} CE wall is beyond the expected upper limit`
      : `${level} PE wall is beyond the expected lower limit`;
  }

  function currentExpectedMove(latest) {
    const api = globalThis.ExpectedMove;
    if (!api || !state.nearestExpiry || latest.expiry !== state.nearestExpiry) return null;
    const opening = openingBaselineSnapshots(latest);
    const openingIv = opening.map((snapshot) => snapshot.atmIv).filter((value) => value > 0);
    if (opening.length < 3 || openingIv.length < 3) return null;
    return api.calculateSessionExpectedMove(
      median(opening.map((snapshot) => snapshot.spot)),
      median(openingIv)
    );
  }

  function renderFifteenMinuteOutlook(latest, read) {
    const bucket = completedFiveMinuteBucket(latest.time);
    if (!state.fifteenOutlook || state.outlookLastBucket !== bucket) {
      state.fifteenOutlook = buildFifteenMinuteOutlook(latest, read);
      state.outlookLastBucket = bucket;
    }
    const outlook = state.fifteenOutlook;
    el.fifteenOutlook.dataset.tone = outlook.tone;
    el.outlookState.textContent = outlook.state;
    el.outlookStage.textContent = `${outlook.stage} · ${outlook.reason}`;
    el.outlookAgreement.textContent = `${outlook.agreement} / ${outlook.total}`;
    el.outlookAgreementRead.textContent = outlook.agreementRead;
    el.outlookTarget.textContent = outlook.target ? price(outlook.target, 0) : outlook.rangeText || "--";
    el.outlookTargetRead.textContent = outlook.targetRead;
    el.outlookInvalidation.textContent = outlook.invalidation ? price(outlook.invalidation, 0) : "--";
    el.outlookInvalidationRead.textContent = outlook.invalidationRead;
    el.outlookGates.innerHTML = outlook.gates.map((gate) => `
      <span class="${gate.pass ? "pass" : "fail"}" title="${escapeHtml(gate.detail)}">${escapeHtml(gate.label)} <b>${gate.pass ? "✓" : "×"}</b></span>
    `).join("");
  }

  function buildFifteenMinuteOutlook(latest, read) {
    const classifier = globalThis.FifteenMinuteOutlook;
    const currentExpiry = Boolean(state.nearestExpiry && latest.expiry === state.nearestExpiry);
    const exact15m = getOlderSnapshot(900);
    const pressure = read.pressure && read.pressure.eventData;
    const support = read.contracts.find((item) => item.strike === read.support && item.side === "PE");
    const resistance = read.contracts.find((item) => item.strike === read.resistance && item.side === "CE");
    const atmCe = read.contracts.find((item) => item.strike === latest.atmStrike && item.side === "CE");
    const atmPe = read.contracts.find((item) => item.strike === latest.atmStrike && item.side === "PE");
    const ceFive = atmCe && atmCe.windows["300"];
    const peFive = atmPe && atmPe.windows["300"];
    const resistanceFive = resistance && resistance.windows["300"];
    const supportFive = support && support.windows["300"];
    const upFlow = Boolean(pressure && pressure.direction === "up" && pressure.aligned >= 2 && !pressure.oppositeMove);
    const downFlow = Boolean(pressure && pressure.direction === "down" && pressure.aligned >= 2 && !pressure.oppositeMove);
    const upPremium = Boolean(ceFive && ceFive.available && ceFive.materialResidual && ceFive.residual > 0);
    const downPremium = Boolean(peFive && peFive.available && peFive.materialResidual && peFive.residual > 0);
    const upResponse = Boolean(pressure && pressure.direction === "up" && pressure.released);
    const downResponse = Boolean(pressure && pressure.direction === "down" && pressure.released);
    const upWallExit = wallWithdrawalGate(resistanceFive, "CE");
    const downWallExit = wallWithdrawalGate(supportFive, "PE");
    const upPath = upWallExit.pass || Boolean(pressure && pressure.direction === "up" && pressure.pathLoadRatio !== null && pressure.pathLoadRatio < 1);
    const downPath = downWallExit.pass || Boolean(pressure && pressure.direction === "down" && pressure.pathLoadRatio !== null && pressure.pathLoadRatio < 1);
    const upGates = [
      outlookGate("OI flow", upFlow, pressure ? `${pressure.aligned}/${pressure.total} material contracts` : "No directional inventory breadth"),
      outlookGate("Premium", upPremium, premiumGateText(ceFive, "CE")),
      outlookGate("Response", upResponse, responseGateText(pressure, "up")),
      outlookGate("Path", upPath, upWallExit.pass ? upWallExit.detail : pathGateText(pressure, "up"))
    ];
    const downGates = [
      outlookGate("OI flow", downFlow, pressure ? `${pressure.aligned}/${pressure.total} material contracts` : "No directional inventory breadth"),
      outlookGate("Premium", downPremium, premiumGateText(peFive, "PE")),
      outlookGate("Response", downResponse, responseGateText(pressure, "down")),
      outlookGate("Path", downPath, downWallExit.pass ? downWallExit.detail : pathGateText(pressure, "down"))
    ];
    const rangeLock = Boolean(read.microRange && read.decision.includes("RANGE")) || read.decision.includes("TWO-SIDED WRITING");
    const ready = Boolean(classifier && currentExpiry && exact15m && openingBaselineSnapshots(latest).length >= 3);
    const reason = !currentExpiry
      ? "Nearest current expiry required"
      : !exact15m
        ? "Exact 15m DB history building"
        : "Opening baseline building";
    const classified = classifier.classifyFifteenMinuteOutlook({
      ready,
      reason,
      upGates,
      downGates,
      rangeLock,
      rangeText: read.microRange ? `${price(read.microRange.low, 0)}–${price(read.microRange.high, 0)} containment` : "Two-sided option writing",
      upText: "Inventory, premium, response, and path checked without weights",
      downText: "Inventory, premium, response, and path checked without weights",
      mixedText: "No three-group directional majority"
    });
    const activeGates = classified.direction === "up" ? upGates : classified.direction === "down" ? downGates : selectStrongerGates(upGates, downGates);
    const expected = currentExpectedMove(latest);
    const target = outlookTarget(classified.direction, latest, read, expected);
    const step = inferStrikeStep(latest.rows);
    const invalidation = classified.direction === "up"
      ? read.invalidation || (read.support ? read.support - step / 2 : 0)
      : classified.direction === "down"
        ? read.invalidation || (read.resistance ? read.resistance + step / 2 : 0)
        : 0;
    return {
      ...classified,
      gates: activeGates,
      agreementRead: classified.direction === "range" ? "Two-sided containment" : `${classified.stage} · no weighted score`,
      target,
      rangeText: classified.direction === "range" && read.microRange ? `${price(read.microRange.low, 0)}–${price(read.microRange.high, 0)}` : "",
      targetRead: outlookTargetRead(classified.direction, target, latest, read, expected),
      invalidation,
      invalidationRead: classified.direction === "up" || classified.direction === "down"
        ? "Direction fails beyond this structure level"
        : "No directional invalidation until 3/4 agreement"
    };
  }

  function completedFiveMinuteBucket(time) {
    return Math.floor(time / (5 * 60 * 1000)) - 1;
  }

  function outlookGate(label, pass, detail) {
    return { key: label.toLowerCase().replace(/\s+/g, "-"), label, pass, detail };
  }

  function wallWithdrawalGate(windowRead, side) {
    if (!windowRead || !windowRead.available) return { pass: false, detail: `${side} wall history building` };
    const inventory = inventoryWindowRead(windowRead, side);
    const pass = windowRead.materialOi && windowRead.oiChange < 0 && inventory.clean
      && (inventory.type === "covering" || inventory.type === "long-unwind");
    return { pass, detail: `${side} wall ${inventory.clean ? inventory.shortLabel : "mixed"} · OI ${compact(windowRead.oiChange)}` };
  }

  function premiumGateText(windowRead, side) {
    if (!windowRead || !windowRead.available) return `${side} 5m premium history building`;
    return `${side} adjusted residual ${signed(windowRead.residual)}${windowRead.materialResidual ? " material" : " not material"}`;
  }

  function responseGateText(pressure, direction) {
    if (!pressure || pressure.direction !== direction) return "Spot release not aligned";
    return `${signed(pressure.spotMove)} pts · ${pressure.responseRatio === null ? "normal building" : `${Math.abs(pressure.responseRatio).toFixed(2)}× session-normal`}`;
  }

  function pathGateText(pressure, direction) {
    if (!pressure || pressure.direction !== direction || pressure.pathLoadRatio === null) return "Opposing path unresolved";
    return `${pressure.pathLoadRatio.toFixed(2)}× local OI toward ${pressure.pathBlocker ? price(pressure.pathBlocker, 0) : "next wall"}`;
  }

  function selectStrongerGates(up, down) {
    return up.filter((gate) => gate.pass).length >= down.filter((gate) => gate.pass).length ? up : down;
  }

  function outlookTarget(direction, latest, read, expected) {
    if (direction === "up") {
      const candidates = [read.resistance, expected && expected.upper].filter((value) => value > latest.spot);
      return candidates.length ? Math.min(...candidates) : 0;
    }
    if (direction === "down") {
      const candidates = [read.support, expected && expected.lower].filter((value) => value > 0 && value < latest.spot);
      return candidates.length ? Math.max(...candidates) : 0;
    }
    return 0;
  }

  function outlookTargetRead(direction, target, latest, read, expected) {
    if (!direction || direction === "range") return read.microRange ? "Confirmed 5m range boundaries" : "Path unresolved";
    if (!target) return "No valid wall or expected boundary ahead";
    const expectedLevel = direction === "up" ? expected && expected.upper : expected && expected.lower;
    const wall = direction === "up" ? read.resistance : read.support;
    if (expectedLevel && wall && Math.abs(expectedLevel - wall) <= inferStrikeStep(latest.rows) / 2) {
      return `${direction === "up" ? "CE ceiling" : "PE floor"} + expected-limit confluence`;
    }
    return target === wall ? `Immediate ${direction === "up" ? "CE resistance" : "PE support"} test` : "Expected-move boundary test";
  }

  function renderResistanceMemory(latest) {
    const memory = state.resistanceMemory;
    if (!memory) {
      el.resistanceMemoryCard.dataset.tone = "building";
      el.resistanceMemoryHeadline.textContent = "Five-session resistance memory unavailable";
      el.resistanceMemoryMeta.textContent = state.resistanceMemoryReason || "Waiting for completed DB sessions";
      el.resistanceMemoryState.textContent = "BUILDING";
      el.resistanceMemoryState.className = "resistance-memory-state building";
      el.resistanceMemoryStrip.innerHTML = ["Level", "Tests", "Accepted breaks", "Distance"]
        .map((label) => `<span>${label} <strong>--</strong></span>`).join("");
      el.resistanceMemoryGrid.innerHTML = `
        <section><span>Historical ceiling</span><strong>Exact sessions required</strong><em>No level is fabricated without DB tests</em></section>
        <section><span>Current CE inventory</span><strong>Waiting for level</strong><em>Cross-expiry OI will never be added</em></section>
        <section><span>Defence effectiveness</span><strong>Unproven</strong><em>Writing requires an actual spot rejection</em></section>
      `;
      el.resistanceMemoryTimeline.innerHTML = "";
      el.resistanceMemoryVerdict.textContent = "WAIT FOR HISTORICAL MEMORY";
      el.resistanceMemoryMeaning.textContent = "A high CE OI value alone is not treated as resistance.";
      el.resistanceMemoryInvalidation.textContent = "Accepted break = two consecutive completed 5m closes above the level.";
      return;
    }

    const read = buildCurrentResistanceRead(latest, memory);
    el.resistanceMemoryCard.dataset.tone = read.tone;
    el.resistanceMemoryHeadline.textContent = `${memory.lookbackSessions}D CEILING · ${price(memory.level, 0)} · ${read.headline}`;
    const expiryText = memory.expiryContinuity === "same-expiry"
      ? `Same-expiry OI continuity from ${memory.sameExpiryPreviousClose.sessionDate}`
      : "Expiry reset · historical OI is not added to current expiry";
    el.resistanceMemoryMeta.textContent = `${expiryText} · historical spot acceptance remains comparable`;
    el.resistanceMemoryState.textContent = read.state;
    el.resistanceMemoryState.className = `resistance-memory-state ${read.tone}`;
    el.resistanceMemoryStrip.innerHTML = [
      `<span>Level <strong>${price(memory.level, 0)}</strong></span>`,
      `<span>Historical <strong>${memory.defendedSessions}/${memory.testedSessions} defended · ${memory.totalTests} tests</strong></span>`,
      `<span>Accepted breaks <strong>${memory.acceptedBreakSessions}/${memory.lookbackSessions} sessions</strong></span>`,
      `<span>Distance <strong>${signed(memory.level - latest.spot)} pts</strong></span>`
    ].join("");
    el.resistanceMemoryGrid.innerHTML = `
      <section class="${memory.acceptedBreakSessions ? "warn" : "positive"}">
        <span>Historical ceiling</span>
        <strong>${memory.testedSessions} tested session${memory.testedSessions === 1 ? "" : "s"} · ${memory.defendedSessions} defended</strong>
        <em>Last test ${memory.lastTestDate || "--"} · acceptance ${memory.acceptedBreakSessions ? "observed" : "not observed"}</em>
      </section>
      <section class="${read.inventoryTone}">
        <span>Current ${price(memory.level, 0)} CE inventory</span>
        <strong>${escapeHtml(read.oiHeadline)}</strong>
        <em>${escapeHtml(read.oiWindows)}</em>
      </section>
      <section class="${read.effectTone}">
        <span>Defence effectiveness</span>
        <strong>${escapeHtml(read.effectHeadline)}</strong>
        <em>${escapeHtml(read.effectDetail)}</em>
      </section>
    `;
    el.resistanceMemoryTimeline.innerHTML = memory.sessionEvidence.map((session) => {
      const stateLabel = session.acceptedBreak
        ? "Accepted above"
        : session.rejectedBreak
          ? "False break rejected"
          : session.tests
            ? `${session.tests} test${session.tests === 1 ? "" : "s"} defended`
            : "Not tested";
      const tone = session.acceptedBreak ? "negative" : session.tests ? "positive" : "neutral";
      return `<span class="${tone}"><b>${escapeHtml(session.date)}</b>${escapeHtml(stateLabel)}</span>`;
    }).join("");
    el.resistanceMemoryVerdict.textContent = read.verdict;
    el.resistanceMemoryMeaning.textContent = read.meaning;
    el.resistanceMemoryInvalidation.textContent = `Accepted breakout only after 2 consecutive completed 5m closes above ${price(memory.level, 0)}.`;
  }

  function buildCurrentResistanceRead(latest, memory) {
    const level = memory.level;
    const row = latest.rows.find((item) => item.strike === level);
    if (!row) return resistanceRead("LEVEL OUTSIDE CURRENT CHAIN", "Historical level is not present in the current option chain", "neutral");
    const opening = openingBaselineSnapshots(latest);
    const windows = {
      open: buildStructureWindow(latest, opening, level, "CE", null),
      "300": buildStructureWindow(latest, opening, level, "CE", 300),
      "600": buildStructureWindow(latest, opening, level, "CE", 600),
      "900": buildStructureWindow(latest, opening, level, "CE", 900),
      "1800": buildStructureWindow(latest, opening, level, "CE", 1800)
    };
    const inventoryReads = ["300", "600", "900"].map((key) => ({
      key,
      window: windows[key],
      inventory: windows[key] && windows[key].available ? inventoryWindowRead(windows[key], "CE") : null
    }));
    const writingWindows = inventoryReads.filter((item) => item.inventory && item.inventory.clean && item.inventory.type === "writing");
    const coveringWindows = inventoryReads.filter((item) => item.inventory && item.inventory.clean && item.inventory.type === "covering");
    const test = currentResistanceTest(latest, level, memory.step);
    const distance = level - latest.spot;
    const near = Math.abs(distance) <= memory.step / 2;
    const approaching = distance >= 0 && distance <= memory.step;
    const recent = windows["300"];
    const open = windows.open;
    const previous = memory.expiryContinuity === "same-expiry" ? memory.sameExpiryPreviousClose : null;
    const previousText = previous ? `Prev close ${compact(previous.ceOi)}` : "Prev OI reset";
    const openText = open.available ? `Open ${compact(open.oiChange)} (${signedPercent(open.oiChangePct)})` : "Open building";
    const recentText = recent.available ? `5m ${compact(recent.oiChange)} (${signedPercent(recent.oiChangePct)})` : "5m building";
    const oiHeadline = `OI ${compact(row.ce.oi)} · ${previousText} · ${openText}`;
    const oiWindows = `${recentText} · ${windowInventoryLabel(inventoryReads, "600", "10m")} · ${windowInventoryLabel(inventoryReads, "900", "15m")}`;
    const persistence = writingWindows.length
      ? `${writingWindows.map((item) => `${Number(item.key) / 60}m`).join("/")} writing-like`
      : coveringWindows.length
        ? `${coveringWindows.map((item) => `${Number(item.key) / 60}m`).join("/")} short-covering-like`
        : "No persistent directional CE flow";
    const response = test.lastTestClose === null
      ? "No current-session test"
      : test.rejection
        ? `Rejected · spot ${signed(latest.spot - test.lastTestClose)} pts after latest test`
        : `No downside release · spot ${signed(latest.spot - test.lastTestClose)} pts after latest test`;

    let result;
    if (test.acceptedBreak) {
      result = resistanceRead("ACCEPTED BREAKOUT", "Two consecutive completed 5m closes accepted above the historical ceiling", "negative");
    } else if (test.breakCandidate) {
      result = resistanceRead("BREAK CANDIDATE", "One completed 5m close is above resistance; the second close decides acceptance", "warn");
    } else if (test.rejectedBreak && writingWindows.length) {
      result = resistanceRead("BREAKOUT REJECTED", "A close above failed, spot returned below, and CE writing-like flow reappeared", "positive");
    } else if (writingWindows.length >= 2 && test.rejection) {
      result = resistanceRead("RESISTANCE REINFORCED", "Persistent CE writing-like flow produced an actual downside spot response", "positive");
    } else if (writingWindows.length >= 2 && (near || test.tests > 0)) {
      result = resistanceRead("WRITING ABSORBED", "Persistent CE writing-like flow has not produced downside release; breakout risk is rising", "warn");
    } else if (coveringWindows.length && (near || approaching)) {
      result = resistanceRead("RESISTANCE WEAKENING", "CE short-covering-like flow is reducing resistance inventory near the ceiling", "negative");
    } else if (test.tests > 0 || near) {
      result = resistanceRead("RESISTANCE TESTING", "Spot is testing the historical ceiling; inventory persistence is not qualified yet", "warn");
    } else if (approaching) {
      result = resistanceRead("APPROACHING RESISTANCE", "Spot is within one strike of the historical ceiling", "neutral");
    } else {
      result = resistanceRead("HISTORICAL CEILING", "The level remains historical context until spot approaches it", "neutral");
    }
    return {
      ...result,
      headline: result.state,
      oiHeadline,
      oiWindows,
      inventoryTone: writingWindows.length ? "positive" : coveringWindows.length ? "negative" : "neutral",
      effectHeadline: `${persistence} · ${test.tests} current test${test.tests === 1 ? "" : "s"}`,
      effectDetail: `${response} · ${test.closesAbove} completed close${test.closesAbove === 1 ? "" : "s"} above`,
      effectTone: result.tone
    };
  }

  function resistanceRead(stateLabel, meaning, tone) {
    return { state: stateLabel, verdict: stateLabel, meaning, tone, headline: stateLabel, inventoryTone: "neutral", effectTone: tone };
  }

  function windowInventoryLabel(reads, key, label) {
    const item = reads.find((entry) => entry.key === key);
    if (!item || !item.window || !item.window.available) return `${label} building`;
    return `${label} ${compact(item.window.oiChange)} · ${item.inventory && item.inventory.clean ? item.inventory.shortLabel : "mixed"}`;
  }

  function currentResistanceTest(latest, level, step) {
    const source = state.candles5m.length ? state.candles5m : buildSnapshotFiveMinuteCandles(latest.time);
    const candles = source.filter((candle) => istSessionDate(candle.start) === istSessionDate(latest.time)).sort((a, b) => a.start - b.start);
    const approachFloor = level - step / 2;
    let tests = 0;
    let inTest = false;
    let closesAbove = 0;
    let acceptedBreak = false;
    let hadCloseAbove = false;
    let rejectedBreak = false;
    let lastTestClose = null;
    candles.forEach((candle, index) => {
      const previousClose = index ? candles[index - 1].close : candle.open;
      if (previousClose <= level && candle.high >= approachFloor && !inTest) {
        tests += 1;
        lastTestClose = candle.close;
        inTest = true;
      }
      if (candle.high < approachFloor) inTest = false;
      if (candle.close > level) {
        closesAbove += 1;
        hadCloseAbove = true;
        if (index && candles[index - 1].close > level) acceptedBreak = true;
      } else if (hadCloseAbove) {
        rejectedBreak = true;
      }
    });
    const latestClose = candles.length ? candles[candles.length - 1].close : latest.spot;
    return {
      tests,
      closesAbove,
      acceptedBreak,
      breakCandidate: hadCloseAbove && !acceptedBreak && latestClose > level,
      rejectedBreak: rejectedBreak && !acceptedBreak && latestClose <= level,
      lastTestClose,
      rejection: lastTestClose !== null && latestClose < lastTestClose && latestClose <= level
    };
  }

  function renderStructureQualification(read) {
    const support = qualifyStructureWall(read, "support");
    const resistance = qualifyStructureWall(read, "resistance");
    const pressure = read.pressure && read.pressure.eventData;
    const pressureTone = pressure
      ? pressure.oppositeMove ? "warn" : pressure.direction === "up" ? "positive" : "negative"
      : "neutral";
    const pressureStatus = pressure
      ? `${pressure.direction === "up" ? "Upside" : "Downside"} · ${pressure.aligned}/${pressure.total} aligned`
      : "Unproven";
    const pressureDetail = pressure
      ? `${read.pressure.verdict} · exact 5m flow`
      : read.pressure && read.pressure.headline
        ? read.pressure.headline
        : "Waiting for aligned OI and premium response";
    el.structureQualification.innerHTML = [
      qualificationCell("Support", support.status, support.detail, support.tone),
      qualificationCell("Current pressure", pressureStatus, pressureDetail, pressureTone),
      qualificationCell("Resistance", resistance.status, resistance.detail, resistance.tone)
    ].join("");
  }

  function qualificationCell(label, status, detail, tone) {
    return `
      <div class="${tone || "neutral"}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(status)}</strong>
        <em>${escapeHtml(detail)}</em>
      </div>
    `;
  }

  function qualifyStructureWall(read, kind) {
    const isSupport = kind === "support";
    const wall = isSupport ? read.supportWall : read.resistanceWall;
    const contract = read.contracts.find((item) => item.role.toLowerCase().includes(kind));
    if (!wall || !contract) return { status: "Building", detail: "Exact wall history needed", tone: "neutral" };
    const recent = contract.windows["300"];
    const stable = wall.confirmations >= 2;
    const recentInventory = recent && recent.available ? inventoryWindowRead(recent, contract.side) : null;
    const fresh = recentInventory && recentInventory.clean && recentInventory.type === "writing";
    const defended = isSupport ? read.spot >= wall.strike : read.spot <= wall.strike;
    const reference = getOlderSnapshot(300);
    const reacted = reference ? (isSupport ? read.spot > reference.spot : read.spot < reference.spot) : false;
    const passed = [stable, fresh, defended, reacted].filter(Boolean).length;
    const weakening = recent && recent.available && recent.materialOi && recent.oiChange < 0;
    const breached = !defended;
    const status = breached
      ? `Breached · ${passed}/4 evidence`
      : weakening
        ? `Weakening · ${passed}/4 evidence`
        : passed === 4
          ? "Qualified · 4/4 evidence"
          : `Building · ${passed}/4 evidence`;
    const freshText = recent && recent.available
      ? `5m ${compact(recent.oiChange)} (${signedPercent(recent.oiChangePct)}) · ${recentInventory && recentInventory.clean ? recentInventory.shortLabel : "mixed"}`
      : "5m building";
    return {
      status,
      detail: `${price(wall.strike, 0)} · ${wall.dominance.toFixed(2)}× local lead · ${freshText}`,
      tone: breached || weakening ? "negative" : passed === 4 ? (isSupport ? "positive" : "negative") : "warn"
    };
  }

  function renderStructureAnalytics(read) {
    const atmPe = read.contracts.find((item) => item.strike === lastSnapshot().atmStrike && item.side === "PE");
    const atmCe = read.contracts.find((item) => item.strike === lastSnapshot().atmStrike && item.side === "CE");
    const participation = buildParticipationRead(lastSnapshot());
    el.structureAnalytics.innerHTML = `
      ${premiumAttributionCell("ATM CE response", atmCe && atmCe.windows["300"], "CE")}
      ${premiumAttributionCell("ATM PE response", atmPe && atmPe.windows["300"], "PE")}
      <div class="structure-analytic participation ${participation.tone}">
        <span>Participation · ATM ±3</span>
        <strong>${escapeHtml(participation.optionText)}</strong>
        <em>${escapeHtml(participation.futureText)}</em>
      </div>
    `;
  }

  function premiumAttributionCell(label, windowRead, side) {
    if (!windowRead || !windowRead.available) {
      return `<div class="structure-analytic"><span>${label}</span><strong>Building</strong><em>Exact 5m Greek history needed</em></div>`;
    }
    const inventory = inventoryWindowRead(windowRead, side);
    const tone = windowRead.residual > 0 ? "positive" : windowRead.residual < 0 ? "negative" : "neutral";
    return `
      <div class="structure-analytic ${tone}">
        <span>${label}</span>
        <strong>Actual ${signed(windowRead.premiumChange)} · Expected ${signed(windowRead.expectedChange)}</strong>
        <em>Residual ${signed(windowRead.residual)} · ${escapeHtml(inventory.clean ? inventory.label : "No clean inferred flow")}</em>
      </div>
    `;
  }

  function buildParticipationRead(latest) {
    const snapshots = [0, 300, 600, 900, 1200].map((seconds) => (
      seconds === 0 ? latest : getOlderSnapshot(seconds)
    ));
    if (!snapshots[1]) {
      return {
        optionText: "Exact 5m volume history building",
        futureText: latest.future ? "Futures baseline building" : "Index futures feed unavailable",
        tone: "neutral"
      };
    }
    const step = inferStrikeStep(latest.rows);
    const strikes = latest.rows
      .filter((row) => Math.abs(row.strike - latest.atmStrike) <= step * 3)
      .map((row) => row.strike);
    const windows = snapshots.slice(0, -1).map((current, index) => {
      const reference = snapshots[index + 1];
      if (!current || !reference) return null;
      return {
        ce: optionVolumeDelta(current, reference, strikes, "CE"),
        pe: optionVolumeDelta(current, reference, strikes, "PE"),
        future: futureVolumeDelta(current, reference)
      };
    }).filter(Boolean);
    const current = windows[0];
    const historyTotals = windows.slice(1).map((item) => item.ce + item.pe).filter((value) => value > 0);
    const normal = median(historyTotals);
    const total = current.ce + current.pe;
    const participationRatio = normal ? total / normal : null;
    const optionText = `CE ${compact(current.ce)} · PE ${compact(current.pe)}${participationRatio ? ` · ${participationRatio.toFixed(2)}× recent` : ""}`;
    const futureText = current.future === null
      ? "Index futures feed unavailable"
      : `Futures volume +${compact(current.future)} / 5m (secondary confirmation)`;
    return {
      optionText,
      futureText,
      tone: participationRatio === null ? "neutral" : participationRatio >= 1 ? "positive" : "warn"
    };
  }

  function optionVolumeDelta(current, reference, strikes, side) {
    return strikes.reduce((total, strike) => {
      const currentRow = current.rows.find((row) => row.strike === strike);
      const referenceRow = reference.rows.find((row) => row.strike === strike);
      if (!currentRow || !referenceRow) return total;
      const currentOption = side === "CE" ? currentRow.ce : currentRow.pe;
      const referenceOption = side === "CE" ? referenceRow.ce : referenceRow.pe;
      return total + Math.max(0, currentOption.volume - referenceOption.volume);
    }, 0);
  }

  function futureVolumeDelta(current, reference) {
    if (!current.future || !reference.future || current.future.instrumentKey !== reference.future.instrumentKey) return null;
    return Math.max(0, current.future.volume - reference.future.volume);
  }

  function renderPressureResponse(pressure) {
    el.pressureHeadline.textContent = pressure.headline;
    el.pressureVerdict.textContent = pressure.verdict;
    el.pressureVerdict.className = `pressure-verdict ${pressure.tone}`;
    el.pressureMetrics.innerHTML = pressure.metrics.map((metric) => `
      <div class="${metric.tone}">
        <span>${escapeHtml(metric.label)}</span>
        <strong>${escapeHtml(metric.value)}</strong>
      </div>
    `).join("");
    el.pressureNarrative.textContent = pressure.narrative;
  }

  function freshEventTapeState() {
    return {
      sessionKey: null,
      events: [],
      trackers: {},
      lastEvaluatedBucket: null,
      lastWalls: null,
      unread: 0,
      drawerOpen: false,
      pendingNotifications: null
    };
  }

  function eventStorageKey(snapshot) {
    return `structure_events_v${EVENT_STORAGE_VERSION}:${istSessionDate(snapshot.time)}:${snapshot.instrumentKey}:${snapshot.expiry}`;
  }

  function hydrateEventTape(snapshot) {
    const key = eventStorageKey(snapshot);
    if (state.eventTape.sessionKey === key) return;
    const fresh = freshEventTapeState();
    fresh.sessionKey = key;
    try {
      const stored = JSON.parse(localStorage.getItem(key) || "null");
      if (stored && stored.version === EVENT_STORAGE_VERSION) {
        fresh.events = Array.isArray(stored.events) ? stored.events.slice(0, EVENT_MAX_ITEMS) : [];
        fresh.trackers = stored.trackers && typeof stored.trackers === "object" ? stored.trackers : {};
        fresh.lastEvaluatedBucket = Number.isFinite(stored.lastEvaluatedBucket) ? stored.lastEvaluatedBucket : null;
        fresh.lastWalls = stored.lastWalls || null;
        fresh.unread = number(stored.unread);
      }
    } catch (error) {
      localStorage.removeItem(key);
    }
    state.eventTape = fresh;
    renderEventCenter();
  }

  function persistEventTape() {
    if (!state.eventTape.sessionKey) return;
    localStorage.setItem(state.eventTape.sessionKey, JSON.stringify({
      version: EVENT_STORAGE_VERSION,
      events: state.eventTape.events.slice(0, EVENT_MAX_ITEMS),
      trackers: state.eventTape.trackers,
      lastEvaluatedBucket: state.eventTape.lastEvaluatedBucket,
      lastWalls: state.eventTape.lastWalls,
      unread: state.eventTape.unread
    }));
  }

  function updateStructureEventTape(read, latest) {
    hydrateEventTape(latest);
    renderEventCenter();
    if (latest.source !== "live" || !isMarketSessionIst(latest.time)) return;
    const bucketMs = 5 * 60 * 1000;
    const millisecondsIntoBucket = latest.time % bucketMs;
    if (millisecondsIntoBucket > 2 * 60 * 1000) return;
    const bucket = Math.floor(latest.time / bucketMs);
    if (state.eventTape.lastEvaluatedBucket === bucket) return;

    if (state.eventTape.lastEvaluatedBucket !== null && bucket - state.eventTape.lastEvaluatedBucket > 1) {
      state.eventTape.pendingNotifications = [];
      pauseEventsAcrossGap(latest.time);
      flushEventNotifications();
      state.eventTape.lastEvaluatedBucket = bucket;
      state.eventTape.lastWalls = wallSnapshot(read);
      persistEventTape();
      renderEventCenter();
      return;
    }

    state.eventTape.pendingNotifications = [];
    collectWallMigrationEvents(read, latest, bucket);
    const observations = buildStructureEventObservations(read, latest);
    ["pressure", "support", "resistance"].forEach((category) => {
      processEventObservation(category, observations[category] || null, bucket, latest);
    });
    flushEventNotifications();
    state.eventTape.lastEvaluatedBucket = bucket;
    state.eventTape.lastWalls = wallSnapshot(read);
    persistEventTape();
    renderEventCenter();
  }

  function buildStructureEventObservations(read, latest) {
    const observations = { pressure: null, support: null, resistance: null };
    const pressure = read.pressure && read.pressure.eventData;
    if (pressure && pressure.aligned >= 2) {
      const label = pressure.direction === "up" ? "UPSIDE" : "DOWNSIDE";
      observations.pressure = {
        signature: `pressure:${pressure.direction}`,
        title: `${label} PRESSURE`,
        tone: pressure.direction === "up" ? "positive" : "negative",
        direction: pressure.direction,
        startSpot: latest.spot,
        details: `${pressure.aligned}/${pressure.total} material contracts · spot ${signed(pressure.spotMove)} / 5m`,
        meaning: `(OI and adjusted premium agree toward ${pressure.direction === "up" ? "upside" : "downside"}; price release is being checked)`,
        metrics: pressure
      };
    }

    const support = read.contracts.find((item) => item.strike === read.support && item.side === "PE");
    const resistance = read.contracts.find((item) => item.strike === read.resistance && item.side === "CE");
    observations.support = wallObservation(support, read.supportWall, latest, "support");
    observations.resistance = wallObservation(resistance, read.resistanceWall, latest, "resistance");
    return observations;
  }

  function wallObservation(contract, wall, latest, role) {
    const recent = contract && contract.windows && contract.windows["300"];
    if (!contract || !wall || !wall.stable || !recent || !recent.available || !recent.materialOi || !recent.materialResidual) return null;
    const inventory = inventoryWindowRead(recent, contract.side);
    if (!inventory.clean) return null;
    const isSupport = role === "support";
    const flowName = inventoryTypeName(inventory.type);
    const title = `${isSupport ? "SUPPORT" : "RESISTANCE"} ${contract.side} ${flowName.toUpperCase()}`;
    const meaning = wallInventoryMeaning(contract.side, inventory.type, isSupport);
    return {
      signature: `${role}:${contract.strike}:${inventory.type}`,
      title,
      tone: inventory.tone,
      direction: inventoryDirection(contract.side, inventory.type),
      startSpot: latest.spot,
      details: `${price(contract.strike, 0)} ${contract.side} ${flowName} · OI ${compact(recent.oiChange)} · Prem adj ${signed(recent.residual)}`,
      meaning,
      metrics: {
        strike: contract.strike,
        side: contract.side,
        oiChange: recent.oiChange,
        residual: recent.residual,
        inventoryType: inventory.type
      }
    };
  }

  function inventoryTypeName(type) {
    return ({
      "long-build": "long-build-like",
      writing: "writing-like",
      covering: "short-covering-like",
      "long-unwind": "long-unwind-like"
    })[type] || "material flow";
  }

  function wallInventoryMeaning(side, type, isSupport) {
    const meanings = {
      "PE:writing": "(OI and adjusted premium are consistent with PE writing at stable support; defence evidence while spot holds)",
      "PE:long-build": "(OI and adjusted premium are consistent with PE buying; downside pressure is attacking support)",
      "PE:covering": "(OI and adjusted premium are consistent with PE short covering; prior support-writing inventory may be weakening)",
      "PE:long-unwind": "(OI and adjusted premium are consistent with PE long exit; bearish demand is reducing)",
      "CE:writing": "(OI and adjusted premium are consistent with CE writing at stable resistance; defence evidence while spot stays below)",
      "CE:long-build": "(OI and adjusted premium are consistent with CE buying; upside pressure is attacking resistance)",
      "CE:covering": "(OI and adjusted premium are consistent with CE short covering; resistance inventory may be weakening)",
      "CE:long-unwind": "(OI and adjusted premium are consistent with CE long exit; upside demand is reducing)"
    };
    return meanings[`${side}:${type}`] || `(Material ${side} inventory changed at the ${isSupport ? "support" : "resistance"} wall)`;
  }

  function processEventObservation(category, observation, bucket, latest) {
    const tracker = state.eventTape.trackers[category];
    if (!observation) {
      if (!tracker) return;
      tracker.misses = number(tracker.misses) + 1;
      if (tracker.misses >= 2) closeTrackedEvent(category, "FADED", latest.time, "(The same material condition was absent for two completed 5m windows)");
      return;
    }

    if (!tracker || tracker.signature !== observation.signature) {
      if (tracker) {
        const oppositePressure = category === "pressure" && tracker.direction && tracker.direction !== observation.direction;
        closeTrackedEvent(category, oppositePressure ? "FAILED" : "FADED", latest.time,
          oppositePressure ? "(Opposite material inventory replaced the active pressure)" : "(The previous structure condition changed)"
        );
      }
      startTrackedEvent(category, observation, bucket, latest);
      return;
    }

    if (bucket - tracker.lastBucket !== 1) return;
    tracker.windows += 1;
    tracker.lastBucket = bucket;
    tracker.misses = 0;
    updateTrackedEvent(category, observation, latest);
  }

  function startTrackedEvent(category, observation, bucket, latest) {
    const id = `${latest.time}:${category}:${observation.signature}`;
    const event = {
      id,
      category,
      signature: observation.signature,
      title: observation.title,
      baseTitle: observation.title,
      tone: observation.tone,
      direction: observation.direction,
      stage: "EMERGING",
      active: true,
      windows: 1,
      durationMinutes: 5,
      startTime: latest.time,
      endTime: latest.time,
      startSpot: observation.startSpot,
      details: observation.details,
      meaning: observation.meaning,
      metrics: observation.metrics
    };
    state.eventTape.events.unshift(event);
    state.eventTape.events = state.eventTape.events.slice(0, EVENT_MAX_ITEMS);
    state.eventTape.trackers[category] = {
      eventId: id,
      signature: observation.signature,
      direction: observation.direction,
      windows: 1,
      lastBucket: bucket,
      misses: 0,
      lastNotifiedStage: "EMERGING"
    };
    notifyEvent(event);
  }

  function updateTrackedEvent(category, observation, latest) {
    const tracker = state.eventTape.trackers[category];
    const event = findStructureEvent(tracker.eventId);
    if (!event) return;
    const previousStage = event.stage;
    event.windows = tracker.windows;
    event.durationMinutes = tracker.windows * 5;
    event.endTime = latest.time;
    event.details = observation.details;
    event.meaning = observation.meaning;
    event.metrics = observation.metrics;
    event.stage = tracker.windows >= 3 ? "SUSTAINED" : tracker.windows >= 2 ? "CONFIRMED" : "EMERGING";

    if (category === "pressure") applyPressureOutcome(event, observation, latest);
    event.title = eventTitleForStage(event);
    if (event.stage !== previousStage && event.stage !== tracker.lastNotifiedStage) {
      tracker.lastNotifiedStage = event.stage;
      notifyEvent(event);
    }
  }

  function applyPressureOutcome(event, observation, latest) {
    const directionMove = event.direction === "up" ? latest.spot - event.startSpot : event.startSpot - latest.spot;
    const normalMove = sessionMedianFiveMinuteMove(latest.time);
    const responseRatio = normalMove > 0 ? directionMove / normalMove : null;
    const metrics = observation.metrics;
    event.details = `${metrics.aligned}/${metrics.total} material contracts · spot ${signed(latest.spot - event.startSpot)} · ${responseRatio === null ? "normal building" : `${responseRatio.toFixed(2)}× normal`}`;
    if (event.windows >= 2 && responseRatio !== null && responseRatio >= 1) {
      event.stage = "RELEASED";
      event.meaning = "(Sustained option inventory converted into a meaningful same-direction spot move)";
    } else if (event.windows >= 3 && directionMove <= 0) {
      event.stage = "ABSORBED";
      event.meaning = "(Material option pressure persisted for 15m, but spot repeatedly failed to move with it)";
    } else if (event.windows >= 3) {
      event.meaning = "(Pressure persisted for 15m; price response exists but full release is still unproven)";
    } else if (event.windows >= 2) {
      event.meaning = "(The same material inventory direction appeared in two consecutive 5m windows)";
    }
  }

  function eventTitleForStage(event) {
    if (["RELEASED", "ABSORBED", "FAILED", "FADED", "UNVERIFIED GAP"].includes(event.stage)) {
      const direction = event.direction === "up" ? "UPSIDE" : event.direction === "down" ? "DOWNSIDE" : event.baseTitle;
      return event.category === "pressure" ? `${direction} ${event.stage}` : event.baseTitle;
    }
    return event.baseTitle;
  }

  function closeTrackedEvent(category, stage, time, meaning) {
    const tracker = state.eventTape.trackers[category];
    if (!tracker) return;
    const event = findStructureEvent(tracker.eventId);
    if (event) {
      event.active = false;
      event.endTime = time;
      event.stage = stage;
      event.title = eventTitleForStage(event);
      event.meaning = meaning || event.meaning;
      if (event.windows >= 2 || stage === "FAILED") notifyEvent(event);
    }
    delete state.eventTape.trackers[category];
  }

  function pauseEventsAcrossGap(time) {
    Object.keys(state.eventTape.trackers).forEach((category) => {
      closeTrackedEvent(category, "UNVERIFIED GAP", time, "(Recording paused; the missing interval was not assumed or added to duration)");
    });
  }

  function collectWallMigrationEvents(read, latest, bucket) {
    const previous = state.eventTape.lastWalls;
    const current = wallSnapshot(read);
    if (!previous) return;
    if (read.supportWall && read.supportWall.stable && previous.support && previous.support !== current.support) {
      addDiscreteStructureEvent({
        id: `${bucket}:support-migration:${previous.support}:${current.support}`,
        category: "migration",
        title: "IMMEDIATE SUPPORT MIGRATED",
        tone: current.support > previous.support ? "positive" : "negative",
        details: `PE wall ${price(previous.support, 0)} → ${price(current.support, 0)} · OI ${compact(read.supportWall.oi)}`,
        meaning: `(The maximum PE OI wall shifted ${current.support > previous.support ? "higher" : "lower"} and held across completed windows)`,
        time: latest.time
      });
    }
    if (read.resistanceWall && read.resistanceWall.stable && previous.resistance && previous.resistance !== current.resistance) {
      addDiscreteStructureEvent({
        id: `${bucket}:resistance-migration:${previous.resistance}:${current.resistance}`,
        category: "migration",
        title: "IMMEDIATE RESISTANCE MIGRATED",
        tone: current.resistance > previous.resistance ? "positive" : "negative",
        details: `CE wall ${price(previous.resistance, 0)} → ${price(current.resistance, 0)} · OI ${compact(read.resistanceWall.oi)}`,
        meaning: `(The maximum CE OI wall shifted ${current.resistance > previous.resistance ? "higher" : "lower"} and held across completed windows)`,
        time: latest.time
      });
    }
  }

  function addDiscreteStructureEvent(input) {
    if (state.eventTape.events.some((event) => event.id === input.id)) return;
    const event = {
      ...input,
      baseTitle: input.title,
      stage: "CONFIRMED",
      active: false,
      windows: 2,
      durationMinutes: 10,
      startTime: input.time,
      endTime: input.time
    };
    state.eventTape.events.unshift(event);
    state.eventTape.events = state.eventTape.events.slice(0, EVENT_MAX_ITEMS);
    notifyEvent(event);
  }

  function wallSnapshot(read) {
    return {
      support: read.supportWall && read.supportWall.stable ? read.support || 0 : 0,
      resistance: read.resistanceWall && read.resistanceWall.stable ? read.resistance || 0 : 0
    };
  }

  function findStructureEvent(id) {
    return state.eventTape.events.find((event) => event.id === id) || null;
  }

  function notifyEvent(event) {
    state.eventTape.unread += 1;
    renderEventButton();
    if (Array.isArray(state.eventTape.pendingNotifications)) {
      state.eventTape.pendingNotifications.push(event);
      return;
    }
    showEventToast(event, 0);
  }

  function flushEventNotifications() {
    const pending = state.eventTape.pendingNotifications || [];
    state.eventTape.pendingNotifications = null;
    if (!pending.length) return;
    const stagePriority = { RELEASED: 7, ABSORBED: 7, FAILED: 6, CONFIRMED: 5, SUSTAINED: 4, EMERGING: 3, FADED: 2, "UNVERIFIED GAP": 1 };
    const categoryPriority = { pressure: 4, migration: 3, support: 2, resistance: 2 };
    const ranked = [...pending].sort((left, right) => (
      number(stagePriority[right.stage]) - number(stagePriority[left.stage])
      || number(categoryPriority[right.category]) - number(categoryPriority[left.category])
    ));
    showEventToast(ranked[0], ranked.length - 1);
  }

  function showEventToast(event, relatedCount = 0) {
    const toast = document.createElement("article");
    toast.className = `event-toast ${event.tone || "neutral"}`;
    toast.dataset.eventId = event.id;
    toast.innerHTML = `
      <button class="event-toast-open" type="button" aria-label="Open Structure Event Center">
        <span>${escapeHtml(formatTime(event.endTime))} · ${escapeHtml(event.stage)} · ${event.durationMinutes}m${relatedCount ? ` · +${relatedCount} related` : ""}</span>
        <strong>${escapeHtml(event.title)}</strong>
        <em>${escapeHtml(event.details || "")}</em>
        <small>${escapeHtml(event.meaning || "")}</small>
      </button>
      <button class="event-toast-close" type="button" title="Dismiss notification" aria-label="Dismiss notification">×</button>
      <i aria-hidden="true"></i>
    `;
    const openButton = toast.querySelector(".event-toast-open");
    const closeButton = toast.querySelector(".event-toast-close");
    openButton.addEventListener("click", openEventDrawer);
    closeButton.addEventListener("click", () => dismissEventToast(toast));
    el.eventToastStack.prepend(toast);
    while (el.eventToastStack.children.length > 3) el.eventToastStack.lastElementChild.remove();
    window.setTimeout(() => dismissEventToast(toast), EVENT_TOAST_MS);
  }

  function dismissEventToast(toast) {
    if (!toast || !toast.isConnected) return;
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 180);
  }

  function openEventDrawer() {
    state.eventTape.drawerOpen = true;
    state.eventTape.unread = 0;
    el.eventDrawer.classList.add("open");
    el.eventDrawer.setAttribute("aria-hidden", "false");
    el.eventDrawerBackdrop.hidden = false;
    document.body.classList.add("event-drawer-open");
    persistEventTape();
    renderEventCenter();
  }

  function closeEventDrawer() {
    state.eventTape.drawerOpen = false;
    el.eventDrawer.classList.remove("open");
    el.eventDrawer.setAttribute("aria-hidden", "true");
    el.eventDrawerBackdrop.hidden = true;
    document.body.classList.remove("event-drawer-open");
  }

  function renderEventCenter() {
    renderEventButton();
    const events = [...state.eventTape.events].sort((left, right) => right.endTime - left.endTime);
    const active = events.filter((event) => event.active).length;
    const confirmed = events.filter((event) => event.windows >= 2).length;
    el.eventDrawerSummary.textContent = events.length
      ? `${active} live · ${confirmed} confirmed · ${events.length} total today · newest first`
      : "No meaningful completed-5m transition recorded yet";
    el.eventTape.innerHTML = events.length ? events.map(eventTapeRow).join("") : `
      <div class="event-empty">
        <strong>Waiting for meaningful structure</strong>
        <span>Material OI and adjusted premium must agree. A 5m observation appears early; 10m confirms and 15m sustains it.</span>
      </div>
    `;
  }

  function renderEventButton() {
    const unread = number(state.eventTape.unread);
    el.eventUnreadCount.hidden = unread === 0;
    el.eventUnreadCount.textContent = unread > 99 ? "99+" : String(unread);
    el.eventCenterButton.classList.toggle("has-events", state.eventTape.events.length > 0);
  }

  function eventTapeRow(event) {
    const sameTime = event.startTime === event.endTime;
    const time = sameTime ? formatTime(event.endTime) : `${formatTime(event.startTime)}–${formatTime(event.endTime)}`;
    return `
      <article class="event-tape-row ${event.tone || "neutral"} ${event.active ? "active" : ""}">
        <div class="event-tape-time">
          <strong>${escapeHtml(time)}</strong>
          <span>${event.durationMinutes}m observed</span>
        </div>
        <div class="event-tape-copy">
          <header><strong>${escapeHtml(event.title)}</strong><b>${escapeHtml(event.stage)}</b></header>
          <p>${escapeHtml(event.details || "")}</p>
          <span>${escapeHtml(event.meaning || "")}</span>
        </div>
      </article>
    `;
  }

  function structureContractRow(contract) {
    return `
      <div class="structure-contract ${contract.tone}">
        <div class="structure-contract-name">
          <span>${escapeHtml(contract.role)}</span>
          <strong>${price(contract.strike, 0)} ${contract.side}</strong>
          <em>OI ${compact(contract.currentOi)} · Mid ${price(contract.currentPremium)}</em>
          <b class="structure-inventory ${contract.inventory.tone}">${escapeHtml(contract.inventory.label)}</b>
        </div>
        ${STRUCTURE_WINDOWS.map((item) => structureWindowCell(contract.windows[item.key], item.label, contract.side)).join("")}
      </div>
    `;
  }

  function structureWindowCell(windowRead, label, side) {
    if (!windowRead || !windowRead.available) {
      return `<div class="structure-window building"><span>${label}</span><strong>Building</strong><em>Exact history needed</em></div>`;
    }
    const oiTone = windowRead.oiChange > 0 ? "positive" : windowRead.oiChange < 0 ? "negative" : "muted";
    const premiumTone = windowRead.premiumChange > 0 ? "positive" : windowRead.premiumChange < 0 ? "negative" : "muted";
    const inventory = inventoryWindowRead(windowRead, side);
    const residualTone = windowRead.residual > 0 ? "positive" : windowRead.residual < 0 ? "negative" : "muted";
    return `
      <div class="structure-window">
        <span>${label}${windowRead.oiRank ? ` · #${windowRead.oiRank}/${windowRead.universeSize}` : ""}</span>
        <strong class="${oiTone}">OI ${compact(windowRead.oiChange)} (${signedPercent(windowRead.oiChangePct)})</strong>
        <em class="${premiumTone}">Prem ${signed(windowRead.premiumChange)} (${signedPercent(windowRead.premiumChangePct)})</em>
        <b class="${residualTone}">Adj ${signed(windowRead.residual)} · ${escapeHtml(inventory.clean ? inventory.shortLabel : "Mixed")}</b>
      </div>
    `;
  }

  function buildMarketStructureRead(latest) {
    const step = inferStrikeStep(latest.rows);
    const openingSnapshots = openingBaselineSnapshots(latest);
    const openingSupport = buildOpeningWall(openingSnapshots, "PE", step);
    const openingResistance = buildOpeningWall(openingSnapshots, "CE", step);
    const supportWall = resolveStableOiWall(latest, "PE", openingSupport, step);
    const resistanceWall = resolveStableOiWall(latest, "CE", openingResistance, step);
    const majorSupportWall = findMaxOiWall(latest.rows, latest.spot, "PE", step);
    const majorResistanceWall = findMaxOiWall(latest.rows, latest.spot, "CE", step);
    const support = supportWall ? supportWall.strike : 0;
    const resistance = resistanceWall ? resistanceWall.strike : 0;
    const contracts = buildStructureContracts(latest, openingSnapshots, support, resistance);
    const microRange = detectMicroRange(latest);
    const location = structureLocation(latest.spot, support, resistance, step, microRange);
    const origin = buildSessionOrigin(latest, openingSnapshots, openingSupport, openingResistance, step);
    const interpretation = interpretMarketStructure({
      latest,
      step,
      support,
      resistance,
      supportWall,
      resistanceWall,
      majorSupportWall,
      majorResistanceWall,
      contracts,
      microRange,
      location,
      openingReady: openingSnapshots.length >= 3
    });
    const pressure = buildPressureResponseRead(latest, {
      step,
      support,
      resistance,
      supportWall,
      resistanceWall
    });
    return {
      ...interpretation,
      origin,
      spot: latest.spot,
      support,
      resistance,
      contracts,
      microRange,
      supportWall,
      resistanceWall,
      majorSupportWall,
      majorResistanceWall,
      pressure
    };
  }

  function buildPressureResponseRead(latest, structure) {
    const reference = getOlderSnapshot(300);
    if (!reference) return buildingPressureRead("Exact 5m DB baseline is not available yet");

    const atmIndex = latest.rows.findIndex((row) => row.strike === latest.atmStrike);
    const nearbyRows = latest.rows.slice(Math.max(0, atmIndex - 3), atmIndex + 4);
    const flows = nearbyRows.flatMap((row) => ["CE", "PE"].map((side) => {
      const windowRead = buildStructureWindow(latest, [], row.strike, side, 300);
      if (!windowRead.available) return null;
      const inventory = inventoryWindowRead(windowRead, side);
      if (!inventory.clean) return null;
      return {
        strike: row.strike,
        side,
        type: inventory.type,
        direction: inventoryDirection(side, inventory.type),
        oiChange: windowRead.oiChange,
        residual: windowRead.residual
      };
    })).filter(Boolean);

    const bullish = flows.filter((flow) => flow.direction === "up");
    const bearish = flows.filter((flow) => flow.direction === "down");
    const direction = bullish.length > bearish.length && bullish.length >= 2
      ? "up"
      : bearish.length > bullish.length && bearish.length >= 2
        ? "down"
        : null;
    const dominant = direction === "up" ? bullish : direction === "down" ? bearish : [];
    const normalMove = sessionMedianFiveMinuteMove(latest.time);
    const rawSpotMove = latest.spot - reference.spot;
    const directionalSpotMove = direction === "up" ? rawSpotMove : direction === "down" ? -rawSpotMove : 0;
    const responseRatio = normalMove > 0 ? directionalSpotMove / normalMove : null;
    const drivers = describeInventoryDrivers(dominant);
    const migration = pressureWallMigration(latest, structure);
    const path = pressurePathLoad(latest, direction, structure.step);
    const roleFlip = detectInventoryRoleFlip(latest, structure.step);

    if (!direction) {
      return {
        headline: flows.length
          ? `SPLIT INVENTORY · ${bullish.length} upside vs ${bearish.length} downside contracts`
          : "NO MATERIAL INVENTORY IMPULSE",
        verdict: "NO OI-SUPPORTED EDGE",
        tone: "neutral",
        metrics: [
          pressureMetric("Flow breadth", `${bullish.length} up · ${bearish.length} down`, "neutral"),
          pressureMetric("Spot response", `${signed(rawSpotMove)} pts / 5m`, "neutral"),
          pressureMetric("Wall / role", migration.value, migration.tone),
          pressureMetric("Path load", "Direction unresolved", "neutral")
        ],
        narrative: flows.length
          ? "Material OI and premium-residual flows disagree across nearby strikes. The current spot move cannot yet be attributed to one inventory side."
          : "Nearby contracts do not show simultaneous material OI and premium-residual change. Treat the current spot move as unproven by option inventory.",
        eventData: null
      };
    }

    const directionLabel = direction === "up" ? "UPSIDE" : "DOWNSIDE";
    const oppositeMove = directionalSpotMove <= 0;
    const released = !oppositeMove && responseRatio !== null && responseRatio >= 1;
    const verdict = oppositeMove
      ? "OI PRESSURE ABSORBED"
      : released
        ? "OI-SUPPORTED RELEASE"
        : "PARTIAL RESPONSE";
    const tone = oppositeMove || !released ? "warn" : direction === "up" ? "positive" : "negative";
    const responseText = responseRatio === null
      ? `${signed(rawSpotMove)} pts · normal building`
      : `${signed(rawSpotMove)} pts · ${Math.abs(responseRatio).toFixed(2)}× normal`;
    const flowTone = direction === "up" ? "positive" : "negative";
    const roleText = roleFlip.confirmed ? ` ${roleFlip.value}.` : "";
    const narrative = oppositeMove
      ? `${directionLabel.toLowerCase()} inventory pressure appeared across ${dominant.length}/${flows.length} material contracts, but spot moved ${signed(rawSpotMove)} points. The pressure is being absorbed; a directional break is not confirmed.${roleText}`
      : `Inferred ${directionLabel.toLowerCase()} driver: ${drivers}. Spot responded ${responseRatio === null ? "in the same direction" : `${responseRatio.toFixed(2)}× its session-median 5m move`} with ${dominant.length}/${flows.length} material contracts aligned.${roleText}`;

    return {
      headline: `${directionLabel} INVENTORY · ${drivers}`,
      verdict,
      tone,
      metrics: [
        pressureMetric("Flow breadth", `${dominant.length}/${flows.length} aligned · ${bullish.length}↑ ${bearish.length}↓`, flowTone),
        pressureMetric("Spot response", responseText, oppositeMove ? "warn" : flowTone),
        pressureMetric("Wall / role", roleFlip.confirmed ? roleFlip.value : migration.value, roleFlip.confirmed ? roleFlip.tone : migration.tone),
        pressureMetric("Path load", path.value, path.tone)
      ],
      narrative,
      eventData: {
        direction,
        aligned: dominant.length,
        total: flows.length,
        bullish: bullish.length,
        bearish: bearish.length,
        spotMove: rawSpotMove,
        responseRatio,
        drivers,
        verdict,
        oppositeMove,
        released,
        pathLoadRatio: path.loadRatio,
        pathBlocker: path.blocker
      }
    };
  }

  function buildingPressureRead(reason) {
    return {
      headline: reason,
      verdict: "UNPROVEN",
      tone: "building",
      metrics: [
        pressureMetric("Flow breadth", "Building", "neutral"),
        pressureMetric("Spot response", "Building", "neutral"),
        pressureMetric("Wall / role", "Building", "neutral"),
        pressureMetric("Path load", "Building", "neutral")
      ],
      narrative: "The inferred move driver will appear only after material OI and Greek-adjusted premium residual agree across multiple nearby contracts.",
      eventData: null
    };
  }

  function pressureMetric(label, value, tone) {
    return { label, value, tone: tone || "neutral" };
  }

  function inventoryDirection(side, type) {
    if (side === "CE") {
      return type === "long-build" || type === "covering" ? "up" : "down";
    }
    return type === "writing" || type === "long-unwind" ? "up" : "down";
  }

  function describeInventoryDrivers(flows) {
    const labels = flows.reduce((counts, flow) => {
      const key = `${flow.side}:${flow.type}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    const names = {
      "CE:long-build": "CE long-build-like",
      "CE:writing": "CE writing-like",
      "CE:covering": "CE short-covering-like",
      "CE:long-unwind": "CE long-exit-like",
      "PE:long-build": "PE long-build-like",
      "PE:writing": "PE writing-like",
      "PE:covering": "PE short-covering-like",
      "PE:long-unwind": "PE long-exit-like"
    };
    return Object.entries(labels)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([key, count]) => `${names[key]}${count > 1 ? ` ×${count}` : ""}`)
      .join(" + ") || "material flow unresolved";
  }

  function sessionMedianFiveMinuteMove(referenceTime) {
    const candles = state.candles5m.length ? state.candles5m : buildSnapshotFiveMinuteCandles(referenceTime);
    const sessionDate = istSessionDate(referenceTime);
    const completed = candles.filter((candle) => istSessionDate(candle.start) === sessionDate).sort((a, b) => a.start - b.start);
    const changes = completed.slice(1).map((candle, index) => Math.abs(candle.close - completed[index].close)).filter((value) => value > 0);
    return median(changes);
  }

  function pressureWallMigration(latest, structure) {
    const reference = getOlderSnapshot(900);
    if (!reference) return { value: "15m history building", tone: "neutral" };
    const oldSupport = findImmediateOiLevel(reference.rows, reference.spot, "PE", structure.step);
    const oldResistance = findImmediateOiLevel(reference.rows, reference.spot, "CE", structure.step);
    if (!oldSupport || !oldResistance || !structure.support || !structure.resistance) {
      return { value: "Wall history incomplete", tone: "neutral" };
    }
    const supportShift = structure.support - oldSupport.strike;
    const resistanceShift = structure.resistance - oldResistance.strike;
    const alignedUp = supportShift > 0 && resistanceShift >= 0;
    const alignedDown = resistanceShift < 0 && supportShift <= 0;
    return {
      value: `PE ${price(oldSupport.strike, 0)}→${price(structure.support, 0)} · CE ${price(oldResistance.strike, 0)}→${price(structure.resistance, 0)}`,
      tone: alignedUp ? "positive" : alignedDown ? "negative" : "neutral"
    };
  }

  function pressurePathLoad(latest, direction, step) {
    if (!direction) return { value: "Direction unresolved", tone: "neutral", loadRatio: null, blocker: null };
    const side = direction === "up" ? "CE" : "PE";
    const ordered = latest.rows.filter((row) => (
      direction === "up"
        ? row.strike > latest.spot && row.strike - latest.spot <= step * WALL_SCAN_STRIKES
        : row.strike < latest.spot && latest.spot - row.strike <= step * WALL_SCAN_STRIKES
    )).sort((a, b) => direction === "up" ? a.strike - b.strike : b.strike - a.strike);
    const target = ordered.slice(0, 3);
    if (!target.length) return { value: "Target strikes unavailable", tone: "neutral", loadRatio: null, blocker: null };
    const oi = (row) => side === "CE" ? row.ce.oi : row.pe.oi;
    const localMedian = median(ordered.map(oi).filter((value) => value > 0));
    const targetAverage = sum(target, oi) / target.length;
    const loadRatio = localMedian ? targetAverage / localMedian : 0;
    const blocker = [...target].sort((a, b) => oi(b) - oi(a))[0];
    return {
      value: `${loadRatio.toFixed(2)}× local OI · ${price(blocker.strike, 0)} blocker`,
      tone: loadRatio < 1 ? "positive" : loadRatio > 1 ? "warn" : "neutral",
      loadRatio,
      blocker: blocker.strike
    };
  }

  function detectInventoryRoleFlip(latest, step) {
    const reference = getOlderSnapshot(900);
    if (!reference) return { value: "", tone: "neutral", confirmed: false };
    const crossed = latest.rows.filter((row) => (
      (reference.spot < row.strike && latest.spot >= row.strike)
      || (reference.spot > row.strike && latest.spot <= row.strike)
    )).sort((a, b) => Math.abs(a.strike - latest.spot) - Math.abs(b.strike - latest.spot));
    if (!crossed.length) return { value: "", tone: "neutral", confirmed: false };
    const strike = crossed[0].strike;
    const upward = latest.spot >= strike;
    const ce = buildStructureWindow(latest, [], strike, "CE", 900);
    const pe = buildStructureWindow(latest, [], strike, "PE", 900);
    const confirmed = ce.available && pe.available && ce.materialOi && pe.materialOi && (
      upward
        ? ce.oiChange < 0 && pe.oiChange > 0
        : pe.oiChange < 0 && ce.oiChange > 0
    );
    return {
      value: confirmed
        ? `${price(strike, 0)} ${upward ? "R→S" : "S→R"} inventory flip`
        : `${price(strike, 0)} crossed · role unconfirmed`,
      tone: confirmed ? (upward ? "positive" : "negative") : "warn",
      confirmed
    };
  }

  function inferStrikeStep(rows) {
    const differences = rows.slice(1).map((row, index) => row.strike - rows[index].strike).filter((value) => value > 0);
    return median(differences) || 50;
  }

  function openingBaselineSnapshots(latest) {
    const sessionDate = istSessionDate(latest.time);
    return state.history.filter((snapshot) => {
      if (snapshot.source !== latest.source || snapshot.expiry !== latest.expiry || istSessionDate(snapshot.time) !== sessionDate) return false;
      const parts = istParts(snapshot.time);
      const minute = parts.hour * 60 + parts.minute;
      return minute >= 9 * 60 + 15 && minute < 9 * 60 + 20;
    });
  }

  function buildOpeningWall(snapshots, side, step) {
    if (snapshots.length < 3) return null;
    const strikes = [...new Set(snapshots.flatMap((snapshot) => snapshot.rows.map((row) => row.strike)))].sort((a, b) => a - b);
    const rows = strikes.map((strike) => {
      const options = snapshots.map((snapshot) => snapshot.rows.find((row) => row.strike === strike)).filter(Boolean);
      return {
        strike,
        ce: { oi: median(options.map((row) => row.ce.oi)) },
        pe: { oi: median(options.map((row) => row.pe.oi)) }
      };
    });
    const spot = median(snapshots.map((snapshot) => snapshot.spot));
    const wall = findImmediateOiLevel(rows, spot, side, step);
    return wall ? { ...wall, source: "opening nearest-11-strike max OI", stable: true, confirmations: 1 } : null;
  }

  function findMaxOiWall(rows, spot, side, step) {
    const isSupport = side === "PE";
    const candidates = rows.filter((row) => (
      isSupport
        ? row.strike <= spot && spot - row.strike <= step * WALL_SCAN_STRIKES
        : row.strike >= spot && row.strike - spot <= step * WALL_SCAN_STRIKES
    )).map((row) => {
      const option = isSupport ? row.pe : row.ce;
      return {
        strike: row.strike,
        oi: option.oi
      };
    }).filter((item) => item.oi > 0)
      .sort((a, b) => b.oi - a.oi || Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    if (!candidates.length) return null;
    return {
      ...candidates[0],
      significant: true,
      secondOi: candidates[1] ? candidates[1].oi : 0,
      scannedStrikes: candidates.length,
      dominance: candidates[1] && candidates[1].oi
        ? candidates[0].oi / candidates[1].oi
        : 1
    };
  }

  function findImmediateOiLevel(rows, spot, side, step) {
    const isSupport = side === "PE";
    const candidates = rows.filter((row) => (
      isSupport
        ? row.strike <= spot && spot - row.strike <= step * IMMEDIATE_WALL_STRIKES
        : row.strike >= spot && row.strike - spot <= step * IMMEDIATE_WALL_STRIKES
    )).map((row) => {
      const option = isSupport ? row.pe : row.ce;
      return { strike: row.strike, oi: option.oi };
    }).filter((item) => item.oi > 0)
      .sort((a, b) => b.oi - a.oi || Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    const immediate = candidates[0];
    if (immediate) {
      const secondOi = candidates[1] ? candidates[1].oi : 0;
      return {
        ...immediate,
        significant: !secondOi || immediate.oi > secondOi,
        secondOi,
        dominance: secondOi ? immediate.oi / secondOi : 1,
        selection: "nearest-eleven-strike-max-oi",
        scannedStrikes: candidates.length
      };
    }
    const fallback = findMaxOiWall(rows, spot, side, step);
    return fallback ? { ...fallback, selection: "absolute-max-fallback" } : null;
  }

  function resolveStableOiWall(latest, side, openingWall, step) {
    const current = findImmediateOiLevel(latest.rows, latest.spot, side, step);
    if (!current) return null;
    const snapshots = completedWindowSnapshots(latest.time, 3);
    const candidates = snapshots
      .map((snapshot) => findImmediateOiLevel(snapshot.rows, snapshot.spot, side, step))
      .filter(Boolean);
    const confirmations = candidates.filter((wall) => wall.strike === current.strike).length;
    return {
      ...current,
      source: confirmations >= 2 ? "nearest-11-strike max OI · completed 5m confirmed" : "nearest-11-strike max OI",
      stable: confirmations >= 2,
      confirmations,
      openingStrike: openingWall ? openingWall.strike : null
    };
  }

  function completedWindowSnapshots(referenceTime, count) {
    const lastEnd = Math.floor(referenceTime / 300000) * 300000;
    const snapshots = [];
    for (let index = 0; index < count; index += 1) {
      const snapshot = findSnapshotNear(lastEnd - index * 300000);
      if (snapshot && !snapshots.some((item) => item.time === snapshot.time)) snapshots.push(snapshot);
    }
    return snapshots;
  }

  function buildStructureContracts(latest, openingSnapshots, support, resistance) {
    const definitions = [];
    if (support) definitions.push({ role: support === latest.atmStrike ? "Support + ATM" : "Support", strike: support, side: "PE" });
    if (latest.atmStrike !== support) definitions.push({ role: "ATM", strike: latest.atmStrike, side: "PE" });
    definitions.push({ role: resistance === latest.atmStrike ? "ATM + Resistance" : "ATM", strike: latest.atmStrike, side: "CE" });
    if (resistance && resistance !== latest.atmStrike) definitions.push({ role: "Resistance", strike: resistance, side: "CE" });
    return definitions.map((definition) => buildStructureContract(latest, openingSnapshots, definition));
  }

  function buildStructureContract(latest, openingSnapshots, definition) {
    const row = latest.rows.find((item) => item.strike === definition.strike);
    const option = row ? (definition.side === "CE" ? row.ce : row.pe) : null;
    const windows = {};
    STRUCTURE_WINDOWS.forEach((item) => {
      windows[item.key] = buildStructureWindow(latest, openingSnapshots, definition.strike, definition.side, item.seconds);
    });
    const flow = readContractFlow(windows);
    const inventory = classifyStructureInventory(windows, definition.side);
    return {
      ...definition,
      currentOi: option ? option.oi : 0,
      currentPremium: option ? option.mid : 0,
      windows,
      flow,
      inventory,
      tone: structureContractTone(definition.side, flow.state)
    };
  }

  function classifyStructureInventory(windows, side) {
    const recent = windows["300"];
    const medium = windows["900"];
    if (!recent || !recent.available) {
      return { label: "Flow building", type: "building", tone: "neutral" };
    }
    const recentRead = inventoryWindowRead(recent, side);
    if (!recentRead.clean) {
      return { label: "No clean 5m flow", type: "mixed", tone: "neutral" };
    }
    const mediumRead = medium && medium.available ? inventoryWindowRead(medium, side) : null;
    const sustained = mediumRead && mediumRead.clean && mediumRead.type === recentRead.type;
    return {
      ...recentRead,
      label: `${sustained ? "Sustained " : "5m "}${recentRead.label}`
    };
  }

  function inventoryWindowRead(windowRead, side) {
    if (!windowRead.materialOi || !windowRead.materialResidual) {
      return { clean: false, label: "Mixed", type: "mixed", tone: "neutral" };
    }
    const oiUp = windowRead.oiChange > 0;
    const premiumUp = windowRead.residual > 0;
    let type = "long-unwind";
    let label = "Long-unwind-like";
    if (oiUp && premiumUp) {
      type = "long-build";
      label = "Long-build-like";
    } else if (oiUp && !premiumUp) {
      type = "writing";
      label = "Writing-like";
    } else if (!oiUp && premiumUp) {
      type = "covering";
      label = "Short-covering-like";
    }
    const bullish = side === "CE"
      ? type === "long-build" || type === "covering"
      : type === "writing" || type === "long-unwind";
    return { clean: true, label: `${side} ${label}`, shortLabel: label, type, tone: bullish ? "positive" : "negative" };
  }

  function structureContractTone(side, flowState) {
    const adding = flowState === "Sustained addition" || flowState === "Addition building";
    const withdrawing = flowState === "Sustained withdrawal" || flowState === "Withdrawal building" || flowState.includes("recent withdrawal");
    if (adding) return side === "PE" ? "positive" : "negative";
    if (withdrawing) return side === "PE" ? "negative" : "positive";
    if (flowState.includes("building")) return "warn";
    return "neutral";
  }

  function buildStructureWindow(latest, openingSnapshots, strike, side, seconds) {
    const reference = seconds === null
      ? openingOptionReference(openingSnapshots, strike, side)
      : snapshotOptionReference(getOlderSnapshot(seconds), strike, side);
    const currentRow = latest.rows.find((row) => row.strike === strike);
    const currentOption = currentRow ? (side === "CE" ? currentRow.ce : currentRow.pe) : null;
    if (!reference || !currentOption) return { available: false };

    const attribution = greekPremiumAttribution(latest, currentOption, reference, side);
    const premiumChange = attribution.actualChange;
    const oiChange = currentOption.oi - reference.oi;
    const oiChangePct = reference.oi ? oiChange / reference.oi : 0;
    const premiumChangePct = reference.mid ? premiumChange / reference.mid : 0;
    const residual = attribution.residual;
    const universe = structureWindowUniverse(latest, openingSnapshots, side, seconds);
    const oiMagnitude = universe.map((item) => Math.abs(item.oiChange));
    const oiCenter = median(oiMagnitude);
    const oiMad = median(oiMagnitude.map((value) => Math.abs(value - oiCenter)));
    const residualMagnitude = universe.map((item) => Math.abs(item.residual));
    const residualCenter = median(residualMagnitude);
    const residualMad = median(residualMagnitude.map((value) => Math.abs(value - residualCenter)));
    const oiRank = [...universe].sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange)).findIndex((item) => item.strike === strike) + 1;
    return {
      available: true,
      oiChange,
      premiumChange,
      oiChangePct,
      premiumChangePct,
      residual,
      expectedChange: attribution.expectedChange,
      deltaTerm: attribution.deltaTerm,
      gammaTerm: attribution.gammaTerm,
      vegaTerm: attribution.vegaTerm,
      thetaTerm: attribution.thetaTerm,
      oiRank: oiRank > 0 ? oiRank : null,
      universeSize: universe.length,
      materialOi: Math.abs(oiChange) > 0 && Math.abs(oiChange) >= oiCenter + oiMad,
      materialResidual: Math.abs(residual) > 0 && Math.abs(residual) >= residualCenter + residualMad
    };
  }

  function structureWindowUniverse(latest, openingSnapshots, side, seconds) {
    const atmIndex = latest.rows.findIndex((row) => row.strike === latest.atmStrike);
    return latest.rows.slice(
      Math.max(0, atmIndex - WALL_SCAN_STRIKES),
      atmIndex + WALL_SCAN_STRIKES + 1
    ).map((row) => {
      const reference = seconds === null
        ? openingOptionReference(openingSnapshots, row.strike, side)
        : snapshotOptionReference(getOlderSnapshot(seconds), row.strike, side);
      if (!reference) return null;
      const option = side === "CE" ? row.ce : row.pe;
      const attribution = greekPremiumAttribution(latest, option, reference, side);
      return {
        strike: row.strike,
        oiChange: option.oi - reference.oi,
        residual: attribution.residual
      };
    }).filter(Boolean);
  }

  function greekPremiumAttribution(latest, currentOption, reference, side) {
    const spotChange = latest.spot - reference.spot;
    const signedDelta = side === "CE" ? reference.delta : -reference.delta;
    const elapsedDays = Math.max(0, latest.time - reference.time) / (24 * 60 * 60 * 1000);
    const ivChange = currentOption.iv - reference.iv;
    const deltaTerm = signedDelta * spotChange;
    const gammaTerm = 0.5 * reference.gamma * spotChange * spotChange;
    const vegaTerm = reference.vega * ivChange;
    const thetaTerm = -Math.abs(reference.theta) * elapsedDays;
    const expectedChange = deltaTerm + gammaTerm + vegaTerm + thetaTerm;
    const actualChange = currentOption.mid - reference.mid;
    return {
      actualChange,
      expectedChange,
      residual: actualChange - expectedChange,
      deltaTerm,
      gammaTerm,
      vegaTerm,
      thetaTerm
    };
  }

  function openingOptionReference(snapshots, strike, side) {
    const points = snapshots.map((snapshot) => {
      const row = snapshot.rows.find((item) => item.strike === strike);
      if (!row) return null;
      const option = side === "CE" ? row.ce : row.pe;
      return {
        time: snapshot.time,
        spot: snapshot.spot,
        oi: option.oi,
        mid: option.mid,
        delta: option.delta,
        gamma: option.gamma,
        theta: option.theta,
        vega: option.vega,
        iv: option.iv
      };
    }).filter(Boolean);
    if (points.length < 3) return null;
    return {
      time: median(points.map((item) => item.time)),
      spot: median(points.map((item) => item.spot)),
      oi: median(points.map((item) => item.oi)),
      mid: median(points.map((item) => item.mid)),
      delta: median(points.map((item) => item.delta)),
      gamma: median(points.map((item) => item.gamma)),
      theta: median(points.map((item) => item.theta)),
      vega: median(points.map((item) => item.vega)),
      iv: median(points.map((item) => item.iv))
    };
  }

  function snapshotOptionReference(snapshot, strike, side) {
    if (!snapshot) return null;
    const row = snapshot.rows.find((item) => item.strike === strike);
    if (!row) return null;
    const option = side === "CE" ? row.ce : row.pe;
    return {
      time: snapshot.time,
      spot: snapshot.spot,
      oi: option.oi,
      mid: option.mid,
      delta: option.delta,
      gamma: option.gamma,
      theta: option.theta,
      vega: option.vega,
      iv: option.iv
    };
  }

  function readContractFlow(windows) {
    const open = windows.open;
    const recent = windows["300"];
    const medium = windows["900"];
    const long = windows["1800"];
    if (!open.available || !recent.available) return { state: "Building", tone: "building" };
    if (!medium.available) {
      if (open.oiChange > 0 && recent.oiChange > 0 && (open.materialOi || recent.materialOi)) {
        return { state: "Addition building", tone: "warn" };
      }
      if (open.oiChange < 0 && recent.oiChange < 0 && (open.materialOi || recent.materialOi)) {
        return { state: "Withdrawal building", tone: "warn" };
      }
      return { state: "History building", tone: "building" };
    }
    const availableTrend = [recent, medium, long].filter((item) => item.available);
    const allPositive = open.oiChange > 0 && availableTrend.every((item) => item.oiChange > 0);
    const allNegative = open.oiChange < 0 && availableTrend.every((item) => item.oiChange < 0);
    const material = [open, ...availableTrend].some((item) => item.materialOi);
    if (allPositive && material) return { state: "Sustained addition", tone: "positive" };
    if (allNegative && material) return { state: "Sustained withdrawal", tone: "negative" };
    if (open.oiChange > 0 && recent.oiChange < 0) return { state: "Session add · recent withdrawal", tone: "warn" };
    if (open.oiChange < 0 && recent.oiChange > 0) return { state: "Session exit · recent addition", tone: "warn" };
    return { state: "Mixed inventory", tone: "neutral" };
  }

  function detectMicroRange(latest) {
    const candles = state.candles5m.length ? state.candles5m : buildSnapshotFiveMinuteCandles(latest.time);
    const sessionDate = istSessionDate(latest.time);
    const sessionCandles = candles.filter((candle) => istSessionDate(candle.start) === sessionDate);
    for (let length = sessionCandles.length; length >= 4; length -= 1) {
      const recent = sessionCandles.slice(-length);
      const high = Math.max(...recent.map((candle) => candle.high));
      const low = Math.min(...recent.map((candle) => candle.low));
      const width = high - low;
      if (width <= 0 || width > MAX_CONFIRMED_RANGE_POINTS) continue;
      const upperBoundary = low + width * 0.8;
      const lowerBoundary = low + width * 0.2;
      const upperTouches = recent.filter((candle) => candle.high >= upperBoundary).length;
      const lowerTouches = recent.filter((candle) => candle.low <= lowerBoundary).length;
      const directionChanges = recent.slice(2).reduce((count, candle, index) => {
        const previousMove = recent[index + 1].close - recent[index].close;
        const currentMove = candle.close - recent[index + 1].close;
        return count + (previousMove && currentMove && Math.sign(previousMove) !== Math.sign(currentMove) ? 1 : 0);
      }, 0);
      if (upperTouches >= 2 && lowerTouches >= 2 && directionChanges >= 2) {
        return {
          low,
          high,
          width,
          minutes: length * 5,
          startedAt: recent[0].start,
          upperTouches,
          lowerTouches,
          directionChanges
        };
      }
    }
    return null;
  }

  function structureLocation(spot, support, resistance, step, microRange) {
    const nearDistance = step / 2;
    const supportDistance = support ? Math.abs(spot - support) : Infinity;
    const resistanceDistance = resistance ? Math.abs(resistance - spot) : Infinity;
    if (supportDistance <= nearDistance && supportDistance <= resistanceDistance) return microRange ? "MICRO-RANGE AT SUPPORT" : "NEAR SUPPORT";
    if (resistanceDistance <= nearDistance) return microRange ? "MICRO-RANGE AT RESISTANCE" : "NEAR RESISTANCE";
    if (microRange) return "MICRO-RANGE";
    return "BETWEEN OI WALLS";
  }

  function buildSessionOrigin(latest, openingSnapshots, supportWall, resistanceWall, step) {
    if (openingSnapshots.length < 3 || !supportWall || !resistanceWall) {
      return "Opening inventory building · need valid 09:15–09:20 snapshots";
    }
    const openingSpot = latest.dayOpen || median(openingSnapshots.map((snapshot) => snapshot.spot));
    const gap = latest.previousClose ? openingSpot - latest.previousClose : null;
    const gapText = gap === null ? "Previous close unavailable" : gap >= 0 ? `Gap Up ${price(Math.abs(gap), 0)} pts` : `Gap Down ${price(Math.abs(gap), 0)} pts`;
    const supportDistance = Math.abs(openingSpot - supportWall.strike);
    const resistanceDistance = Math.abs(resistanceWall.strike - openingSpot);
    const nearDistance = step / 2;
    let location = "Opened between OI walls";
    if (openingSpot < supportWall.strike) location = `Opened below ${price(supportWall.strike, 0)} support`;
    else if (openingSpot > resistanceWall.strike) location = `Opened above ${price(resistanceWall.strike, 0)} resistance`;
    else if (supportDistance <= nearDistance && supportDistance <= resistanceDistance) location = `Opened near ${price(supportWall.strike, 0)} support`;
    else if (resistanceDistance <= nearDistance) location = `Opened near ${price(resistanceWall.strike, 0)} resistance`;
    return `${gapText} · ${location} · immediate max OI inside nearest ${IMMEDIATE_WALL_STRIKES} strikes; major walls scan ATM ±${WALL_SCAN_STRIKES}`;
  }

  function interpretMarketStructure(input) {
    const { latest, step, support, resistance, contracts, microRange, location, openingReady } = input;
    const supportPe = findStructureContract(contracts, support, "PE");
    const resistanceCe = findStructureContract(contracts, resistance, "CE");
    const atmPe = findStructureContract(contracts, latest.atmStrike, "PE");
    const atmCe = findStructureContract(contracts, latest.atmStrike, "CE");
    const supportFlow = supportPe ? supportPe.flow : { state: "Building" };
    const resistanceFlow = resistanceCe ? resistanceCe.flow : { state: "Building" };
    const supportPremium = contractPremiumRead(supportPe);
    const resistancePremium = contractPremiumRead(resistanceCe);
    const atmPePremium = contractPremiumRead(atmPe);
    const atmCePremium = contractPremiumRead(atmCe);
    const supportAdding = supportFlow.state === "Sustained addition";
    const supportWithdrawing = supportFlow.state === "Sustained withdrawal" || supportFlow.state.includes("recent withdrawal");
    const resistanceAdding = resistanceFlow.state === "Sustained addition";
    const resistanceWithdrawing = resistanceFlow.state === "Sustained withdrawal" || resistanceFlow.state.includes("recent withdrawal");
    const atmPeAdding = atmPe && atmPe.flow.state === "Sustained addition";
    const atmPeWithdrawing = atmPe && (atmPe.flow.state === "Sustained withdrawal" || atmPe.flow.state.includes("recent withdrawal"));
    const atmCeAdding = atmCe && atmCe.flow.state === "Sustained addition";
    const atmCeWithdrawing = atmCe && (atmCe.flow.state === "Sustained withdrawal" || atmCe.flow.state.includes("recent withdrawal"));
    const supportSuppressed = supportPremium === "Suppressed";
    const resistanceSuppressed = resistancePremium === "Suppressed";
    const peLeading = supportPremium === "Leading" || atmPePremium === "Leading";
    const ceLeading = resistancePremium === "Leading" || atmCePremium === "Leading";
    const upsideGroups = [
      supportAdding && resistanceWithdrawing,
      atmPeAdding || atmCeWithdrawing,
      ceLeading || supportSuppressed
    ];
    const downsideGroups = [
      resistanceAdding && supportWithdrawing,
      atmCeAdding || atmPeWithdrawing,
      peLeading || resistanceSuppressed
    ];
    const upsideAgreement = upsideGroups.filter(Boolean).length;
    const downsideAgreement = downsideGroups.filter(Boolean).length;
    const dataReady = openingReady && supportPe && resistanceCe && contracts.some((contract) => contract.windows["300"].available);

    let stateLabel = "DATA BUILDING";
    let decision = "WAIT FOR EXACT HISTORY";
    let tone = "building";
    if (dataReady && location.includes("SUPPORT")) {
      if (supportAdding && supportSuppressed && atmCeWithdrawing && ceLeading) {
        stateLabel = "SUPPORT DEFENDED";
        decision = "SUPPORT DEFENDED · UPSIDE RELEASE";
        tone = "positive";
      } else if (supportAdding && atmCeAdding && atmCePremium === "Suppressed") {
        stateLabel = "SUPPORT HELD";
        decision = "SUPPORT HELD · BOUNCE CAPPED";
        tone = "warn";
      } else if (supportWithdrawing && (atmCeAdding || atmPeWithdrawing) && peLeading) {
        stateLabel = "SUPPORT WITHDRAWAL";
        decision = "BREAKDOWN PRESSURE";
        tone = "negative";
      } else {
        stateLabel = "SUPPORT TEST";
        decision = "SUPPORT TEST · EVIDENCE BUILDING";
        tone = "warn";
      }
    } else if (dataReady && location.includes("RESISTANCE")) {
      if (resistanceAdding && resistanceSuppressed && atmPeWithdrawing && peLeading) {
        stateLabel = "CEILING DEFENDED";
        decision = "CEILING DEFENDED · DOWNSIDE RELEASE";
        tone = "negative";
      } else if (resistanceAdding && atmPeAdding && atmPePremium === "Suppressed") {
        stateLabel = "CEILING HELD";
        decision = "CEILING HELD · RANGE LOCK";
        tone = "warn";
      } else if (resistanceWithdrawing && (atmPeAdding || atmCeWithdrawing) && ceLeading) {
        stateLabel = "CEILING WITHDRAWAL";
        decision = "BREAKOUT PRESSURE";
        tone = "positive";
      } else {
        stateLabel = "RESISTANCE TEST";
        decision = "RESISTANCE TEST · EVIDENCE BUILDING";
        tone = "warn";
      }
    } else if (dataReady && microRange) {
      if (upsideAgreement === 3 && upsideAgreement > downsideAgreement) {
        stateLabel = "MICRO-RANGE";
        decision = "RANGE PRESSURE UP";
        tone = "positive";
      } else if (downsideAgreement === 3 && downsideAgreement > upsideAgreement) {
        stateLabel = "MICRO-RANGE";
        decision = "RANGE PRESSURE DOWN";
        tone = "negative";
      } else if (supportAdding && resistanceAdding && supportSuppressed && resistanceSuppressed) {
        stateLabel = "MICRO-RANGE";
        decision = "RANGE LOCKED · BUYER EDGE ABSENT";
        tone = "warn";
      } else if (supportWithdrawing && resistanceWithdrawing) {
        stateLabel = "MICRO-RANGE";
        decision = "EXPANSION ARMED · DIRECTION PENDING";
        tone = "warn";
      } else {
        stateLabel = "MICRO-RANGE";
        decision = "RANGE MIXED · WAIT";
        tone = "neutral";
      }
    } else if (dataReady) {
      if (upsideAgreement === 3 && upsideAgreement > downsideAgreement) {
        stateLabel = "BETWEEN WALLS";
        decision = "STRUCTURE TILTING UP";
        tone = "positive";
      } else if (downsideAgreement === 3 && downsideAgreement > upsideAgreement) {
        stateLabel = "BETWEEN WALLS";
        decision = "STRUCTURE TILTING DOWN";
        tone = "negative";
      } else if (supportAdding && resistanceAdding && supportSuppressed && resistanceSuppressed) {
        stateLabel = "BETWEEN WALLS";
        decision = "TWO-SIDED WRITING · RANGE RISK";
        tone = "warn";
      } else {
        stateLabel = "BETWEEN WALLS";
        decision = "INVENTORY MIXED · WAIT";
        tone = "neutral";
      }
    }

    const bullish = tone === "positive";
    const bearish = tone === "negative";
    const trigger = bullish
      ? microRange ? microRange.high : support ? support + step / 2 : resistance
      : bearish
        ? microRange ? microRange.low : resistance ? resistance - step / 2 : support
        : 0;
    const invalidation = bullish
      ? microRange ? microRange.low : support ? support - step / 2 : 0
      : bearish
        ? microRange ? microRange.high : resistance ? resistance + step / 2 : 0
        : 0;
    const evidence = [
      {
        label: "Support PE",
        value: `${supportPe ? supportPe.inventory.label : "Flow building"} · ${supportFlow.state.toLowerCase()} · premium ${supportPremium.toLowerCase()}`,
        tone: supportPe ? supportPe.inventory.tone : "neutral"
      },
      {
        label: "ATM Inventory",
        value: `${atmPe ? atmPe.inventory.label : "PE building"} · ${atmCe ? atmCe.inventory.label : "CE building"}`,
        tone: evidenceTone(atmPeAdding || atmCeWithdrawing, atmPeWithdrawing || atmCeAdding)
      },
      {
        label: "Resistance CE",
        value: `${resistanceCe ? resistanceCe.inventory.label : "Flow building"} · ${resistanceFlow.state.toLowerCase()} · premium ${resistancePremium.toLowerCase()}`,
        tone: resistanceCe ? resistanceCe.inventory.tone : "neutral"
      }
    ];
    const supportFive = supportPe && supportPe.windows["300"].available ? supportPe.windows["300"] : null;
    return {
      state: stateLabel,
      decision,
      tone,
      headline: `${location} · ${microRange ? `${price(microRange.low, 0)}–${price(microRange.high, 0)} · ${microRange.minutes}m confirmed range` : `nearest-11-strike OI levels · major walls kept as context`}`,
      evidence,
      trigger,
      invalidation,
      peOi: supportFive ? supportFive.oiChange : null,
      pePremium: supportFive ? supportFive.premiumChange : null,
      atmResponse: `${Math.max(upsideAgreement, downsideAgreement)}/3 evidence groups`,
      note: evidence.map((item) => `${item.label}: ${item.value}`).join(" · ")
    };
  }

  function findStructureContract(contracts, strike, side) {
    return contracts.find((contract) => contract.strike === strike && contract.side === side) || null;
  }

  function contractPremiumRead(contract) {
    if (!contract) return "Building";
    const windowRead = contract.windows["300"].available ? contract.windows["300"] : contract.windows["900"];
    if (!windowRead || !windowRead.available || !windowRead.materialResidual) return "Neutral";
    if (windowRead.residual < 0) return "Suppressed";
    if (windowRead.residual > 0) return "Leading";
    return "Neutral";
  }

  function evidenceTone(positiveEvidence, negativeEvidence) {
    if (positiveEvidence && !negativeEvidence) return "positive";
    if (negativeEvidence && !positiveEvidence) return "negative";
    return "neutral";
  }

  function stabilizeStructureRead(read, latest) {
    const candles = state.candles5m.length ? state.candles5m : buildSnapshotFiveMinuteCandles(latest.time);
    const lastWindowEnd = candles.length ? candles[candles.length - 1].end : Math.floor(latest.time / 300000) * 300000;
    const key = `${read.state}:${read.decision}:${read.support}:${read.resistance}`;
    if (state.structureStability.key !== key) {
      const restored = state.structureStability.key === null
        && state.sessionHydrated
        && Boolean(getOlderSnapshot(900))
        && Boolean(read.supportWall && read.supportWall.stable)
        && Boolean(read.resistanceWall && read.resistanceWall.stable);
      state.structureStability = {
        key,
        since: restored ? latest.time - 10 * 60 * 1000 : latest.time,
        windows: restored ? 2 : 0,
        lastWindowEnd,
        restored
      };
    } else if (lastWindowEnd > state.structureStability.lastWindowEnd) {
      state.structureStability.windows += 1;
      state.structureStability.lastWindowEnd = lastWindowEnd;
    }
    read.stability = { ...state.structureStability };
    return read;
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
      version: "calibration-v3",
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

  function recordCalibrationSnapshot(latest, active, structureRead) {
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
      callWall: structureRead.resistance || null,
      putWall: structureRead.support || null,
      structureState: structureRead.state,
      structureDecision: structureRead.decision,
      structureTone: structureRead.tone,
      structureTrigger: structureRead.trigger,
      structureInvalidation: structureRead.invalidation,
      supportPeOiChange: structureRead.peOi,
      supportPePremiumChange: structureRead.pePremium,
      spotChange: active.spotChange,
      straddleChange: active.straddleChange,
      ivChange: active.ivChange
    });
    state.calibration.snapshots = state.calibration.snapshots.slice(-900);
    return true;
  }

  function createStructureCalibrationSignal(structureRead, latest) {
    const bullishSetups = [
      "SUPPORT DEFENDED · UPSIDE RELEASE",
      "RANGE PRESSURE UP",
      "BREAKOUT PRESSURE",
      "STRUCTURE TILTING UP"
    ];
    const bearishSetups = [
      "CEILING DEFENDED · DOWNSIDE RELEASE",
      "RANGE PRESSURE DOWN",
      "BREAKDOWN PRESSURE",
      "STRUCTURE TILTING DOWN"
    ];
    const side = bullishSetups.includes(structureRead.decision)
      ? "CE"
      : bearishSetups.includes(structureRead.decision)
        ? "PE"
        : null;
    if (!side || !structureRead.stability || structureRead.stability.windows < 2) {
      state.calibration.lastActionState = null;
      state.calibration.ignored.nonActionable += 1;
      return;
    }

    if (state.calibration.lastActionState === structureRead.decision) {
      state.calibration.ignored.cooldown += 1;
      return;
    }

    const setupLevel = structureRead.trigger;
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
      setup: structureRead.decision,
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
      reason: structureRead.note,
      checks: {
        "180": null,
        "300": null,
        "600": null
      },
      result: "Pending"
    });
    state.calibration.lastActionState = structureRead.decision;
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
        <td>${escapeHtml(signal.setup || "Structure trigger")}</td>
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

  function signedPercent(value) {
    const numeric = number(value) * 100;
    const sign = numeric > 0 ? "+" : "";
    return `${sign}${numeric.toFixed(2)}%`;
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
