const NSE_ARCHIVE = "https://nsearchives.nseindia.com/content/nsccl";
const NSE_CASH_URL = "https://www.nseindia.com/api/fiidiiTradeReact";
const USER_AGENT = "Mozilla/5.0 (compatible; OptionBuyerCockpit/1.0)";

async function fetchParticipantOi(date, fetchImpl = fetch) {
  const dateText = isoDate(date);
  const url = `${NSE_ARCHIVE}/fao_participant_oi_${compactDate(dateText)}.csv`;
  const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/csv,*/*" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`NSE participant report request failed with ${response.status}`);
  const csv = await response.text();
  return parseParticipantOi(csv, dateText, url);
}

async function fetchLatestCash(fetchImpl = fetch) {
  const response = await fetchImpl(NSE_CASH_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`NSE cash report request failed with ${response.status}`);
  const rows = await response.json();
  const fii = rows.find((item) => String(item.category).toUpperCase().includes("FII"));
  const dii = rows.find((item) => String(item.category).toUpperCase() === "DII");
  if (!fii || !fii.date) return null;
  return {
    date: nseDateToIso(fii.date),
    fiiNet: number(fii.netValue),
    diiNet: dii ? number(dii.netValue) : null,
    sourceUrl: NSE_CASH_URL
  };
}

function parseParticipantOi(csv, expectedDate, sourceUrl = "") {
  const lines = String(csv || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 4) throw new Error("NSE participant OI report is incomplete");
  const title = lines[0].replace(/"/g, "");
  const titleDate = parseTitleDate(title);
  if (!titleDate || titleDate !== expectedDate) throw new Error(`NSE report date mismatch: expected ${expectedDate}, received ${titleDate || "unknown"}`);
  if (titleDate > istToday()) throw new Error(`Future-dated NSE report rejected: ${titleDate}`);
  const headers = parseCsvLine(lines[1]).map(cleanHeader);
  const rows = lines.slice(2).map(parseCsvLine).filter((row) => row.length >= headers.length - 1);
  const participants = {};
  rows.forEach((row) => {
    const type = String(row[0] || "").trim().toUpperCase();
    if (!type) return;
    participants[type] = Object.fromEntries(headers.slice(1).map((header, index) => [header, number(row[index + 1])]));
  });
  if (!participants.FII || !participants.TOTAL) throw new Error("FII or TOTAL row is missing from NSE participant report");
  validateTotals(participants.TOTAL);
  return {
    tradeDate: titleDate,
    verified: true,
    source: { participantOiUrl: sourceUrl, title },
    fii: mapParticipant(participants.FII),
    participants: Object.fromEntries(Object.entries(participants).map(([key, value]) => [key, mapParticipant(value)]))
  };
}

function mapParticipant(row) {
  return {
    futureIndexLong: row.futureIndexLong,
    futureIndexShort: row.futureIndexShort,
    futureStockLong: row.futureStockLong,
    futureStockShort: row.futureStockShort,
    optionIndexCallLong: row.optionIndexCallLong,
    optionIndexPutLong: row.optionIndexPutLong,
    optionIndexCallShort: row.optionIndexCallShort,
    optionIndexPutShort: row.optionIndexPutShort,
    optionStockCallLong: row.optionStockCallLong,
    optionStockPutLong: row.optionStockPutLong,
    optionStockCallShort: row.optionStockCallShort,
    optionStockPutShort: row.optionStockPutShort,
    totalLongContracts: row.totalLongContracts,
    totalShortContracts: row.totalShortContracts
  };
}

function validateTotals(total) {
  const pairs = [
    ["futureIndexLong", "futureIndexShort"],
    ["futureStockLong", "futureStockShort"],
    ["optionIndexCallLong", "optionIndexCallShort"],
    ["optionIndexPutLong", "optionIndexPutShort"],
    ["optionStockCallLong", "optionStockCallShort"],
    ["optionStockPutLong", "optionStockPutShort"],
    ["totalLongContracts", "totalShortContracts"]
  ];
  for (const [longKey, shortKey] of pairs) {
    if (Math.abs(number(total[longKey]) - number(total[shortKey])) > 1) {
      throw new Error(`NSE participant totals failed validation for ${longKey}/${shortKey}`);
    }
  }
}

function cleanHeader(value) {
  return String(value || "").trim().replace(/\s+/g, " ").replace(/[^a-zA-Z0-9]+(.)/g, (_, letter) => letter.toUpperCase()).replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

function parseCsvLine(line) {
  const output = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      output.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  output.push(value.trim());
  return output;
}

function parseTitleDate(title) {
  const match = String(title).match(/as on\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/i);
  if (!match) return null;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  return `${match[3]}-${months[match[1].toLowerCase()]}-${String(match[2]).padStart(2, "0")}`;
}

function nseDateToIso(value) {
  const match = String(value).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!match) return "";
  return parseTitleDate(`as on ${match[2]} ${match[1]}, ${match[3]}`);
}

function compactDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}${month}${year}`;
}

function isoDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function istToday() {
  return isoDate(new Date());
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = { NSE_CASH_URL, fetchLatestCash, fetchParticipantOi, parseParticipantOi };
