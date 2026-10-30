// Everything that talks to Homeworks: the one-time OAuth connection, keeping the
// login fresh, and the clock in / clock out / lunch logic.
import crypto from "node:crypto";
import { getJSON, setJSON, del } from "./store.mjs";
import { randomToken } from "./security.mjs";

const API = (process.env.HOMEWORKS_API || "https://api.home.works").replace(/\/$/, "");
const LUNCH_SECONDS = 30 * 60;
const MIN_SPLIT_SECONDS = 45 * 60; // one entry this long gets the whole 30 min

export class NotConnectedError extends Error {}

// ---------- OAuth (one-time "Connect Homeworks") ----------

async function getClient(redirectUri) {
  const existing = await getJSON("oauth-client");
  if (existing && existing.redirectUri === redirectUri) return existing;
  const res = await fetch(`${API}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "J-Brothers Shop Clock",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`Homeworks app registration failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const client = { clientId: data.client_id, redirectUri };
  await setJSON("oauth-client", client);
  return client;
}

export async function startAuth(origin) {
  const redirectUri = `${origin}/api/oauth/callback`;
  const { clientId } = await getClient(redirectUri);
  const verifier = randomToken(32);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = randomToken(16);
  await setJSON(`oauth-state-${state}`, { verifier, redirectUri, created: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid company",
    state,
  });
  return `${API}/oauth/authorize?${q}`;
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Homeworks token request failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

function saveTokens(data, previous = {}) {
  const claims = decodeJwt(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refreshExpiresAt: data.refresh_token ? Date.now() + 14 * 86400_000 : previous.refreshExpiresAt,
    connectedAs: claims.username || previous.connectedAs,
    userId: claims.userId ?? previous.userId,
    role: claims.role || previous.role,
    connectedAt: previous.connectedAt || Date.now(),
    refreshedAt: Date.now(),
  };
}

// Returns { ok: true } or { ok: false, error }.
export async function finishAuth(code, state) {
  const saved = state && (await getJSON(`oauth-state-${state}`));
  if (!saved || Date.now() - saved.created > 15 * 60_000) return { ok: false, error: "That login link expired. Try Connect again." };
  await del(`oauth-state-${state}`);
  const { clientId } = await getJSON("oauth-client");
  const data = await tokenRequest({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: saved.redirectUri,
    code_verifier: saved.verifier,
  });
  const claims = decodeJwt(data.access_token);
  if (!String(claims.role || "").toUpperCase().includes("OWNER")) {
    return { ok: false, error: "Please log in with the Homeworks owner account. Employee logins can't clock other people in." };
  }
  await setJSON("tokens", { ...saveTokens(data), connectedAt: Date.now() });
  return { ok: true };
}

let refreshing = null;
export async function getAccessToken({ force = false } = {}) {
  const t = await getJSON("tokens");
  if (!t?.refreshToken) throw new NotConnectedError("Homeworks isn't connected yet.");
  if (!force && t.expiresAt - 120_000 > Date.now()) return t.accessToken;
  if (!refreshing) refreshing = doRefresh(t).finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh(t) {
  const { clientId } = await getJSON("oauth-client");
  try {
    const data = await tokenRequest({ client_id: clientId, grant_type: "refresh_token", refresh_token: t.refreshToken });
    const next = saveTokens(data, t);
    await setJSON("tokens", next);
    return next.accessToken;
  } catch (err) {
    // Another request may have refreshed at the same moment; use its result if so.
    const latest = await getJSON("tokens");
    if (latest && latest.refreshToken !== t.refreshToken && latest.expiresAt > Date.now()) return latest.accessToken;
    await setJSON("tokens", { ...t, broken: true, error: String(err.message).slice(0, 300) });
    throw new NotConnectedError("The Homeworks connection expired. Reconnect it from the admin screen.");
  }
}

export async function connectionStatus() {
  const t = await getJSON("tokens");
  if (!t?.refreshToken) return { connected: false };
  return {
    connected: !t.broken,
    connectedAs: t.connectedAs,
    refreshedAt: t.refreshedAt,
    refreshExpiresAt: t.refreshExpiresAt,
    error: t.broken ? t.error : undefined,
  };
}

// ---------- GraphQL ----------

export async function gql(query, variables = {}) {
  let token = await getAccessToken();
  let res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    token = await getAccessToken({ force: true });
    res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    const msg = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Homeworks: ${msg}`);
  }
  return body.data;
}

export async function listEmployees() {
  const data = await gql(`{ users(where: { isDeleted: false }) { id firstName lastName role inactiveDate } }`);
  return data.users
    .filter((u) => !u.inactiveDate)
    .map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), firstName: u.firstName, role: u.role }));
}

// A person counts as clocked in if any timer (shop/drive or job) is running for them.
export async function clockedInSince(userId) {
  const data = await gql(
    `query($u: SafeInt!) { timeEntries(where: { userId: { equals: $u }, isRunning: true }, take: 5) { id startedAt } }`,
    { u: userId }
  );
  const running = data.timeEntries;
  if (!running.length) return null;
  // Walk back to the start of today's shift for a friendlier "since" time.
  const since = await shiftStart(userId, running.map((r) => r.startedAt).sort()[0]);
  return since;
}

async function shiftStart(userId, fallback) {
  const from = new Date(Date.now() - 16 * 3600_000).toISOString();
  const data = await gql(
    `query($u: SafeInt!, $from: DateTime!) { timeEntries(where: { userId: { equals: $u }, startedAt: { gte: $from } }, orderBy: [{ timeStart: asc }], take: 300) { startedAt endedAt } }`,
    { u: userId, from }
  );
  // Chain backwards from the running timer while entries touch each other (gaps under 2 min).
  const entries = data.timeEntries;
  let start = fallback;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.startedAt >= start) continue;
    if (e.endedAt && new Date(start) - new Date(e.endedAt) <= 120_000) start = e.startedAt;
  }
  return start;
}

export async function clockIn(userId) {
  const data = await gql(`mutation($u: SafeInt!) { clockInUser(userId: $u) { id createdAt } }`, { u: userId });
  return data.clockInUser; // null = was already clocked in
}

export async function clockOut(userId) {
  const data = await gql(`mutation($u: SafeInt!) { clockOutUser(userId: $u) { id createdAt } }`, { u: userId });
  return data.clockOutUser; // null = wasn't clocked in
}

// Takes 30 minutes of lunch out of the shift that just ended. Clock-in and clock-out
// times always stay as punched; the time comes out of the middle of entries.
// 1) Normal case: one 30-min gap in the middle of the longest entry (45+ min long).
// 2) Choppy day with no 45-min entry: the 30 min is spread across the longest entries,
//    always leaving at least 10 min of each entry in place.
const KEEP_SECONDS = 10 * 60;      // never shrink an entry below this
const MIN_PIECE_SECONDS = 5 * 60;  // don't bother with cuts smaller than this

async function cutGap(entry, cutSecs, userId) {
  const startMs = new Date(entry.startedAt).getTime();
  const gapStart = new Date(startMs + Math.round((entry.secs - cutSecs) / 2) * 1000);
  const gapEnd = new Date(gapStart.getTime() + cutSecs * 1000);
  const mins = Math.round(cutSecs / 60);
  const note = (extra) => [entry.notes, extra].filter(Boolean).join(" | ");

  const input = {
    startedAt: gapEnd.toISOString(),
    endedAt: entry.endedAt,
    userId,
    notes: note(`After ${mins} min of 30 min lunch deducted (shop clock)`),
  };
  if (entry.eventId) {
    input.eventId = entry.eventId;
    if (entry.customerId) input.customerId = entry.customerId;
    if (entry.propertyId) input.propertyId = entry.propertyId;
  } else if (entry.categoryId) {
    input.categoryId = entry.categoryId;
  }
  if (entry.hourlyRate != null) input.hourlyRate = entry.hourlyRate;

  // Add the second half first, then shorten the original, so time is never lost if a step fails.
  const added = await gql(`mutation($i: TimeEntryInput!) { addTimeEntry(input: $i) { id } }`, { i: input });
  try {
    await gql(`mutation($id: SafeInt!, $i: UpdateTimeEntryInput!) { updateTimeEntry(timeEntryId: $id, input: $i) { id } }`, {
      id: entry.id,
      i: { endedAt: gapStart.toISOString(), notes: note(`Before ${mins} min of 30 min lunch deducted (shop clock)`) },
    });
  } catch (err) {
    await gql(`mutation($id: SafeInt!) { deleteTimeEntry(timeEntryId: $id) }`, { id: added.addTimeEntry.id }).catch(() => {});
    throw err;
  }
  return { entryId: entry.id, type: entry.type, minutes: mins, gapStart: gapStart.toISOString(), gapEnd: gapEnd.toISOString() };
}

export async function deductLunch(userId, clockOutAt) {
  const end = new Date(clockOutAt || Date.now());
  const from = new Date(end - 16 * 3600_000).toISOString();
  const data = await gql(
    `query($u: SafeInt!, $from: DateTime!) { timeEntries(where: { userId: { equals: $u }, startedAt: { gte: $from } }, take: 300) {
       id type categoryId eventId customerId propertyId startedAt endedAt totalSeconds hourlyRate notes } }`,
    { u: userId, from }
  );
  const fromMs = end.getTime() - 16 * 3600_000;
  const entries = data.timeEntries
    .filter(
      (e) =>
        e.endedAt &&
        new Date(e.startedAt).getTime() >= fromMs &&
        new Date(e.endedAt).getTime() <= end.getTime() + 60_000 &&
        !String(e.notes || "").includes("lunch deducted")
    )
    .map((e) => ({ ...e, secs: (new Date(e.endedAt) - new Date(e.startedAt)) / 1000 }))
    .sort((a, b) => b.secs - a.secs);

  // Plan the cuts.
  const plan = [];
  if (entries[0] && entries[0].secs >= MIN_SPLIT_SECONDS) {
    plan.push([entries[0], LUNCH_SECONDS]);
  } else {
    let left = LUNCH_SECONDS;
    for (const e of entries) {
      if (left <= 0) break;
      const room = Math.floor((e.secs - KEEP_SECONDS) / 60) * 60;
      const take = Math.min(left, room);
      if (take < MIN_PIECE_SECONDS) continue;
      plan.push([e, take]);
      left -= take;
    }
    if (left > 0) {
      return { ok: false, reason: `Not enough time on the clock today to take out 30 min of lunch (could only find ${Math.round((LUNCH_SECONDS - left) / 60)} min). Nothing was changed.` };
    }
  }

  const cuts = [];
  for (const [entry, secs] of plan) {
    try {
      cuts.push(await cutGap(entry, secs, userId));
    } catch (err) {
      const done = cuts.reduce((n, c) => n + c.minutes, 0);
      return { ok: false, cuts, reason: `Only ${done} of 30 min of lunch was taken out; the rest needs fixing by hand. (${err.message})` };
    }
  }
  return { ok: true, cuts };
}
