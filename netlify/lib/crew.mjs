// Crew clock: leads (John, James, Juan) run job timers for the crew on Homeworks visits.
//
// How time is kept:
// - Homeworks only lets an app run a live job timer for the logged-in account, so the
//   crew clock keeps the stopwatch itself ("crew-running") and writes the finished
//   job entry to Homeworks (addTimeEntry) when work is stopped.
// - Like FieldForce, a job pauses the person's shop/drive (global) timer: Start work
//   clocks them out of the global timer, Stop work writes the job entry and clocks them
//   back in. So job time and shop time never overlap.
// - Each finished job entry is also remembered here ("crew-ev-<eventId>") at its full
//   length. Update labor qty uses that, so a lunch cut made later by the shop clock
//   never lowers what the customer is billed.
import { getJSON, setJSON } from "./store.mjs";
import { gql } from "./homeworks.mjs";

const GLOBAL_CATEGORY = 11154; // Homeworks "shop / drive" timer category
const r2 = (x) => Math.round(x * 100) / 100;
const hours = (ms) => ms / 3600_000;

// ---------- running timers ----------

export const getRunning = () => getJSON("crew-running", {});
const saveRunning = (r) => setJSON("crew-running", r);
export async function runningFor(userId) {
  return (await getRunning())[userId] || null;
}

const segKey = (eventId) => `crew-ev-${eventId}`;
const getSegments = (eventId) => getJSON(segKey(eventId), []);

// Times sent from a phone (it may have been offline) are trusted within reason.
export function cleanTime(value, { notBefore } = {}) {
  const now = Date.now();
  let t = value ? Date.parse(value) : now;
  if (!Number.isFinite(t)) t = now;
  if (t > now + 2 * 60_000) t = now; // phone clock running fast
  if (t < now - 36 * 3600_000) t = now - 36 * 3600_000;
  if (notBefore && t < notBefore) t = notBefore;
  return t;
}

async function runningGlobal(userIds) {
  if (!userIds.length) return {};
  const data = await gql(
    `query($ids: [SafeInt!]) { timeEntries(where: { isRunning: true, userId: { in: $ids } }, take: 100) { id userId type categoryId startedAt hourlyRate } }`,
    { ids: userIds }
  );
  const out = {};
  for (const e of data.timeEntries) if (!out[e.userId] || e.type === "GLOBAL_TIMER") out[e.userId] = e;
  return out;
}

async function profileRates(userIds) {
  if (!userIds.length) return {};
  const d = await gql(`query($ids: [SafeInt!]) { users(where: { id: { in: $ids } }) { id rate } }`, { ids: userIds });
  return Object.fromEntries(d.users.filter((u) => u.rate != null).map((u) => [u.id, String(u.rate)]));
}

async function eventBasics(eventId) {
  const d = await gql(`query($id: SafeInt!) { event(eventId: $id) { id title customerId propertyId status } }`, { id: eventId });
  if (!d.event) throw new Error("That visit wasn't found in Homeworks.");
  return d.event;
}

// Start work for several people at once. Anyone already on another job is moved here.
export async function startWork({ eventId, userIds, at, by }) {
  const ev = await eventBasics(eventId);
  const start = cleanTime(at);
  const running = await getRunning();
  const moved = [], carry = {};
  for (const uid of userIds) {
    const cur = running[uid];
    if (cur && cur.eventId === eventId) continue;
    if (cur) {
      await addSegments(cur.eventId, [await finishOne(uid, cur, start, { by, resume: false })]);
      moved.push({ userId: uid, from: cur.title });
      carry[uid] = cur; // keep their rate; they go job to job without shop time between
      delete running[uid];
    }
  }
  const fresh = userIds.filter((u) => !(running[u] && running[u].eventId === eventId));
  const globals = await runningGlobal(fresh);
  const rates = await profileRates(fresh.filter((u) => !globals[u] && !carry[u]));
  const results = await Promise.all(
    fresh.map(async (uid) => {
      const g = globals[uid], c = carry[uid];
      if (g) await gql(`mutation($u: SafeInt!) { clockOutUser(userId: $u) { id } }`, { u: uid });
      return [uid, {
        eventId, title: ev.title, customerId: ev.customerId, propertyId: ev.propertyId,
        start, by, rate: g?.hourlyRate ?? c?.rate ?? rates[uid] ?? null, category: g?.categoryId || c?.category || GLOBAL_CATEGORY,
        wasClockedIn: !!(g || c?.wasClockedIn),
      }];
    })
  );
  const latest = await getRunning(); // re-read so two phones don't overwrite each other
  for (const [uid, rec] of results) latest[uid] = rec;
  for (const m of moved) if (latest[m.userId]?.eventId !== eventId) delete latest[m.userId];
  await saveRunning(latest);
  return { ok: true, started: results.map(([u]) => u), moved };
}

// Write one person's finished job entry. resume=true puts them back on shop/drive time.
async function finishOne(userId, rec, end, { by, resume }) {
  end = Math.max(end, rec.start + 1000);
  const input = {
    eventId: rec.eventId, userId,
    startedAt: new Date(rec.start).toISOString(), endedAt: new Date(end).toISOString(),
    notes: `Crew clock${by ? ` · ${by}` : ""}`,
  };
  if (rec.customerId) input.customerId = rec.customerId;
  if (rec.propertyId) input.propertyId = rec.propertyId;
  if (rec.rate != null) input.hourlyRate = rec.rate;
  const added = await gql(`mutation($i: TimeEntryInput!) { addTimeEntry(input: $i) { id } }`, { i: input });
  const seg = { id: added.addTimeEntry.id, userId, start: rec.start, end, by: by || null };

  if (resume) {
    const back = await gql(`mutation($u: SafeInt!) { clockInUser(userId: $u) { id createdAt } }`, { u: userId });
    // Stopped earlier than now (they left the job a while ago): cover the gap with shop time.
    const resumedAt = back?.clockInUser ? Date.parse(back.clockInUser.createdAt) : Date.now();
    if (resumedAt - end > 2 * 60_000) {
      const gap = { categoryId: rec.category || GLOBAL_CATEGORY, userId, startedAt: new Date(end).toISOString(), endedAt: new Date(resumedAt).toISOString(), notes: "Shop / drive time after job (crew clock)" };
      if (rec.rate != null) gap.hourlyRate = rec.rate;
      await gql(`mutation($i: TimeEntryInput!) { addTimeEntry(input: $i) { id } }`, { i: gap });
    }
  }
  return seg;
}

// Remember finished job entries at their full length (see trackedHours).
async function addSegments(eventId, segs) {
  if (!segs.length) return;
  const all = await getSegments(eventId);
  all.push(...segs);
  await setJSON(segKey(eventId), all);
}

export async function stopWork({ eventId, userIds, end, by }) {
  const running = await getRunning();
  const ids = userIds.filter((u) => running[u]?.eventId === eventId);
  const stopAt = cleanTime(end);
  // Everyone in parallel so a big crew still saves quickly.
  // Back on shop / drive time only if they were on the shop clock when the job started.
  // (Someone put on a job after hours, or entered after the fact, stays off the clock.)
  const settled = await Promise.allSettled(ids.map((uid) => finishOne(uid, running[uid], Math.max(stopAt, running[uid].start + 60_000), { by, resume: !!running[uid].wasClockedIn })));
  const done = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);
  await addSegments(eventId, done);
  const failedIds = ids.filter((_, i) => settled[i].status === "rejected");
  const latest = await getRunning();
  for (const uid of ids) if (latest[uid]?.eventId === eventId && !failedIds.includes(uid)) delete latest[uid];
  await saveRunning(latest);
  if (failedIds.length) throw new Error(`Couldn't save job time for ${failedIds.length} ${failedIds.length === 1 ? "person" : "people"}: ${settled.find((x) => x.status === "rejected").reason.message}`);
  return { ok: true, stopped: done.map((d) => d.userId) };
}

export async function fixStart({ eventId, userId, start }) {
  const running = await getRunning();
  const rec = running[userId];
  if (!rec || rec.eventId !== eventId) return { ok: false, error: "They're not on this job anymore." };
  const t = cleanTime(start);
  if (t > Date.now()) return { ok: false, error: "Start time can't be in the future." };
  rec.start = t;
  await saveRunning(running);
  return { ok: true };
}

// Called by the shop clock when someone clocks out while still on a job:
// the job ends at their clock-out time and they are NOT put back on shop time.
export async function stopForClockOut(userId, at) {
  const running = await getRunning();
  const rec = running[userId];
  if (!rec) return null;
  const end = cleanTime(at);
  await addSegments(rec.eventId, [await finishOne(userId, rec, end, { by: "shop clock-out", resume: false })]);
  const latest = await getRunning();
  delete latest[userId];
  await saveRunning(latest);
  return { title: rec.title, start: rec.start, end };
}

// ---------- tracked time & labor qty ----------

// Full job time on a visit, everyone added up (hours). Entries the crew clock wrote count
// at the length it recorded (ignoring later lunch cuts); other entries count as they are.
// Homeworks is the source of truth, so hand edits there count. The one exception: when
// the shop clock cut 30 min of lunch out of a job entry the crew clock wrote, the entry
// counts at its full length (customers are billed as if no lunch was taken).
const LUNCH_NOTE = /lunch deducted \(shop clock\)/;
export function trackedHours(timeEntries, segs, running, eventId, now = Date.now()) {
  const mine = new Map(segs.map((s) => [s.id, s]));
  let ms = 0;
  for (const e of timeEntries) {
    if (!e.endedAt) continue;
    const s = Date.parse(e.startedAt), en = Date.parse(e.endedAt);
    const seg = mine.get(e.id);
    if (seg && LUNCH_NOTE.test(e.notes || "")) { ms += seg.end - seg.start; continue; }
    if (!seg && LUNCH_NOTE.test(e.notes || "") && /^After|\| After/.test(e.notes || "") &&
        segs.some((g) => g.userId === e.userId && s >= g.start - 1000 && en <= g.end + 1000)) continue; // other half of that cut
    ms += en - s;
  }
  for (const rec of Object.values(running)) if (rec.eventId === eventId) ms += Math.max(0, now - rec.start);
  return hours(ms);
}

// Labor lines are SERVICE / LABOR items priced by the hour; flat-price lines (qty 1, not
// $50-style hourly) are left alone. Hours are split by budgeted hours.
export function laborPlan(lineItems, tracked) {
  const labor = lineItems.filter((li) => ["SERVICE", "LABOR"].includes(li.item?.type) && Number(li.budgetedHours) > 0 && !isFlat(li));
  const totalBh = labor.reduce((s, li) => s + Number(li.budgetedHours), 0);
  const T = r2(tracked);
  let left = T;
  return labor.map((li, i) => {
    const q = i === labor.length - 1 ? r2(left) : r2((T * Number(li.budgetedHours)) / totalBh);
    left = r2(left - q);
    return { lineItemId: li.id, name: li.name, from: Number(li.quantity), to: q };
  });
}
function isFlat(li) {
  return Number(li.quantity) === 1 && Number(li.price) > 200; // e.g. Tree Removal $2,800 x 1
}

export async function eventTracked(eventId, timeEntries) {
  return trackedHours(timeEntries, await getSegments(eventId), await getRunning(), eventId);
}

// ---------- reading visits ----------

const MEDIA = `id thumb(width: 600, height: 600)`;

export async function schedule(userId, date) {
  const d = await gql(
    `query($u: SafeInt!, $d: Date!) { events(where: { isDeleted: false, startDate: { equals: $d }, users: { id: { equals: $u } } }, take: 200) {
       id title status type startDate sortOrder budgetedHours recurringEventId
       customer { fullName } property { address { street1 city state zip } }
       users { id firstName lastName } timeEntries { id userId startedAt endedAt notes } } }`,
    { u: userId, d: date }
  );
  const running = await getRunning();
  const list = d.events.filter((e) => e.status !== "CANCELLED").sort((a, b) => a.sortOrder - b.sortOrder);
  const segsAll = await Promise.all(list.map((e) => getSegments(e.id)));
  return list.map((e, i) => ({
    id: e.id, title: e.title, status: e.status, mow: !!e.recurringEventId && /mow|cut/i.test(e.title),
    customer: e.customer?.fullName || "", address: addr(e.property?.address),
    bh: Number(e.budgetedHours) || 0,
    tracked: r2(trackedHours(e.timeEntries, segsAll[i], running, e.id)),
    done: r2(trackedHours(e.timeEntries, segsAll[i], {}, e.id)),
    crew: e.users.map((u) => u.firstName),
    onJob: Object.entries(running).filter(([, r]) => r.eventId === e.id).map(([u]) => Number(u)),
  }));
}

const addr = (a) => (a ? [a.street1, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "");
const text = (html) => String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

export async function visit(eventId) {
  const d = await gql(
    `query($id: SafeInt!) { event(eventId: $id) { id title status startDate budgetedHours description propertyId customerId recurringEventId
       customer { id fullName phone cell } property { id notes address { street1 city state zip } media { ${MEDIA} } }
       users { id firstName lastName }
       lineItems { id name description quantity price budgetedHours item { type } }
       dispatchNotes { message author date }
       beforeAndAfters { id beforeMedia { ${MEDIA} } afterMedia { ${MEDIA} } }
       media { ${MEDIA} }
       timeEntries { id userId startedAt endedAt notes } }
     upsells { id name textActive } }`,
    { id: eventId }
  );
  const e = d.event;
  if (!e) throw new Error("That visit wasn't found in Homeworks.");
  const running = await getRunning();
  const segs = await getSegments(eventId);
  const tracked = trackedHours(e.timeEntries, segs, running, eventId);
  const ba = e.beforeAndAfters || [];
  return {
    id: e.id, title: e.title, status: e.status, date: e.startDate, bh: Number(e.budgetedHours) || 0,
    mow: !!e.recurringEventId && /mow|cut/i.test(e.title),
    visitNote: text(e.description),
    customer: e.customer?.fullName || "", customerId: e.customerId,
    phone: e.customer?.cell || e.customer?.phone || "",
    address: addr(e.property?.address), propertyId: e.propertyId, propNotes: text(e.property?.notes),
    assigned: e.users.map((u) => u.id),
    items: e.lineItems.map((li) => ({
      id: li.id, n: li.name, d: text(li.description), qty: Number(li.quantity), price: Number(li.price),
      bh: Number(li.budgetedHours) || 0, labor: ["SERVICE", "LABOR"].includes(li.item?.type),
    })),
    notes: (e.dispatchNotes || []).map((n) => ({ text: n.message, by: n.author, at: n.date })).reverse(),
    media: {
      before: ba.flatMap((b) => (b.beforeMedia || []).map((m) => ({ id: m.id, ba: b.id, src: m.thumb }))),
      after: ba.flatMap((b) => (b.afterMedia || []).map((m) => ({ id: m.id, ba: b.id, src: m.thumb }))),
      event: (e.media || []).map((m) => ({ id: m.id, src: m.thumb })),
      prop: (e.property?.media || []).map((m) => ({ id: m.id, src: m.thumb })),
    },
    tracked: r2(tracked),
    done: r2(trackedHours(e.timeEntries, segs, {}, eventId)),
    running: Object.fromEntries(Object.entries(running).filter(([, r]) => r.eventId === eventId).map(([u, r]) => [u, r.start])),
    labor: laborPlan(e.lineItems, tracked),
    entries: e.timeEntries.filter((t) => t.endedAt).map((t) => ({ id: t.id, userId: t.userId, start: Date.parse(t.startedAt), end: Date.parse(t.endedAt) })).sort((a, b) => a.start - b.start),
    upsells: (d.upsells || []).filter((u) => u.textActive).map((u) => ({ id: u.id, name: u.name })),
  };
}

// Everyone who can be put on a job, with whether they're on the clock and where.
export async function crewList(employees, punches) {
  const running = await getRunning();
  const globals = await runningGlobal(employees.map((p) => p.id));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return employees.map((p) => {
    const lastIn = punches.filter((x) => x.userId === p.id && x.action === "in" && new Date(x.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today).pop();
    const r = running[p.id];
    return {
      id: p.id, name: p.name, first: p.firstName,
      clockedIn: !!(globals[p.id] || r),
      since: lastIn?.at || globals[p.id]?.startedAt || (r ? new Date(r.start).toISOString() : null),
      onJob: r ? { eventId: r.eventId, title: r.title, start: r.start } : null,
    };
  });
}

// ---------- changes to the visit ----------

export async function updateLabor(eventId, plan) {
  for (const p of plan) {
    await gql(`mutation($e: SafeInt!, $l: SafeInt!, $i: UpdateEventLineItemInput!) { updateEventLineItem(eventId: $e, lineItemId: $l, input: $i) { id } }`, {
      e: eventId, l: p.lineItemId, i: { quantity: String(p.to) },
    });
  }
  return { ok: true };
}

export const addDispatchNote = (eventId, message) =>
  gql(`mutation($e: SafeInt!, $i: DispatchNoteInput!) { createEventDispatchNote(eventId: $e, input: $i) { id } }`, { e: eventId, i: { message } });
export const setVisitNote = (eventId, description) =>
  gql(`mutation($e: SafeInt!, $d: String!) { updateEventDescription(eventId: $e, description: $d) { id } }`, { e: eventId, d: description });
export const setPropertyNotes = (propertyId, notes) =>
  gql(`mutation($p: SafeInt!, $i: UpdatePropertyInput!) { updateProperty(propertyId: $p, input: $i) { id } }`, { p: propertyId, i: { notes } });
export const closeEvent = (eventId) => gql(`mutation($e: SafeInt!) { closeEvent(eventId: $e) { id status } }`, { e: eventId });
export const skipEvent = (eventId, reason) => gql(`mutation($e: SafeInt!, $r: String!) { skipEvent(eventId: $e, skippedReason: $r) { id status } }`, { e: eventId, r: reason });
export const reopenEvent = (eventId) => gql(`mutation($e: SafeInt!) { reopenEvent(eventId: $e) { id status } }`, { e: eventId });
export const sendUpsell = (eventId, customerId, upsellId) =>
  gql(`mutation($i: SubmitUpsellInput!) { submitUpsell(input: $i) { id wasSent } }`, { i: { upsellId, eventId, customerId } });

// ---------- photos ----------
// The phone shrinks the photo and sends it here; we upload it to Homeworks' storage and
// attach it. Doing the upload server-side avoids browser upload restrictions.
export async function addPhoto({ eventId, propertyId, kind, contentType, data }) {
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new Error("The photo was empty.");
  const t = await gql(`mutation($c: String!, $s: SafeInt!) { createUpload(contentType: $c, size: $s) { key uploadUrl } }`, { c: contentType, s: bytes.length });
  const up = await fetch(t.createUpload.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!up.ok) throw new Error(`Photo upload failed (${up.status}).`);
  const key = t.createUpload.key;
  if (kind === "event") {
    await gql(`mutation($e: SafeInt!, $k: String!) { addEventMedia(eventId: $e, tempFileName: $k) { id } }`, { e: eventId, k: key });
  } else if (kind === "prop") {
    await gql(`mutation($p: SafeInt!, $k: String!) { addPropertyMedia(propertyId: $p, tempFileName: $k) { id } }`, { p: propertyId, k: key });
  } else {
    const d = await gql(`query($id: SafeInt!) { event(eventId: $id) { beforeAndAfters { id } } }`, { id: eventId });
    let baId = d.event.beforeAndAfters?.[0]?.id;
    if (!baId) baId = (await gql(`mutation($e: SafeInt!) { addBeforeAndAfter(eventId: $e) { id } }`, { e: eventId })).addBeforeAndAfter.id;
    const m = kind === "before" ? "addBeforeMedia" : "addAfterMedia";
    await gql(`mutation($b: SafeInt!, $k: String!) { ${m}(beforeAndAfterId: $b, tempFileName: $k) { id } }`, { b: baId, k: key });
  }
  return { ok: true };
}

export async function removePhoto({ kind, mediaId, ba, eventId, propertyId }) {
  if (kind === "event") await gql(`mutation($e: SafeInt!, $m: SafeInt!) { removeEventMedia(eventId: $e, mediaId: $m) { id } }`, { e: eventId, m: mediaId });
  else if (kind === "prop") await gql(`mutation($p: SafeInt!, $m: SafeInt!) { removePropertyMedia(propertyId: $p, mediaId: $m) { id } }`, { p: propertyId, m: mediaId });
  else {
    const m = kind === "before" ? "removeBeforeMedia" : "removeAfterMedia";
    await gql(`mutation($b: SafeInt!, $m: SafeInt!) { ${m}(beforeAndAfterId: $b, mediaId: $m) { id } }`, { b: ba, m: mediaId });
  }
  return { ok: true };
}

// Copy someone's finished job time on this visit to other people (same start and end).
// Their shop timers aren't touched; payroll counts overlapping time once.
export async function copyTime({ eventId, entryIds, userIds, by }) {
  const d = await gql(`query($id: SafeInt!) { event(eventId: $id) { id customerId propertyId timeEntries { id userId startedAt endedAt } } }`, { id: eventId });
  const ev = d.event;
  if (!ev) throw new Error("That visit wasn't found in Homeworks.");
  const pick = ev.timeEntries.filter((t) => entryIds.includes(t.id) && t.endedAt);
  if (!pick.length) throw new Error("That time isn't on this visit anymore. Refresh and try again.");
  const rates = await profileRates(userIds);
  const made = [], skipped = [];
  for (const uid of userIds) {
    for (const src of pick) {
      if (src.userId === uid) continue;
      const s = Date.parse(src.startedAt), e = Date.parse(src.endedAt);
      const clash = ev.timeEntries.some((t) => t.userId === uid && t.endedAt && Date.parse(t.startedAt) < e && Date.parse(t.endedAt) > s);
      if (clash) { skipped.push(uid); continue; }
      const input = { eventId, userId: uid, startedAt: src.startedAt, endedAt: src.endedAt, notes: `Crew clock · copied${by ? ` by ${by}` : ""}` };
      if (ev.customerId) input.customerId = ev.customerId;
      if (ev.propertyId) input.propertyId = ev.propertyId;
      if (rates[uid] != null) input.hourlyRate = rates[uid];
      const added = await gql(`mutation($i: TimeEntryInput!) { addTimeEntry(input: $i) { id } }`, { i: input });
      made.push({ id: added.addTimeEntry.id, userId: uid, start: s, end: e, by: by || null });
    }
  }
  await addSegments(eventId, made);
  return { ok: true, made: made.length, skipped: [...new Set(skipped)] };
}
