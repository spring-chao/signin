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

  // ===== CHECKIN =====
  if (p === "/checkin" && method === "POST") {
    const name = (data.name || "").trim();
    const phone = (data.phone || "").trim().replace(/\s/g, "").replace(/-/g, "");
    if (!name || !phone) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入姓名和手机号" }) };
    if (phone.length !== 11 || !/^\d+$/.test(phone)) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "请输入正确的11位手机号" }) };
    try {
      const regRes = await db.collection("registrations").where({ phone }).get();
      if (regRes.data.length === 0) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "手机号未在报名名单中" }) };
      const reg = regRes.data[0];
      const regName = (reg.name || "").trim();
      const n1 = name.replace(/\s+/g, "").toLowerCase();
      const n2 = regName.replace(/\s+/g, "").toLowerCase();
      if (n1 !== n2) return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "姓名与报名信息不符" }) };
      
      const existing = await db.collection("checkins").where({ phone, name: regName }).get();
      if (existing.data.length > 0) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, already: true, msg: "您已签到过", data: { name: regName, phone, center: reg.center || "", company: reg.company || "", checked_at: existing.data[0].checked_at || "" } }) };
      }
      
      const now = new Date().toISOString();
      await db.collection("checkins").add({ name: regName, phone, center: reg.center || "", company: reg.company || "", checked_at: now });
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到成功", data: { name: regName, phone, center: reg.center || "", company: reg.company || "", checked_at: now } }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "签到失败: " + (e.message || "") }) };
    }
  }

  // ===== EVENT INFO =====
  if (p === "/event" && method === "GET") {
    try {
      const c = await db.collection("config").where({ key: "event_name" }).get();
      const n = await db.collection("registrations").count();
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: c.data.length > 0 ? c.data[0].value : "盛和塾签到", total: n.total }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: "盛和塾签到", total: 0 }) };
    }
  }

  // ===== STATS =====
  if (p === "/stats" && method === "GET") {
    try {
      const c = await db.collection("config").where({ key: "event_name" }).get();
      const regs = await db.collection("registrations").limit(2000).get();
      const cks = await db.collection("checkins").limit(2000).get();
      const phones = new Set(cks.data.map(x => x.phone));
      const total = regs.data.length, checked = phones.size, rate = total > 0 ? Math.round(checked / total * 1000) / 10 : 0;
      const centers = {};
      regs.data.forEach(a => { const cc = a.center || "未知"; if (!centers[cc]) centers[cc] = { total: 0, checked: 0 }; centers[cc].total++; if (phones.has(a.phone)) centers[cc].checked++; });
      const nc = regs.data.filter(a => !phones.has(a.phone)).map(a => ({ name: a.name, center: a.center || "", company: a.company || "" }));
      const rc = cks.data.sort((a, b) => (b.checked_at || "").localeCompare(a.checked_at || "")).slice(0, 20).map(r => ({ name: r.name, center: r.center || "", company: r.company || "", checked_at: r.checked_at }));
      return { statusCode: 200, headers: h, body: JSON.stringify({ event_name: c.data.length > 0 ? c.data[0].value : "盛和塾签到", total, checked, rate, centers, not_checked: nc, recent: rc }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ total: 0, checked: 0, rate: 0, centers: {}, not_checked: [], recent: [] }) };
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
      const ec = await db.collection("config").where({ key: "event_name" }).get();
      if (ec.data.length > 0) {
        await db.collection("config").where({ key: "event_name" }).update({ value: eventName });
      } else {
        await db.collection("config").add({ key: "event_name", value: eventName });
      }
      // Delete old data
      const oldRegs = await db.collection("registrations").limit(2000).get();
      for (const r of oldRegs.data) { try { await db.collection("registrations").doc(r._id).remove(); } catch(e) {} }
      const oldCks = await db.collection("checkins").limit(2000).get();
      for (const ck of oldCks.data) { try { await db.collection("checkins").doc(ck._id).remove(); } catch(e) {} }
      // Insert new
      for (const row of rows) {
        if (row.name && row.phone) {
          await db.collection("registrations").add({ name: row.name, phone: row.phone, center: row.center || "", company: row.company || "" });
        }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, event_name: eventName, msg: "上传成功，共导入 " + rows.length + " 条记录" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "上传失败: " + (e.message || "") }) };
    }
  }

  // ===== RESET CHECKINS =====
  if (p === "/reset" && method === "POST") {
    try {
      const oldCks = await db.collection("checkins").limit(2000).get();
      for (const ck of oldCks.data) { try { await db.collection("checkins").doc(ck._id).remove(); } catch(e) {} }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "签到记录已清空" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  // ===== CLEAR ALL =====
  if (p === "/clear_all" && method === "POST") {
    try {
      const oldRegs = await db.collection("registrations").limit(2000).get();
      for (const r of oldRegs.data) { try { await db.collection("registrations").doc(r._id).remove(); } catch(e) {} }
      const oldCks = await db.collection("checkins").limit(2000).get();
      for (const ck of oldCks.data) { try { await db.collection("checkins").doc(ck._id).remove(); } catch(e) {} }
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, msg: "全部数据已清空" }) };
    } catch (e) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "操作失败: " + (e.message || "") }) };
    }
  }

  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: false, msg: "Not found" }) };
};
