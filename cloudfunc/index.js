const cloudbase = require("@cloudbase/node-sdk");
const crypto = require("crypto");
const https = require("https");

let BUILD_INFO = {
  version: "unknown",
  commit: "unknown",
  deployed_at: "unknown",
  environment: "unknown",
  service: "signin"
};
try {
  BUILD_INFO = { ...BUILD_INFO, ...require("./build-info.json") };
} catch (e) {}

const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const loginFailures = new Map();
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

function readableOpsError(payload, fallback) {
  const detail = payload && (payload.detail || payload.msg || payload.message);
  if (Array.isArray(detail)) {
    const messages = detail.map(item => {
      if (!item || typeof item !== "object") return String(item || "");
      const location = Array.isArray(item.loc)
        ? item.loc.filter(part => part !== "query" && part !== "body").join(".")
        : "";
      return (location ? location + "：" : "") + (item.msg || item.message || JSON.stringify(item));
    }).filter(Boolean);
    return messages.length ? messages.join("；") : fallback;
  }
  if (detail && typeof detail === "object") {
    return detail.msg || detail.message || JSON.stringify(detail);
  }
  return String(detail || fallback);
}

function buildOpsRosterParams(data, scope) {
  const classOrgUnitId = String(data.class_org_unit_id || "").trim();
  const groupOrgUnitId = String(data.group_org_unit_id || "").trim();
  return {
    class_org_unit_id: classOrgUnitId,
    group_org_unit_id: scope === "group" ? groupOrgUnitId : ""
  };
}

function normalizeOpsRosterData(result) {
  const data = result && result.data;
  if (Array.isArray(data)) return { members: data, version: null };
  if (data && Array.isArray(data.members)) {
    return { members: data.members, version: data.version || null };
  }
  if (result && Array.isArray(result.members)) {
    return { members: result.members, version: result.version || null };
  }
  return { members: [], version: data && data.version ? data.version : null };
}

function normalizeOpsRosterOptions(result) {
  const data = result && result.data;
  const options = data && !Array.isArray(data) ? data : result;
  return {
    classes: Array.isArray(options && options.classes) ? options.classes : [],
    groups: Array.isArray(options && options.groups) ? options.groups : [],
    special_cohorts: Array.isArray(options && options.special_cohorts)
      ? options.special_cohorts
      : [],
    version: options && options.version ? options.version : null
  };
}

function validateOpsRosterOptions(result) {
  const payload = result && result.data && !Array.isArray(result.data)
    ? result.data
    : result;
  const options = normalizeOpsRosterOptions(result);
  if (!payload || payload.source !== "PLATFORM_ORG_RELATIONS") {
    throw new Error("名单来源校验失败，已停止使用非统一平台数据");
  }
  if (payload.query_mode !== "ORG_UNIT_ID" || payload.fallback_mode !== "FAIL_CLOSED") {
    throw new Error("名单接口未启用组织 ID 严格模式");
  }
  const classIds = new Set(options.classes.map(item => String(item && item.id || "")).filter(Boolean));
  if (classIds.size !== options.classes.length) {
    throw new Error("班级组织 ID 缺失或重复");
  }
  const groupIds = new Set();
  for (const group of options.groups) {
    const groupId = String(group && group.id || "");
    const parentId = String(group && group.parent_id || "");
    if (!groupId || groupIds.has(groupId)) throw new Error("小组组织 ID 缺失或重复");
    if (!parentId || !classIds.has(parentId)) throw new Error("小组班级归属校验失败");
    groupIds.add(groupId);
  }
  return options;
}

function validateOpsRosterData(result, params) {
  const payload = result && result.data && !Array.isArray(result.data)
    ? result.data
    : null;
  if (!payload || payload.source !== "PLATFORM_ORG_RELATIONS") {
    throw new Error("名单来源校验失败，已停止导入");
  }
  if (payload.query_mode !== "ORG_UNIT_ID" || payload.fallback_mode !== "FAIL_CLOSED") {
    throw new Error("名单接口未启用组织 ID 严格模式");
  }
  const expectedId = String(params.group_org_unit_id || params.class_org_unit_id || "");
  const scopeId = String(payload.scope && payload.scope.org_unit_id || "");
  if (!expectedId || scopeId !== expectedId) {
    throw new Error("名单组织范围与请求不一致");
  }
  if (
    params.group_org_unit_id &&
    String(payload.scope && payload.scope.class_org_unit_id || "") !==
      String(params.class_org_unit_id || "")
  ) {
    throw new Error("小组所属班级与请求不一致");
  }
  const normalized = normalizeOpsRosterData(result);
  if (Number(payload.member_count) !== normalized.members.length) {
    throw new Error("名单数量校验失败");
  }
  if (normalized.members.some(item =>
    String(item && item.relation_org_id || "") !== expectedId
  )) {
    throw new Error("名单中存在不属于所选组织的人员");
  }
  return normalized;
}

function validateRosterIntegrity(result) {
  const payload = result && result.data;
  if (
    !payload ||
    payload.source !== "PLATFORM_ORG_RELATIONS" ||
    payload.query_mode !== "ORG_UNIT_ID" ||
    payload.fallback_mode !== "FAIL_CLOSED"
  ) {
    throw new Error("名单主数据来源配置校验失败");
  }
  if (!payload.passed) {
    throw new Error(
      "名单组织关系校验未通过：班级归属异常 " +
      Number(payload.group_class_mismatch_count || 0) +
      "，无效关系 " +
      Number(payload.invalid_relation_count || 0)
    );
  }
  return payload;
}

function isScheduledAttendanceSyncEvent(event) {
  return Boolean(
    event &&
    String(event.Type || event.type || "").toLowerCase() === "timer" &&
    String(event.TriggerName || event.triggerName || "") === "attendanceSyncWeekdays0000"
  );
}

function rosterIdentity(rows) {
  const values = (field) => [...new Set((Array.isArray(rows) ? rows : [])
    .map(item => String(item && item[field] || "").trim())
    .filter(Boolean))];
  const centers = values("center");
  const classes = values("class_name");
  return {
    center: centers.length === 1 ? centers[0] : "",
    class_name: classes.length === 1 ? classes[0] : "",
    center_count: centers.length,
    class_count: classes.length
  };
}

function findClassOption(options, identity) {
  const className = String(identity && identity.class_name || "").trim();
  const center = String(identity && identity.center || "").trim();
  if (!className) return null;
  let matches = (Array.isArray(options) ? options : []).filter(item =>
    String(item && (item.name || item.class_name) || "").trim() === className
  );
  if (center && matches.length > 1) {
    const centered = matches.filter(item => {
      const itemCenter = String(
        item && (item.center || item.parent_name || item.center_name) || ""
      ).trim();
      const path = String(item && item.path || "");
      return itemCenter === center || path.includes(center);
    });
    if (centered.length) matches = centered;
  }
  return matches.length === 1 ? matches[0] : null;
}

function resolveOpsConnection(env) {
  const configuredBase = String(env.OPS_API_BASE || "").replace(/\/$/, "");
  const legacyBase = /seiwajyuku-ops-/i.test(configuredBase);
  return {
    base: String(env.CHECKIN_ROSTER_API_BASE || (
      legacyBase
        ? "https://seiwajyuku-platform-api-287369-8-1453587887.sh.run.tcloudbase.com"
        : configuredBase
    )).replace(/\/$/, ""),
    apiKey: String(env.CHECKIN_ROSTER_API_KEY || (
      legacyBase ? env.SIGNIN_SERVICE_API_KEY : env.OPS_ROSTER_API_KEY
    ) || "")
  };
}

exports._test = {
  readableOpsError,
  buildOpsRosterParams,
  normalizeOpsRosterData,
  normalizeOpsRosterOptions,
  validateOpsRosterData,
  validateOpsRosterOptions,
  validateRosterIntegrity,
  rosterIdentity,
  findClassOption,
  resolveOpsConnection,
  isScheduledAttendanceSyncEvent
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Content-Type": "application/json; charset=utf-8",
    "X-App-Version": String(BUILD_INFO.version || "unknown"),
    "X-Git-Commit": String(BUILD_INFO.commit || "unknown")
  };
  
  if (method === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  if (p === "/version" && method === "GET") {
    const complete = Boolean(
      BUILD_INFO.version && BUILD_INFO.version !== "unknown" &&
      /^[0-9a-f]{40}$/i.test(String(BUILD_INFO.commit || "")) &&
      BUILD_INFO.deployed_at && BUILD_INFO.deployed_at !== "unknown" &&
      BUILD_INFO.environment && BUILD_INFO.environment !== "unknown"
    );
    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        ok: complete,
        version: String(BUILD_INFO.version || "unknown"),
        commit: String(BUILD_INFO.commit || "unknown"),
        deployed_at: String(BUILD_INFO.deployed_at || "unknown"),
        environment: String(BUILD_INFO.environment || "unknown"),
        service: String(BUILD_INFO.service || "signin")
      })
    };
  }

  function requestJson(urlText, headers, method, body, timeoutMs) {
    const url = new URL(urlText);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: method || "GET",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          Accept: "application/json",
          ...(payload ? {
            "Content-Type": "application/json",
            "Content-Length": payload.length
          } : {}),
          ...(headers || {})
        },
        timeout: timeoutMs || 20000
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
            return reject(new Error(readableOpsError(payload, "运营系统请求失败")));
          }
          resolve(payload);
        });
      });
      req.on("timeout", () => req.destroy(new Error("连接运营系统超时")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function requestOps(pathname, params) {
    // 旧 OPS_API_BASE 指向历史运营系统，既会超时，也不返回三场签到所需的
    // 组织 ID。迁移期间自动切到统一平台；新部署可用两个 CHECKIN_ROSTER_*
    // 环境变量显式覆盖，完成独立密钥切换后即可移除兼容分支。
    const connection = resolveOpsConnection(process.env);
    const base = connection.base;
    const apiKey = connection.apiKey;
    if (!base || !apiKey) throw new Error("签到系统尚未配置运营名册连接");
    const url = new URL(base + pathname);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value).trim());
      }
    });
    return await requestJson(url.toString(), { "X-API-Key": apiKey });
  }

  async function requestScheduledAttendanceSync() {
    const connection = resolveOpsConnection(process.env);
    if (!connection.base || !connection.apiKey) {
      throw new Error("统一平台签到同步连接未配置");
    }
    const validation = validateRosterIntegrity(
      await requestOps("/api/v1/checkin-rosters/validate")
    );
    const syncResult = await requestJson(
      connection.base + "/api/v1/attendance/sync/scheduled",
      { "X-API-Key": connection.apiKey },
      "POST",
      {},
      100000
    );
    return { validation, syncResult };
  }

  if (isScheduledAttendanceSyncEvent(event)) {
    const result = await requestScheduledAttendanceSync();
    return {
      ok: true,
      action: "platform_attendance_sync",
      roster_validation: "PASSED",
      class_member_count: result.validation.class_member_count,
      group_member_count: result.validation.group_member_count,
      status: result.syncResult && result.syncResult.data &&
        result.syncResult.data.status || "UNKNOWN"
    };
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

  function lifecycleStatus(item) {
    const value = String(item && item.lifecycle_status || "DRAFT").trim().toUpperCase();
    return ["DRAFT", "CONFIRMED", "CANCELLED"].includes(value) ? value : "DRAFT";
  }

  function validEventDate(value) {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  }

  function chinaDateFromTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? chinaDateKey(new Date(timestamp)) : "";
  }

  function eventBusinessDate(item) {
    const eventDate = validEventDate(item && item.event_date);
    if (eventDate) return eventDate;
    return chinaDateFromTimestamp(item && item.checkin_start_at);
  }

  function isEventConfirmed(item) {
    return lifecycleStatus(item) === "CONFIRMED";
  }

  function isPublicCheckinEligible(item, now) {
    return isEventConfirmed(item) && isEventToday(item, now) && isEventOpen(item);
  }

  function isPublicUpcoming(item, now) {
    return isEventConfirmed(item) && isEventToday(item, now) && eventTimeState(item, now) === "upcoming";
  }

  function canManageEventRegistrations(item) {
    return lifecycleStatus(item) !== "CANCELLED" && ["upcoming", "open"].includes(eventTimeState(item));
  }

  async function manualRegistrationTargetEvents(selectedEvent) {
    const selectedOrder = Number(selectedEvent && selectedEvent.session_order);
    const eventGroupId = String(selectedEvent && selectedEvent.event_group_id || "").trim();
    if (normalizeActivityType(selectedEvent && selectedEvent.activity_type) !== "class_meeting" || !eventGroupId || ![1, 2, 3].includes(selectedOrder)) {
      return [selectedEvent];
    }
    const related = (await getEventGroupById(eventGroupId)).filter(item =>
      normalizeActivityType(item.activity_type) === "class_meeting" &&
      Number(item.session_order) >= selectedOrder &&
      Number(item.session_order) <= 3
    ).sort((a, b) => Number(a.session_order) - Number(b.session_order));
    return related.length ? related : [selectedEvent];
  }

  function chinaDateKey(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now || new Date());
    const value = {};
    parts.forEach(part => { if (part.type !== "literal") value[part.type] = part.value; });
    return value.year + "-" + value.month + "-" + value.day;
  }

  function isEventToday(item, now) {
    const eventDate = eventBusinessDate(item);
    const today = chinaDateKey(now);
    return eventDate === today;
  }

  async function rowsForBatch(collectionName, batchId, maxTotal) {
    // batch_id is written with every registration and check-in. Query it in the
    // database instead of reading the entire historical collection first.
    return getAll(collectionName, maxTotal || 5000, { batch_id: String(batchId || "") });
  }

  async function ensureLegacyEvent() {
    const existing = await db.collection("events").limit(1).get();
    if (existing.data && existing.data.length) return;
    const batchId = await getConfig("active_batch_id", "");
    if (!batchId) return;
    const name = await getConfig("event_name", "盛和塾签到");
    const groupField = await getConfig("group_field", "");
    await db.collection("events").add({
      event_id: batchId,
      name,
      activity_type: "other",
      event_date: inferEventDate(name),
      status: "active",
      lifecycle_status: "DRAFT",
      source_system: "MANUAL_ADMIN",
      group_field: groupField,
      created_at: new Date().toISOString(),
      migrated_from_legacy: true
    });
  }

  async function getEventById(eventId) {
    await ensureLegacyEvent();
    const key = String(eventId || "").trim();
    if (!key) return null;
    const byEventId = await db.collection("events").where({ event_id: key }).limit(1).get();
    if (byEventId.data && byEventId.data.length) return byEventId.data[0];
    const byDocumentId = await db.collection("events").where({ _id: key }).limit(1).get();
    return byDocumentId.data && byDocumentId.data.length ? byDocumentId.data[0] : null;
  }

  async function getEventGroupById(eventGroupId) {
    await ensureLegacyEvent();
    const key = String(eventGroupId || "").trim();
    if (!key) return [];
    const result = await db.collection("events")
      .where({ event_group_id: key })
      .orderBy("session_order", "asc")
      .get();
    return (result.data || []).sort((a, b) => Number(a.session_order || 0) - Number(b.session_order || 0));
  }

  function eventDateQueryFilter(filters) {
    const from = validEventDate(filters && filters.date_from);
    const to = validEventDate(filters && filters.date_to);
    const command = db.command;
    if (!command || (!from && !to)) return null;
    const conditions = [];
    if (from) conditions.push(command.gte(from));
    if (to) conditions.push(command.lte(to));
    return conditions.length === 1 ? conditions[0] : command.and(...conditions);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function eventListWhere(filters) {
    const where = {};
    const lifecycle = String(filters && filters.lifecycle_status || "").trim().toUpperCase();
    const activityType = String(filters && filters.activity_type || "").trim();
    if (lifecycle && lifecycle !== "ALL") where.lifecycle_status = lifecycle;
    if (activityType && activityType !== "ALL") where.activity_type = activityType;
    const dateFilter = eventDateQueryFilter(filters);
    if (dateFilter) where.event_date = dateFilter;
    const keyword = String(filters && filters.keyword || "").trim();
    if (keyword && typeof db.RegExp === "function") {
      where.name = db.RegExp({ regexp: escapeRegExp(keyword), options: "i" });
    }
    return where;
  }

  function matchesEventListFilter(item, filters) {
    const lifecycle = String(filters && filters.lifecycle_status || "").trim().toUpperCase();
    const activityType = String(filters && filters.activity_type || "").trim();
    const keyword = String(filters && filters.keyword || "").trim().toLowerCase();
    const date = String(item && item.event_date || "");
    if (lifecycle && lifecycle !== "ALL" && lifecycleStatus(item) !== lifecycle) return false;
    if (activityType && activityType !== "ALL" && normalizeActivityType(item && item.activity_type) !== activityType) return false;
    if (validEventDate(filters && filters.date_from) && date < String(filters.date_from)) return false;
    if (validEventDate(filters && filters.date_to) && date > String(filters.date_to)) return false;
    if (keyword && !String(item && item.name || "").toLowerCase().includes(keyword)) return false;
    return true;
  }

  async function queryEventPage(filters) {
    await ensureLegacyEvent();
    const page = Math.max(1, Math.min(parseInt(filters && filters.page || "1", 10) || 1, 100000));
    const pageSize = Math.max(1, Math.min(parseInt(filters && filters.page_size || "20", 10) || 20, 50));
    const where = eventListWhere(filters || {});
    let query = db.collection("events");
    if (Object.keys(where).length) query = query.where(where);
    const keyword = String(filters && filters.keyword || "").trim();
    const needsClientFiltering = !db.command || (keyword && typeof db.RegExp !== "function");
    if (needsClientFiltering) {
      // The local regression double does not implement CloudBase commands or
      // regex queries. Filter before slicing so page boundaries remain valid.
      const result = await query.orderBy("event_date", "desc").limit(10000).get();
      const filtered = (result.data || []).filter(item => matchesEventListFilter(item, filters || {}));
      const offset = (page - 1) * pageSize;
      return { rows: filtered.slice(offset, offset + pageSize), page, pageSize, hasMore: filtered.length > offset + pageSize };
    }
    const result = await query.orderBy("event_date", "desc").skip((page - 1) * pageSize).limit(pageSize + 1).get();
    const rows = result.data || [];
    return { rows: rows.slice(0, pageSize), page, pageSize, hasMore: rows.length > pageSize };
  }

  async function getTodayEvents() {
    await ensureLegacyEvent();
    const today = chinaDate();
    const filters = { date_from: today, date_to: today };
    const where = eventListWhere(filters);
    let query = db.collection("events");
    if (Object.keys(where).length) query = query.where(where);
    const result = await query.orderBy("event_date", "desc").limit(1000).get();
    const rows = result.data || [];
    return (!db.command ? rows.filter(item => matchesEventListFilter(item, filters)) : rows);
  }

  async function getEventsByDate(eventDate) {
    await ensureLegacyEvent();
    const key = validEventDate(eventDate);
    if (!key) return [];
    const result = await db.collection("events").where({ event_date: key }).orderBy("created_at", "desc").limit(1000).get();
    return result.data || [];
  }

  function logicalActivityName(item) {
    const name = String(item && item.name || "盛和塾活动");
    const sessionName = String(item && item.session_name || "").trim();
    const suffix = sessionName ? " - " + sessionName : "";
    return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  }

  function summarizeEventGroup(rows) {
    const sorted = (rows || []).slice().sort((a, b) => Number(a.session_order || 0) - Number(b.session_order || 0));
    const primary = sorted[0];
    if (!primary) return null;
    const sessions = sorted.map(publicEvent);
    const groupId = String(primary.event_group_id || "");
    const logicalName = groupId ? logicalActivityName(primary) : String(primary.name || "盛和塾活动");
    return {
      ...publicEvent(primary),
      name: logicalName,
      logical_name: logicalName,
      event_group_id: groupId,
      is_group: Boolean(groupId && sorted.length > 1),
      session_count: sorted.length,
      sessions
    };
  }

  async function getRequestedEvent(eventId) {
    const selectedId = String(eventId || await getConfig("active_batch_id", "")).trim();
    return selectedId ? await getEventById(selectedId) : null;
  }

  function publicEvent(item) {
    const timeState = eventTimeState(item);
    return {
      event_id: item.event_id || item._id || "",
      event_group_id: item.event_group_id || "",
      session_code: item.session_code || "",
      session_name: item.session_name || "",
      session_order: item.session_order || 0,
      name: item.name || "盛和塾活动",
      event_date: item.event_date || "",
      activity_type: normalizeActivityType(item.activity_type),
      activity_type_name: ACTIVITY_TYPES[normalizeActivityType(item.activity_type)],
      status: ["closed", "ended"].includes(timeState) ? "closed" : "active",
      manual_status: item.status === "closed" ? "closed" : "active",
      lifecycle_status: lifecycleStatus(item),
      source_system: item.source_system || "MANUAL_ADMIN",
      source_event_id: item.source_event_id || "",
      source_revision: item.source_revision || "",
      checkin_status: timeState,
      checkin_start_at: item.checkin_start_at || "",
      checkin_end_at: item.checkin_end_at || "",
      scheduled_start_at: item.scheduled_start_at || "",
      scheduled_end_at: item.scheduled_end_at || "",
      group_field: item.group_field || "",
      org_unit_id: item.org_unit_id || "",
      class_org_unit_id: item.class_org_unit_id || ""
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
    return crypto.createHmac("sha256", secret).update(await configuredAdminPasswordHash()).digest("hex");
  }

  async function configuredAdminPasswordHash() {
    // A value changed through the protected admin page takes precedence. The
    // environment variable remains the initial secure bootstrap credential.
    const storedHash = String(await getConfig("admin_password_hash", "")).trim().toLowerCase();
    const passwordHash = /^[a-f0-9]{64}$/.test(storedHash)
      ? storedHash
      : String(process.env.ADMIN_PASSWORD_HASH || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(passwordHash)) {
      throw new Error("ADMIN_PASSWORD_HASH 未配置或格式不正确");
    }
    return passwordHash;
  }

  function loginClientKey() {
    const headers = event.headers || {};
    const forwarded = String(headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "").split(",")[0].trim();
    const sourceIp = String(
      forwarded ||
      (event.requestContext && event.requestContext.sourceIp) ||
      (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) ||
      "unknown"
    );
    return crypto.createHash("sha256").update(sourceIp).digest("hex");
  }

  function currentLoginFailures(clientKey) {
    const now = Date.now();
    const recent = (loginFailures.get(clientKey) || []).filter(timestamp => now - timestamp < LOGIN_RATE_LIMIT_WINDOW_MS);
    if (recent.length) loginFailures.set(clientKey, recent);
    else loginFailures.delete(clientKey);
    return recent;
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
    let configuredHash;
    try {
      configuredHash = await configuredAdminPasswordHash();
    } catch (error) {
      return { statusCode: 503, headers: h, body: JSON.stringify({ ok: false, msg: "管理员认证尚未安全配置" }) };
    }
    const clientKey = loginClientKey();
    const failures = currentLoginFailures(clientKey);
    if (failures.length >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
      return { statusCode: 429, headers: h, body: JSON.stringify({ ok: false, msg: "登录失败次数过多，请稍后再试" }) };
    }
    const suppliedHash = crypto.createHash("sha256").update(String(data.password || "")).digest("hex");
    const actual = Buffer.from(suppliedHash, "hex");
    const expected = Buffer.from(configuredHash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      failures.push(Date.now());
      loginFailures.set(clientKey, failures);
      return { statusCode: 401, headers: h, body: JSON.stringify({ ok: false, msg: "密码错误" }) };
    }
    loginFailures.delete(clientKey);
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, token: await issueAdminToken(), expires_in: ADMIN_TOKEN_TTL_MS / 1000 }) };
  }

  const protectedPaths = new Set(["/settings", "/admin_password", "/admin_events", "/event_update", "/event_lifecycle_update", "/registration", "/registration_delete", "/attendance_status", "/export", "/stats", "/ops_roster_options", "/ops_roster_members", "/upload_preview", "/upload", "/reset", "/clear_all", "/create_class_meeting_sessions"]);
  if (protectedPaths.has(p) && !(await isAdminRequest())) return unauthorized();

  async function writeEventAudit(eventItem, previousStatus, nextStatus, reason) {
    await db.collection("event_audit_logs").add({
      action: "event.lifecycle_status.update",
      event_id: String(eventItem.event_id || eventItem._id || ""),
      event_group_id: String(eventItem.event_group_id || ""),
      previous_status: previousStatus,
      next_status: nextStatus,
      reason: String(reason || "").trim(),
      source_system: eventItem.source_system || "MANUAL_ADMIN",
      actor: "admin_token",
      occurred_at: new Date().toISOString()
    });
  }

  async function writeEventDeletionAudit(eventItem, reason) {
    await db.collection("event_audit_logs").add({
      action: "event.deleted",
      event_id: String(eventItem.event_id || eventItem._id || ""),
      event_group_id: String(eventItem.event_group_id || ""),
      previous_status: lifecycleStatus(eventItem),
      next_status: "DELETED",
      reason: String(reason || "后台人工永久删除").trim(),
      source_system: eventItem.source_system || "MANUAL_ADMIN",
      actor: "admin_token",
      occurred_at: new Date().toISOString()
    });
  }

  function validateLifecycleConfirmation(eventItem) {
    const eventDate = validEventDate(eventItem && eventItem.event_date);
    if (!eventDate) return "活动日期必须为 YYYY-MM-DD";
    const startsAt = Date.parse(eventItem && eventItem.checkin_start_at || "");
    const endsAt = Date.parse(eventItem && eventItem.checkin_end_at || "");
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      return "签到开始和截止时间必须完整且顺序正确";
    }
    if (!ACTIVITY_TYPES[String(eventItem && eventItem.activity_type || "")]) return "活动类型不正确";
    const type = normalizeActivityType(eventItem && eventItem.activity_type);
    if (type === "class_meeting" && !String(eventItem.class_org_unit_id || "").trim()) return "班会活动缺少班级组织 ID";
    if (type === "group_meeting" && !String(eventItem.group_org_unit_id || eventItem.class_org_unit_id || "").trim()) return "小组活动缺少组织 ID";
    return "";
  }

  if (p === "/event_lifecycle_update" && method === "POST") {
    try {
      const requestedStatus = String(data.lifecycle_status || "").trim().toUpperCase();
      if (!["DRAFT", "CONFIRMED", "CANCELLED"].includes(requestedStatus)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "生命周期状态必须是 DRAFT、CONFIRMED 或 CANCELLED" }) };
      }
      const selectedEvent = data.event_group_id
        ? null
        : await getEventById(data.event_id);
      const selectedGroup = data.event_group_id
        ? await getEventGroupById(data.event_group_id)
        : (selectedEvent && selectedEvent.event_group_id ? await getEventGroupById(selectedEvent.event_group_id) : []);
      const targetEvents = data.event_group_id || (selectedEvent && selectedEvent.event_group_id)
        ? selectedGroup
        : (selectedEvent ? [selectedEvent] : []);
      if (!targetEvents.length) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到活动或活动组" }) };
      if (requestedStatus === "CONFIRMED") {
        const invalid = targetEvents.map(item => ({ item, msg: validateLifecycleConfirmation(item) })).find(row => row.msg);
        if (invalid) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: String(invalid.item.name || "活动") + "：" + invalid.msg }) };
        if (targetEvents.some(item => lifecycleStatus(item) === "CANCELLED" && data.allow_restore !== true)) {
          return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "已取消活动需先退回草稿，再确认举办" }) };
        }
      }
      const now = new Date().toISOString();
      const changes = {
        lifecycle_status: requestedStatus,
        confirmed_at: requestedStatus === "CONFIRMED" ? now : "",
        confirmed_by: requestedStatus === "CONFIRMED" ? "admin_token" : "",
        cancelled_at: requestedStatus === "CANCELLED" ? now : "",
        cancelled_by: requestedStatus === "CANCELLED" ? "admin_token" : "",
        updated_at: now
      };
      const snapshots = targetEvents.map(item => ({
        item,
        previous: {
          lifecycle_status: item.lifecycle_status,
          confirmed_at: item.confirmed_at || "",
          confirmed_by: item.confirmed_by || "",
          cancelled_at: item.cancelled_at || "",
          cancelled_by: item.cancelled_by || "",
          updated_at: item.updated_at || ""
        }
      }));
      const updated = [];
      try {
        for (const snapshot of snapshots) {
          await db.collection("events").doc(snapshot.item._id).update(changes);
          updated.push(snapshot);
        }
        for (const snapshot of snapshots) {
          await writeEventAudit(snapshot.item, lifecycleStatus(snapshot.item), requestedStatus, data.reason);
        }
      } catch (writeError) {
        for (const snapshot of updated.reverse()) {
          try { await db.collection("events").doc(snapshot.item._id).update(snapshot.previous); } catch (rollbackError) {}
        }
        throw writeError;
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, lifecycle_status: requestedStatus, event_group_id: targetEvents[0].event_group_id || "", events: targetEvents.map(item => publicEvent({ ...item, ...changes })), msg: requestedStatus === "CONFIRMED" ? "活动已确认举办" : requestedStatus === "CANCELLED" ? "活动已取消，不会进入公开签到" : "活动已退回草稿" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "更新活动生命周期失败: " + (e.message || "") }) };
    }
  }

  if (p === "/admin_password" && method === "POST") {
    const newPassword = String(data.new_password || "");
    if (newPassword.length < 10 || newPassword.length > 128 || /\s/.test(newPassword) || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "新密码须为10至128位，包含字母和数字，且不含空格" }) };
    }
    await setConfig("admin_password_hash", crypto.createHash("sha256").update(newPassword).digest("hex"));
    loginFailures.clear();
    return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "密码已修改，请使用新密码重新登录" }) };
  }

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
      const activeEvents = (await getTodayEvents()).filter(item => isPublicCheckinEligible(item));
      if (!activeEvents.length) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前没有开放签到的活动" }) };
      const activeIds = new Set(activeEvents.map(item => String(item.event_id || item._id || "")));
      // Phones are normalized when importing or adding registrations. Limiting
      // this lookup to one phone prevents each QR scan from scanning all events.
      const phoneRows = await getAll("registrations", 5000, { phone });
      const phoneRegistrations = phoneRows.filter(reg => activeIds.has(String(reg.batch_id || "")) && String(reg.phone || "").trim().replace(/\s/g, "").replace(/-/g, "") === phone);
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
      const allEvents = await getTodayEvents();
      // The public QR page only shows activities dated today in China Standard
      // Time. Future activities remain available in the admin console.
      const todayEvents = allEvents.filter(item => isEventToday(item));
      const activeEvents = todayEvents.filter(item => isPublicCheckinEligible(item));
      const upcomingEvents = todayEvents
        .filter(item => isPublicUpcoming(item))
        .sort((a, b) => Date.parse(a.checkin_start_at || "") - Date.parse(b.checkin_start_at || ""));
      const nextEvent = upcomingEvents[0] || null;
      const displayEvents = activeEvents.concat(
        nextEvent && !activeEvents.some(item => String(item.event_id || item._id || "") === String(nextEvent.event_id || nextEvent._id || ""))
          ? [nextEvent]
          : []
      );
      const ds = await getDisplaySettings();
      const activeIds = activeEvents.map(item => String(item.event_id || item._id || ""));
      const activeRegistrationRows = await Promise.all(activeIds.map(eventId => rowsForBatch("registrations", eventId, 5000)));
      const total = activeRegistrationRows.reduce((sum, rows) => sum + rows.length, 0);
      const eventName = activeEvents.length === 1
        ? (activeEvents[0].name || "盛和塾活动签到")
        : (activeEvents.length > 1 ? "盛和塾活动签到" : "当前暂无可签到活动");
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, active_event_count: activeEvents.length, active_events: activeEvents.map(publicEvent), next_event: nextEvent ? publicEvent(nextEvent) : null, display_events: displayEvents.map(publicEvent), show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: "签到活动加载失败", active_event_count: 0, active_events: [], show_group: "true", show_dinner_table: "true", total: 0 }) };
    }
  }

  // ===== SETTINGS =====
  if (p === "/admin_events" && method === "GET") {
    try {
      const pageResult = await queryEventPage({
        page: query.page,
        page_size: query.page_size,
        keyword: query.keyword,
        lifecycle_status: query.lifecycle_status,
        activity_type: query.activity_type,
        date_from: query.date_from,
        date_to: query.date_to
      });
      const summaries = [];
      const seenGroups = new Set();
      for (const item of pageResult.rows) {
        const groupId = String(item.event_group_id || "");
        if (groupId && seenGroups.has(groupId)) continue;
        const rows = groupId ? await getEventGroupById(groupId) : [item];
        if (groupId) seenGroups.add(groupId);
        const summary = summarizeEventGroup(rows);
        if (summary) summaries.push(summary);
      }
      const selectedEventId = await getConfig("active_batch_id", "");
      let selectedItem = null;
      if (selectedEventId) {
        const selectedEvent = await getEventById(selectedEventId);
        if (selectedEvent) {
          const selectedRows = selectedEvent.event_group_id
            ? await getEventGroupById(selectedEvent.event_group_id)
            : [selectedEvent];
          selectedItem = summarizeEventGroup(selectedRows);
        }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        items: summaries,
        // Keep the legacy key during the PR #6 transition for older admin tabs.
        events: summaries,
        page: pageResult.page,
        page_size: pageResult.pageSize,
        has_more: pageResult.hasMore,
        selected_event_id: selectedEventId,
        selected_item: selectedItem,
        activity_types: ACTIVITY_TYPES
      }) };
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
      const options = validateOpsRosterOptions(result);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, ...options }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "读取运营名单选项失败: " + (e.message || "") }) };
    }
  }

  if (p === "/ops_roster_members" && method === "POST") {
    try {
      const scope = data.scope === "group" ? "group" : "class";
      const params = buildOpsRosterParams(data, scope);
      if (!params.class_org_unit_id || (scope === "group" && !params.group_org_unit_id)) {
        throw new Error(scope === "group" ? "请选择有效的小组组织 ID" : "请选择有效的班级组织 ID");
      }
      const result = await requestOps(
        "/api/v1/checkin-rosters/members",
        params
      );
      const normalized = validateOpsRosterData(result, params);
      const attendees = normalized.members.map(item => ({
        name: item.name || "",
        phone: item.phone || "",
        member_code: item.member_code || "",
        company: item.company_name || item.company || "",
        center: item.primary_org_name || item.center || "",
        class_name: item.class_name || "",
        group_name: item.group_name || "",
        group_num: null,
        dinner_table_num: null
      }));
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        scope,
        member_count: attendees.length,
        attendees,
        version: normalized.version
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
      if (!canManageEventRegistrations(selectedEvent)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前活动已结束或已关闭，不能新增临时报名" }) };
      const targetEvents = await manualRegistrationTargetEvents(selectedEvent);
      const unavailableEvent = targetEvents.find(item => !canManageEventRegistrations(item));
      if (unavailableEvent) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "需同步的“" + String(unavailableEvent.session_name || unavailableEvent.name || "活动") + "”已结束或已关闭，未新增任何报名" }) };
      }
      const targetRows = await Promise.all(targetEvents.map(async item => ({
        event: item,
        registrations: await rowsForBatch("registrations", String(item.event_id || item._id || ""), 5000)
      })));
      const missingTargets = targetRows.filter(item => !item.registrations.some(row => identityKey(row) === identityKey(registration)));
      const existingTargets = targetRows.filter(item => item.registrations.some(row => identityKey(row) === identityKey(registration)));
      if (!missingTargets.length) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "当前场次及其后续场次已有相同姓名和手机号的报名记录" }) };
      }
      const added = [];
      for (const target of missingTargets) {
        const item = target.event;
        const batchId = String(item.event_id || item._id || "");
        const result = await db.collection("registrations").add({
          ...registration,
          batch_id: batchId,
          event_group_id: String(item.event_group_id || ""),
          session_code: String(item.session_code || "")
        });
        added.push({
          registration_id: result.id || result._id || "",
          event_id: batchId,
          session_name: String(item.session_name || item.name || "当前活动")
        });
      }
      const addedNames = added.map(item => item.session_name).join("、");
      const existingNames = existingTargets.map(item => String(item.event.session_name || item.event.name || "当前活动")).join("、");
      const message = (added.length > 1 ? "临时报名已自动同步至" : "临时报名已新增至") + addedNames + "，共" + added.length + "场" + (existingNames ? "；" + existingNames + "已有相同报名，已跳过" : "");
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        registration_id: added[0].registration_id,
        added_count: added.length,
        skipped_count: existingTargets.length,
        added_events: added,
        msg: message
      }) };
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
      const registrationEvent = await getEventById(registration.batch_id);
      if (registrationEvent && lifecycleStatus(registrationEvent) === "CANCELLED") {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动已取消，不能删除或修改报名记录" }) };
      }
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
      const registrationEvent = await getEventById(registration.batch_id);
      if (registrationEvent && lifecycleStatus(registrationEvent) === "CANCELLED") {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动已取消，不能删除或修改报名记录" }) };
      }
      if (registrationEvent && String(registrationEvent.session_code || "").toUpperCase() === "KONPA" && status === "late") {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "晚上空巴不设置迟到状态，请以实际签到记录为准" }) };
      }
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
      const events = await getEventsByDate(upload.eventDate);
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
    const eventsAtConfirmation = await getEventsByDate(eventDate);
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
      const eventResult = await db.collection("events").add({ event_id: batchId, name: eventName, event_date: eventDate, checkin_start_at: checkinStartAt, checkin_end_at: checkinEndAt, activity_type: activityType, status: "active", lifecycle_status: "DRAFT", source_system: "MANUAL_ADMIN", group_field: groupField, created_at: new Date().toISOString() });
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
      const eventGroupId = String(selectedEvent.event_group_id || "").trim();
      const targetEvents = eventGroupId ? await getEventGroupById(eventGroupId) : [selectedEvent];
      const deletedEventIds = [];
      let delRegs = 0;
      let delCks = 0;
      for (const target of targetEvents) {
        const eventId = String(target.event_id || target._id || "");
        delRegs += await deleteDocs("registrations", await rowsForBatch("registrations", eventId, 5000));
        delCks += await deleteDocs("checkins", await rowsForBatch("checkins", eventId, 5000));
        await db.collection("events").doc(target._id).remove();
        await writeEventDeletionAudit(target, eventGroupId ? "后台人工永久删除三场活动组" : "后台人工永久删除单场活动");
        deletedEventIds.push(eventId);
      }
      const remainingPage = await queryEventPage({ page: 1, page_size: 1 });
      const nextEvent = remainingPage.rows[0] || null;
      await setConfig("event_name", nextEvent ? nextEvent.name : "盛和塾签到");
      await setConfig("group_field", nextEvent ? (nextEvent.group_field || "") : "");
      await setConfig("active_batch_id", nextEvent ? String(nextEvent.event_id || nextEvent._id || "") : "");
      const groupText = targetEvents.length > 1 ? "活动组（" + targetEvents.map(item => String(item.session_name || item.name || "活动")).join("、") + "）" : "当前活动“" + String(selectedEvent.name || "") + "”";
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, deleted_event_id: deletedEventIds[0] || "", deleted_event_ids: deletedEventIds, deleted_event_group_id: eventGroupId, deleted_count: deletedEventIds.length, msg: groupText + "已删除（报名" + delRegs + "条，签到" + delCks + "条）；其他活动未受影响" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  // ===== API KEY VERIFICATION FOR OPS ENDPOINTS =====
  function verifyOpsApiKey() {
    const expected = String(process.env.SIGNIN_SERVICE_API_KEY || "");
    const apiKeyHeader = Object.entries(event.headers || {}).find(([name]) => String(name).toLowerCase() === "x-api-key");
    const provided = String(apiKeyHeader ? apiKeyHeader[1] : "");
    if (!expected || !provided) return false;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  // ===== CREATE THREE-SESSION CLASS MEETING =====
  // Creates one logical activity group with three checkin sessions:
  // MORNING (7pts), AFTERNOON (7pts), KONPA (4pts)
  if (p === "/create_class_meeting_sessions" && method === "POST") {
    try {
      const eventDate = String(data.event_date || "").trim();
      const eventName = String(data.event_name || "").trim() || (eventDate + " 班级学习会");
      const groupField = String(data.group_field || "class_name").trim();
      let orgUnitId = String(data.org_unit_id || "").trim();
      let classOrgUnitId = String(data.class_org_unit_id || "").trim();
      const rosterMembers = Array.isArray(data.roster_members) ? data.roster_members : [];
      const identity = rosterIdentity(rosterMembers);
      const requestedIdentity = {
        center: String(data.center_name || identity.center || "").trim(),
        class_name: String(data.class_name || identity.class_name || "").trim()
      };

      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动日期格式必须为 YYYY-MM-DD" }) };
      }
      if (!classOrgUnitId && requestedIdentity.class_name) {
        try {
          const options = normalizeOpsRosterOptions(
            await requestOps("/api/v1/checkin-rosters/options")
          );
          const matched = findClassOption(options.classes, requestedIdentity);
          if (matched) {
            classOrgUnitId = String(matched.id || matched.class_org_unit_id || "").trim();
            orgUnitId = orgUnitId || String(
              matched.parent_id || matched.org_unit_id || ""
            ).trim();
          }
        } catch (resolveError) {}
      }
      if (!orgUnitId || !classOrgUnitId) {
        return { statusCode: 200, headers: h, body: JSON.stringify({
          ok: false,
          msg: requestedIdentity.class_name
            ? "Excel 名单已读取，但暂时无法确认“" + requestedIdentity.class_name + "”的班级组织信息，请稍后重试"
            : "Excel 名单中需要有且只能有一个班级，或先从运营系统选择班级"
        }) };
      }

      // Session definitions
      const sessions = [
        { code: "MORNING", name: "上午", order: 1,
          checkin_start: data.morning_checkin_start || (eventDate + "T07:30"),
          scheduled_start: data.morning_scheduled_start || (eventDate + "T09:00"),
          scheduled_end: data.morning_scheduled_end || (eventDate + "T12:00"),
          checkin_end: data.morning_checkin_end || (eventDate + "T10:30") },
        { code: "AFTERNOON", name: "下午", order: 2,
          checkin_start: data.afternoon_checkin_start || (eventDate + "T12:10"),
          scheduled_start: data.afternoon_scheduled_start || (eventDate + "T13:30"),
          scheduled_end: data.afternoon_scheduled_end || (eventDate + "T17:00"),
          checkin_end: data.afternoon_checkin_end || (eventDate + "T15:00") },
        { code: "KONPA", name: "晚上空巴", order: 3,
          checkin_start: data.konpa_checkin_start || (eventDate + "T17:10"),
          scheduled_start: data.konpa_scheduled_start || (eventDate + "T18:00"),
          scheduled_end: data.konpa_scheduled_end || (eventDate + "T20:30"),
          checkin_end: data.konpa_checkin_end || (eventDate + "T20:30") }
      ];

      let previousScheduledEnd = null;
      for (const session of sessions) {
        session.checkin_start_at = parseChinaDateTime(session.checkin_start);
        session.scheduled_start_at = parseChinaDateTime(session.scheduled_start);
        session.checkin_end_at = parseChinaDateTime(session.checkin_end);
        session.scheduled_end_at = parseChinaDateTime(session.scheduled_end);
        const timestamps = [
          session.checkin_start_at,
          session.scheduled_start_at,
          session.checkin_end_at,
          session.scheduled_end_at
        ].map(value => Date.parse(value));
        if (timestamps.some(value => !Number.isFinite(value))) {
          return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: session.name + "时间填写不完整" }) };
        }
        if (!(timestamps[0] <= timestamps[1] && timestamps[1] <= timestamps[2] && timestamps[2] <= timestamps[3])) {
          return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: session.name + "时间顺序必须是：签到开放 ≤ 正式开始 ≤ 签到截止 ≤ 正式结束" }) };
        }
        if (previousScheduledEnd !== null && previousScheduledEnd > timestamps[0]) {
          return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "上午、下午和空巴的时间不能重叠" }) };
        }
        previousScheduledEnd = timestamps[3];
      }

      // Generate a shared event_group_id
      const eventGroupId = Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");

      // Create three events
      const createdEvents = [];
      for (const session of sessions) {
        const batchId = Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
        await db.collection("events").add({
          event_id: batchId,
          event_group_id: eventGroupId,
          session_code: session.code,
          session_name: session.name,
          session_order: session.order,
          name: eventName + " - " + session.name,
          event_date: eventDate,
          checkin_start_at: session.checkin_start_at,
          checkin_end_at: session.checkin_end_at,
          scheduled_start_at: session.scheduled_start_at,
          scheduled_end_at: session.scheduled_end_at,
          activity_type: "class_meeting",
          status: "active",
          lifecycle_status: "DRAFT",
          source_system: "MANUAL_ADMIN",
          group_field: groupField,
          org_unit_id: orgUnitId,
          class_org_unit_id: classOrgUnitId,
          created_at: new Date().toISOString()
        });
        createdEvents.push({ event_id: batchId, session_code: session.code, session_name: session.name });
      }

      // If roster data is provided, copy to all three sessions
      if (rosterMembers.length > 0) {
        for (const ev of createdEvents) {
          for (const member of rosterMembers) {
            await db.collection("registrations").add({
              name: String(member.name || "").trim(),
              phone: String(member.phone || "").trim().replace(/\s/g, "").replace(/-/g, ""),
              center: normalizeCenterValue(member.center || member.primary_org_name || ""),
              class_name: normalizeGroupValue(member.class_name || ""),
              group_name: normalizeGroupValue(member.group_name || ""),
              company: String(member.company_name || member.company || "").trim(),
              member_code: String(member.member_code || "").trim(),
              group_num: null,
              dinner_table_num: null,
              attendance_status: "pending",
              attendance_note: "",
              source: data.roster_source === "excel_upload" ? "excel_upload" : "ops_roster",
              batch_id: ev.event_id,
              event_group_id: eventGroupId,
              session_code: ev.session_code,
              created_at: new Date().toISOString()
            });
          }
        }
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        event_group_id: eventGroupId,
        events: createdEvents,
        msg: "三场次班级学习会创建成功" + (rosterMembers.length ? "，名单已复制到三个场次" : "")
      }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "创建失败: " + (e.message || "") }) };
    }
  }

  // ===== OPS API: INCREMENTAL SESSIONS PULL =====
  if (p === "/ops/v1/attendance/sessions" && method === "GET") {
    if (!verifyOpsApiKey()) {
      return { statusCode: 401, headers: h, body: JSON.stringify({ detail: "API Key 无效" }) };
    }
    try {
      const cursor = String(query.cursor || "");
      const limit = Math.min(parseInt(query.limit || "200", 10), 500);
      // Stable ordering prevents offset pagination from skipping or duplicating
      // events while new events are appended.
      let q = db.collection("events").orderBy("created_at", "asc");

      let skip = 0;
      if (cursor) {
        try { skip = parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) || 0; } catch(e) { skip = 0; }
      }

      const result = await q.skip(skip).limit(limit).get();
      const items = (result.data || []).map(function(item) {
        return {
          session_id: item.event_id,
          external_session_id: item.event_id,
          event_group: {
            // Legacy single-session events predate event_group_id. Their event_id
            // is stable and unique, so use it as a safe group identity.
            external_group_id: item.event_group_id || item.event_id,
            title: item.name,
            event_date: item.event_date,
            activity_type: item.activity_type,
            org_unit_id: item.org_unit_id || "",
            study_org_unit_id: item.class_org_unit_id || null,
            lifecycle_status: lifecycleStatus(item),
            source_system: item.source_system || "MANUAL_ADMIN",
            source_event_id: item.source_event_id || "",
            source_revision: item.source_revision || ""
          },
          session_code: item.session_code || "MORNING",
          session_name: item.session_name || "",
          session_order: item.session_order || 0,
          checkin_start_at: item.checkin_start_at || "",
          scheduled_start_at: item.scheduled_start_at || "",
          scheduled_end_at: item.scheduled_end_at || "",
          checkin_end_at: item.checkin_end_at || "",
          status: item.status || "active",
          lifecycle_status: lifecycleStatus(item),
          source_system: item.source_system || "MANUAL_ADMIN",
          source_event_id: item.source_event_id || "",
          source_revision: item.source_revision || "",
          revision: 1,
          updated_at: item.created_at || ""
        };
      });

      const nextCursor = items.length === limit ? Buffer.from(String(skip + limit)).toString("base64") : null;
      return { statusCode: 200, headers: h, body: JSON.stringify({
        items: items,
        next_cursor: nextCursor,
        has_more: items.length === limit
      }) };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ detail: "查询失败: " + (e.message || "") }) };
    }
  }

  // ===== OPS API: INCREMENTAL RECORDS PULL =====
  if (p === "/ops/v1/attendance/records" && method === "GET") {
    if (!verifyOpsApiKey()) {
      return { statusCode: 401, headers: h, body: JSON.stringify({ detail: "API Key 无效" }) };
    }
    try {
      const session_id = String(query.session_id || "");
      const cursor = String(query.cursor || "");
      const limit = Math.min(parseInt(query.limit || "500", 10), 1000);

      if (!session_id) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ detail: "session_id is required" }) };
      }

      let q = db.collection("registrations")
        .where({ batch_id: session_id })
        .orderBy("created_at", "asc");

      let skip = 0;
      if (cursor) {
        try { skip = parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10) || 0; } catch(e) { skip = 0; }
      }

      const regResult = await q.skip(skip).limit(limit).get();
      const registrations = regResult.data || [];

      // Get checkins for these registrations
      const checkinMap = {};
      if (registrations.length > 0) {
        const checkins = await getAll("checkins", 5000, { batch_id: session_id });
        for (const ck of checkins) {
          const regId = String(ck.registration_id || "");
          if (regId) checkinMap[regId] = ck;
        }
      }

      const items = registrations.map(function(reg) {
        const ck = checkinMap[String(reg._id)] || null;
        const checkedIn = !!ck;
        return {
          external_record_id: String(reg._id),
          external_registration_id: String(reg._id),
          member_code: reg.member_code || "",
          name: reg.name || "",
          participant_type: "MEMBER",
          score_eligible: true,
          attendance_status: checkedIn ? "PRESENT" : (reg.attendance_status === "leave" ? "LEAVE" : "ABSENT"),
          checked_at: ck ? (ck.checked_at || "") : null,
          checkin_source: ck ? "QR" : null,
          revision: 1,
          updated_at: reg.created_at || ""
        };
      });

      const nextCursor = items.length === limit ? Buffer.from(String(skip + limit)).toString("base64") : null;
      return { statusCode: 200, headers: h, body: JSON.stringify({
        items: items,
        next_cursor: nextCursor,
        has_more: items.length === limit
      }) };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ detail: "查询失败: " + (e.message || "") }) };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "Not found" }) };
};
