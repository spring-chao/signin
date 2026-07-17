const assert = require("assert");
const Module = require("module");

function createDatabase(seed) {
  const collections = {};
  Object.keys(seed || {}).forEach(name => {
    collections[name] = seed[name].map(row => ({ ...row }));
  });
  let nextId = 1;

  function rowsFor(name) {
    if (!collections[name]) collections[name] = [];
    return collections[name];
  }

  function collection(name) {
    let filter = null;
    let offset = 0;
    let pageSize = Infinity;
    const query = {
      where(criteria) {
        filter = criteria;
        return query;
      },
      skip(value) {
        offset = value;
        return query;
      },
      limit(value) {
        pageSize = value;
        return query;
      },
      async get() {
        let rows = rowsFor(name);
        if (filter) rows = rows.filter(row => Object.keys(filter).every(key => row[key] === filter[key]));
        return { data: rows.slice(offset, offset + pageSize) };
      },
      async add(value) {
        const id = `${name}-${nextId++}`;
        rowsFor(name).push({ ...value, _id: id });
        return { id };
      },
      async update(value) {
        const rows = rowsFor(name).filter(row => !filter || Object.keys(filter).every(key => row[key] === filter[key]));
        rows.forEach(row => Object.assign(row, value));
        return { updated: rows.length };
      },
      doc(id) {
        return {
          async update(value) {
            const row = rowsFor(name).find(item => item._id === id);
            if (!row) throw new Error("document not found");
            Object.assign(row, value);
            return { updated: 1 };
          },
          async remove() {
            const index = rowsFor(name).findIndex(item => item._id === id);
            if (index >= 0) rowsFor(name).splice(index, 1);
            return { deleted: index >= 0 ? 1 : 0 };
          }
        };
      }
    };
    return query;
  }

  return { collection, collections };
}

const db = createDatabase({
  config: [
    { _id: "config-1", key: "event_name", value: "测试活动" },
    { _id: "config-2", key: "active_batch_id", value: "batch-1" }
  ],
  registrations: [
    { _id: "reg-1", batch_id: "batch-1", name: "陈一", phone: "13800000001", center: "", class_name: "一班", group_name: "一组", company: "甲公司" },
    { _id: "reg-2", batch_id: "batch-1", name: "李二", phone: "13800000002", center: "", class_name: "二班", group_name: "二组", company: "乙公司" }
  ],
  checkins: []
});

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@cloudbase/node-sdk") return { init: () => ({ database: () => db }) };
  return originalLoad.call(this, request, parent, isMain);
};
const api = require("../cloudfunc/index.js");
Module._load = originalLoad;

async function request(path, method, body, token) {
  const response = await api.main({
    path,
    httpMethod: method || "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? "" : JSON.stringify(body)
  });
  return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
}

(async () => {
  const login = await request("/admin_login", "POST", { password: "shenghe2024" });
  assert.equal(login.status, 200);
  assert.equal(login.data.ok, true);
  const token = login.data.token;

  const initial = await request("/stats", "GET", undefined, token);
  assert.equal(initial.data.group_field, "class_name", "没有分中心数据时应按班级分类");
  assert.equal(initial.data.pending, 2);

  const added = await request("/registration", "POST", {
    name: "王三",
    phone: "13800000003",
    center: "东莞分中心",
    class_name: "三班",
    group_name: "三组"
  }, token);
  assert.equal(added.data.ok, true);

  const duplicate = await request("/registration", "POST", {
    name: "王三",
    phone: "13800000003"
  }, token);
  assert.equal(duplicate.data.ok, false, "临时报名不应意外制造重复名额");

  const afterAdd = await request("/stats", "GET", undefined, token);
  assert.equal(afterAdd.data.total, 3);
  assert.equal(afterAdd.data.group_field, "center", "存在分中心数据时应优先按分中心分类");
  assert(afterAdd.data.not_checked.some(row => row.phone === "13800000003"), "未签到名单应返回电话跟进所需手机号");

  const late = await request("/attendance_status", "POST", {
    registration_id: "reg-1",
    status: "late",
    note: "预计十点到"
  }, token);
  assert.equal(late.data.ok, true);

  const lateStats = await request("/stats", "GET", undefined, token);
  assert.equal(lateStats.data.late, 1);
  assert.equal(lateStats.data.pending, 2);
  assert.equal(lateStats.data.not_checked.find(row => row.registration_id === "reg-1").attendance_note, "预计十点到");

  const checked = await request("/checkin", "POST", { name: "陈一", phone: "13800000001" });
  assert.equal(checked.data.ok, true);

  const checkedStats = await request("/stats", "GET", undefined, token);
  assert.equal(checkedStats.data.checked, 1);
  assert.equal(checkedStats.data.late, 0, "实际签到后不应继续计入迟到跟进人数");
  assert(!checkedStats.data.not_checked.some(row => row.registration_id === "reg-1"));

  const overwriteChecked = await request("/attendance_status", "POST", {
    registration_id: "reg-1",
    status: "leave"
  }, token);
  assert.equal(overwriteChecked.data.ok, false);
  assert.equal(overwriteChecked.data.checked, true, "已签到状态不得被人工请假覆盖");

  const leave = await request("/attendance_status", "POST", {
    registration_id: "reg-2",
    status: "leave",
    note: "临时有事"
  }, token);
  assert.equal(leave.data.ok, true);

  const exported = await request("/export", "POST", {}, token);
  assert.equal(exported.data.rows.find(row => row.phone === "13800000001").sign_status, "已签到");
  assert.equal(exported.data.rows.find(row => row.phone === "13800000002").sign_status, "请假");
  assert.equal(exported.data.rows.find(row => row.phone === "13800000002").attendance_note, "临时有事");

  console.log("checkin API regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
