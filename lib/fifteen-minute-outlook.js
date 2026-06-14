(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FifteenMinuteOutlook = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function classifyFifteenMinuteOutlook(input) {
    const upGates = normalizeGates(input && input.upGates);
    const downGates = normalizeGates(input && input.downGates);
    const upAgreement = upGates.filter((gate) => gate.pass).length;
    const downAgreement = downGates.filter((gate) => gate.pass).length;

    if (!input || !input.ready) {
      return outlook("UNPROVEN", "building", "WAIT", 0, 4, input && input.reason || "Need exact current-expiry 15m history", upGates, downGates);
    }
    if (input.rangeLock && Math.max(upAgreement, downAgreement) < 3) {
      return outlook("RANGE HOLD", "warn", "RANGE", Math.max(upAgreement, downAgreement), 4,
        input.rangeText || "Two-sided inventory is containing spot", upGates, downGates);
    }
    if (upAgreement >= 3 && upAgreement > downAgreement) {
      return outlook(upAgreement === 4 ? "UPSIDE TEST" : "UP BIAS BUILDING", "positive",
        upAgreement === 4 ? "QUALIFIED" : "EARLY", upAgreement, 4,
        input.upText || "Upside evidence has a four-group majority", upGates, downGates);
    }
    if (downAgreement >= 3 && downAgreement > upAgreement) {
      return outlook(downAgreement === 4 ? "DOWNSIDE TEST" : "DOWN BIAS BUILDING", "negative",
        downAgreement === 4 ? "QUALIFIED" : "EARLY", downAgreement, 4,
        input.downText || "Downside evidence has a four-group majority", upGates, downGates);
    }
    return outlook("UNPROVEN", "neutral", "WAIT", Math.max(upAgreement, downAgreement), 4,
      input.mixedText || "Directional evidence is split or incomplete", upGates, downGates);
  }

  function normalizeGates(gates) {
    return Array.isArray(gates) ? gates.map((gate) => ({
      key: String(gate.key || "gate"),
      label: String(gate.label || gate.key || "Evidence"),
      pass: Boolean(gate.pass),
      detail: String(gate.detail || "")
    })) : [];
  }

  function outlook(state, tone, stage, agreement, total, reason, upGates, downGates) {
    const direction = tone === "positive" ? "up" : tone === "negative" ? "down" : tone === "warn" ? "range" : null;
    return { state, tone, stage, direction, agreement, total, reason, upGates, downGates };
  }

  return { classifyFifteenMinuteOutlook };
});
