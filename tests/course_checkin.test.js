const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

const ADMIN_PASSWORD = "course-test-password!";
process.env.ADMIN_PASSWORD_HASH = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest("hex");
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function createDatabase(seed) {
  const collections = {};
  Object.keys(seed || {}).forEach(name => { collections[name] = seed[name].map(row => ({ ...row })); });
  let nextId = 1;
  const rowsFor = name => (collections[name] || (collections[name] = []));
  function collection(name) {
    let filter = null, offset = 0, limit = Infinity, sortField = null, sortDirection = "asc";
    const query = {
      where(criteria) { filter = criteria; return query; },
      skip(value) { offset = value; return query; },
      limit(value) { limit = value; return query; },
      orderBy(field, direction) { sortField = field; sortDirection = direction === "desc" ? "desc" : "asc"; return query; },
      async get() {
        let rows = rowsFor(name);
        if (filter) rows = rows.filter(row => Object.keys(filter).every(key => row[key] === filter[key]));
        if (sortField) rows = [...rows].sort((a, b) => { const v = String(a[sortField] || "").localeCompare(String(b[sortField] || "")); return sortDirection === "desc" ? -v : v; });
        return { data: rows.slice(offset, offset + limit) };
      },
      async add(value) { const id = `${name}-${nextId++}`; rowsFor(name).push({ ...value, _id: id }); return { id }; },
      async update(value) { rowsFor(name).forEach(row => { if (!filter || Object.keys(filter).every(key => row[key] === filter[key])) Object.assign(row, value); }); return { updated: 1 }; },
      doc(id) {
        return {
          async update(value) { const row = rowsFor(name).find(item => item._id === id); if (!row) throw new Error("document not found"); Object.assign(row, value); return { updated: 1 }; },
          async remove() { const index = rowsFor(name).findIndex(item => item._id === id); if (index >= 0) rowsFor(name).splice(index, 1); return { deleted: index >= 0 ? 1 : 0 }; }
        };
      }
    };
    return query;
  }
  return { collection, collections };
}

const db = createDatabase({
  config: [{ _id: "config-1", key: "event_name", value: "盛和塾签到" }],
  events: [], registrations: [], checkins: [], event_audit_logs: []
});
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@cloudbase/node-sdk") return { init: () => ({ database: () => db }) };
  return originalLoad.call(this, request, parent, isMain);
};
const api = require("../cloudfunc/index.js");
Module._load = originalLoad;

async function request(path, method, body, token) {
  const [pathname, search = ""] = path.split("?");
  const response = await api.main({
    path: pathname,
    queryStringParameters: Object.fromEntries(new URLSearchParams(search)),
    httpMethod: method || "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? "" : JSON.stringify(body)
  });
  return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
}

(async () => {
  const login = await request("/admin_login", "POST", { password: ADMIN_PASSWORD });
  assert.equal(login.data.ok, true);
  const token = login.data.token;
  const payload = {
    event_name: "课程姓名签到回归",
    event_date: TODAY,
    activity_type: "course",
    checkin_start_at: `${TODAY}T00:00`,
    checkin_end_at: `${TODAY}T23:59`,
    attendees: [
      { name: "张三", phone: "", company: "甲团队" },
      { name: "代报名联系人", phone: "bad-phone", company: "甲团队" },
      { name: "同名学员", phone: "", company: "A公司" },
      { name: "同名学员", phone: "", company: "B公司" }
    ]
  };
  const preview = await request("/upload_preview", "POST", payload, token);
  assert.equal(preview.data.ok, true, "课程手机号为空或格式异常不应阻断预览");
  assert.equal(preview.data.new_total, 4);
  assert.equal(preview.data.course_phone_quality.missing_count, 3);
  assert.equal(preview.data.course_phone_quality.invalid_count, 1);
  const uploaded = await request("/upload", "POST", {
    ...payload,
    preview_issued_at: preview.data.preview_issued_at,
    preview_token: preview.data.preview_token
  }, token);
  assert.equal(uploaded.data.ok, true);
  const eventId = uploaded.data.event_id;
  const confirmed = await request("/event_lifecycle_update", "POST", { event_id: eventId, lifecycle_status: "CONFIRMED" }, token);
  assert.equal(confirmed.data.ok, true);
  const rows = db.collections.registrations.filter(row => row.batch_id === eventId);
  assert.equal(rows.length, 4, "课程重复姓名/手机号行应保留为独立报名名额");
  assert(rows.some(row => row.phone === ""));
  assert(rows.some(row => row.phone === "badphone"));
  assert(rows.every(row => row.registered_name === row.name));

  const unique = await request("/checkin/lookup", "POST", { event_id: eventId, name: "张三" });
  assert.equal(unique.data.status, "UNIQUE");
  assert.equal(unique.data.candidates[0].phone, undefined, "课程姓名候选不得暴露手机号");
  assert.equal(unique.data.candidates[0].phone_last4, undefined);
  const direct = await request("/checkin/confirm", "POST", { event_id: eventId, registration_id: unique.data.candidates[0].registration_id, name: "张三" });
  assert.equal(direct.data.ok, true);
  assert.equal(direct.data.data.attendance_role, "COURSE_REGISTRANT");
  const legacyNameOnly = await request("/checkin", "POST", { event_id: eventId, name: "同名学员" });
  assert.equal(legacyNameOnly.data.status, "MULTIPLE", "旧签到入口省略手机号时也应转入统一姓名查询");

  const sameName = await request("/checkin/lookup", "POST", { event_id: eventId, name: "同名学员" });
  assert.equal(sameName.data.status, "MULTIPLE");
  assert.equal(sameName.data.candidates.length, 2);
  assert(sameName.data.candidates.every(row => !row.phone_last4));

  const teamLookup = await request("/checkin/lookup", "POST", { event_id: eventId, name: "现场学员" });
  assert.equal(teamLookup.data.status, "TEAM_REQUIRED");
  const team = await request("/checkin/course-team-lookup", "POST", { event_id: eventId, name: "现场学员", company: "甲团队" });
  assert.equal(team.data.status, "AVAILABLE");
  assert.equal(team.data.total_slots, 2);
  assert.equal(team.data.checked_slots, 1);
  assert.equal(team.data.remaining_slots, 1);
  const teamConfirm = await request("/checkin/course-team-confirm", "POST", {
    event_id: eventId, name: "现场学员", company: "甲团队", candidate_token: team.data.candidate_token
  });
  assert.equal(teamConfirm.data.ok, true);
  assert.equal(teamConfirm.data.data.attendance_role, "EVENT_TEAM_MEMBER");
  assert.equal(teamConfirm.data.data.name, "现场学员");
  assert.equal(teamConfirm.data.data.registered_name, "代报名联系人");
  const consumed = db.collections.registrations.find(row => row.batch_id === eventId && row.company === "甲团队" && row.name === "代报名联系人");
  assert.equal(consumed.registered_name, "代报名联系人", "团队签到不得改写原始报名姓名");
  assert.equal(consumed.actual_attendee_name, "现场学员");
  const noSlots = await request("/checkin/course-team-lookup", "POST", { event_id: eventId, name: "另一位现场学员", company: "甲团队" });
  assert.equal(noSlots.data.status, "NO_SLOTS");

  db.collections.events.push({ _id: "report-event", event_id: "report-1", name: "全国报告会", event_date: TODAY, activity_type: "national_report", status: "active", lifecycle_status: "CONFIRMED" });
  db.collections.registrations.push(
    { _id: "report-reg-1", batch_id: "report-1", name: "报告本人", registered_name: "报告本人", phone: "", company: "报告公司" },
    { _id: "report-reg-2", batch_id: "report-1", name: "报告联系人", registered_name: "报告联系人", phone: "", company: "报告公司" }
  );
  const reportUnique = await request("/checkin/lookup", "POST", { event_id: "report-1", name: "报告本人" });
  assert.equal(reportUnique.data.status, "UNIQUE", "全国报告会也应使用统一姓名查询");
  const reportTeam = await request("/checkin/team-lookup", "POST", { event_id: "report-1", name: "报告现场人", company: "报告公司" });
  assert.equal(reportTeam.data.status, "AVAILABLE", "全国报告会应支持团队剩余报名名额");

  const stats = await request(`/stats?event_id=${eventId}`, "GET", undefined, token);
  assert.equal(stats.data.total, 4);
  assert.equal(stats.data.checked, 2);
  assert.equal(stats.data.registration_total, 4);
  assert(stats.data.recent.some(row => row.name === "现场学员" && row.registered_name === "代报名联系人"));
  console.log("course name-first checkin regression tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
