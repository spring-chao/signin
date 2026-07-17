const cloudbase = require("@cloudbase/node-sdk");
const crypto = require("crypto");

const ADMIN_PASSWORD_HASH = "da40d101ff0a0f2d9aadf5ff9c2e7b1ec0f58896497f9ee518218bd910abc0af";
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

exports.main = async (event, context) => {
  const app = cloudbase.init({ env: "shengheshu-d2g2zyyl99f6c6fc2" });
  const db = app.database();
  const method = event.httpMethod || "GET";
  const p = event.path || "/";
  
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

  const protectedPaths = new Set(["/settings", "/registration", "/registration_delete", "/attendance_status", "/export", "/stats", "/upload_preview", "/upload", "/reset", "/clear_all"]);
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
    const groupField = ["center", "class_name", "group_name"].includes(payload.group_field) ? payload.group_field : "";
    if (!eventName || rows.length === 0) return { error: "活动名称和报名数据不能为空" };
    if (rows.length > 5000) return { error: "报名数据不能超过5000条" };

    const normalizedRows = [];
    const identityCounts = {};
    const restoreCheckins = payload.restore_checkins === true;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const cleanRow = {
        name: String(row.name || "").trim(),
        phone: String(row.phone || "").trim().replace(/\s/g, "").replace(/-/g, ""),
        center: String(row.center || "").trim(),
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
    return { eventName, groupField, normalizedRows, identityCounts, restoreCheckins };
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
        if (normalizeGroupValue(r[field])) fields[field]++;
      });
    });
    if (fields.center > 0) return { field: "center", label: definitions.center.label };
    if (fields.class_name > 0) return { field: "class_name", label: definitions.class_name.label };
    if (fields.group_name > 0) return { field: "group_name", label: definitions.group_name.label };
    return { field: "center", label: "分组" };
  }

  // ===== CHECKIN =====
  if (p === "/checkin" && method === "POST") {
    const name = (data.name || "").trim();
    const phone = (data.phone || "").trim().replace(/\s/g, "").replace(/-/g, "");
    if (!name || !phone) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入姓名和手机号" }) };
    if (phone.length !== 11 || !/^\d+$/.test(phone)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入正确的11位手机号" }) };
    try {
      const activeBatchId = await getConfig("active_batch_id", "");
      const currentRegistrations = await getActiveRows("registrations", 5000);
      const phoneRegistrations = currentRegistrations.filter(reg => String(reg.phone || "").trim().replace(/\s/g, "").replace(/-/g, "") === phone);
      if (phoneRegistrations.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到报名记录，请先确认是否已报名，或检查手机号是否正确" }) };
      const n1 = name.replace(/\s+/g, "").toLowerCase();
      const matchingRegs = phoneRegistrations.filter(function(reg) {
        return String(reg.name || "").trim().replace(/\s+/g, "").toLowerCase() === n1;
      });
      if (matchingRegs.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "姓名与报名时填写的不一致，请检查后重新输入" }) };

      const regName = String(matchingRegs[0].name || "").trim();
      const currentCheckins = await getActiveRows("checkins", 5000);
      const phoneCheckins = currentCheckins.filter(checkin => String(checkin.phone || "").trim().replace(/\s/g, "").replace(/-/g, "") === phone);
      const attendance = buildAttendanceState(matchingRegs, phoneCheckins);
      const remainingIndexes = matchingRegs.map((_, index) => index).filter(index => !attendance.checkedIndexes.has(index));
      const totalSlots = matchingRegs.length;
      const checkedSlots = totalSlots - remainingIndexes.length;
      const ds = await getDisplaySettings();
      const gf = detectGroupField(matchingRegs);

      function makeDisplayData(reg) {
        return {
          name: regName,
          phone,
          center: normalizeGroupValue(reg.center),
          class_name: normalizeGroupValue(reg.class_name),
          group_name: normalizeGroupValue(reg.group_name),
          group_type: gf.label,
          group_value: normalizeGroupValue(reg[gf.field]),
          company: reg.company || "",
          group_num: ds.show_group === "true" ? (reg.group_num || null) : null,
          dinner_table_num: ds.show_dinner_table === "true" ? (reg.dinner_table_num || null) : null,
          show_group: ds.show_group,
          show_dinner_table: ds.show_dinner_table,
          multi_total: totalSlots
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
        await db.collection("checkins").add({ registration_id: reg._id || "", name: String(reg.name || "").trim(), phone, center: normalizeGroupValue(reg.center), class_name: normalizeGroupValue(reg.class_name), group_name: normalizeGroupValue(reg.group_name), company: reg.company || "", group_num: reg.group_num || null, dinner_table_num: reg.dinner_table_num || null, batch_id: activeBatchId || "", checked_at: now });
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
      const eventName = await getConfig("event_name", "盛和塾签到");
      const ds = await getDisplaySettings();
      const regs = await getActiveRows("registrations", 5000);
      const total = regs.length;
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: "盛和塾签到", show_group: "true", show_dinner_table: "true", total: 0 }) };
    }
  }

  // ===== SETTINGS =====
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
        center: String(data.center || "").trim(),
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

      const activeBatchId = await getConfig("active_batch_id", "");
      const regs = await getActiveRows("registrations", 5000);
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

      const regs = await getActiveRows("registrations", 5000);
      const index = regs.findIndex(row => String(row._id || "") === registrationId);
      if (index < 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到当前活动的报名记录" }) };
      const cks = await getActiveRows("checkins", 5000);
      if (buildAttendanceState(regs, cks).checkedIndexes.has(index)) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, checked: true, msg: "该学长已经签到，不能删除报名记录" }) };
      }

      const registration = regs[index];
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

      const regs = await getActiveRows("registrations", 5000);
      const index = regs.findIndex(row => String(row._id || "") === registrationId);
      if (index < 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到当前活动的报名记录" }) };
      const cks = await getActiveRows("checkins", 5000);
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
      const regs = await getActiveRows("registrations", 5000);
      const cks = await getActiveRows("checkins", 5000);
      const attendance = buildAttendanceState(regs, cks);
      // Build export rows: all registrations with check-in status
      const rows = regs.map(function(r, index) {
        var ck = attendance.checkinByIndex.get(index);
        return {
          name: r.name || "",
          phone: r.phone || "",
          company: r.company || "",
          center: normalizeGroupValue(r.center),
          class_name: normalizeGroupValue(r.class_name),
          group_name: normalizeGroupValue(r.group_name),
          group_num: r.group_num || "",
          dinner_table_num: r.dinner_table_num || "",
          sign_status: ck ? "已签到" : attendanceStatusLabel(r.attendance_status),
          sign_time: ck ? (ck.checked_at || "") : "",
          attendance_note: ck ? "" : (r.attendance_note || "")
        };
      });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, rows: rows }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "导出失败: " + (e.message || "") }) };
    }
  }

  // ===== STATS =====
  if (p === "/stats" && method === "GET") {
    try {
      const eventName = await getConfig("event_name", "盛和塾签到");
      const ds = await getDisplaySettings();
      const regs = await getActiveRows("registrations", 5000);
      const cks = await getActiveRows("checkins", 5000);
      const attendance = buildAttendanceState(regs, cks);
      const total = regs.length;
      const checked = attendance.checkedIndexes.size;
      const rate = total > 0 ? Math.round(checked / total * 1000) / 10 : 0;
      const gf = detectGroupField(regs);
      const groups = {};
      regs.forEach((a, index) => {
        const gv = normalizeGroupValue(a[gf.field]) || "未知";
        if (!groups[gv]) groups[gv] = { total: 0, checked: 0 };
        groups[gv].total++;
        if (attendance.checkedIndexes.has(index)) groups[gv].checked++;
      });
      const nc = regs.filter((a, index) => !attendance.checkedIndexes.has(index)).map(a => ({
        registration_id: a._id || "",
        name: a.name,
        phone: a.phone || "",
        center: normalizeGroupValue(a.center),
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
      const rc = cks.sort((a, b) => (b.checked_at || "").localeCompare(a.checked_at || "")).slice(0, 20).map(r => ({ name: r.name, center: normalizeGroupValue(r.center), class_name: normalizeGroupValue(r.class_name), group_name: normalizeGroupValue(r.group_name), company: r.company || "", group_num: r.group_num || null, dinner_table_num: r.dinner_table_num || null, checked_at: r.checked_at }));
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total, checked, rate, pending: followUp.pending, late: followUp.late, leave: followUp.leave, group_field: gf.field, group_type: gf.label, groups, not_checked: nc, recent: rc }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ total: 0, checked: 0, rate: 0, pending: 0, late: 0, leave: 0, group_type: "分组", groups: {}, not_checked: [], recent: [] }) };
    }
  }

  // ===== ADMIN UPLOAD PREVIEW =====
  if (p === "/upload_preview" && method === "POST") {
    try {
      const upload = normalizeUploadPayload(data);
      if (upload.error) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: upload.error }) };
      const oldRegs = await getActiveRows("registrations", 5000);
      const oldCks = await getActiveRows("checkins", 5000);
      const oldEventName = await getConfig("event_name", "盛和塾签到");
      const activeBatchId = await getConfig("active_batch_id", "");
      const changes = compareIdentityCounts(countIdentities(oldRegs), upload.identityCounts);
      const counts = Object.values(upload.identityCounts);
      const repeatedSlots = counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const duplicateGroups = counts.filter(count => count > 1).length;
      const oldChecked = buildAttendanceState(oldRegs, oldCks).checkedIndexes.size;
      const restoredCheckins = upload.normalizedRows.filter(row => row.restore_checked_at).length;
      const issuedAt = Date.now();
      const previewToken = await signUploadPreview(upload, activeBatchId, activeRegistrationFingerprint(oldRegs), issuedAt);
      return { statusCode: 200, headers: h, body: JSON.stringify({
        ok: true,
        old_event_name: oldEventName,
        new_event_name: upload.eventName,
        event_changed: oldEventName !== upload.eventName,
        old_total: oldRegs.length,
        new_total: upload.normalizedRows.length,
        added: changes.added,
        removed: changes.removed,
        duplicate_groups: duplicateGroups,
        repeated_slots: repeatedSlots,
        old_checked: oldChecked,
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
    const { eventName, groupField, normalizedRows, identityCounts } = upload;
    const oldBatchId = await getConfig("active_batch_id", "");
    const activeRegsAtConfirmation = await getActiveRows("registrations", 5000);
    const previewIssuedAt = Number(data.preview_issued_at);
    if (!(await verifyUploadPreview(upload, oldBatchId, activeRegistrationFingerprint(activeRegsAtConfirmation), previewIssuedAt, data.preview_token))) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, needs_preview: true, msg: "名单或预览已发生变化，请重新核对变更后再导入" }) };
    }
    const batchId = Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
    const oldRegs = await getAll("registrations", 5000);
    const oldCks = await getAll("checkins", 5000);
    const oldEventName = await getConfig("event_name", "盛和塾签到");
    const oldGroupField = await getConfig("group_field", "");
    const stagedDocs = [];
    const stagedCheckinDocs = [];
    try {
      for (const row of normalizedRows) {
        const { restore_checked_at: restoreCheckedAt, ...registrationData } = row;
        const result = await db.collection("registrations").add({ ...registrationData, batch_id: batchId });
        stagedDocs.push({ _id: result.id || result._id });
        if (restoreCheckedAt) {
          const checkinResult = await db.collection("checkins").add({ registration_id: result.id || result._id || "", name: row.name, phone: row.phone, center: normalizeGroupValue(row.center), class_name: normalizeGroupValue(row.class_name), group_name: normalizeGroupValue(row.group_name), company: row.company, group_num: row.group_num, dinner_table_num: row.dinner_table_num, batch_id: batchId, checked_at: restoreCheckedAt });
          stagedCheckinDocs.push({ _id: checkinResult.id || checkinResult._id });
        }
      }
      await setConfig("event_name", eventName);
      await setConfig("group_field", groupField);
      await setConfig("active_batch_id", batchId);

      // 切换成功后再清理旧批次；即使清理失败，读取也只会命中新批次。
      await deleteDocs("registrations", oldRegs);
      await deleteDocs("checkins", oldCks);
      const repeatedSlots = Object.values(identityCounts).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const repeatMessage = repeatedSlots ? "，其中多人共用姓名和手机号的额外名额 " + repeatedSlots + " 个" : "";
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event_name: eventName, repeated_slots: repeatedSlots, restored_checkins: stagedCheckinDocs.length, msg: "上传成功，共导入 " + normalizedRows.length + " 条记录" + repeatMessage }) };
    } catch (e) {
      try {
        const stagedByBatch = await getAll("registrations", 5000, { batch_id: batchId });
        const stagedCheckinsByBatch = await getAll("checkins", 5000, { batch_id: batchId });
        await deleteDocs("registrations", stagedByBatch.length ? stagedByBatch : stagedDocs);
        await deleteDocs("checkins", stagedCheckinsByBatch.length ? stagedCheckinsByBatch : stagedCheckinDocs);
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
      const delCks = await deleteAll("checkins");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到记录已清空（" + delCks + "条）" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  // ===== CLEAR ALL =====
  if (p === "/clear_all" && method === "POST") {
    try {
      const delRegs = await deleteAll("registrations");
      const delCks = await deleteAll("checkins");
      await setConfig("event_name", "盛和塾签到");
      await setConfig("group_field", "");
      await setConfig("active_batch_id", "");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "全部数据已清空（报名" + delRegs + "条，签到" + delCks + "条）" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "Not found" }) };
};
