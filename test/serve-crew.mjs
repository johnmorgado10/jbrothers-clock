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
const http = await import("node:http");
const fs = await import("node:fs");
const path = await import("node:path");
// Set up: connected, PINs, Juan has crew access, Pablo on the shop clock.
const { setJSON } = await import("../netlify/lib/store.mjs");
await setJSON("oauth-client", { clientId: "cid", redirectUri: "x" });
await setJSON("tokens", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600e3 });
await setJSON("config", { adminPin: null, devices: [], crewAccess: [16358], pins: {
  16358: { pin: "4821", name: "Juan Morgado" }, 22206: { pin: "7351", name: "John Morgado-Martinez" },
  22210: { pin: "5173", name: "Pablo Quilimaco" }, 32102: { pin: "6264", name: "Jose A Viñas Lopez" } } });
globalStart(22210, Date.now() - 3 * HOUR); globalStart(22206, Date.now() - 3 * HOUR);
event.startDate = new Date().toLocaleDateString("en-CA");
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json", ".css": "text/css" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    if (globalThis.OFFLINE) { req.socket.destroy(); return; }
    let body = ""; for await (const c of req) body += c;
    const r = await handler(new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: req.method === "POST" ? body : undefined }), { ip: "1.1.1.1" });
    res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(await r.text()); return;
  }
  if (url.pathname === "/__offline") { globalThis.OFFLINE = url.searchParams.get("on") === "1"; res.end("ok"); return; }
  if (url.pathname === "/__state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ entries, event, puts })); return; }
  let p = path.join("public", url.pathname);
  if (p.endsWith("/")) p += "index.html";
  if (!fs.existsSync(p)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream" }); res.end(fs.readFileSync(p));
}).listen(8788, () => console.log("ready"));
