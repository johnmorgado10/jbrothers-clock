// Local test: in-memory storage + fake Homeworks API.
const mem = new Map();
globalThis.__TEST_STORE__ = {
  get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
  setJSON: async (k, v) => mem.set(k, JSON.stringify(v)),
  delete: async (k) => mem.delete(k),
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `x.${b64(claims)}.y`;
let entries = [], nextId = 100, clockedIn = new Set(), calls = [], refreshCount = 0;
const H = (11 * 3600e3);
const day = Date.parse("2026-10-29T11:00:00Z");
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.endsWith("/oauth/register")) return reply({ client_id: "cid123" });
  if (url.endsWith("/oauth/token")) {
    const p = new URLSearchParams(opts.body);
    calls.push("token:" + p.get("grant_type"));
    if (p.get("grant_type") === "refresh_token") refreshCount++;
    const role = globalThis.ROLE || "OWNER";
    return reply({ access_token: jwt({ role, username: "owner@x.com", userId: 1 }), refresh_token: "r" + Math.random(), expires_in: 3600 });
  }
  if (url.endsWith("/graphql")) {
    const { query, variables: v } = JSON.parse(opts.body);
    calls.push(query.replace(/\s+/g, " ").slice(0, 40));
    if (query.includes("users(")) return reply({ data: { users: [
      { id: 1, firstName: "Juan", lastName: "M", role: "OWNER", inactiveDate: null },
      { id: 2, firstName: "Pablo", lastName: "Q", role: "EMPLOYEE", inactiveDate: null },
      { id: 3, firstName: "Old", lastName: "Guy", role: "EMPLOYEE", inactiveDate: "2025-01-01" } ] } });
    if (query.includes("clockInUser")) {
      if (clockedIn.has(v.u)) return reply({ data: { clockInUser: null } });
      clockedIn.add(v.u); entries.push({ id: nextId++, userId: v.u, type: "GLOBAL_TIMER", categoryId: 11154, startedAt: new Date(day).toISOString(), endedAt: null, notes: null, hourlyRate: "16" });
      return reply({ data: { clockInUser: { id: 1, createdAt: new Date(day).toISOString() } } });
    }
    if (query.includes("clockOutUser")) {
      if (!clockedIn.has(v.u)) return reply({ data: { clockOutUser: null } });
      clockedIn.delete(v.u);
      const end = new Date(day + 9 * 3600e3).toISOString();
      for (const e of entries) if (e.userId === v.u && !e.endedAt) e.endedAt = end;
      return reply({ data: { clockOutUser: { id: 2, createdAt: end } } });
    }
    if (query.includes("isRunning: true")) return reply({ data: { timeEntries: entries.filter((e) => e.userId === v.u && !e.endedAt) } });
    if (query.includes("timeEntries(")) return reply({ data: { timeEntries: entries.filter((e) => e.userId === v.u).map((e) => ({ ...e, totalSeconds: 0 })) } });
    if (query.includes("addTimeEntry")) { const e = { id: nextId++, type: v.i.eventId ? "EVENT_TIMER" : "GLOBAL_TIMER", ...v.i }; entries.push(e); return reply({ data: { addTimeEntry: { id: e.id } } }); }
    if (query.includes("updateTimeEntry")) { if (globalThis.FAIL_UPDATE) return reply({ errors: [{ message: "nope" }] }); Object.assign(entries.find((e) => e.id === v.id), v.i); return reply({ data: { updateTimeEntry: { id: v.id } } }); }
    if (query.includes("deleteTimeEntry")) { entries = entries.filter((e) => e.id !== v.id); return reply({ data: { deleteTimeEntry: true } }); }
  }
  return reply({ error: "unmocked " + url }, 500);
};

const { default: handler } = await import("../netlify/functions/api.mjs");
const O = "https://clock.test";
const call = async (path, { body, headers = {}, method } = {}) => {
  const res = await handler(new Request(O + "/api/" + path, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get("location") };
};
let ok = 0, fail = 0;
const t = (name, cond, extra) => { cond ? ok++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(extra))); };

// Not connected yet
let r = await call("admin/status");
t("status before connect", r.data.homeworks.connected === false && !r.data.hasAdminPin, r);

// Employee-role login is rejected
globalThis.ROLE = "EMPLOYEE";
r = await call("oauth/start"); let state = new URL(r.location).searchParams.get("state");
r = await call(`oauth/callback?code=abc&state=${state}`);
t("employee login rejected", r.location.includes("error="), r.location);

// Owner login works
globalThis.ROLE = "OWNER";
r = await call("oauth/start");
const authUrl = new URL(r.location);
t("authorize url", authUrl.pathname === "/oauth/authorize" && authUrl.searchParams.get("redirect_uri") === O + "/api/oauth/callback" && authUrl.searchParams.get("code_challenge_method") === "S256", r.location);
state = authUrl.searchParams.get("state");
r = await call(`oauth/callback?code=abc&state=${state}`);
const session = new URLSearchParams(r.location.split("#")[1]).get("session");
t("owner connected + session", !!session, r.location);
r = await call(`oauth/callback?code=abc&state=${state}`);
t("state can't be reused", r.location.includes("error="));
const A = { Authorization: "Bearer " + session };

r = await call("admin/set-admin-pin", { body: { pin: "9090" }, headers: A });
t("set admin pin", r.data.ok, r);
r = await call("admin/employees", { body: {}, headers: { Authorization: "Bearer bad.sig" } });
t("bad session blocked", r.status === 401);
r = await call("admin/generate-pins", { body: {}, headers: A });
t("generate pins (skips owner, inactive)", r.data.made === 1, r);
r = await call("admin/employees", { body: {}, headers: A });
const pablo = r.data.employees.find((e) => e.id === 2);
t("employees list", r.data.employees.length === 2 && /^\d{4}$/.test(pablo.pin), r.data);
r = await call("admin/set-pin", { body: { userId: 1, name: "Juan M", pin: pablo.pin }, headers: A });
t("duplicate pin refused", r.status === 400, r);
r = await call("admin/set-pin", { body: { userId: 2, name: "Pablo Q", pin: "4826" }, headers: A });
t("set custom pin", r.data.ok);
r = await call("admin/set-pin", { body: { userId: 1, name: "Juan M", pin: "9090" }, headers: A });
t("admin pin can't be employee pin", r.status === 400);

// Kiosk without device
r = await call("kiosk/lookup", { body: { pin: "4826" } });
t("unregistered device blocked", r.status === 403 && r.data.notSetUp);
r = await call("admin/add-device", { body: { label: "Shop iPad" }, headers: A });
const D = { "X-Device-Token": r.data.token };

r = await call("kiosk/lookup", { body: { pin: "4826" }, headers: D });
t("lookup clocked out", r.data.name === "Pablo Q" && r.data.clockedIn === false, r);
r = await call("kiosk/clock", { body: { pin: "4826", action: "in" }, headers: D });
t("clock in", r.data.ok && !r.data.already, r);
r = await call("kiosk/clock", { body: { pin: "4826", action: "in" }, headers: D });
t("double clock in", r.data.already === true, r);
r = await call("kiosk/lookup", { body: { pin: "4826" }, headers: D });
t("lookup clocked in", r.data.clockedIn === true && r.data.since, r);

// Clock out with lunch: 9h global entry -> split
r = await call("kiosk/clock", { body: { pin: "4826", action: "out", lunch: true }, headers: D });
const mine = entries.filter((e) => e.userId === 2).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const total = mine.reduce((s, e) => s + (Date.parse(e.endedAt) - Date.parse(e.startedAt)), 0) / 3600e3;
t("lunch deducted", r.data.lunch?.ok && mine.length === 2 && total === 8.5, { r: r.data, mine, total });
t("clock in/out times kept", mine[0].startedAt === new Date(day).toISOString() && mine[1].endedAt === new Date(day + 9 * 3600e3).toISOString(), mine);
t("second half keeps category+rate", mine[1].categoryId === 11154 && mine[1].hourlyRate === "16", mine[1]);
console.log("   gap:", mine[0].endedAt, "->", mine[1].startedAt);

// Event timer split + no-candidate flag
entries.push({ id: nextId++, userId: 2, type: "EVENT_TIMER", eventId: 77, customerId: 5, propertyId: 6, categoryId: null, startedAt: "2026-10-30T12:00:00Z", endedAt: "2026-10-30T16:00:00Z", hourlyRate: "16", notes: null });
const hw = await import("../netlify/lib/homeworks.mjs");
let L = await hw.deductLunch(2, "2026-10-30T20:00:00Z");
const ev = entries.filter((e) => e.eventId === 77);
t("job timer split keeps job", L.ok && ev.length === 2 && ev.every((e) => e.customerId === 5 && e.propertyId === 6), { L, ev });
L = await hw.deductLunch(2, "2026-10-31T20:00:00Z");
t("nothing to cut -> not ok", !L.ok, L);

// Choppy day: no 45-min entry, so lunch is spread across the longest entries
for (const [a, b] of [["13:00", "13:25"], ["14:00", "14:25"], ["15:00", "15:20"], ["16:00", "16:04"]])
  entries.push({ id: nextId++, userId: 2, type: "EVENT_TIMER", eventId: 88, customerId: 1, propertyId: 1, categoryId: null, startedAt: `2026-10-31T${a}:00Z`, endedAt: `2026-10-31T${b}:00Z`, hourlyRate: "16", notes: null });
const dayMins = () => entries.filter((e) => e.userId === 2 && e.startedAt.startsWith("2026-10-31")).reduce((s, e) => s + (Date.parse(e.endedAt) - Date.parse(e.startedAt)), 0) / 60e3;
const beforeMins = dayMins();
L = await hw.deductLunch(2, "2026-10-31T17:00:00Z");
t("choppy day spread across entries", L.ok && L.cuts.length === 2 && beforeMins - dayMins() === 30, { L, beforeMins, after: dayMins() });
const tiny = entries.filter((e) => e.startedAt === "2026-10-31T16:00:00Z")[0];
t("tiny entry left alone", Date.parse(tiny.endedAt) - Date.parse(tiny.startedAt) === 4 * 60e3);
L = await hw.deductLunch(2, "2026-10-31T17:00:00Z");
t("already-cut entries not cut twice", !L.ok, L);

// Update failure rolls back
entries.push({ id: nextId++, userId: 2, type: "GLOBAL_TIMER", categoryId: 11154, startedAt: "2026-11-01T12:00:00Z", endedAt: "2026-11-01T18:00:00Z", hourlyRate: "16", notes: null });
const before = entries.length; globalThis.FAIL_UPDATE = true;
L = await hw.deductLunch(2, "2026-11-01T19:00:00Z");
globalThis.FAIL_UPDATE = false;
t("failed update rolled back", !L.ok && entries.length === before, { L, n: entries.length, before });

// Flag shows up when lunch can't be deducted at clock out
await call("kiosk/clock", { body: { pin: "4826", action: "in" }, headers: D });
entries = entries.filter((e) => !(e.userId === 2 && !e.endedAt));
entries.push({ id: nextId++, userId: 2, type: "GLOBAL_TIMER", categoryId: 1, startedAt: new Date(day + 9 * 3600e3 - 600e3).toISOString(), endedAt: null, notes: null });
r = await call("kiosk/clock", { body: { pin: "4826", action: "out", lunch: true }, headers: D });
const flags = await call("admin/flags", { body: {}, headers: A });
t("flag recorded", r.data.lunch && !r.data.lunch.ok && flags.data.flags.length === 1, { r: r.data, f: flags.data });

// Wrong PIN lockout
for (let i = 0; i < 5; i++) await call("kiosk/lookup", { body: { pin: "0001" }, headers: D });
r = await call("kiosk/lookup", { body: { pin: "4826" }, headers: D });
t("lockout after 5 wrong", r.status === 429, r);

// Admin login
r = await call("admin/login", { body: { pin: "9090" } });
t("admin login (separate lockout)", !!r.data.session, r);

// Token refresh when expired
const tok = JSON.parse(mem.get("tokens")); tok.expiresAt = Date.now() - 1; mem.set("tokens", JSON.stringify(tok));
const rc = refreshCount;
r = await call("admin/employees", { body: {}, headers: A });
t("auto refresh", refreshCount === rc + 1 && r.status === 200, r);

// Removed device stops working
const devs = await call("admin/devices", { body: {}, headers: A });
await call("admin/remove-device", { body: { id: devs.data.devices[0].id }, headers: A });
r = await call("kiosk/check", { body: {}, headers: D });
t("removed device blocked", r.status === 403);

// Scheduled refresh
const { default: keep } = await import("../netlify/functions/keep-connected.mjs");
const rc2 = refreshCount; await keep();
t("daily refresh", refreshCount === rc2 + 1);

console.log(`\n${ok} passed, ${fail} failed`);
