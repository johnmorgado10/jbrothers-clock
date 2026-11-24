// Crew clock tests: in-memory storage + a fake Homeworks that keeps real time entries.
const mem = new Map();
globalThis.__TEST_STORE__ = {
  get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
  setJSON: async (k, v) => mem.set(k, JSON.stringify(v)),
  delete: async (k) => mem.delete(k),
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `x.${b64(claims)}.y`;
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.now();

let entries = [], nextId = 1000, puts = [], calls = [];
const users = [
  { id: 16358, firstName: "Juan", lastName: "Morgado", role: "OWNER", inactiveDate: null },
  { id: 22206, firstName: "John", lastName: "Morgado-Martinez", role: "EMPLOYEE", inactiveDate: null },
  { id: 22210, firstName: "Pablo", lastName: "Quilimaco", role: "EMPLOYEE", inactiveDate: null },
  { id: 32102, firstName: "Jose A", lastName: "Viñas Lopez", role: "EMPLOYEE", inactiveDate: null },
];
const event = {
  id: 500, title: "Paver patio", status: "OPEN", startDate: "2026-11-24", budgetedHours: "29", description: "<p>Continue paver installation.</p>",
  propertyId: 77, customerId: 88, recurringEventId: null, sortOrder: 1,
  customer: { id: 88, fullName: "Anthony Evans", phone: "", cell: "(919) 491-9176" },
  property: { id: 77, notes: "", address: { street1: "33 Warrenton Rd", city: "Baltimore", state: "MD", zip: "21210" }, media: [] },
  users: users.slice(0, 4).map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
  lineItems: [
    { id: 1, name: "Miscellaneous Work", description: "<p>Concrete paver job.</p>", quantity: "18.5", price: "50", budgetedHours: "20", item: { type: "SERVICE" } },
    { id: 2, name: "Gutter Cleaning", description: "", quantity: "0", price: "50", budgetedHours: "5", item: { type: "SERVICE" } },
    { id: 3, name: "General Materials", description: "<p>Quikrete, 80 lb bags.</p>", quantity: "175", price: "10.86", budgetedHours: "0", item: { type: "ITEM" } },
    { id: 4, name: "Tree Removal", description: "", quantity: "1", price: "2800", budgetedHours: "4", item: { type: "SERVICE" } },
  ],
  dispatchNotes: [], beforeAndAfters: [], media: [], latestUpsellHistory: null,
};

function globalStart(u, at) { entries.push({ id: nextId++, userId: u, type: "GLOBAL_TIMER", categoryId: 11154, eventId: null, startedAt: iso(at), endedAt: null, hourlyRate: "16.5", notes: null }); }

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.endsWith("/oauth/register")) return reply({ client_id: "cid" });
  if (url.endsWith("/oauth/token")) return reply({ access_token: jwt({ role: "OWNER", username: "o", userId: 16358 }), refresh_token: "r", expires_in: 3600 });
  if (url.startsWith("https://s3.test/")) { puts.push({ url, type: opts.headers["Content-Type"], size: opts.body.length }); return new Response("", { status: 200 }); }
  if (!url.endsWith("/graphql")) return reply({ error: "unmocked " + url }, 500);
  const { query, variables: v } = JSON.parse(opts.body);
  const q = query.replace(/\s+/g, " ");
  calls.push(q.slice(0, 60));
  const d = (data) => reply({ data });
  if (q.includes("users(where")) return d({ users });
  if (q.includes("clockOutUser")) {
    const open = entries.filter((e) => e.userId === v.u && !e.endedAt);
    if (!open.length) return d({ clockOutUser: null });
    for (const e of open) e.endedAt = iso(Date.now());
    return d({ clockOutUser: { id: 1, createdAt: iso(Date.now()) } });
  }
  if (q.includes("clockInUser")) {
    if (entries.some((e) => e.userId === v.u && !e.endedAt)) return d({ clockInUser: null });
    globalStart(v.u, Date.now());
    return d({ clockInUser: { id: 2, createdAt: iso(Date.now()) } });
  }
  if (q.includes("isRunning: true, userId: { in:")) return d({ timeEntries: entries.filter((e) => !e.endedAt && v.ids.includes(e.userId)) });
  if (q.includes("isRunning: true")) return d({ timeEntries: entries.filter((e) => e.userId === v.u && !e.endedAt) });
  if (q.includes("addTimeEntry")) { const e = { id: nextId++, type: v.i.eventId ? "EVENT_TIMER" : "GLOBAL_TIMER", hourlyRate: null, notes: null, ...v.i }; entries.push(e); return d({ addTimeEntry: { id: e.id } }); }
  if (q.includes("updateTimeEntry")) { Object.assign(entries.find((e) => e.id === v.id), v.i); return d({ updateTimeEntry: { id: v.id } }); }
  if (q.includes("deleteTimeEntry")) { entries = entries.filter((e) => e.id !== v.id); return d({ deleteTimeEntry: true }); }
  if (q.includes("timeEntries(where: { userId")) return d({ timeEntries: entries.filter((e) => e.userId === v.u && e.startedAt >= v.from).map((e) => ({ ...e, totalSeconds: 0 })) });
  if (q.includes("updateEventLineItem")) { event.lineItems.find((l) => l.id === v.l).quantity = String(v.i.quantity); return d({ updateEventLineItem: { id: 500 } }); }
  if (q.includes("createUpload")) return d({ createUpload: { key: "tmp/abc.jpg", uploadUrl: "https://s3.test/upload/abc" } });
  if (q.includes("addBeforeAndAfter")) { const ba = { id: 9, beforeMedia: [], afterMedia: [] }; event.beforeAndAfters.push(ba); return d({ addBeforeAndAfter: { id: 9 } }); }
  if (q.includes("addAfterMedia") || q.includes("addBeforeMedia")) {
    const ba = event.beforeAndAfters.find((b) => b.id === v.b);
    (q.includes("addAfterMedia") ? ba.afterMedia : ba.beforeMedia).push({ id: 300 + nextId++, thumb: "https://img.test/" + v.k });
    return d({ x: { id: v.b } });
  }
  if (q.includes("removeAfterMedia")) { const ba = event.beforeAndAfters.find((b) => b.id === v.b); ba.afterMedia = ba.afterMedia.filter((m) => m.id !== v.m); return d({ x: { id: 9 } }); }
  if (q.includes("createEventDispatchNote")) { event.dispatchNotes.push({ message: v.i.message, author: "Juan Morgado", date: iso(Date.now()) }); return d({ x: { id: 500 } }); }
  if (q.includes("closeEvent")) { event.status = "CLOSED"; return d({ closeEvent: { id: 500, status: "CLOSED" } }); }
  if (q.includes("events(where")) return d({ events: [{ ...event, timeEntries: entries.filter((e) => e.eventId === 500) }, { ...event, id: 501, status: "CANCELLED", sortOrder: 2, timeEntries: [] }] });
  if (q.includes("event(eventId")) return d({ event: { ...event, timeEntries: entries.filter((e) => e.eventId === 500) }, upsells: [{ id: 2410, name: "MULCH", textActive: true }] });
  return reply({ errors: [{ message: "unmocked query: " + q.slice(0, 80) }] });
};

const { default: handler } = await import("../netlify/functions/api.mjs");
const crewLib = await import("../netlify/lib/crew.mjs");
const O = "https://clock.test";
const call = async (path, { body, headers = {}, ip = "1.1.1.1" } = {}) => {
  const res = await handler(new Request(O + "/api/" + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }), { ip });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get("location") };
};
let ok = 0, fail = 0;
const t = (name, cond, extra) => { cond ? ok++ : fail++; console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(extra))); };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// Connect Homeworks + admin.
let r = await call("oauth/start"); const state = new URL(r.location).searchParams.get("state");
r = await call(`oauth/callback?code=c&state=${state}`);
const admin = { Authorization: "Bearer " + new URLSearchParams(r.location.split("#")[1]).get("session") };
await call("admin/set-admin-pin", { body: { pin: "9090" }, headers: admin });
await call("admin/set-pin", { body: { userId: 16358, name: "Juan Morgado", pin: "4821" }, headers: admin });
await call("admin/set-pin", { body: { userId: 22210, name: "Pablo Quilimaco", pin: "5173" }, headers: admin });
await call("admin/set-pin", { body: { userId: 32102, name: "Jose A Viñas Lopez", pin: "6264" }, headers: admin });

// ---- access ----
r = await call("crew/login", { body: { pin: "4821" } });
t("no access until switched on", r.status === 403 && /don't have access/.test(r.data.error), r);
r = await call("admin/crew-access", { body: { userId: 16358, on: true }, headers: admin });
r = await call("admin/employees", { body: {}, headers: admin });
t("admin shows crew access", r.data.employees.find((e) => e.id === 16358).crew === true && r.data.employees.find((e) => e.id === 22210).crew === false, r.data);
r = await call("crew/login", { body: { pin: "4821" } });
t("lead signs in", r.status === 200 && r.data.me.id === 16358 && r.data.session, r);
const juan = { Authorization: "Bearer " + r.data.session };
r = await call("crew/login", { body: { pin: "5173" } });
t("crew member without access is refused", r.status === 403, r);
r = await call("crew/login", { body: { pin: "0000" } });
t("wrong PIN refused", r.status === 401, r);
r = await call("crew/schedule", { body: { date: "2026-11-24" } });
t("no session refused", r.status === 401 && r.data.signedOut, r);
r = await call("crew/schedule", { body: { date: "2026-11-24" }, headers: { Authorization: "Bearer 16358.9999999999999.forged" } });
t("forged session refused", r.status === 401, r);

// ---- schedule & visit ----
r = await call("crew/schedule", { body: { date: "2026-11-24" }, headers: juan });
t("schedule hides cancelled visits", r.status === 200 && r.data.visits.length === 1 && r.data.visits[0].address === "33 Warrenton Rd, Baltimore, MD 21210", r.data);
r = await call("crew/visit", { body: { eventId: 500 }, headers: juan });
t("visit details", r.status === 200 && r.data.visit.visitNote === "Continue paver installation." && r.data.visit.phone === "(919) 491-9176" && r.data.visit.items[2].d === "Quikrete, 80 lb bags.", r.data.visit);
t("crew list", r.data.crew.length === 4 && r.data.crew.every((c) => c.clockedIn === false), r.data.crew);

// ---- start work: Pablo clocked in at the shop, Jose not ----
globalStart(22210, T0 - 2 * HOUR);
const startAt = Date.now() - 3 * HOUR; // phone was offline, sent later
r = await call("crew/start", { body: { eventId: 500, userIds: [22210, 32102], at: iso(startAt) }, headers: juan });
t("start ok", r.status === 200 && r.data.started.length === 2, r.data);
const pabloGlobal = entries.find((e) => e.userId === 22210 && e.type === "GLOBAL_TIMER");
t("start pauses Pablo's shop timer", !!pabloGlobal.endedAt, pabloGlobal);
let running = await crewLib.getRunning();
t("running kept with phone's start time", running[22210].start === startAt && running[32102].start === startAt && running[22210].rate === "16.5", running);
r = await call("kiosk/lookup", { body: { pin: "5173" } });
t("shop clock sees Pablo as clocked in while on the job", r.data.clockedIn === true, r.data);
r = await call("crew/visit", { body: { eventId: 500 }, headers: juan });
t("visit shows who is running", Object.keys(r.data.visit.running).length === 2 && near(r.data.visit.tracked, 6, 0.05) && r.data.visit.done === 0, r.data.visit);

// fix start time
const fixed = startAt - 30 * MIN;
r = await call("crew/fix", { body: { eventId: 500, userId: 32102, start: iso(fixed) }, headers: juan });
running = await crewLib.getRunning();
t("fix start time", r.data.ok && running[32102].start === fixed, r.data);

// ---- stop Pablo 20 min ago (he left earlier) ----
const pabloEnd = Date.now() - 20 * MIN;
r = await call("crew/stop", { body: { eventId: 500, userIds: [22210], end: iso(pabloEnd) }, headers: juan });
const job = entries.find((e) => e.userId === 22210 && e.eventId === 500);
t("stop writes job entry to Homeworks", job && job.startedAt === iso(startAt) && job.endedAt === iso(pabloEnd) && job.hourlyRate === "16.5" && /Crew clock · Juan/.test(job.notes), job);
const gap = entries.find((e) => e.userId === 22210 && e.notes === "Shop / drive time after job (crew clock)");
t("gap after early stop covered by shop time", gap && gap.startedAt === iso(pabloEnd) && gap.categoryId === 11154, gap);
t("Pablo back on shop timer", entries.some((e) => e.userId === 22210 && e.type === "GLOBAL_TIMER" && !e.endedAt));
running = await crewLib.getRunning();
t("Pablo no longer running, Jose still is", !running[22210] && !!running[32102], running);

// ---- Jose clocks out at the shop while still on the job, with lunch ----
r = await call("kiosk/lookup", { body: { pin: "6264" } });
t("Jose looks clocked in at the shop", r.data.clockedIn === true, r.data);
r = await call("kiosk/clock", { body: { pin: "6264", action: "out", lunch: true } });
t("clock-out works even with no shop timer running", r.status === 200 && r.data.action === "out" && !r.data.already && r.data.lunch?.ok, r.data);
running = await crewLib.getRunning();
const joseJobs = entries.filter((e) => e.userId === 32102 && e.eventId === 500);
t("job stopped at clock-out", !running[32102] && joseJobs.length === 2 /* split by lunch */, joseJobs);
t("Jose NOT put back on the shop clock", !entries.some((e) => e.userId === 32102 && !e.endedAt), entries.filter((e) => e.userId === 32102));
const joseMins = joseJobs.reduce((s, e) => s + (Date.parse(e.endedAt) - Date.parse(e.startedAt)), 0) / MIN;
const fullJose = (Date.now() - fixed) / MIN;
t("lunch came out of Jose's timesheet (30 min)", Math.abs(fullJose - joseMins - 30) < 1, { joseMins, fullJose });

// ---- tracked & labor: lunch counted as work for the customer ----
r = await call("crew/visit", { body: { eventId: 500 }, headers: juan });
const expectHrs = (pabloEnd - startAt + (Date.now() - fixed)) / HOUR;
t("tracked counts full time (lunch not taken off)", near(r.data.visit.tracked, expectHrs, 0.03), { tracked: r.data.visit.tracked, expectHrs });
const plan = r.data.visit.labor;
t("labor plan: hourly lines only, split by BH", plan.length === 2 && plan[0].lineItemId === 1 && plan[1].lineItemId === 2 && near(plan[0].to + plan[1].to, r.data.visit.tracked, 0.011) && near(plan[0].to / plan[1].to, 4, 0.05), plan);
r = await call("crew/labor", { body: { eventId: 500, apply: true, plan: [{ lineItemId: 1, to: 10.5 }, { lineItemId: 2, to: 2.5 }, { lineItemId: 3, to: 999 }, { lineItemId: 4, to: 7 }] }, headers: juan });
t("labor update uses phone's numbers, only for labor lines", r.status === 200 && event.lineItems[0].quantity === "10.5" && event.lineItems[1].quantity === "2.5" && event.lineItems[2].quantity === "175" && event.lineItems[3].quantity === "1", event.lineItems);

// ---- notes, photos ----
r = await call("crew/note", { body: { eventId: 500, text: "Gate code 4412" }, headers: juan });
t("dispatch note tagged with lead", event.dispatchNotes[0].message === "Gate code 4412 — Juan", event.dispatchNotes);
const tinyJpeg = Buffer.from("ffd8ffe000104a46494600", "hex").toString("base64");
r = await call("crew/photo", { body: { eventId: 500, propertyId: 77, kind: "after", contentType: "image/jpeg", data: tinyJpeg }, headers: juan });
t("photo uploaded then attached as After", r.status === 200 && puts.length === 1 && puts[0].type === "image/jpeg" && event.beforeAndAfters[0].afterMedia.length === 1, { r: r.data, puts, ba: event.beforeAndAfters });
r = await call("crew/photo", { body: { eventId: 500, kind: "after", contentType: "text/html", data: tinyJpeg }, headers: juan });
t("non-photo refused", r.status === 400, r.data);
const mid = event.beforeAndAfters[0].afterMedia[0].id;
r = await call("crew/photo-remove", { body: { eventId: 500, kind: "after", mediaId: mid, ba: 9 }, headers: juan });
t("photo removed", r.status === 200 && event.beforeAndAfters[0].afterMedia.length === 0, r.data);

// ---- complete stops anyone still on the job ----
globalStart(22206, Date.now() - HOUR);
await call("admin/set-pin", { body: { userId: 22206, name: "John Morgado-Martinez", pin: "7351" }, headers: admin });
r = await call("crew/start", { body: { eventId: 500, userIds: [22206] }, headers: juan });
r = await call("crew/complete", { body: { eventId: 500 }, headers: juan });
running = await crewLib.getRunning();
t("complete stops runners and closes visit", r.data.stopped?.[0] === 22206 && !running[22206] && event.status === "CLOSED", r.data);

// ---- access can be taken away ----
await call("admin/crew-access", { body: { userId: 16358, on: false }, headers: admin });
r = await call("crew/schedule", { body: { date: "2026-11-24" }, headers: juan });
t("access removed takes effect right away", r.status === 401, r);

// ---- shop clock still behaves normally for someone not on a job ----
await call("admin/set-pin", { body: { userId: 22210, name: "Pablo Quilimaco", pin: "5173" }, headers: admin });
r = await call("kiosk/clock", { body: { pin: "5173", action: "out", lunch: false } });
t("normal shop clock-out unaffected", r.status === 200 && r.data.action === "out" && !r.data.already, r.data);
r = await call("kiosk/clock", { body: { pin: "5173", action: "out" } });
t("second clock-out says already out", r.data.already === true, r.data);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
