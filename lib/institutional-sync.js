const { fetchLatestCash, fetchParticipantOi } = require("./nse-institutional");
const {
  attachCashReport,
  loadStoredInstitutionalDates,
  saveInstitutionalRecord
} = require("./institutional-store");

async function syncInstitutionalHistory(options = {}) {
  const lookbackDays = Math.max(7, Math.min(90, Number(options.lookbackDays) || 45));
  const stored = await loadStoredInstitutionalDates(lookbackDays + 5);
  const dates = calendarDatesBack(lookbackDays).filter((date) => !stored.has(date));
  const saved = [];
  const rejected = [];
  for (let index = 0; index < dates.length; index += 6) {
    const batch = dates.slice(index, index + 6);
    const reports = await Promise.all(batch.map(async (date) => {
      try {
        return await fetchParticipantOi(date);
      } catch (error) {
        rejected.push({ date, reason: error.message || "Invalid NSE report" });
        return null;
      }
    }));
    for (const report of reports.filter(Boolean)) {
      await saveInstitutionalRecord(report);
      saved.push(report.tradeDate);
    }
  }

  let cash = null;
  try {
    cash = await fetchLatestCash();
    if (cash) await attachCashReport(cash);
  } catch (error) {
    rejected.push({ date: "cash", reason: error.message || "NSE cash fetch failed" });
  }
  return { saved, cashDate: cash && cash.date, rejected };
}

function calendarDatesBack(days, at = new Date()) {
  const output = [];
  const anchor = new Date(at);
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(anchor.getTime() - offset * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    output.push(`${values.year}-${values.month}-${values.day}`);
  }
  return output;
}

module.exports = { calendarDatesBack, syncInstitutionalHistory };
