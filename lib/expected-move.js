(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExpectedMove = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CALENDAR_DAYS = 365;

  function calculateSessionExpectedMove(sessionOpen, atmIvPct) {
    const anchor = Number(sessionOpen);
    const ivPct = Number(atmIvPct);
    if (!Number.isFinite(anchor) || anchor <= 0 || !Number.isFinite(ivPct) || ivPct <= 0) return null;

    const distance = anchor * (ivPct / 100) * Math.sqrt(1 / CALENDAR_DAYS);
    return {
      anchor,
      atmIvPct: ivPct,
      distance,
      lower: anchor - distance,
      upper: anchor + distance,
      calendarDays: CALENDAR_DAYS,
      formula: "session open x ATM IV x sqrt(1/365)"
    };
  }

  function classifyBoundary(boundary, wall, strikeStep, kind) {
    const expected = Number(boundary);
    const oiWall = Number(wall);
    const step = Math.max(1, Number(strikeStep) || 0);
    if (!Number.isFinite(expected) || !Number.isFinite(oiWall) || oiWall <= 0) {
      return { state: "unavailable", tone: "neutral", gap: null };
    }

    const gap = oiWall - expected;
    const aligned = Math.abs(gap) <= step / 2;
    if (aligned) return { state: "confluence", tone: kind === "upper" ? "negative" : "positive", gap };

    if (kind === "upper") {
      return gap < 0
        ? { state: "wall-inside", tone: "warn", gap }
        : { state: "wall-beyond", tone: "neutral", gap };
    }
    return gap > 0
      ? { state: "wall-inside", tone: "warn", gap }
      : { state: "wall-beyond", tone: "neutral", gap };
  }

  return { calculateSessionExpectedMove, classifyBoundary };
});
