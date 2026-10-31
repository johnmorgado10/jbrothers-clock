// Payroll math tests against a fake Homeworks (respects date filters, includes a daylight-saving week).
const mem = new Map();
globalThis.__TEST_STORE__ = {
  get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
  setJSON: async (k, v) => mem.set(k, JSON.stringify(v)),
  delete: async (k) => mem.delete(k),
};
mem.set("oauth-client", JSON.stringify({ clientId: "c" }));
mem.set("tokens", JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600e3 }));

const users = [
  { id: 1, firstName: "Juan", lastName: "M", role: "OWNER", rate: "0", inactiveDate: null },
  { id: 2, firstName: "Pablo", lastName: "Q", role: "EMPLOYEE", rate: "16.5", inactiveDate: null },
  { id: 3, firstName: "Rolando", lastName: "R", role: "EMPLOYEE", rate: "16", inactiveDate: null },
  { id: 4, firstName: "Jose", lastName: "V", role: "EMPLOYEE", rate: "15", inactiveDate: null },
  { id: 5, firstName: "John", lastName: "MM", role: "EMPLOYEE", rate: "16.5", inactiveDate: null },
  { id: 6, firstName: "Gone", lastName: "Guy", role: "EMPLOYEE", rate: "16", inactiveDate: "2025-01-01" },
];
let id = 1;
const E = (userId, s, e, notes = null) => ({ id: id++, userId, startedAt: s, endedAt: e, notes });
const entries = [
  // Week Mon Oct 19 – Sun Oct 25, 2026 (EDT = UTC-4)
  E(2, "2026-10-19T11:00:00Z", "2026-10-19T15:45:00Z", "Before 30 min of 30 min lunch deducted (shop clock)"), // Mon 7:00–11:45
  E(2, "2026-10-19T16:15:00Z", "2026-10-19T20:30:00Z", "After 30 min of 30 min lunch deducted (shop clock)"),  // 12:15–4:30 → 9.0 h
  E(2, "2026-10-20T11:02:00Z", "2026-10-20T15:00:00Z"), // Tue overlapping timers → union 7:02–4:15 = 9.2167
  E(2, "2026-10-20T14:00:00Z", "2026-10-20T20:15:00Z"),
  E(2, "2026-10-21T11:00:00Z", "2026-10-21T19:45:00Z"), // Wed 7:00–3:45 = 8.75, clocked out outside kiosk → "?"
  E(2, "2026-10-22T11:00:00Z", "2026-10-23T03:59:59Z"), // Thu forgot to clock out → midnight
  E(2, "2026-10-24T13:00:00Z", "2026-10-24T14:00:00Z"), // Sat 1 h → short day
  E(4, "2026-10-19T11:00:00Z", "2026-10-19T19:30:00Z"), // Jose Mon 8.5
  E(5, "2026-10-20T12:00:00Z", "2026-10-20T20:00:00Z"), // John Tue 8
  E(1, "2026-10-20T12:00:00Z", "2026-10-20T20:00:00Z"), // owner, never in payroll
  // DST week Mon Oct 26 – Sun Nov 1 (clocks fall back Sun Nov 1, 2am)
  E(3, "2026-10-31T03:30:00Z", "2026-10-31T03:45:00Z"), // Fri Oct 30 11:30 PM EDT → Friday
  E(3, "2026-11-01T14:00:00Z", "2026-11-01T16:00:00Z"), // Sun Nov 1 9:00 AM EST
  E(3, "2026-11-02T04:30:00Z", "2026-11-02T04:45:00Z"), // Sun Nov 1 11:30 PM EST → still this week
  E(3, "2026-11-02T05:30:00Z", "2026-11-02T06:00:00Z"), // Mon Nov 2 12:30 AM EST → next week
  // 2027 for year-to-date
  E(4, "2027-01-01T12:00:00Z", "2027-01-01T20:00:00Z"), // Fri Jan 1: 8 h (week of Dec 28)
  E(4, "2027-01-04T12:00:00Z", "2027-01-04T21:00:00Z"), // Mon Jan 4: 9 h
  E(4, "2027-01-05T12:00:00Z", "2027-01-05T20:30:00Z"), // Tue Jan 5: 8.5 h
  E(4, "2026-12-31T12:00:00Z", "2026-12-31T20:00:00Z"), // Dec 31, 2026: not in 2027 YTD
];
// Punch log: shop clock started Oct 20; Pablo said "No" to lunch Tue
mem.set("punches", JSON.stringify([
  { at: "2026-10-20T11:00:00Z", userId: 2, action: "in", source: "shop" },
  { at: "2026-10-20T20:15:00Z", userId: 2, action: "out", lunch: false, lunchOk: null, source: "shop", clockOutAt: "2026-10-20T20:15:00Z" },
]));

globalThis.fetch = async (url, opts = {}) => {
  const reply = (o) => new Response(JSON.stringify(o), { status: 200 });
  const { query, variables: v } = JSON.parse(opts.body);
  if (query.includes("users(")) return reply({ data: { users } });
  if (query.includes("timeEntries(")) {
    const from = Date.parse(v.from), to = Date.parse(v.to);
    return reply({ data: { timeEntries: entries.filter((e) => Date.parse(e.startedAt) >= from && Date.parse(e.startedAt) < to) } });
  }
  return reply({ errors: [{ message: "unmocked" }] });
};

const P = await import("../netlify/lib/payroll.mjs");
let ok = 0, fail = 0;
const t = (name, cond, extra) => { cond ? ok++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(extra))); };
const near = (a, b) => Math.abs(a - b) < 0.00005;

// Date helpers
t("midnight EDT Nov 1", new Date(P.startOfDay("2026-11-01")).toISOString() === "2026-11-01T04:00:00.000Z", new Date(P.startOfDay("2026-11-01")).toISOString());
t("midnight EST Nov 2", new Date(P.startOfDay("2026-11-02")).toISOString() === "2026-11-02T05:00:00.000Z", new Date(P.startOfDay("2026-11-02")).toISOString());
t("midnight EDT Mar 8 2026 (spring forward)", new Date(P.startOfDay("2026-03-08")).toISOString() === "2026-03-08T05:00:00.000Z", new Date(P.startOfDay("2026-03-08")).toISOString());
t("midnight EDT Mar 9 2026", new Date(P.startOfDay("2026-03-09")).toISOString() === "2026-03-09T04:00:00.000Z");
t("mondayOf Sunday", P.mondayOf("2026-11-01") === "2026-10-26");
t("mondayOf Monday", P.mondayOf("2026-10-19") === "2026-10-19");
t("default week on Thursday = last week", P.defaultWeek(Date.parse("2026-10-29T15:00:00Z")) === "2026-10-19");
t("default week on Monday = last week", P.defaultWeek(Date.parse("2026-11-02T15:00:00Z")) === "2026-10-26");

// Check words
t("words 693", P.dollarsInWords(693) === "Six hundred ninety-three and 00/100 dollars", P.dollarsInWords(693));
t("words 640", P.dollarsInWords(640) === "Six hundred forty and 00/100 dollars");
t("words 1015", P.dollarsInWords(1015) === "One thousand fifteen and 00/100 dollars", P.dollarsInWords(1015));
t("words 12", P.dollarsInWords(12) === "Twelve and 00/100 dollars");
t("words 2300", P.dollarsInWords(2300) === "Two thousand three hundred and 00/100 dollars", P.dollarsInWords(2300));
t("words rounds 577.5 → 578", P.dollarsInWords(577.5) === "Five hundred seventy-eight and 00/100 dollars", P.dollarsInWords(577.5));

// Weekly payroll
const now = Date.parse("2026-10-29T15:00:00Z");
let W = await P.payrollWeek("2026-10-21", { pins: { 2: {}, 3: {}, 4: {} }, nowMs: now }); // any day snaps to its Monday
t("week snaps to Monday", W.week === "2026-10-19" && W.weekEnd === "2026-10-25" && W.payDay === "2026-10-29", W);
const names = W.workers.map((w) => w.name);
t("owner + inactive excluded, John (hours, no PIN) included, Rolando (PIN, no hours) included", !names.includes("Juan M") && !names.includes("Gone Guy") && names.includes("John MM") && names.includes("Rolando R"), names);
const pablo = W.workers.find((w) => w.id === 2);
const d = Object.fromEntries(pablo.days.map((x) => [x.weekday, x]));
t("Mon 9.0 with lunch Yes", near(d.Mon.hours, 9) && d.Mon.lunch === "Yes" && d.Mon.in === "7:00 AM" && d.Mon.out === "4:30 PM", d.Mon);
t("Tue overlaps counted once (9.2167), lunch No", near(d.Tue.hours, 9.2167) && d.Tue.lunch === "No", d.Tue);
t("Wed lunch unknown + flagged", d.Wed.lunch === "?" && d.Wed.flags.some((f) => f.includes("Check lunch")), d.Wed);
t("Thu midnight flagged once (no extra long-day/lunch flags)", d.Thu.flags.length === 1 && d.Thu.flags[0].includes("midnight"), d.Thu);
t("Sat short day flagged", d.Sat.flags.some((f) => f.includes("Short day")), d.Sat);
t("Fri/Sun off", d.Fri.off && d.Sun.off);
const expTotal = 9 + 9.216666667 + 8.75 + (16 + 59 / 60 + 59 / 3600) + 1;
t("weekly total (4 dp)", near(pablo.total, Math.round(expTotal * 10000) / 10000), { got: pablo.total, exp: expTotal });
t("pay = total × 16.5, rounded + words", pablo.rounded === Math.round(pablo.total * 16.5) && pablo.words.endsWith("and 00/100 dollars") && near(pablo.pay, Math.round(pablo.total * 16.5 * 100) / 100), pablo);
t("flags listed for review (Wed lunch, Thu midnight, Sat lunch + short)", pablo.flags.length === 4, pablo.flags);
const jose = W.workers.find((w) => w.id === 4);
t("Jose 8.5 × 15 = $128 (127.50 rounds up)", near(jose.total, 8.5) && jose.rounded === 128 && jose.words === "One hundred twenty-eight and 00/100 dollars", jose);
const rol = W.workers.find((w) => w.id === 3);
t("Rolando 0 hours", rol.total === 0 && rol.rounded === 0);
t("no YTD before 2027", W.ytd === null);

// Hidden workers drop out of totals
const allPay = W.totals.pay;
W = await P.payrollWeek("2026-10-19", { pins: { 2: {}, 3: {}, 4: {} }, hidden: [5], nowMs: now });
t("hidden John excluded from totals", W.workers.find((w) => w.id === 5).hidden && W.totals.pay === allPay - W.workers.find((w) => w.id === 5).rounded, { allPay, now: W.totals.pay });

// DST week
W = await P.payrollWeek("2026-10-26", { pins: { 3: {} }, nowMs: Date.parse("2026-11-05T15:00:00Z") });
const r3 = Object.fromEntries(W.workers.find((w) => w.id === 3).days.map((x) => [x.weekday, x]));
t("DST: Fri 11:30 PM EDT stays Friday", near(r3.Fri.hours, 0.25), r3.Fri);
t("DST: Sunday has 9 AM + 11:30 PM EST entries (2.25 h)", near(r3.Sun.hours, 2.25) && r3.Sun.in === "9:00 AM", r3.Sun);
t("DST: Mon Nov 2 12:30 AM not in this week", W.workers.find((w) => w.id === 3).days.every((x) => x.date <= "2026-11-01"));

// Running timer today vs. past day
entries.push(E(4, "2026-10-29T11:00:00Z", null));
W = await P.payrollWeek("2026-10-26", { pins: { 4: {} }, nowMs: Date.parse("2026-10-29T15:00:00Z") });
const jThu = W.workers.find((w) => w.id === 4).days.find((x) => x.weekday === "Thu");
t("on the clock today: not flagged", jThu.out === "On clock" && !jThu.flags.some((f) => f.includes("Never")), jThu);
W = await P.payrollWeek("2026-10-26", { pins: { 4: {} }, nowMs: Date.parse("2026-11-03T15:00:00Z") });
const jThu2 = W.workers.find((w) => w.id === 4).days.find((x) => x.weekday === "Thu");
t("still running days later: flagged", jThu2.flags.some((f) => f.includes("Never clocked out")), jThu2);
entries.pop();

// Year to date (2027)
W = await P.payrollWeek("2027-01-04", { pins: { 4: {} }, nowMs: Date.parse("2027-01-14T15:00:00Z") });
const y = W.ytd && W.ytd.workers[4];
t("YTD starts Jan 1 2027: 8 + 9 + 8.5 = 25.5 h, pay = $120 + $263 = $383", y && near(y.hours, 25.5) && y.pay === 120 + Math.round(17.5 * 15), y);

// Averages
const A = await P.averages("2026-10-19", "2026-10-25", { nowMs: now });
const ap = A.workers.find((w) => w.id === 2);
t("averages: forgotten clock-out day left out (Pablo 4 days)", ap.days === 4 && A.skipped === 1 && near(ap.perDay, ap.total / 4) && near(ap.perWeek, ap.total), { ap, skipped: A.skipped });
t("averages: Rolando (no days) left out", !A.workers.some((w) => w.id === 3));
const sumT = A.workers.reduce((s, w) => s + w.total, 0), sumD = A.workers.reduce((s, w) => s + w.days, 0);
t("crew per day = all hours / all days", near(A.crew.perDay, Math.round(sumT / sumD * 10000) / 10000), A.crew);
const A2 = await P.averages("2026-10-12", "2026-10-25", { nowMs: now, hidden: [5] });
t("2-week range halves per-week; hidden excluded", Math.abs(A2.workers.find((w) => w.id === 2).perWeek - ap.total / 2) < 0.0002 && !A2.workers.some((w) => w.id === 5), A2);

console.log(`\n${ok} passed, ${fail} failed`);
