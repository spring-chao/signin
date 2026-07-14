const cloudbase = require("@cloudbase/node-sdk");

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

  async function getAll(collectionName, maxTotal) {
    const BATCH = 100; const all = [];
    while (all.length < (maxTotal || 5000)) {
      const batch = await db.collection(collectionName).skip(all.length).limit(BATCH).get();
      if (!batch.data || batch.data.length === 0) break;
      all.push(...batch.data);
      if (batch.data.length < BATCH) break;
    }
    return all;
  }

  async function getDisplaySettings() {
    return {
      show_group: await getConfig("show_group", "true"),
      show_dinner_table: await getConfig("show_dinner_table", "true")
    };
  }

  function detectGroupField(regs) {
    var fields = { center: 0, class_name: 0 };
    regs.forEach(function(r) {
      if (r.center && r.center.trim()) fields.center++;
      if (r.class_name && r.class_name.trim()) fields.class_name++;
    });
    if (fields.center > 0) return { field: "center", label: "分中心" };
    if (fields.class_name > 0) return { field: "class_name", label: "班级" };
    return { field: "center", label: "分组" };
  }

  // ===== CHECKIN =====
  if (p === "/checkin" && method === "POST") {
    const name = (data.name || "").trim();
    const phone = (data.phone || "").trim().replace(/\s/g, "").replace(/-/g, "");
    if (!name || !phone) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入姓名和手机号" }) };
    if (phone.length !== 11 || !/^\d+$/.test(phone)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入正确的11位手机号" }) };
    try {
      const regRes = await db.collection("registrations").where({ phone }).get();
      if (regRes.data.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "未找到报名记录，请先确认是否已报名，或检查手机号是否正确" }) };
      let reg = null;
      const n1 = name.replace(/\s+/g, "").toLowerCase();
      for (const r of regRes.data) {
        const rn = (r.name || "").trim().replace(/\s+/g, "").toLowerCase();
        if (rn === n1) { reg = r; break; }
      }
      if (!reg) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "姓名与报名时填写的不一致，请检查后重新输入" }) };
      
      const regName = (reg.name || "").trim();
      const existing = await db.collection("checkins").where({ phone, name: regName }).get();
      const ds = await getDisplaySettings();
      if (existing.data.length > 0) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, already: true, msg: "您已签到过", data: { name: regName, phone, center: reg.center || "", class_name: reg.class_name || "", company: reg.company || "", group_num: ds.show_group === "true" ? (reg.group_num || null) : null, dinner_table_num: ds.show_dinner_table === "true" ? (reg.dinner_table_num || null) : null, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, checked_at: existing.data[0].checked_at || "" } }) };
      }
      
      const now = new Date().toISOString();
      await db.collection("checkins").add({ name: regName, phone, center: reg.center || "", class_name: reg.class_name || "", company: reg.company || "", group_num: reg.group_num || null, dinner_table_num: reg.dinner_table_num || null, checked_at: now });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到成功", data: { name: regName, phone, center: reg.center || "", class_name: reg.class_name || "", company: reg.company || "", group_num: ds.show_group === "true" ? (reg.group_num || null) : null, dinner_table_num: ds.show_dinner_table === "true" ? (reg.dinner_table_num || null) : null, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, checked_at: now } }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "签到失败: " + (e.message || "") }) };
    }
  }

  // ===== EVENT INFO =====
  if (p === "/event" && method === "GET") {
    try {
      const eventName = await getConfig("event_name", "盛和塾签到");
      const ds = await getDisplaySettings();
      const n = await db.collection("registrations").count();
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total: n.total }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: "盛和塾签到", show_group: "true", show_dinner_table: "true", total: 0 }) };
    }
  }

  // ===== SETTINGS =====
  if (p === "/settings" && method === "POST") {
    const pwd = data.password || "";
    if (pwd !== "shenghe2024") return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "密码错误" }) };
    try {
      if (data.show_group !== undefined) await setConfig("show_group", data.show_group ? "true" : "false");
      if (data.show_dinner_table !== undefined) await setConfig("show_dinner_table", data.show_dinner_table ? "true" : "false");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "设置已保存" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "保存失败: " + (e.message || "") }) };
    }
  }

  // ===== EXPORT =====
  if (p === "/export" && method === "POST") {
    const pwd = data.password || "";
    if (pwd !== "shenghe2024") return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "密码错误" }) };
    try {
      const regs = await getAll("registrations", 5000);
      const cks = await getAll("checkins", 5000);
      const phoneMap = {};
      cks.forEach(function(c) { phoneMap[c.phone] = c; });
      // Build export rows: all registrations with check-in status
      const rows = regs.map(function(r) {
        var ck = phoneMap[r.phone];
        return {
          name: r.name || "",
          phone: r.phone || "",
          company: r.company || "",
          center: r.center || "",
          class_name: r.class_name || "",
          group_num: r.group_num || "",
          dinner_table_num: r.dinner_table_num || "",
          sign_status: ck ? "已签到" : "未签到",
          sign_time: ck ? (ck.checked_at || "") : ""
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
      const regs = await getAll("registrations", 5000);
      const cks = await getAll("checkins", 5000);
      const phones = new Set(cks.map(x => x.phone));
      const total = regs.length, checked = phones.size, rate = total > 0 ? Math.round(checked / total * 1000) / 10 : 0;
      const gf = detectGroupField(regs);
      const groups = {};
      regs.forEach(a => {
        const gv = a[gf.field] || "未知";
        if (!groups[gv]) groups[gv] = { total: 0, checked: 0 };
        groups[gv].total++;
        if (phones.has(a.phone)) groups[gv].checked++;
      });
      const nc = regs.filter(a => !phones.has(a.phone)).map(a => ({ name: a.name, center: a.center || "", class_name: a.class_name || "", company: a.company || "" }));
      const rc = cks.sort((a, b) => (b.checked_at || "").localeCompare(a.checked_at || "")).slice(0, 20).map(r => ({ name: r.name, center: r.center || "", class_name: r.class_name || "", company: r.company || "", group_num: r.group_num || null, dinner_table_num: r.dinner_table_num || null, checked_at: r.checked_at }));
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: eventName, show_group: ds.show_group, show_dinner_table: ds.show_dinner_table, total, checked, rate, group_type: gf.label, groups, not_checked: nc, recent: rc }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ total: 0, checked: 0, rate: 0, group_type: "分组", groups: {}, not_checked: [], recent: [] }) };
    }
  }

  // ===== ADMIN UPLOAD =====
  if (p === "/upload" && method === "POST") {
    const pwd = data.password || "";
    if (pwd !== "shenghe2024") return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "密码错误" }) };
    const rows = data.attendees || [];
    const eventName = data.event_name || "";
    if (!eventName || rows.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "活动名称和报名数据不能为空" }) };
    try {
      await setConfig("event_name", eventName);
      const delRegs = await deleteAll("registrations");
      const delCks = await deleteAll("checkins");
      let inserted = 0;
      for (const row of rows) {
        if (row.name && row.phone) {
          await db.collection("registrations").add({ name: row.name, phone: row.phone, center: row.center || "", class_name: row.class_name || "", company: row.company || "", group_num: row.group_num || null, dinner_table_num: row.dinner_table_num || null });
          inserted++;
        }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event_name: eventName, msg: "上传成功，共导入 " + inserted + " 条记录" }) };
    } catch (e) {
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
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "全部数据已清空（报名" + delRegs + "条，签到" + delCks + "条）" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "Not found" }) };
};
