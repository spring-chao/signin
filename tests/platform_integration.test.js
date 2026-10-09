const nodeAssert = require("assert");
let assertionCount = 0;
const assert = new Proxy(nodeAssert, {
  apply(target, receiver, args) { assertionCount++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === "function" ? (...args) => { assertionCount++; return value(...args); } : value; }
});
const Module = require("module");
const crypto = require("crypto");
const { createAtomicDatabase } = require("./support/atomic_database");
const { checkinDocumentId, persistCheckin, verifyCheckinTicket } = require("../cloudfunc/platform-service");

process.env.SIGNIN_PLATFORM_API_KEY = "isolated-platform-caller";
process.env.SIGNIN_SERVICE_API_KEY = "isolated-reader-key";
process.env.ADMIN_PASSWORD_HASH = crypto.createHash("sha256").update("isolated-legacy-admin").digest("hex");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400000));
const db = createAtomicDatabase({ config: [], events: [], registrations: [], checkins: [], event_audit_logs: [] });
const load = Module._load;
const initializedEnvironments = [];
Module._load = function(name, parent, main) { if (name === "@cloudbase/node-sdk") return { init: options => { initializedEnvironments.push(options.env); return { database: () => db }; } }; return load.call(this, name, parent, main); };
const api = require("../cloudfunc/index");
Module._load = load;

const permissions = ["attendance:view", "attendance:create", "attendance:update", "attendance:manage", "attendance:status", "attendance:import", "attendance:export", "attendance:code"];
let immediateCalls = [], failSync = false, blockedOps = false;
api._test.setPlatformRequestHandler(async (path, body) => {
  immediateCalls.push({ path, body });
  if (failSync) throw new Error("isolated platform outage");
  return { success: true, data: { status: "SUCCESS", received_sessions: 1 } };
});
api._test.setRequestOpsHandler(async (path, params) => {
  if (blockedOps) throw new Error("isolated platform is stopped");
  if (path.endsWith("/options")) return { success: true, data: { source: "PLATFORM_ORG_RELATIONS", query_mode: "ORG_UNIT_ID", fallback_mode: "FAIL_CLOSED", classes: [{ id: "class-1", parent_id: "center-1" }, { id: "class-2", parent_id: "center-1" }], groups: [{ id: "group-1", parent_id: "class-1" }] } };
  if (path.endsWith("/validate")) return { success: true, data: { source: "PLATFORM_ORG_RELATIONS", query_mode: "ORG_UNIT_ID", fallback_mode: "FAIL_CLOSED", passed: true, class_member_count: 1, group_member_count: 1, group_class_mismatch_count: 0, invalid_relation_count: 0 } };
  if (path.endsWith("/cross-class-members")) return { success: true, data: { source: "PLATFORM_ORG_RELATIONS", query_mode: "EXACT_NAME_CURRENT_STUDY_CLASS", fallback_mode: "FAIL_CLOSED", event_class_org_unit_id: params.event_class_org_unit_id, members: [{ member_id: "22", member_code: "M22", name: "同名学员", home_class_org_unit_id: "class-2", home_class_name: "二班", company_name: "示例公司" }] } };
  if (path.endsWith("/members")) {
    const id = params.group_org_unit_id || params.class_org_unit_id;
    return { success: true, data: { source: "PLATFORM_ORG_RELATIONS", query_mode: "ORG_UNIT_ID", fallback_mode: "FAIL_CLOSED", member_count: 1, scope: { org_unit_id: id, class_org_unit_id: params.class_org_unit_id }, members: [{ name: "正式学员", member_id: "10", member_code: "M10", relation_org_id: id, class_name: "一班", group_name: "一组" }] } };
  }
  throw new Error("unexpected isolated request " + path);
});

async function request(path, method = "POST", body = {}, key = process.env.SIGNIN_PLATFORM_API_KEY) {
  const [pathname, search = ""] = path.split("?");
  const response = await api.main({ path: pathname, httpMethod: method, queryStringParameters: Object.fromEntries(new URLSearchParams(search)), headers: key ? { "X-API-Key": key } : {}, body: JSON.stringify(body) });
  return { status: response.statusCode, data: JSON.parse(response.body || "{}") };
}
async function manage(operation, payload, options = {}) {
  return request("/ops/v1/manage/" + operation, "POST", { payload, actor: { id: "operator-1", permissions: options.permissions || permissions }, allowed_org_unit_ids: options.scope === undefined ? null : options.scope }, options.key === undefined ? process.env.SIGNIN_PLATFORM_API_KEY : options.key);
}
function seedEvent(id, extra = {}) {
  db.collections.events.push({ _id: "doc-" + id, event_id: id, name: "示例 " + id, event_date: today, activity_type: "course", lifecycle_status: "CONFIRMED", status: "active", org_unit_id: "center-1", class_org_unit_id: "class-1", checkin_start_at: new Date(Date.now() - 60000).toISOString(), checkin_end_at: new Date(Date.now() + 600000).toISOString(), ...extra });
}
function seedRegistration(id, event, extra = {}) { db.collections.registrations.push({ _id: id, batch_id: event, name: "同名学员", registered_name: "同名学员", actual_attendee_name: "", platform_member_id: "11", member_code: "M11", attendance_role: "COURSE_REGISTRANT", attendance_status: "pending", created_at: new Date().toISOString(), ...extra }); }
function signTicket(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded + "." + crypto.createHmac("sha256", process.env.SIGNIN_PLATFORM_API_KEY).update(encoded).digest("base64url");
}

(async () => {
  process.env.SIGNIN_DEPLOYMENT_MODE = "staging";
  for (const invalid of ["", "shengheshu-d2g2zyyl99f6c6fc2", "REPLACE_WITH_ISOLATED_STAGING_ENV_ID"]) {
    process.env.SIGNIN_CLOUDBASE_ENV_ID = invalid;
    const before = initializedEnvironments.length;
    await assert.rejects(() => request("/ops/v1/manage/admin_events", "POST", {}), /ISOLATED_STAGING_ENVIRONMENT_REQUIRED/);
    assert.equal(initializedEnvironments.length, before, "unsafe staging environment fails before SDK initialization");
  }
  process.env.SIGNIN_CLOUDBASE_ENV_ID = "isolated-test-environment";
  await manage("admin_events", {});
  assert.equal(initializedEnvironments.at(-1), "isolated-test-environment");
  assert.equal((await request("/ops/v1/member-checkin/events", "POST", {})).data.fallback_url, null, "staging never falls back to the production site");
  process.env.SIGNIN_LEGACY_URL = "https://spring-chao.github.io/signin/";
  assert.equal((await request("/ops/v1/member-checkin/events", "POST", {})).data.fallback_url, null);
  process.env.SIGNIN_LEGACY_URL = "https://legacy.signin-fixture.net/index.html";
  assert.equal((await request("/ops/v1/member-checkin/events", "POST", {})).data.fallback_url, process.env.SIGNIN_LEGACY_URL);
  delete process.env.SIGNIN_LEGACY_URL;
  delete process.env.SIGNIN_DEPLOYMENT_MODE; delete process.env.SIGNIN_CLOUDBASE_ENV_ID;
  seedEvent("main");
  seedRegistration("r11", "main");
  seedRegistration("r12", "main", { platform_member_id: "12", member_code: "M12" });
  assert.equal((await manage("admin_events", {}, { key: "" })).status, 401);
  assert.equal((await manage("admin_events", {}, { key: process.env.SIGNIN_SERVICE_API_KEY })).status, 401, "read key must not authorize management");
  assert.equal((await manage("admin_events", {}, { permissions: ["attendance:export"] })).status, 403);
  for (const operation of ["reset", "clear_all", "admin_password", "settings", "unknown"]) assert.equal((await manage(operation, {})).status, 404);
  const spoof = await request("/event_update", "POST", { event_id: "main", status: "closed", actor: { id: "fake", permissions }, allowed_org_unit_ids: null, _trusted: true });
  assert.equal(spoof.status, 401, "HTTP bodies cannot construct the internal trusted symbol");
  assert.equal((await manage("event_detail", { event_id: "main" }, { scope: ["class-2"] })).status, 403);
  assert.equal((await manage("event_detail", { event_id: "main" }, { scope: ["center-1"] })).status, 403, "a center ID alone is not an expanded class scope");
  seedEvent("other", { class_org_unit_id: "class-2" });
  const scoped = await manage("admin_events", { page: 1 }, { scope: ["class-1"] });
  assert(scoped.data.items.some(item => item.event_id === "main"));
  assert(!scoped.data.items.some(item => item.event_id === "other"));
  const unauthorizedStatus = await manage("event_update", { event_id: "main", status: "closed" }, { permissions: ["attendance:update"] });
  assert.equal(unauthorizedStatus.status, 403);
  const mixed = await manage("event_update", { event_id: "main", name: "混合修改", status: "closed" }, { permissions: ["attendance:manage"] });
  assert.equal(mixed.status, 403);
  const close = await manage("event_update", { event_id: "main", status: "closed" }, { permissions: ["attendance:manage"] });
  assert.equal(close.data.ok, true);
  assert.equal(close.data.audit.actor, "operator-1");
  assert.equal(close.data.audit.before.status, "active");
  assert.equal(close.data.audit.after.manual_status, "closed");
  await manage("event_update", { event_id: "main", status: "active" });

  const anonymous = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "main", member: null });
  assert.equal(anonymous.data.registration, null);
  assert.equal(anonymous.data.can_checkin, false);
  const member = { member_id: "11", member_code: "M11", name: "同名学员" };
  const lookup = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "main", member });
  assert.equal(lookup.data.registration_id, "r11", "bound identity must bypass same-name selection");
  assert.equal(lookup.data.registration.registration_id, "r11");
  assert.equal((await request("/ops/v1/member-checkin/confirm", "POST", { event_id: "main", member, registration_id: "r12" })).status, 403);
  const confirmations = await Promise.all(Array.from({ length: 20 }, () => request("/ops/v1/member-checkin/confirm", "POST", { event_id: "main", member, registration_id: "r11" })));
  assert(confirmations.every(result => result.data.ok));
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "main" && row.registration_id === "r11").length, 1, "concurrent requests create one fact");
  assert(confirmations.some(result => result.data.already));
  assert.equal(confirmations[0].data.sync_status, "SYNCED");
  assert.equal(db.collections.checkins.find(row => row.registration_id === "r11").checkin_source, "WECHAT");
  const details = await manage("event_detail", { event_id: "main" });
  assert.equal(details.data.rows.length, 2);
  assert.equal(details.data.rows.find(row => row.registration_id === "r11").checked, true);
  assert(!JSON.stringify(details.data).includes("attendance_note"));
  const attemptedEdit = await manage("event_update", { event_id: "main", class_org_unit_id: "class-2" });
  assert.equal(attemptedEdit.data.code, "ACTIVITY_ALREADY_STARTED");
  const pull = await request("/ops/v1/attendance/records?session_id=main&event_id=main", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.equal(pull.data.items.find(row => row.external_record_id === "r11").member_id, 11);
  assert.equal(pull.data.items.find(row => row.external_record_id === "r11").checkin_source, "WECHAT");
  const sessions = await request("/ops/v1/attendance/sessions?event_id=main", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.deepEqual(sessions.data.items.map(item => item.session_id), ["main"]);

  failSync = true;
  seedEvent("outage"); seedRegistration("r-outage", "outage");
  const outage = await request("/ops/v1/member-checkin/confirm", "POST", { event_id: "outage", member });
  assert.equal(outage.data.ok, true, "platform outage must never roll back check-in");
  assert.equal(outage.data.sync_status, "PENDING");
  const pending = db.collections.checkins.find(row => row.registration_id === "r-outage");
  assert.equal(pending.sync_state, "PENDING");
  assert.equal(pending.sync_attempts, 1);
  assert.equal(pending.sync_last_error_code, "PLATFORM_SYNC_UNAVAILABLE");
  failSync = false; pending.sync_next_retry_at = "2000-01-01T00:00:00Z";
  const retry = await api.main({ Type: "Timer", TriggerName: "attendanceSyncRetryEvery5Minutes" });
  assert(retry.delivered_count >= 1);
  assert.equal(db.collections.checkins.find(row => row.registration_id === "r-outage").sync_state, "DELIVERED");
  process.env.CHECKIN_ROSTER_API_BASE = "https://platform.invalid";
  process.env.CHECKIN_ROSTER_API_KEY = "isolated-roster-reader";
  const fallback = await api.main({ Type: "Timer", TriggerName: "attendanceSyncWeekdays0000" });
  assert.equal(fallback.action, "platform_attendance_sync");
  assert(immediateCalls.some(call => call.path.endsWith("/sync/scheduled")));
  delete process.env.CHECKIN_ROSTER_API_BASE; delete process.env.CHECKIN_ROSTER_API_KEY;

  seedEvent("native"); seedRegistration("r-native", "native");
  const issuedAt = Math.floor(Date.now() / 1000);
  const ticketPayload = { purpose: "MEMBER_CHECKIN", event_id: "native", member, iat: issuedAt, exp: issuedAt + 300, binding_id: "binding-11", token_version: 1 };
  for (const skew of [-1, 1]) assert.equal(verifyCheckinTicket(signTicket({ ...ticketPayload, iat: issuedAt + skew, exp: issuedAt + skew + 300 }), process.env.SIGNIN_PLATFORM_API_KEY, issuedAt).event_id, "native", "one-second clock skew preserves a five-minute ticket");
  assert.throws(() => verifyCheckinTicket(signTicket({ ...ticketPayload, iat: issuedAt + 6, exp: issuedAt + 306 }), process.env.SIGNIN_PLATFORM_API_KEY, issuedAt), /CHECKIN_TICKET_INVALID/);
  assert.throws(() => verifyCheckinTicket(signTicket({ ...ticketPayload, exp: issuedAt + 301 }), process.env.SIGNIN_PLATFORM_API_KEY, issuedAt), /CHECKIN_TICKET_INVALID/);
  assert.throws(() => verifyCheckinTicket(signTicket({ ...ticketPayload, iat: undefined }), process.env.SIGNIN_PLATFORM_API_KEY, issuedAt), /CHECKIN_TICKET_INVALID/);
  assert.throws(() => verifyCheckinTicket(signTicket({ ...ticketPayload, iat: issuedAt - 300, exp: issuedAt }), process.env.SIGNIN_PLATFORM_API_KEY, issuedAt), /CHECKIN_TICKET_INVALID/);
  const ticket = signTicket(ticketPayload);
  const tamperedTicket = ticket.split(".")[0] + "." + (ticket.split(".")[1][0] === "A" ? "B" : "A") + ticket.split(".")[1].slice(1);
  for (const invalid of [tamperedTicket, signTicket({ ...ticketPayload, purpose: "ADMIN_MANAGE" }), signTicket({ ...ticketPayload, exp: Math.floor(Date.now() / 1000) - 1 }), signTicket({ ...ticketPayload, exp: Math.floor(Date.now() / 1000) + 600 }), signTicket({ ...ticketPayload, binding_id: "" })]) {
    assert.equal((await request("/native/v1/checkin/confirm", "POST", { ticket: invalid }, "")).status, 401);
  }
  assert.equal((await request("/native/v1/checkin/confirm", "POST", { ticket, member: { member_id: "12" } }, "")).status, 401, "native endpoint accepts only a signed authorization");
  assert.equal((await manage("admin_events", {}, { key: ticket })).status, 401, "check-in tickets cannot authorize management");
  failSync = true; blockedOps = true;
  const offlineNative = await request("/native/v1/checkin/confirm", "POST", { ticket }, "");
  assert.equal(offlineNative.data.ok, true, "preloaded ticket commits directly with the platform stopped");
  assert.equal(offlineNative.data.sync_status, "PENDING");
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "native").length, 1);
  seedEvent("native-cross", { activity_type: "class_meeting" });
  const nativeCrossMember = { member_id: "22", member_code: "M22", name: "同名学员", home_class_org_unit_id: "class-2", class_name: "二班", group_name: "二组" };
  const nativeCross = await request("/native/v1/checkin/confirm", "POST", { ticket: signTicket({ ...ticketPayload, event_id: "native-cross", member: nativeCrossMember }) }, "");
  assert.equal(nativeCross.data.ok, true, "signed current organization snapshot preserves cross-class attendance during platform outage");
  assert.equal(nativeCross.data.sync_status, "PENDING");
  assert.equal(db.collections.registrations.find(row => row.batch_id === "native-cross").home_class_org_unit_id, "class-2");
  failSync = false; blockedOps = false;
  seedEvent("native-storage-error"); seedRegistration("r-native-storage-error", "native-storage-error");
  const originalTransaction = db.runTransaction;
  db.runTransaction = async () => { throw new Error("isolated storage outage"); };
  const storageError = await request("/native/v1/checkin/confirm", "POST", { ticket: signTicket({ ...ticketPayload, event_id: "native-storage-error" }) }, "");
  assert.equal(storageError.status, 503, "storage errors cannot be reported as invalid signed tickets");
  assert.equal(storageError.data.code, "CHECKIN_ENGINE_UNAVAILABLE");
  assert(!db.collections.checkins.some(row => row.batch_id === "native-storage-error"));
  db.runTransaction = originalTransaction;
  seedEvent("upcoming", { checkin_start_at: new Date(Date.now() + 60000).toISOString() });
  seedRegistration("r-upcoming", "upcoming");
  const upcomingLookup = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "upcoming", member });
  assert.equal(upcomingLookup.data.ok, true);
  assert.equal(upcomingLookup.data.can_checkin, false);
  assert.equal(upcomingLookup.data.status, "UPCOMING");
  assert.equal((await request("/ops/v1/member-checkin/confirm", "POST", { event_id: "upcoming", member })).data.ok, false);
  const singleRecord = await request("/ops/v1/attendance/records?event_id=main&registration_id=r11", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.equal(singleRecord.data.items.length, 1);
  assert.equal(singleRecord.data.items[0].external_registration_id, "r11");
  assert.equal(singleRecord.data.has_more, false);
  assert.equal((await request("/ops/v1/attendance/records?event_id=outage&registration_id=r11", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY)).data.items.length, 0);
  assert.equal((await request("/ops/v1/attendance/records?registration_id=r11", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY)).status, 400);

  for (const [id, extra] of [["closed", { status: "closed" }], ["draft", { lifecycle_status: "DRAFT" }], ["expired", { checkin_end_at: new Date(Date.now() - 1000).toISOString() }], ["future", { event_date: tomorrow }]]) {
    seedEvent(id, extra); seedRegistration("r-" + id, id);
    assert.equal((await request("/ops/v1/member-checkin/confirm", "POST", { event_id: id, member })).data.ok, false);
    assert(!db.collections.checkins.some(row => row.batch_id === id));
  }
  const absent = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "main", member: { member_id: "99", member_code: "M99", name: "未报名学员" } });
  assert.equal(absent.data.requires_fallback, true);
  assert.equal(absent.data.can_checkin, false);
  const unbound = await request("/ops/v1/member-checkin/confirm", "POST", { event_id: "main", member: {} });
  assert.equal(unbound.data.status, "UNBOUND");
  seedEvent("cross", { activity_type: "class_meeting" });
  const external = { member_id: "22", member_code: "M22", name: "同名学员" };
  const crossLookup = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "cross", member: external });
  assert.equal(crossLookup.data.cross_class_member, true);
  const crossConfirm = await Promise.all(Array.from({ length: 8 }, () => request("/ops/v1/member-checkin/confirm", "POST", { event_id: "cross", member: external })));
  assert(crossConfirm.every(result => result.data.ok));
  assert.equal(db.collections.registrations.filter(row => row.batch_id === "cross" && row.platform_member_id === "22").length, 1);
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "cross").length, 1);
  const crossPull = await request("/ops/v1/attendance/records?session_id=cross", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.equal(crossPull.data.items[0].participant_type, "MEMBER");
  assert.equal(crossPull.data.items[0].attendance_role, "CROSS_CLASS_MEMBER");
  assert.equal(crossPull.data.items[0].score_eligible, false);
  assert.equal(crossPull.data.items[0].home_class_org_unit_id, "class-2");
  seedEvent("home-platform-type", { activity_type: "class_meeting" });
  seedRegistration("home-platform-r", "home-platform-type", { attendance_role: "HOME_CLASS_MEMBER" });
  const homePull = await request("/ops/v1/attendance/records?session_id=home-platform-type", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.equal(homePull.data.items[0].participant_type, "MEMBER");
  assert.equal(homePull.data.items[0].attendance_role, "HOME_CLASS_MEMBER");

  const metadata = { event_name: "空名单新活动", event_date: tomorrow, activity_type: "course", org_unit_id: "center-1", checkin_start_at: tomorrow + "T08:00", checkin_end_at: tomorrow + "T10:00", scheduled_start_at: tomorrow + "T09:00", scheduled_end_at: tomorrow + "T12:00" };
  const created = await manage("create_event", metadata);
  assert.equal(created.data.ok, true);
  assert.equal(db.collections.registrations.filter(row => row.batch_id === created.data.event_id).length, 0);
  assert.equal(db.collections.events.find(row => row.event_id === created.data.event_id).org_unit_id, "center-1");
  const importPayload = { event_id: created.data.event_id, attendees: [{ name: "原报名联系人", company: "团队一" }, { name: "原报名联系人", company: "团队一" }] };
  const preview = await manage("import_preview", importPayload);
  assert.equal(preview.data.ok, true, preview.data.code || preview.data.msg); assert(preview.data.preview_token);
  const imported = await manage("import_apply", { ...importPayload, preview_token: preview.data.preview_token, preview_issued_at: preview.data.preview_issued_at });
  assert.equal(imported.data.added, 2, "repeated registration slots remain independent");
  const stale = await manage("import_apply", { ...importPayload, preview_token: preview.data.preview_token, preview_issued_at: preview.data.preview_issued_at });
  assert.equal(stale.data.needs_preview, true);
  const badTimes = await manage("create_event", { ...metadata, event_name: "错误时间", scheduled_start_at: tomorrow + "T11:00" });
  assert.equal(badTimes.data.ok, false);

  const classCreated = await manage("create_class_meeting_sessions", { event_date: tomorrow, event_name: "三场学习会", org_unit_id: "class-1", class_org_unit_id: "class-1", roster_members: [{ name: "伪造名单", member_id: "999" }] }, { scope: ["class-1"] });
  assert.equal(classCreated.data.ok, true);
  assert.deepEqual(classCreated.data.events.map(item => item.session_code), ["MORNING", "AFTERNOON", "KONPA"]);
  const morningId = classCreated.data.events[0].event_id, afternoonId = classCreated.data.events[1].event_id;
  assert.equal(db.collections.registrations.filter(row => row.event_group_id === classCreated.data.event_group_id).length, 3);
  assert(!db.collections.registrations.some(row => row.name === "伪造名单"));
  for (const id of [morningId, afternoonId]) {
    Object.assign(db.collections.events.find(row => row.event_id === id), { event_date: today, checkin_start_at: new Date(Date.now() - 1000).toISOString(), checkin_end_at: new Date(Date.now() + 60000).toISOString() });
    assert.equal((await request("/ops/v1/member-checkin/confirm", "POST", { event_id: id, member: { member_id: "10", member_code: "M10", name: "正式学员" } })).data.ok, true);
  }
  assert.equal(db.collections.checkins.filter(row => [morningId, afternoonId].includes(row.batch_id)).length, 2, "morning attendance never substitutes for afternoon");
  const groupCreated = await manage("create_event", { ...metadata, event_name: "小组学习", activity_type: "group_meeting", class_org_unit_id: "class-1", group_org_unit_id: "group-1" });
  assert.equal(groupCreated.data.ok, true);
  const groupRows = db.collections.registrations.filter(row => row.batch_id === groupCreated.data.event_id);
  assert.equal(groupRows[0].platform_member_id, "10");
  assert.equal(groupRows[0].member_code, "M10");
  const groupOnly = await manage("create_event", { ...metadata, event_name: "小组权限活动", activity_type: "group_meeting", org_unit_id: "group-1", class_org_unit_id: "class-1", group_org_unit_id: "group-1", center_name: "示例分中心", class_name: "一班", group_name: "一组" }, { scope: ["group-1"] });
  assert.equal(groupOnly.data.ok, true, "group ownership does not require parent class or center scope");
  const groupDetail = await manage("event_detail", { event_id: groupOnly.data.event_id }, { scope: ["group-1"] });
  assert.equal(groupDetail.data.event.class_name, "一班");
  assert.equal(groupDetail.data.event.group_name, "一组");
  assert.equal((await manage("event_detail", { event_id: groupOnly.data.event_id }, { scope: ["class-1"] })).status, 403);
  const groupOptions = await manage("ops_roster_options", {}, { scope: ["group-1"] });
  assert.equal(groupOptions.data.classes.length, 1, "parent selector metadata does not extend ownership authorization");
  assert.equal(groupOptions.data.classes[0].id, "class-1");
  assert.equal((await manage("create_event", { ...metadata, event_name: "错误祖先关系", activity_type: "group_meeting", class_org_unit_id: "class-2", group_org_unit_id: "group-1" }, { scope: ["group-1"] })).status, 403);
  assert.equal((await manage("create_event", { ...metadata, event_name: "错误分中心", org_unit_id: "wrong-center", class_org_unit_id: "class-1" })).status, 403);
  assert.equal((await manage("event_update", { event_id: groupOnly.data.event_id, class_org_unit_id: "class-2" }, { scope: ["group-1"] })).status, 403);
  assert.equal((await manage("event_lifecycle_update", { event_id: created.data.event_id, lifecycle_status: "CONFIRMED" }, { permissions: ["attendance:manage"] })).status, 403);
  assert.equal((await manage("event_lifecycle_update", { event_id: created.data.event_id, lifecycle_status: "CONFIRMED" }, { permissions: ["attendance:update"] })).data.ok, true);
  assert.equal((await manage("event_lifecycle_update", { event_id: created.data.event_id, lifecycle_status: "CANCELLED" }, { permissions: ["attendance:update"] })).status, 403);
  assert.equal((await manage("event_lifecycle_update", { event_id: created.data.event_id, lifecycle_status: "CANCELLED" }, { permissions: ["attendance:manage"] })).data.ok, true);
  assert.equal((await manage("upload", metadata, { permissions: ["attendance:import"] })).status, 403);

  for (const [eventId, role, slots] of [["single-bound-team", "EVENT_TEAM_MEMBER", 1], ["multiple-bound-team", "COURSE_TEAM_MEMBER", 2]]) {
    seedEvent(eventId);
    for (let i = 0; i < slots; i++) seedRegistration(eventId + "-" + i, eventId, { attendance_role: role, company: "绑定团队联系人" });
    for (const operation of ["lookup", "confirm"]) {
      const teamBridge = await request("/ops/v1/member-checkin/" + operation, "POST", { event_id: eventId, member });
      assert.equal(teamBridge.status, operation === "lookup" ? 200 : 409);
      assert.equal(teamBridge.data.ok, operation === "lookup");
      assert.equal(teamBridge.data.status, "TEAM_FALLBACK");
      assert.equal(teamBridge.data.can_checkin, false);
      assert.equal(teamBridge.data.requires_fallback, true);
    }
    const teamNative = await request("/native/v1/checkin/confirm", "POST", { ticket: signTicket({ ...ticketPayload, event_id: eventId }) }, "");
    assert.equal(teamNative.status, 409);
    assert.equal(teamNative.data.ok, false);
    assert.equal(teamNative.data.status, "TEAM_FALLBACK");
    assert(!db.collections.checkins.some(row => row.batch_id === eventId), "bound team contacts cannot write ordinary attendance");
  }
  seedEvent("non-team-conflict");
  for (let i = 0; i < 2; i++) seedRegistration("non-team-conflict-" + i, "non-team-conflict");
  const identityConflict = await request("/ops/v1/member-checkin/lookup", "POST", { event_id: "non-team-conflict", member });
  assert.equal(identityConflict.data.ok, false);
  assert.equal(identityConflict.data.status, "IDENTITY_CONFLICT");
  assert(!identityConflict.data.requires_fallback, "non-team stable identity conflicts remain fail-closed");
  for (const change of ["deleted", "changed-to-team"]) {
    const eventId = "preloaded-ticket-" + change;
    seedEvent(eventId); seedRegistration(eventId + "-registration", eventId);
    const preloadedTicket = signTicket({ ...ticketPayload, event_id: eventId });
    if (change === "deleted") db.collections.registrations.splice(db.collections.registrations.findIndex(row => row._id === eventId + "-registration"), 1);
    else db.collections.registrations.find(row => row._id === eventId + "-registration").attendance_role = "EVENT_TEAM_MEMBER";
    const changed = await request("/native/v1/checkin/confirm", "POST", { ticket: preloadedTicket }, "");
    assert.equal(changed.status, 409);
    assert.equal(changed.data.ok, false, "preloaded authorization is not a committed attendance fact");
    assert.equal(changed.data.status, change === "deleted" ? "NOT_REGISTERED" : "TEAM_FALLBACK");
    assert(!db.collections.checkins.some(row => row.batch_id === eventId));
  }

  seedEvent("team-race");
  for (let i = 1; i <= 2; i++) seedRegistration("team-r" + i, "team-race", { name: "原报名联系人", registered_name: "原报名联系人", platform_member_id: "", member_code: "", company: "并发团队" });
  const teamLookup = await request("/checkin/team-lookup", "POST", { event_id: "team-race", name: "实际参加人", company: "并发团队" }, "");
  const teamBody = { event_id: "team-race", name: "实际参加人", company: "并发团队", candidate_token: teamLookup.data.candidate_token };
  const teamResults = await Promise.all(Array.from({ length: 12 }, () => request("/checkin/team-confirm", "POST", teamBody, "")));
  assert(teamResults.every(result => result.data.ok));
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "team-race").length, 1, "one team authorization consumes one registration slot under concurrency");
  const teamDetails = await manage("event_detail", { event_id: "team-race" });
  assert(teamDetails.data.rows.every(row => row.is_team));
  const teamManual = await manage("manual_checkin", { event_id: "team-race", registration_id: "team-r2" });
  assert.equal(teamManual.data.code, "TEAM_ACTUAL_ATTENDEE_REQUIRED");
  const teamPull = await request("/ops/v1/attendance/records?session_id=team-race", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert.equal(teamPull.data.items.find(row => row.attendance_status === "PRESENT").actual_attendee_name, "实际参加人");
  assert.equal(teamPull.data.items.find(row => row.attendance_status === "PRESENT").registered_name, "原报名联系人");
  assert.equal(teamPull.data.items.find(row => row.attendance_status === "PRESENT").member_id, null, "unbound team attendees never inherit the contact's identity");

  seedEvent("guest-scene"); seedRegistration("real-same-name", "guest-scene", { name: "同名来宾" });
  const guestBody = { event_id: "guest-scene", guest_id: "a".repeat(64), name: "同名来宾" };
  assert.equal((await request("/ops/v1/guest-checkin/confirm", "POST", guestBody, "")).status, 401);
  assert.equal((await request("/ops/v1/guest-checkin/confirm", "POST", { ...guestBody, platform_member_id: "11" })).status, 400);
  failSync = true;
  const guests = await Promise.all(Array.from({ length: 8 }, () => request("/ops/v1/guest-checkin/confirm", "POST", guestBody)));
  assert(guests.every(row => row.data.ok && row.data.checked_at && row.data.sync_status === "PENDING"));
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "guest-scene").length, 1);
  assert.equal(db.collections.registrations.filter(row => row.batch_id === "guest-scene" && row.attendance_role === "GUEST").length, 1);
  failSync = false;
  const secondGuest = await request("/ops/v1/guest-checkin/confirm", "POST", { ...guestBody, guest_id: "b".repeat(64) });
  assert.equal(secondGuest.data.ok, true);
  assert.equal(db.collections.checkins.filter(row => row.batch_id === "guest-scene").length, 2, "same-name accounts remain separate guests");
  assert(!db.collections.checkins.some(row => row.registration_id === "real-same-name"), "guest never consumes a same-name member registration");
  const guestPull = await request("/ops/v1/attendance/records?session_id=guest-scene", "GET", {}, process.env.SIGNIN_SERVICE_API_KEY);
  assert(guestPull.data.items.filter(row => row.participant_type === "GUEST").every(row => row.member_id === null && !row.member_code));
  assert(guestPull.data.items.filter(row => row.attendance_role === "GUEST").every(row => row.score_eligible === false));
  assert(guestPull.data.items.every(row => ["MEMBER", "GUEST", "OBSERVER"].includes(row.participant_type)), "platform participant types obey its existing MySQL constraint");
  db.collections.events.find(row => row.event_id === "guest-scene").status = "closed";
  assert.equal((await request("/ops/v1/guest-checkin/confirm", "POST", { ...guestBody, guest_id: "c".repeat(64) })).status, 409);
  assert.equal(db.collections.registrations.filter(row => row.batch_id === "guest-scene" && row.attendance_role === "GUEST").length, 2);

  // Losing transactions neither consume a slot nor partially write a fact.
  await assert.rejects(() => persistCheckin({ collection: db.collection }, { batch_id: "main", registration_id: "r11" }), /ATOMIC_CHECKIN_UNAVAILABLE/);
  assert.equal(checkinDocumentId("morning", "r1"), checkinDocumentId("morning", "r1"));
  assert.notEqual(checkinDocumentId("morning", "r1"), checkinDocumentId("afternoon", "r1"));
  console.log(`platform integration tests passed: ${assertionCount} assertions; service auth, RBAC, scope, hierarchy, identity, races, activities, append import, incremental sync, retries and outage-safe native tickets`);
})().catch(error => { console.error(error); process.exitCode = 1; });
