// Weekly payroll and averages, built from Homeworks time entries.
// Weeks run Monday–Sunday in Eastern time. Daily hours = time actually on the clock
// (overlapping timers counted once, lunch gaps already cut out by the shop clock).
import { gql } from "./homeworks.mjs";
import { getJSON } from "./store.mjs";

export const TZ = "America/New_York";
const YTD_FIRST_YEAR = 2027;
const LONG_DAY_HOURS = 12;
const SHORT_DAY_HOURS = 2;

// ---------- Eastern-time date helpers (safe across daylight-saving changes) ----------

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function zoneParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}
function offsetMs(ms) {
  const p = zoneParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}
// Midnight Eastern at the start of a "YYYY-MM-DD" date, as a UTC timestamp.
export function startOfDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(guess);
  const again = guess - offsetMs(t);
  if (again !== t) t = again;
  return t;
}
export function dateKey(ms) {
  const p = zoneParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function weekday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}
export function mondayOf(dateStr) {
  const wd = weekday(dateStr);
  return addDays(dateStr, wd === 0 ? -6 : 1 - wd);
}
// The week you pay for this Thursday = last week.
export function defaultWeek(nowMs = Date.now()) {
  return addDays(mondayOf(dateKey(nowMs)), -7);
}
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- check amount in words ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "")); }
  else if (n > 0) out.push(ONES[n]);
  return out.join(" ");
}
export function dollarsInWords(amount) {
  const n = Math.round(amount);
  let text;
  if (n === 0) text = "zero";
  else {
    const parts = [];
    const millions = Math.floor(n / 1e6), thousands = Math.floor((n % 1e6) / 1000), rest = n % 1000;
    if (millions) parts.push(`${under1000(millions)} million`);
    if (thousands) parts.push(`${under1000(thousands)} thousand`);
    if (rest) parts.push(under1000(rest));
    text = parts.join(" ");
  }
  return `${text[0].toUpperCase()}${text.slice(1)} and 00/100 dollars`;
}

// ---------- data ----------

const r4 = (x) => Math.round(x * 10000) / 10000;
const r2 = (x) => Math.round(x * 100) / 100;

async function fetchEntries(fromMs, toMs) {
  const data = await gql(
    `query($from: DateTime!, $to: DateTime!) { timeEntries(where: { startedAt: { gte: $from, lt: $to } }, take: 50000) { id userId startedAt endedAt notes } }`,
    { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }
  );
  return data.timeEntries.filter((e) => {
    const t = Date.parse(e.startedAt);
    return t >= fromMs && t < toMs;
  });
}

async function fetchPeople() {
  const data = await gql(`{ users(where: { isDeleted: false }) { id firstName lastName role rate inactiveDate } }`);
  return data.users.map((u) => ({
    id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role, rate: Number(u.rate) || 0, inactive: !!u.inactiveDate,
  }));
}

// Groups entries into worked days: { userId: { "YYYY-MM-DD": [entries] } }
function groupByDay(entries) {
  const out = {};
  for (const e of entries) {
    const day = dateKey(Date.parse(e.startedAt));
    ((out[e.userId] ||= {})[day] ||= []).push(e);
  }
  return out;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
}

// One worked day → IN, OUT, hours, lunch, problems.
function summarizeDay(day, list, punches, trackingStart, todayKey) {
  const ivals = list
    .map((e) => [Date.parse(e.startedAt), e.endedAt ? Date.parse(e.endedAt) : null, e])
    .sort((a, b) => a[0] - b[0]);
  const running = ivals.some(([, end]) => end === null);
  let secs = 0, curS = null, curE = null;
  for (const [s, e] of ivals) {
    if (e === null) continue;
    if (curE === null || s > curE) { if (curE !== null) secs += (curE - curS) / 1000; curS = s; curE = e; }
    else if (e > curE) curE = e;
  }
  if (curE !== null) secs += (curE - curS) / 1000;
  const inMs = ivals[0][0];
  const ends = ivals.map(([, e]) => e).filter((e) => e !== null);
  const outMs = running || !ends.length ? null : Math.max(...ends);

  const flags = [];
  const hours = secs / 3600;
  // Lunch
  const deducted = list.some((e) => String(e.notes || "").includes("lunch deducted"));
  const dayPunches = punches.filter((p) => p.action === "out" && p.clockOutAt && dateKey(Date.parse(p.clockOutAt)) === day);
  let lunch = "";
  if (deducted) lunch = "Yes";
  else if (dayPunches.some((p) => p.lunch && p.lunchOk === false)) { lunch = "Yes"; flags.push("Said yes to lunch, but it wasn't taken off. Fix in Homeworks."); }
  else if (dayPunches.length && dayPunches.every((p) => !p.lunch)) lunch = "No";
  const midnight = list.some((e) => e.endedAt && /^23:59/.test(clockTime24(Date.parse(e.endedAt))));
  if (running && day < todayKey) flags.push("Never clocked out.");
  if (midnight) flags.push("Timer stopped at midnight. Probably forgot to clock out.");
  // One flag is enough for a forgotten clock-out day; the lunch check would just add noise.
  if (!lunch && trackingStart && day >= trackingStart && !running) {
    lunch = "?";
    if (!midnight) flags.push("Clocked out outside the shop clock. Check lunch.");
  }
  if (!running && !midnight && hours > LONG_DAY_HOURS) flags.push(`Long day (${hours.toFixed(1)} h).`);
  if (!running && hours > 0 && hours < SHORT_DAY_HOURS) flags.push(`Short day (${hours.toFixed(1)} h).`);

  return {
    date: day, weekday: DAY_NAMES[weekday(day)], in: clockTime(inMs), out: outMs ? clockTime(outMs) : running ? "On clock" : "—",
    hours: r4(hours), raw: hours, lunch, flags, running, midnight,
  };
}
const fmt24 = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
function clockTime24(ms) { return fmt24.format(new Date(ms)); }

async function trackingStartDay(punches) {
  if (!punches.length) return null;
  return dateKey(Math.min(...punches.map((p) => Date.parse(p.at))));
}

// ---------- weekly payroll ----------

export async function payrollWeek(weekInput, { hidden = [], pins = {}, nowMs = Date.now() } = {}) {
  const week = mondayOf(weekInput || defaultWeek(nowMs));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const from = startOfDay(week), to = startOfDay(addDays(week, 7));
  const [people, entries, punches] = await Promise.all([fetchPeople(), fetchEntries(from, to), getJSON("punches", [])]);
  const trackingStart = await trackingStartDay(punches);
  const todayKey = dateKey(nowMs);
  const byDay = groupByDay(entries);

  const workers = [];
  for (const p of people) {
    if (p.role === "OWNER") continue;
    const mine = byDay[p.id] || {};
    if (!Object.keys(mine).length && (p.inactive || !pins[p.id])) continue;
    const myPunches = punches.filter((x) => x.userId === p.id);
    const rows = days.map((d) =>
      mine[d] ? summarizeDay(d, mine[d], myPunches, trackingStart, todayKey) : { date: d, weekday: DAY_NAMES[weekday(d)], in: "—", out: "—", hours: 0, raw: 0, lunch: "", flags: [], off: true }
    );
    const total = r4(rows.reduce((s, r) => s + r.raw, 0));
    const pay = r2(total * p.rate);
    rows.forEach((r) => { delete r.raw; delete r.midnight; });
    workers.push({
      id: p.id, name: p.name, rate: p.rate, days: rows, total, pay, rounded: Math.round(total * p.rate), words: dollarsInWords(total * p.rate),
      flags: rows.flatMap((r) => r.flags.map((f) => ({ date: r.date, weekday: r.weekday, text: f }))),
      hidden: hidden.includes(p.id), noRate: !p.rate,
    });
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));

  // Year-to-date (starts 2027): weekly rounded pay added up, at today's Homeworks rate.
  const weekEnd = addDays(week, 6);
  const year = Number(weekEnd.slice(0, 4));
  let ytd = null;
  if (year >= YTD_FIRST_YEAR) {
    const yStart = `${year}-01-01`;
    const ytdEntries = await fetchEntries(startOfDay(yStart), to);
    const ytdByDay = groupByDay(ytdEntries);
    ytd = { year, since: yStart, through: weekEnd, workers: {} };
    for (const w of workers) {
      const weeks = {};
      for (const [d, list] of Object.entries(ytdByDay[w.id] || {})) {
        const s = summarizeDay(d, list, [], null, todayKey);
        weeks[mondayOf(d)] = (weeks[mondayOf(d)] || 0) + s.raw;
      }
      const hours = r4(Object.values(weeks).reduce((a, b) => a + b, 0));
      const pay = Object.values(weeks).reduce((a, h) => a + Math.round(r4(h) * w.rate), 0);
      ytd.workers[w.id] = { hours, pay };
    }
  }

  const shown = workers.filter((w) => !w.hidden);
  return {
    week, weekEnd, payDay: addDays(week, 10), days,
    totals: { hours: r4(shown.reduce((s, w) => s + w.total, 0)), pay: shown.reduce((s, w) => s + w.rounded, 0) },
    workers, ytd,
  };
}

// ---------- averages ----------

export async function averages(fromDate, toDate, { hidden = [], nowMs = Date.now() } = {}) {
  const from = startOfDay(fromDate), to = startOfDay(addDays(toDate, 1));
  const [people, entries] = await Promise.all([fetchPeople(), fetchEntries(from, to)]);
  const byDay = groupByDay(entries);
  const todayKey = dateKey(nowMs);
  const nDays = Math.round((to - from) / 86400_000);
  const weeks = nDays / 7;

  const rows = [];
  let skipped = 0;
  for (const p of people) {
    if (p.role === "OWNER" || hidden.includes(p.id)) continue;
    const mine = byDay[p.id] || {};
    let total = 0, worked = 0;
    for (const [d, list] of Object.entries(mine)) {
      const s = summarizeDay(d, list, [], null, todayKey);
      if (s.running || s.raw <= 0) continue;
      if (s.midnight) { skipped++; continue; } // forgotten clock-out would throw off the average
      total += s.raw; worked++;
    }
    if (!worked) continue;
    rows.push({ id: p.id, name: p.name, days: worked, total: r4(total), perDay: r4(total / worked), perWeek: r4(total / weeks) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const sumDays = rows.reduce((s, r) => s + r.days, 0);
  const crew = rows.length
    ? { perDay: r4(rows.reduce((s, r) => s + r.total, 0) / sumDays), perWeek: r4(rows.reduce((s, r) => s + r.perWeek, 0) / rows.length) }
    : null;
  return { from: fromDate, to: toDate, weeks: r2(weeks), workers: rows, crew, skipped };
}
