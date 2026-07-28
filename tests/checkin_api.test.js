const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

const TEST_ADMIN_PASSWORD = "test-admin-password!";
process.env.ADMIN_PASSWORD_HASH = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD).digest("hex");

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
    let sortField = null;
    let sortDirection = "asc";
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
      orderBy(field, direction) {
        sortField = field;
        sortDirection = direction === "desc" ? "desc" : "asc";
        return query;
      },
      async get() {
        let rows = rowsFor(name);
        if (filter) rows = rows.filter(row => Object.keys(filter).every(key => row[key] === filter[key]));
        if (sortField) {
          rows = [...rows].sort((a, b) => {
            const result = String(a[sortField] || "").localeCompare(String(b[sortField] || ""));
            return sortDirection === "desc" ? -result : result;
          });
        }
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

async function request(path, method, body, token, extraHeaders) {
  const [pathname, search = ""] = path.split("?");
  const queryStringParameters = Object.fromEntries(new URLSearchParams(search));
  const response = await api.main({
    path: pathname,
    queryStringParameters,
    httpMethod: method || "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {})
    },
    body: body === undefined ? "" : JSON.stringify(body)
  });
  return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
}

(async () => {
  const login = await request("/admin_login", "POST", { password: TEST_ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.data.ok, true);
  const token = login.data.token;

  const initial = await request("/stats", "GET", undefined, token);
  assert.equal(initial.data.group_field, "class_name", "没有分中心数据时应按班级分类");
  assert.equal(initial.data.pending, 2);
  const singlePublicEvent = await request("/event", "GET");
  assert.equal(singlePublicEvent.data.event_name, "测试活动", "只有一个开放活动时扫码页应显示活动名称");

  const added = await request("/registration", "POST", {
    name: "王三",
    phone: "13800000003",
    center: "园区",
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
  assert.equal(afterAdd.data.groups["园区分中心"].total, 1, "分中心简称应归一为标准名称");
  assert(!afterAdd.data.groups["园区"]);
  assert.equal(afterAdd.data.not_checked.find(row => row.phone === "13800000003").center, "园区分中心");
  assert(afterAdd.data.not_checked.some(row => row.phone === "13800000003"), "未签到名单应返回电话跟进所需手机号");

  const typo = await request("/registration", "POST", {
    name: "名字填错",
    phone: "13800000004",
    center: "工业园区"
  }, token);
  assert.equal(typo.data.ok, true);
  const fuzzyCenter = await request("/stats", "GET", undefined, token);
  assert.equal(fuzzyCenter.data.groups["园区分中心"].total, 2, "模糊分中心写法不应拆成两个分类");
  const deleted = await request("/registration_delete", "POST", {
    registration_id: typo.data.registration_id
  }, token);
  assert.equal(deleted.data.ok, true, "尚未签到的错误报名应允许删除");
  const afterDelete = await request("/stats", "GET", undefined, token);
  assert.equal(afterDelete.data.total, 3);
  assert(!afterDelete.data.not_checked.some(row => row.phone === "13800000004"));

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

  const deleteChecked = await request("/registration_delete", "POST", {
    registration_id: "reg-1"
  }, token);
  assert.equal(deleteChecked.data.ok, false);
  assert.equal(deleteChecked.data.checked, true, "已签到报名不得删除");

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

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  db.collections.events.push({ _id: "event-2", event_id: "batch-2", name: "同日班会", event_date: today, activity_type: "class_meeting", status: "active" });
  db.collections.registrations.push({ _id: "reg-5", batch_id: "batch-2", name: "陈一", phone: "13800000001", center: "", class_name: "一班", group_name: "一组" });
  const multiplePublicEvents = await request("/event", "GET");
  assert.equal(multiplePublicEvents.data.event_name, "盛和塾活动签到");
  assert.equal(multiplePublicEvents.data.active_events.length, 2, "多个开放活动时扫码页应返回活动名称列表");
  const multiEvent = await request("/checkin", "POST", { name: "陈一", phone: "13800000001" });
  assert.equal(multiEvent.data.needs_event, true, "同一人命中多个开放活动时应要求选择活动");
  assert.equal(multiEvent.data.events.length, 2);
  const selectedEvent = await request("/checkin", "POST", { name: "陈一", phone: "13800000001", event_id: "batch-2" });
  assert.equal(selectedEvent.data.ok, true);
  assert.equal(selectedEvent.data.data.event.activity_type, "class_meeting");
  assert(db.collections.checkins.some(row => row.batch_id === "batch-2"), "签到记录必须写入选中的活动");

  const eventList = await request("/admin_events", "GET", undefined, token);
  assert.equal(eventList.data.events.length, 2);
  const secondStats = await request("/stats?event_id=batch-2", "GET", undefined, token);
  assert.equal(secondStats.data.total, 1);
  assert.equal(secondStats.data.checked, 1);
  assert.equal(secondStats.data.group_field, "group_name", "班会活动应按小组分类");
  assert.equal(secondStats.data.group_type, "小组");
  assert.equal(secondStats.data.groups["一组"].total, 1);

  db.collections.events.find(row => row.event_id === "batch-2").status = "closed";
  const addToClosedEvent = await request("/registration", "POST", {
    event_id: "batch-2", name: "关闭活动测试", phone: "13800000009"
  }, token);
  assert.equal(addToClosedEvent.data.ok, false, "临时报名不得加入已关闭签到的活动");

  db.collections.events.push({ _id: "event-3", event_id: "batch-3", name: "未来课程", event_date: "2099-01-01", activity_type: "course", status: "active", checkin_start_at: "2099-01-01T00:00:00.000Z", checkin_end_at: "2099-01-01T12:00:00.000Z" });
  db.collections.registrations.push({ _id: "reg-6", batch_id: "batch-3", name: "未来学员", phone: "13800000008" });
  const earlyCheckin = await request("/checkin", "POST", { name: "未来学员", phone: "13800000008" });
  assert.equal(earlyCheckin.data.ok, false, "未到签到开始时间不得签到");
  const earlyRegistration = await request("/registration", "POST", { event_id: "batch-3", name: "临时学员", phone: "13800000007" }, token);
  assert.equal(earlyRegistration.data.ok, false, "未到签到开始时间不得新增临时报名");

  const deleteCurrentEvent = await request("/clear_all", "POST", { event_id: "batch-2" }, token);
  assert.equal(deleteCurrentEvent.data.ok, true);
  assert(!db.collections.events.some(row => row.event_id === "batch-2"), "只应删除指定的当前活动");
  assert(!db.collections.registrations.some(row => row.batch_id === "batch-2"));
  assert(!db.collections.checkins.some(row => row.batch_id === "batch-2"));
  assert(db.collections.events.some(row => row.event_id === "batch-1"), "其他活动必须保留");
  assert(db.collections.registrations.some(row => row.batch_id === "batch-1"), "其他活动报名必须保留");

  const previousApiKey = process.env.SIGNIN_SERVICE_API_KEY;
  process.env.SIGNIN_SERVICE_API_KEY = "test-ops-api-key";
  const unauthorizedSessions = await request("/ops/v1/attendance/sessions", "GET");
  assert.equal(unauthorizedSessions.status, 401, "运营拉取接口必须在缺少 API Key 时拒绝访问");

  const createdSessions = await request("/create_class_meeting_sessions", "POST", {
    token,
    event_date: today,
    event_name: "三场次测试班会",
    org_unit_id: "center-1",
    class_org_unit_id: "class-1",
    roster_members: [{
      member_code: "M0001",
      name: "测试学员",
      phone: "13800000010",
      class_name: "测试班",
      group_name: "测试组"
    }]
  });
  assert.equal(createdSessions.data.ok, true);
  assert.equal(createdSessions.data.events.length, 3, "班会必须创建上午、下午和空巴三个场次");
  assert.equal(
    db.collections.registrations.filter(row => row.event_group_id === createdSessions.data.event_group_id).length,
    3,
    "同一份名单必须复制到三个签到场次"
  );

  const authorizedSessions = await request(
    "/ops/v1/attendance/sessions?limit=2",
    "GET",
    undefined,
    undefined,
    { "x-api-key": "test-ops-api-key" }
  );
  assert.equal(authorizedSessions.status, 200);
  assert.equal(authorizedSessions.data.items.length, 2);
  assert.equal(authorizedSessions.data.has_more, true);
  assert(authorizedSessions.data.next_cursor, "达到分页上限时必须返回下一页游标");

  const firstCreatedSession = createdSessions.data.events[0];
  const authorizedRecords = await request(
    `/ops/v1/attendance/records?session_id=${firstCreatedSession.event_id}`,
    "GET",
    undefined,
    undefined,
    { "x-api-key": "test-ops-api-key" }
  );
  assert.equal(authorizedRecords.status, 200);
  assert.equal(authorizedRecords.data.items.length, 1);
  assert.equal(authorizedRecords.data.items[0].member_code, "M0001");
  assert.equal(authorizedRecords.data.items[0].attendance_status, "ABSENT");
  if (previousApiKey === undefined) delete process.env.SIGNIN_SERVICE_API_KEY;
  else process.env.SIGNIN_SERVICE_API_KEY = previousApiKey;

  const configuredAdminHash = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  const unsafeLogin = await request("/admin_login", "POST", { password: TEST_ADMIN_PASSWORD });
  assert.equal(unsafeLogin.status, 503, "未安全配置管理员口令时必须失败关闭");
  process.env.ADMIN_PASSWORD_HASH = configuredAdminHash;

  for (let attempt = 0; attempt < 5; attempt++) {
    const failedLogin = await request("/admin_login", "POST", { password: "wrong-password" });
    assert.equal(failedLogin.status, 401);
  }
  const rateLimitedLogin = await request("/admin_login", "POST", { password: "wrong-password" });
  assert.equal(rateLimitedLogin.status, 429, "连续登录失败必须触发限流");

  console.log("checkin API regression tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
