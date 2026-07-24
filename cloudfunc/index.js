const cloudbase = require("@cloudbase/node-sdk");
const crypto = require("crypto");
const https = require("https");

const ADMIN_PASSWORD_HASH = "da40d101ff0a0f2d9aadf5ff9c2e7b1ec0f58896497f9ee518218bd910abc0af";
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const ACTIVITY_TYPES = {
  national_report: "全国报告会",
  center_quarterly_report: "分中心季度报告会",
  course: "课程",
  class_meeting: "班会/班级学习会",
  group_meeting: "小组学习会",
  staff_training: "班主任辅导员培训会",
  board_meeting: "理事会",
  study_tour: "游学",
  other: "其他"
};

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: "shengheshu-d2g2zyyl99f6c6fc2" });
  const db = app.database();
  const method = event.httpMethod || "GET";
  const p = event.path || "/";
  const query = event.queryStringParameters || {};
  
  let data = {};
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf-8");
  try { data = JSON.parse(raw); } catch(e) { data = {}; }
  
  if (data._e && data.name) {
    try { data.name = decodeURIComponent(data.name); } catch(e) {}
  }
  
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8"
  };
  
  if (method === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  function requestJson(urlText, headers) {
    const url = new URL(urlText);
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: "GET",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: { Accept: "application/json", ...(headers || {}) },
        timeout: 10000
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload = {};
          try { payload = text ? JSON.parse(text) : {}; } catch (e) {
            return reject(new Error("运营系统返回了无法识别的数据"));
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(payload.detail || payload.msg || "运营系统请求失败"));
          }
          resolve(payload);
        });
      });
      req.on("timeout", () => req.destroy(new Error("连接运营系统超时")));
      req.on("error", reject);
      req.end();
    });
  }

  async function requestOps(pathname, params) {
    const base = String(process.env.OPS_API_BASE || "").replace(/\/$/, "");
    const apiKey = String(process.env.OPS_API_KEY || "");
    if (!base || !apiKey) throw new Error("签到系统尚未配置运营名册连接");
    const url = new URL(base + pathname);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value).trim());
      }
    });
    return await requestJson(url.toString(), { "X-API-Key": apiKey });
  }

  async function getConfig(key, def) {
    const r = await db.collection("config").where({ key }).get();
    return r.data.length > 0 ? r.data[0].value : def;
  }

  async function setConfig(key, value) {
    const r = await db.collection("config").where({ key }).get();
    if (r.data.length > 0) {
      await db.collection("config").where({ key }).update({ value });
    } else {
      await db.collection("config").add({ key, value });
    }
  }

  async function deleteAll(collectionName) {
    const BATCH = 100; let deleted = 0;
    while (true) {
      const batch = await db.collection(collectionName).limit(BATCH).get();
      if (!batch.data || batch.data.length === 0) break;
      for (const doc of batch.data) {
        try { await db.collection(collectionName).doc(doc._id).remove(); deleted++; } catch(e) {}
      }
      if (batch.data.length < BATCH) break;
    }
    return deleted;
  }

  async function getAll(collectionName, maxTotal, filter) {
    const BATCH = 100; const all = [];
    while (all.length < (maxTotal || 5000)) {
      var query = db.collection(collectionName);
      if (filter) query = query.where(filter);
      const batch = await query.skip(all.length).limit(BATCH).get();
      if (!batch.data || batch.data.length === 0) break;
      all.push(...batch.data);
      if (batch.data.length < BATCH) break;
    }
    return all;
  }

  async function deleteDocs(collectionName, docs) {
    let deleted = 0;
    for (const doc of docs || []) {
      if (!doc._id) continue;
      try { await db.collection(collectionName).doc(doc._id).remove(); deleted++; } catch (e) {}
    }
    return deleted;
  }

  function chinaDate() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return values.year + "-" + values.month + "-" + values.day;
  }

  function inferEventDate(name) {
    const text = String(name || "");
    let match = text.match(/(?:^|\D)(\d{1,2})[.月\/-](\d{1,2})(?:日|\D|$)/);
    if (!match) {
      const compact = text.match(/(?:^|\D)(\d{3,4})(?:日|\D|$)/);
      if (compact) {
        const digits = compact[1];
        match = digits.length === 3 ? [digits, digits.slice(0, 1), digits.slice(1)] : [digits, digits.slice(0, 2), digits.slice(2)];
      }
    }
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) < 1 || Number(match[2]) > 31) return chinaDate();
    return new Date().getFullYear() + "-" + String(Number(match[1])).padStart(2, "0") + "-" + String(Number(match[2])).padStart(2, "0");
  }

  function normalizeActivityType(value) {
    const type = String(value || "").trim();
    return ACTIVITY_TYPES[type] ? type : "other";
  }

  function parseChinaDateTime(value) {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return "";
    const timestamp = Date.parse(text + ":00+08:00");
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  }

  function eventTimeState(item, now) {
    if (item.status === "closed") return "closed";
    const timestamp = (now || new Date()).getTime();
    const startsAt = item.checkin_start_at ? Date.parse(item.checkin_start_at) : NaN;
    const endsAt = item.checkin_end_at ? Date.parse(item.checkin_end_at) : NaN;
    if (Number.isFinite(startsAt) && timestamp < startsAt) return "upcoming";
    if (Number.isFinite(endsAt) && timestamp > endsAt) return "ended";
    return "open";
  }

  function isEventOpen(item) {
    return eventTimeState(item) === "open";
  }

  async function rowsForBatch(collectionName, batchId, maxTotal) {
    const rows = await getAll(collectionName, maxTotal || 5000);
    return rows.filter(row => String(row.batch_id || "") === String(batchId || ""));
  }

  async function ensureLegacyEvent() {
    const existing = await getAll("events", 500);
    if (existing.length) return existing;
    const batchId = await getConfig("active_batch_id", "");
    if (!batchId) return [];
    const name = await getConfig("event_name", "盛和塾签到");
    const groupField = await getConfig("group_field", "");
    await db.collection("events").add({
      event_id: batchId,
      name,
      activity_type: "other",
      event_date: inferEventDate(name),
      status: "active",
      group_field: groupField,
      created_at: new Date().toISOString(),
      migrated_from_legacy: true
    });
    return await getAll("events", 500);
  }

  async function getEvents() {
    const events = await ensureLegacyEvent();
    return events.sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  }

  async function getEventById(eventId) {
    const events = await getEvents();
    return events.find(item => String(item.event_id || item._id || "") === String(eventId || "")) || null;
  }

  async function getRequestedEvent(eventId) {
    const selectedId = String(eventId || await getConfig("active_batch_id", "")).trim();
    return selectedId ? await getEventById(selectedId) : null;
  }

  function publicEvent(item) {
    const timeState = eventTimeState(item);
    return {
      event_id: item.event_id || item._id || "",
      name: item.name || "盛和塾活动",
      event_date: item.event_date || "",
      activity_type: normalizeActivityType(item.activity_type),
      activity_type_name: ACTIVITY_TYPES[normalizeActivityType(item.activity_type)],
      status: ["closed", "ended"].includes(timeState) ? "closed" : "active",
      manual_status: item.status === "closed" ? "closed" : "active",
      checkin_status: timeState,
      checkin_start_at: item.checkin_start_at || "",
      checkin_end_at: item.checkin_end_at || "",
      group_field: item.group_field || ""
    };
  }

  async function getActiveRows(collectionName, maxTotal) {
    const batchId = await getConfig("active_batch_id", "");
    const allRows = await getAll(collectionName, maxTotal);
    if (!batchId) return allRows;
    const activeRows = allRows.filter(row => String(row.batch_id || "") === String(batchId));
    if (activeRows.length) return activeRows;
    // 兼容批次机制启用前的旧数据，以及异常中断后遗留的批次配置。
    const legacyRows = allRows.filter(row => !row.batch_id);
    return legacyRows.length ? legacyRows : allRows;
  }

  async function getDisplaySettings() {
    return {
      show_group: await getConfig("show_group", "true"),
      show_dinner_table: await getConfig("show_dinner_table", "true")
    };
  }

  function normalizeGroupValue(value) {
    value = String(value || "").trim();
    return /^(是|否|有|无|yes|no|true|false|0|1)$/i.test(value) ? "" : value;
  }

  function normalizeCenterValue(value) {
    const compact = normalizeGroupValue(value).replace(/[\s·•_\-—]+/g, "");
    if (!compact) return "";
    const centers = [
      { pattern: /园区/, name: "园区分中心" },
      { pattern: /(姑苏|相城)/, name: "姑苏相城分中心" },
      { pattern: /吴江/, name: "吴江分中心" },
      { pattern: /昆山/, name: "昆山分中心" },
      { pattern: /新吴/, name: "新吴分中心" },
      { pattern: /张家港/, name: "张家港分中心" }
    ];
    const matched = centers.find(center => center.pattern.test(compact));
    return matched ? matched.name : "";
  }

  function normalizeDimensionValue(row, field) {
    return field === "center" ? normalizeCenterValue(row.center) : normalizeGroupValue(row[field]);
  }

  async function getAuthSecret() {
    var secret = await getConfig("admin_auth_secret", "");
    if (!secret) {
      secret = crypto.randomBytes(32).toString("hex");
      await setConfig("admin_auth_secret", secret);
    }
    return secret;
  }

  async function issueAdminToken() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_TOKEN_TTL_MS })).toString("base64url");
    const signature = crypto.createHmac("sha256", await getAuthSecret()).update(payload).digest("base64url");
    return payload + "." + signature;
  }

  async function isAdminRequest() {
    const headers = event.headers || {};
    const auth = headers.authorization || headers.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "") || data.token || "";
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    try {
      const expected = crypto.createHmac("sha256", await getAuthSecret()).update(parts[0]).digest();
      const actual = Buffer.from(parts[1], "base64url");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      return Number(payload.exp) > Date.now();
    } catch (e) {
      return false;
    }
  }

  function unauthorized() {
    return { statusCode: 401, headers: h, body: JSON.stringify({ ok: false, msg: "登录已失效，请重新登录" }) };
  }

  if (p === "/admin_login" && method === "POST") {
    const suppliedHash = crypto.createHash("sha256").update(String(data.password || "")).digest("hex");
    const actual = Buffer.from(suppliedHash, "hex");
    const expected = Buffer.from(ADMIN_PASSWORD_HASH, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return { statusCode: 401, headers: h, body: JSON.stringify({ ok: false, msg: "密码错误" }) };
    }
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, token: await issueAdminToken(), expires_in: ADMIN_TOKEN_TTL_MS / 1000 }) };
  }

  const protectedPaths = new Set(["/settings", "/admin_events", "/event_update", "/registration", "/registration_delete", "/attendance_status", "/export", "/stats", "/ops_roster_options", "/ops_roster_members", "/upload_preview", "/upload", "/reset", "/clear_all"]);
  if (protectedPaths.has(p) && !(await isAdminRequest())) return unauthorized();

  function identityKey(person) {
    var name = String(person.name || "").trim().replace(/\s+/g, "").toLowerCase();
    var phone = String(person.phone || "").trim().replace(/\s/g, "").replace(/-/g, "");
    return name + "|" + phone;
  }

  function normalizeAttendanceStatus(value) {
    return ["late", "leave"].includes(String(value || "")) ? String(value) : "pending";
  }

  function attendanceStatusLabel(value) {
    return { pending: "未签到", late: "迟到", leave: "请假" }[normalizeAttendanceStatus(value)];
  }

  function buildAttendanceState(regs, checkins) {
    const checkedIndexes = new Set();
    const checkinByIndex = new Map();
    const registrationIndex = new Map();
    regs.forEach(function(reg, index) {
      if (reg._id) registrationIndex.set(String(reg._id), index);
    });

    const legacyCheckins = {};
    (checkins || []).forEach(function(checkin) {
      const registrationId = String(checkin.registration_id || "");
      if (registrationId && registrationIndex.has(registrationId)) {
        const index = registrationIndex.get(registrationId);
        checkedIndexes.add(index);
        checkinByIndex.set(index, checkin);
      } else if (!registrationId) {
        const key = identityKey(checkin);
        if (!legacyCheckins[key]) legacyCheckins[key] = [];
        legacyCheckins[key].push(checkin);
      }
    });

    // 兼容旧签到记录：没有 registration_id 时，每条签到只匹配一个报名名额。
    regs.forEach(function(reg, index) {
      if (checkedIndexes.has(index)) return;
      const queue = legacyCheckins[identityKey(reg)];
      if (queue && queue.length) {
        checkedIndexes.add(index);
        checkinByIndex.set(index, queue.shift());
      }
    });
    return { checkedIndexes, checkinByIndex };
  }

  function normalizeUploadPayload(payload) {
    const rows = payload.attendees || [];
    const eventName = String(payload.event_name || "").trim().replace(/\.(xlsx|xls|xlsm|xlsb|csv)$/i, "").trim();
    const eventDate = String(payload.event_date || "").trim();
    const checkinStartAt = parseChinaDateTime(payload.checkin_start_at);
    const checkinEndAt = parseChinaDateTime(payload.checkin_end_at);
    const activityType = normalizeActivityType(payload.activity_type);
    const groupField = ["center", "class_name", "group_name"].includes(payload.group_field) ? payload.group_field : "";
    if (!eventName || rows.length === 0) return { error: "活动名称和报名数据不能为空" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { error: "请选择正确的活动日期" };
    if (!checkinStartAt || !checkinEndAt) return { error: "请选择完整的签到开始时间和截止时间" };
    if (Date.parse(checkinEndAt) <= Date.parse(checkinStartAt)) return { error: "签到截止时间必须晚于开始时间" };
    if (!ACTIVITY_TYPES[String(payload.activity_type || "")]) return { error: "请选择活动类型" };
    if (rows.length > 5000) return { error: "报名数据不能超过5000条" };

    const normalizedRows = [];
    const identityCounts = {};
    const restoreCheckins = payload.restore_checkins === true;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const cleanRow = {
        name: String(row.name || "").trim(),
        phone: String(row.phone || "").trim().replace(/\s/g, "").replace(/-/g, ""),
        center: normalizeCenterValue(row.center),
        class_name: String(row.class_name || "").trim(),
        group_name: String(row.group_name || "").trim(),
        company: String(row.company || "").trim(),
        group_num: row.group_num || null,
        dinner_table_num: row.dinner_table_num || null,
        restore_checked_at: restoreCheckins && row.checked_at && !isNaN(Date.parse(row.checked_at)) ? new Date(row.checked_at).toISOString() : ""
      };
      if (!cleanRow.name && !cleanRow.phone) continue;
      if (!cleanRow.name) return { error: "第" + (i + 1) + "条缺少姓名，未导入" };
      if (!/^\d{11}$/.test(cleanRow.phone)) return { error: "第" + (i + 1) + "条手机号格式错误，未导入" };
      const key = identityKey(cleanRow);
      identityCounts[key] = (identityCounts[key] || 0) + 1;
      normalizedRows.push(cleanRow);
    }
    if (normalizedRows.length === 0) return { error: "没有可导入的有效报名数据" };
    return { eventName, eventDate, checkinStartAt, checkinEndAt, activityType, groupField, normalizedRows, identityCounts, restoreCheckins };
  }

  function countIdentities(rows) {
    const counts = {};
    (rows || []).forEach(row => {
      const key = identityKey(row);
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  function compareIdentityCounts(oldCounts, newCounts) {
    const keys = new Set([...Object.keys(oldCounts), ...Object.keys(newCounts)]);
    let added = 0;
    let removed = 0;
    keys.forEach(key => {
      const difference = (newCounts[key] || 0) - (oldCounts[key] || 0);
      if (difference > 0) added += difference;
      if (difference < 0) removed -= difference;
    });
    return { added, removed };
  }

  function activeRegistrationFingerprint(registrations) {
    function stableRows(rows, fields) {
      return (rows || []).map(row => JSON.stringify(fields.map(field => String(row[field] || "")))).sort();
    }
    return crypto.createHash("sha256").update(JSON.stringify(
      stableRows(registrations, ["_id", "name", "phone", "center", "class_name", "group_name", "company", "group_num", "dinner_table_num", "attendance_status", "attendance_note", "batch_id"])
    )).digest("hex");
  }

  function uploadFingerprint(upload, activeBatchId, activeRegistrationHash) {
    return crypto.createHash("sha256").update(JSON.stringify({
      active_batch_id: String(activeBatchId || ""),
      active_registration_hash: activeRegistrationHash,
      event_name: upload.eventName,
      event_date: upload.eventDate,
      checkin_start_at: upload.checkinStartAt,
      checkin_end_at: upload.checkinEndAt,
      activity_type: upload.activityType,
      group_field: upload.groupField,
      restore_checkins: upload.restoreCheckins,
      attendees: upload.normalizedRows
    })).digest("hex");
  }

  async function signUploadPreview(upload, activeBatchId, activeRegistrationHash, issuedAt) {
    const fingerprint = uploadFingerprint(upload, activeBatchId, activeRegistrationHash);
    return crypto.createHmac("sha256", await getAuthSecret()).update(String(issuedAt) + "." + fingerprint).digest("base64url");
  }

  async function verifyUploadPreview(upload, activeBatchId, activeRegistrationHash, issuedAt, suppliedToken) {
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60 * 1000 || !suppliedToken) return false;
    const expected = Buffer.from(await signUploadPreview(upload, activeBatchId, activeRegistrationHash, issuedAt), "base64url");
    const actual = Buffer.from(String(suppliedToken), "base64url");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function detectGroupField(regs) {
    var definitions = {
      center: { label: "分中心" },
      class_name: { label: "班级" },
      group_name: { label: "小组" }
    };
    var fields = { center: 0, class_name: 0, group_name: 0 };
    regs.forEach(function(r) {
      Object.keys(fields).forEach(function(field) {
        if (normalizeDimensionValue(r, field)) fields[field]++;
      });
    });
    if (fields.center > 0) return { field: "center", label: definitions.center.label };
    if (fields.class_name > 0) return { field: "class_name", label: definitions.class_name.label };
    if (fields.group_name > 0) return { field: "group_name", label: definitions.group_name.label };
    return { field: "center", label: "分组" };
  }

  function groupFieldForEvent(eventItem, regs) {
    if (normalizeActivityType(eventItem && eventItem.activity_type) === "class_meeting") {
      return { field: "group_name", label: "小组" };
    }
    return detectGroupField(regs);
  }

  // ===== CHECKIN =====
  if (p === "/checkin" && method === "POST") {
    const name = (data.name || "").trim();
    const phone = (data.phone || "").trim().replace(/\s/g, "").replace(/-/g, "");
    if (!name || !phone) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入姓名和手机号" }) };
    if (phone.length !== 11 || !/^\d+$/.test(phone)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入正确的11位手机号" }) };
    try {
      const activeEvents = (await getEvents()).filter(isEventOpen);
      if (!activeEvents.length) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前没有开放签到的活动" }) };
      const activeIds = new Set(activeEvents.map(item => String(item.event_id || item._id || "")));
      const allRegistrations = await getAll("registrations", 5000);
      const phoneRegistrations = allRegistrations.filter(reg => activeIds.has(String(reg.batch_id || "")) && String(reg.phone || "").trim().replace(/\s/g, "").replace(/-/g, "") === phone);
      if (phoneRegistrations.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到报名记录，请先确认是否已报名，或检查手机号是否正确" }) };
      const n1 = name.replace(/\s+/g, "").toLowerCase();
      let matchingRegs = phoneRegistrations.filter(function(reg) {
        return String(reg.name || "").trim().replace(/\s+/g, "").toLowerCase() === n1;
      });
      if (matchingRegs.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "姓名与报名时填写的不一致，请检查后重新输入" }) };

      const matchedIds = [...new Set(matchingRegs.map(reg => String(reg.batch_id || "")))];
      let selectedEvent = null;
      if (data.event_id) {
        selectedEvent = activeEvents.find(item => String(item.event_id || item._id || "") === String(data.event_id)) || null;
        if (!selectedEvent || !matchedIds.includes(String(selectedEvent.event_id || selectedEvent._id || ""))) {
          return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "所选活动没有找到对应报名记录，请重新选择" }) };
        }
      } else if (matchedIds.length > 1) {
        const choices = activeEvents.filter(item => matchedIds.includes(String(item.event_id || item._id || ""))).map(publicEvent);
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, needs_event: true, msg: "检测到您报名了多个正在进行的活动，请选择本次签到活动", events: choices }) };
      } else {
        selectedEvent = activeEvents.find(item => String(item.event_id || item._id || "") === matchedIds[0]) || null;
      }
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动信息不存在，请联系工作人员" }) };
      const selectedEventId = String(selectedEvent.event_id || selectedEvent._id || "");
      matchingRegs = matchingRegs.filter(reg => String(reg.batch_id || "") === selectedEventId);

      const regName = String(matchingRegs[0].name || "").trim();
      const currentCheckins = await rowsForBatch("checkins", selectedEventId, 5000);
      const phoneCheckins = currentCheckins.filter(checkin => String(checkin.phone || "").trim().replace(/\s/g, "").replace(/-/g, "") === phone);
      const attendance = buildAttendanceState(matchingRegs, phoneCheckins);
      const remainingIndexes = matchingRegs.map((_, index) => index).filter(index => !attendance.checkedIndexes.has(index));
      const totalSlots = matchingRegs.length;
      const checkedSlots = totalSlots - remainingIndexes.length;
      const ds = await getDisplaySettings();
      const gf = groupFieldForEvent(selectedEvent, matchingRegs);

      function makeDisplayData(reg) {
        return {
          name: regName,
          phone,
          center: normalizeCenterValue(reg.center),
          class_name: normalizeGroupValue(reg.class_name),
          group_name: normalizeGroupValue(reg.group_name),
          group_type: gf.label,
          group_value: normalizeDimensionValue(reg, gf.field),
          company: reg.company || "",
          group_num: ds.show_group === "true" ? (reg.group_num || null) : null,
          dinner_table_num: ds.show_dinner_table === "true" ? (reg.dinner_table_num || null) : null,
          show_group: ds.show_group,
          show_dinner_table: ds.show_dinner_table,
          multi_total: totalSlots,
          event: publicEvent(selectedEvent)
        };
      }

      if (remainingIndexes.length === 0) {
        const lastCheckin = Array.from(attendance.checkinByIndex.values()).sort((a, b) => String(b.checked_at || "").localeCompare(String(a.checked_at || "")))[0] || {};
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, already: true, msg: "全部名额均已签到", data: { ...makeDisplayData(matchingRegs[0]), multi_checked: totalSlots, checked_at: lastCheckin.checked_at || "" } }) };
      }

      if (totalSlots > 1 && data.quantity === undefined) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, needs_quantity: true, msg: "检测到多人报名，请选择本次实际到场人数", data: { name: regName, total_slots: totalSlots, checked_slots: checkedSlots, remaining_slots: remainingIndexes.length } }) };
      }

      const quantity = totalSlots > 1 ? Number(data.quantity) : 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > remainingIndexes.length) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "本次到场人数应为1至" + remainingIndexes.length + "人" }) };
      }

      const selectedIndexes = remainingIndexes.slice(0, quantity);
      const now = new Date().toISOString();
      for (const index of selectedIndexes) {
        const reg = matchingRegs[index];
        await db.collection("checkins").add({ registration_id: reg._id || "", name: String(reg.name || "").trim(), phone, center: normalizeCenterValue(reg.center), class_name: normalizeGroupValue(reg.class_name), group_name: normalizeGroupValue(reg.group_name), company: reg.company || "", group_num: reg.group_num || null, dinner_table_num: reg.dinner_table_num || null, batch_id: selectedEventId, checked_at: now });
      }
      const newCheckedSlots = checkedSlots + quantity;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到成功，本次登记" + quantity + "人", checked_count: quantity, data: { ...makeDisplayData(matchingRegs[selectedIndexes[0]]), multi_checked: newCheckedSlots, checked_at: now } }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "签到失败: " + (e.message || "") }) };
    }
  }

  // ===== EVENT INFO =====
  if (p === "/event" && method === "GET") {
    try {
      const allEvents = await getEvents();
      const activeEvents = allEvents.filter(isEventOpen);
      const displayEvents = allEvents.filter(item => ["open", "upcoming"].includes(eventTimeState(item)));
      const ds = await getDisplaySettings();
      const activeIds = new Set(activeEvents.map(item => String(item.event_id || item._id || "")));
      const total = (await getAll("registrations", 5000)).filter(row => activeIds.has(String(row.batch_id || ""))).length;
      const eventName = displayEvents.length === 0 ? "当前暂无可签到活动" : (displayEvents.length === 1 ? (displayEvents[0].name || "盛和塾活动签到") : "请选择签到活动");
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, active_event_count: activeEvents.length, active_events: activeEvents.map(publicEvent), display_events: displayEvents.map(publicEvent), show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: "签到活动加载失败", active_event_count: 0, active_events: [], show_group: "true", show_dinner_table: "true", total: 0 }) };
    }
  }

  // ===== SETTINGS =====
  if (p === "/admin_events" && method === "GET") {
    try {
      const events = await getEvents();
      const regs = await getAll("registrations", 5000);
      const cks = await getAll("checkins", 5000);
      const selectedEventId = await getConfig("active_batch_id", "");
      const rows = events.map(item => {
        const eventId = String(item.event_id || item._id || "");
        const eventRegs = regs.filter(row => String(row.batch_id || "") === eventId);
        const eventCks = cks.filter(row => String(row.batch_id || "") === eventId);
        return { ...publicEvent(item), total: eventRegs.length, checked: buildAttendanceState(eventRegs, eventCks).checkedIndexes.size };
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, events: rows, selected_event_id: selectedEventId, activity_types: ACTIVITY_TYPES }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "读取活动失败: " + (e.message || "") }) };
    }
  }

  if (p === "/event_update" && method === "POST") {
    try {
      const eventItem = await getEventById(data.event_id);
      if (!eventItem) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到活动" }) };
      const changes = {};
      if (data.name !== undefined) changes.name = String(data.name || "").trim() || eventItem.name;
      if (data.event_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.event_date))) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动日期格式不正确" }) };
        changes.event_date = String(data.event_date);
      }
      if (data.activity_type !== undefined) {
        if (!ACTIVITY_TYPES[String(data.activity_type)]) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动类型不正确" }) };
        changes.activity_type = String(data.activity_type);
      }
      if (data.status !== undefined) changes.status = data.status === "closed" ? "closed" : "active";
      changes.updated_at = new Date().toISOString();
      await db.collection("events").doc(eventItem._id).update(changes);
      if (data.select === true) {
        await setConfig("active_batch_id", eventItem.event_id || eventItem._id);
        await setConfig("event_name", changes.name || eventItem.name || "盛和塾签到");
        await setConfig("group_field", eventItem.group_field || "");
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event: publicEvent({ ...eventItem, ...changes }), msg: "活动已更新" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "更新活动失败: " + (e.message || "") }) };
    }
  }

  if (p === "/ops_roster_options" && method === "GET") {
    try {
      const result = await requestOps("/api/v1/checkin-rosters/options");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...(result.data || {}) }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "读取运营名单选项失败: " + (e.message || "") }) };
    }
  }

  if (p === "/ops_roster_members" && method === "POST") {
    try {
      const scope = data.scope === "group" ? "group" : "class";
      const result = await requestOps("/api/v1/checkin-rosters/members", {
        center: data.center,
        class_name: data.class_name,
        group_name: scope === "group" ? data.group_name : ""
      });
      const roster = result.data || {};
      const invalidMembers = Array.isArray(roster.invalid_members) ? roster.invalid_members : [];
      if (invalidMembers.length) {
        const names = invalidMembers.slice(0, 5).map(item => item.name).join("、");
        return { statusCode: 200, headers: h, body: JSON.stringify({
          ok: false,
          invalid_count: invalidMembers.length,
          msg: "运营名单中有 " + invalidMembers.length + " 人手机号不完整（" + names + (invalidMembers.length > 5 ? "等" : "") + "），请先在运营系统修正后再导入"
        }) };
      }
      const attendees = (roster.members || []).map(item => ({
        name: item.name || "",
        phone: item.phone || "",
        company: item.company || "",
        center: item.center || "",
        class_name: item.class_name || "",
        group_name: item.group_name || "",
        group_num: null,
        dinner_table_num: null
      }));
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        scope,
        center: roster.center || "",
        class_name: roster.class_name || "",
        group_name: roster.group_name || "",
        member_count: attendees.length,
        version: roster.version || null,
        attendees
      }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "读取运营名单失败: " + (e.message || "") }) };
    }
  }

  if (p === "/settings" && method === "POST") {
    try {
      if (data.show_group !== undefined) await setConfig("show_group", data.show_group ? "true" : "false");
      if (data.show_dinner_table !== undefined) await setConfig("show_dinner_table", data.show_dinner_table ? "true" : "false");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "设置已保存" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "保存失败: " + (e.message || "") }) };
    }
  }

  // ===== ADMIN MANUAL REGISTRATION =====
  if (p === "/registration" && method === "POST") {
    try {
      const registration = {
        name: String(data.name || "").trim(),
        phone: String(data.phone || "").trim().replace(/\s/g, "").replace(/-/g, ""),
        center: normalizeCenterValue(data.center),
        class_name: String(data.class_name || "").trim(),
        group_name: String(data.group_name || "").trim(),
        company: String(data.company || "").trim(),
        group_num: null,
        dinner_table_num: null,
        attendance_status: "pending",
        attendance_note: "",
        source: "manual",
        created_at: new Date().toISOString()
      };
      if (!registration.name) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入姓名" }) };
      if (!/^\d{11}$/.test(registration.phone)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入正确的11位手机号" }) };

      const selectedEvent = await getRequestedEvent(data.event_id);
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请先选择活动" }) };
      if (!isEventOpen(selectedEvent)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前活动不在签到时间内，不能新增临时报名" }) };
      const activeBatchId = String(selectedEvent.event_id || selectedEvent._id || "");
      const regs = await rowsForBatch("registrations", activeBatchId, 5000);
      if (regs.some(row => identityKey(row) === identityKey(registration))) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前活动已有相同姓名和手机号的报名记录" }) };
      }
      const result = await db.collection("registrations").add({ ...registration, batch_id: activeBatchId || "" });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, registration_id: result.id || result._id || "", msg: "临时报名已新增，学长现在可以正常签到" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "新增失败: " + (e.message || "") }) };
    }
  }

  // ===== ADMIN DELETE REGISTRATION =====
  if (p === "/registration_delete" && method === "POST") {
    try {
      const registrationId = String(data.registration_id || "").trim();
      if (!registrationId) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "缺少报名记录标识" }) };

      const allRegs = await getAll("registrations", 5000);
      const registration = allRegs.find(row => String(row._id || "") === registrationId);
      if (!registration) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到报名记录" }) };
      const regs = allRegs.filter(row => String(row.batch_id || "") === String(registration.batch_id || ""));
      const index = regs.findIndex(row => String(row._id || "") === registrationId);
      const cks = await rowsForBatch("checkins", registration.batch_id, 5000);
      if (buildAttendanceState(regs, cks).checkedIndexes.has(index)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, checked: true, msg: "该学长已经签到，不能删除报名记录" }) };
      }

      await db.collection("registrations").doc(registrationId).remove();
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "已删除“" + String(registration.name || "") + "”的报名记录" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "删除失败: " + (e.message || "") }) };
    }
  }

  // ===== ADMIN ATTENDANCE FOLLOW-UP =====
  if (p === "/attendance_status" && method === "POST") {
    try {
      const registrationId = String(data.registration_id || "").trim();
      const status = normalizeAttendanceStatus(data.status);
      const note = String(data.note || "").trim().slice(0, 200);
      if (!registrationId) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "缺少报名记录标识" }) };

      const allRegs = await getAll("registrations", 5000);
      const registration = allRegs.find(row => String(row._id || "") === registrationId);
      if (!registration) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到报名记录" }) };
      const regs = allRegs.filter(row => String(row.batch_id || "") === String(registration.batch_id || ""));
      const index = regs.findIndex(row => String(row._id || "") === registrationId);
      const cks = await rowsForBatch("checkins", registration.batch_id, 5000);
      if (buildAttendanceState(regs, cks).checkedIndexes.has(index)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, checked: true, msg: "该学长已签到，最终状态以实际签到为准" }) };
      }

      await db.collection("registrations").doc(registrationId).update({
        attendance_status: status,
        attendance_note: note,
        attendance_status_updated_at: new Date().toISOString()
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, status, status_label: attendanceStatusLabel(status), msg: "状态已更新为“" + attendanceStatusLabel(status) + "”" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "状态更新失败: " + (e.message || "") }) };
    }
  }

  // ===== EXPORT =====
  if (p === "/export" && method === "POST") {
    try {
      const selectedEvent = await getRequestedEvent(data.event_id);
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请先选择活动" }) };
      const eventId = String(selectedEvent.event_id || selectedEvent._id || "");
      const regs = await rowsForBatch("registrations", eventId, 5000);
      const cks = await rowsForBatch("checkins", eventId, 5000);
      const attendance = buildAttendanceState(regs, cks);
      // Build export rows: all registrations with check-in status
      const rows = regs.map(function(r, index) {
        var ck = attendance.checkinByIndex.get(index);
        return {
          name: r.name || "",
          phone: r.phone || "",
          company: r.company || "",
          center: normalizeCenterValue(r.center),
          class_name: normalizeGroupValue(r.class_name),
          group_name: normalizeGroupValue(r.group_name),
          group_num: r.group_num || "",
          dinner_table_num: r.dinner_table_num || "",
          sign_status: ck ? "已签到" : attendanceStatusLabel(r.attendance_status),
          sign_time: ck ? (ck.checked_at || "") : "",
          attendance_note: ck ? "" : (r.attendance_note || "")
        };
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event: publicEvent(selectedEvent), rows: rows }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "导出失败: " + (e.message || "") }) };
    }
  }

  // ===== STATS =====
  if (p === "/stats" && method === "GET") {
    try {
      const selectedEvent = await getRequestedEvent(query.event_id || data.event_id);
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请先选择活动", total: 0, checked: 0, rate: 0, groups: {}, not_checked: [], recent: [] }) };
      const eventId = String(selectedEvent.event_id || selectedEvent._id || "");
      const ds = await getDisplaySettings();
      const regs = await rowsForBatch("registrations", eventId, 5000);
      const cks = await rowsForBatch("checkins", eventId, 5000);
      const attendance = buildAttendanceState(regs, cks);
      const total = regs.length;
      const checked = attendance.checkedIndexes.size;
      const rate = total > 0 ? Math.round(checked / total * 1000) / 10 : 0;
      const gf = groupFieldForEvent(selectedEvent, regs);
      const groups = {};
      regs.forEach((a, index) => {
        const gv = normalizeDimensionValue(a, gf.field) || "未分组";
        if (!groups[gv]) groups[gv] = { total: 0, checked: 0 };
        groups[gv].total++;
        if (attendance.checkedIndexes.has(index)) groups[gv].checked++;
      });
      const nc = regs.filter((a, index) => !attendance.checkedIndexes.has(index)).map(a => ({
        registration_id: a._id || "",
        name: a.name,
        phone: a.phone || "",
        center: normalizeCenterValue(a.center),
        class_name: normalizeGroupValue(a.class_name),
        group_name: normalizeGroupValue(a.group_name),
        company: a.company || "",
        attendance_status: normalizeAttendanceStatus(a.attendance_status),
        attendance_status_label: attendanceStatusLabel(a.attendance_status),
        attendance_note: a.attendance_note || ""
      }));
      const followUp = nc.reduce((counts, row) => {
        counts[row.attendance_status]++;
        return counts;
      }, { pending: 0, late: 0, leave: 0 });
      const rc = cks.sort((a, b) => (b.checked_at || "").localeCompare(a.checked_at || "")).slice(0, 20).map(r => ({ name: r.name, center: normalizeCenterValue(r.center), class_name: normalizeGroupValue(r.class_name), group_name: normalizeGroupValue(r.group_name), company: r.company || "", group_num: r.group_num || null, dinner_table_num: r.dinner_table_num || null, checked_at: r.checked_at }));
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event: publicEvent(selectedEvent), event_name: selectedEvent.name, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total, checked, rate, pending: followUp.pending, late: followUp.late, leave: followUp.leave, group_field: gf.field, group_type: gf.label, groups, not_checked: nc, recent: rc }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ total: 0, checked: 0, rate: 0, pending: 0, late: 0, leave: 0, group_type: "分组", groups: {}, not_checked: [], recent: [] }) };
    }
  }

  // ===== ADMIN UPLOAD PREVIEW =====
  if (p === "/upload_preview" && method === "POST") {
    try {
      const upload = normalizeUploadPayload(data);
      if (upload.error) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: upload.error }) };
      const events = await getEvents();
      if (events.some(item => String(item.name || "").trim() === upload.eventName && String(item.event_date || "") === upload.eventDate)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "同一天已存在同名活动，请修改活动名称或在已有活动中维护名单" }) };
      }
      const counts = Object.values(upload.identityCounts);
      const repeatedSlots = counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const duplicateGroups = counts.filter(count => count > 1).length;
      const restoredCheckins = upload.normalizedRows.filter(row => row.restore_checked_at).length;
      const issuedAt = Date.now();
      const eventsHash = crypto.createHash("sha256").update(JSON.stringify(events.map(item => [item.event_id, item.name, item.event_date]).sort())).digest("hex");
      const previewToken = await signUploadPreview(upload, "new_event", eventsHash, issuedAt);
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        new_event_name: upload.eventName,
        event_date: upload.eventDate,
        checkin_start_at: upload.checkinStartAt,
        checkin_end_at: upload.checkinEndAt,
        activity_type: upload.activityType,
        activity_type_name: ACTIVITY_TYPES[upload.activityType],
        old_total: 0,
        new_total: upload.normalizedRows.length,
        added: upload.normalizedRows.length,
        removed: 0,
        duplicate_groups: duplicateGroups,
        repeated_slots: repeatedSlots,
        old_checked: 0,
        restored_checkins: restoredCheckins,
        preview_issued_at: issuedAt,
        preview_token: previewToken
      }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "生成导入预览失败: " + (e.message || "") }) };
    }
  }

  // ===== ADMIN UPLOAD =====
  if (p === "/upload" && method === "POST") {
    const upload = normalizeUploadPayload(data);
    if (upload.error) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: upload.error }) };
    const { eventName, eventDate, checkinStartAt, checkinEndAt, activityType, groupField, normalizedRows, identityCounts } = upload;
    const eventsAtConfirmation = await getEvents();
    if (eventsAtConfirmation.some(item => String(item.name || "").trim() === eventName && String(item.event_date || "") === eventDate)) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "同一天已存在同名活动，请勿重复导入" }) };
    }
    const eventsHash = crypto.createHash("sha256").update(JSON.stringify(eventsAtConfirmation.map(item => [item.event_id, item.name, item.event_date]).sort())).digest("hex");
    const previewIssuedAt = Number(data.preview_issued_at);
    if (!(await verifyUploadPreview(upload, "new_event", eventsHash, previewIssuedAt, data.preview_token))) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, needs_preview: true, msg: "名单或预览已发生变化，请重新核对变更后再导入" }) };
    }
    const batchId = Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
    const oldEventName = await getConfig("event_name", "盛和塾签到");
    const oldGroupField = await getConfig("group_field", "");
    const oldBatchId = await getConfig("active_batch_id", "");
    const stagedDocs = [];
    const stagedCheckinDocs = [];
    let stagedEventDoc = null;
    try {
      for (const row of normalizedRows) {
        const { restore_checked_at: restoreCheckedAt, ...registrationData } = row;
        const result = await db.collection("registrations").add({ ...registrationData, batch_id: batchId });
        stagedDocs.push({ _id: result.id || result._id });
        if (restoreCheckedAt) {
          const checkinResult = await db.collection("checkins").add({ registration_id: result.id || result._id || "", name: row.name, phone: row.phone, center: normalizeCenterValue(row.center), class_name: normalizeGroupValue(row.class_name), group_name: normalizeGroupValue(row.group_name), company: row.company, group_num: row.group_num, dinner_table_num: row.dinner_table_num, batch_id: batchId, checked_at: restoreCheckedAt });
          stagedCheckinDocs.push({ _id: checkinResult.id || checkinResult._id });
        }
      }
      await setConfig("event_name", eventName);
      await setConfig("group_field", groupField);
      await setConfig("active_batch_id", batchId);
      const eventResult = await db.collection("events").add({ event_id: batchId, name: eventName, event_date: eventDate, checkin_start_at: checkinStartAt, checkin_end_at: checkinEndAt, activity_type: activityType, status: "active", group_field: groupField, created_at: new Date().toISOString() });
      stagedEventDoc = { _id: eventResult.id || eventResult._id };
      const repeatedSlots = Object.values(identityCounts).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const repeatMessage = repeatedSlots ? "，其中多人共用姓名和手机号的额外名额 " + repeatedSlots + " 个" : "";
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event_id: batchId, event_name: eventName, event_date: eventDate, activity_type: activityType, repeated_slots: repeatedSlots, restored_checkins: stagedCheckinDocs.length, msg: "活动新增成功，共导入 " + normalizedRows.length + " 条记录" + repeatMessage }) };
    } catch (e) {
      try {
        const stagedByBatch = await getAll("registrations", 5000, { batch_id: batchId });
        const stagedCheckinsByBatch = await getAll("checkins", 5000, { batch_id: batchId });
        await deleteDocs("registrations", stagedByBatch.length ? stagedByBatch : stagedDocs);
        await deleteDocs("checkins", stagedCheckinsByBatch.length ? stagedCheckinsByBatch : stagedCheckinDocs);
        if (stagedEventDoc && stagedEventDoc._id) await db.collection("events").doc(stagedEventDoc._id).remove();
        await setConfig("event_name", oldEventName);
        await setConfig("group_field", oldGroupField);
        await setConfig("active_batch_id", oldBatchId);
      } catch (rollbackError) {}
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "上传失败: " + (e.message || "") }) };
    }
  }

  // ===== RESET CHECKINS =====
  if (p === "/reset" && method === "POST") {
    try {
      const selectedEvent = await getRequestedEvent(data.event_id);
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请先选择活动" }) };
      const eventId = String(selectedEvent.event_id || selectedEvent._id || "");
      const delCks = await deleteDocs("checkins", await rowsForBatch("checkins", eventId, 5000));
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到记录已清空（" + delCks + "条）" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  // ===== DELETE CURRENT EVENT =====
  if (p === "/clear_all" && method === "POST") {
    try {
      const selectedEvent = await getRequestedEvent(data.event_id);
      if (!selectedEvent) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请先选择要删除的当前活动" }) };
      const eventId = String(selectedEvent.event_id || selectedEvent._id || "");
      const delRegs = await deleteDocs("registrations", await rowsForBatch("registrations", eventId, 5000));
      const delCks = await deleteDocs("checkins", await rowsForBatch("checkins", eventId, 5000));
      await db.collection("events").doc(selectedEvent._id).remove();
      const remainingEvents = (await getAll("events", 500)).sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")));
      const nextEvent = remainingEvents[0] || null;
      await setConfig("event_name", nextEvent ? nextEvent.name : "盛和塾签到");
      await setConfig("group_field", nextEvent ? (nextEvent.group_field || "") : "");
      await setConfig("active_batch_id", nextEvent ? String(nextEvent.event_id || nextEvent._id || "") : "");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, deleted_event_id: eventId, msg: "当前活动“" + String(selectedEvent.name || "") + "”已删除（报名" + delRegs + "条，签到" + delCks + "条）；其他活动未受影响" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "Not found" }) };
};
