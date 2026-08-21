const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

const TEST_ADMIN_PASSWORD = "test-admin-password!";
process.env.ADMIN_PASSWORD_HASH = crypto.createHash("sha256").update(TEST_ADMIN_PASSWORD).digest("hex");
const TEST_TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

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
  checkins: [],
  events: [{
    _id: "event-1",
    event_id: "batch-1",
    name: "测试活动",
    event_date: TEST_TODAY,
    activity_type: "course",
    status: "active",
    lifecycle_status: "CONFIRMED"
  }]
});

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@cloudbase/node-sdk") return { init: () => ({ database: () => db }) };
  return originalLoad.call(this, request, parent, isMain);
};
const api = require("../cloudfunc/index.js");
Module._load = originalLoad;

assert.deepEqual(
  api._test.buildOpsRosterParams(
    { center: "总中心直属", class_name: "先锋班" },
    "class"
  ),
  { class_org_unit_id: "", group_org_unit_id: "" },
  "名单查询不得再用分中心或班级名称拼接参数"
);
assert.deepEqual(
  api._test.buildOpsRosterParams(
    { class_org_unit_id: "class-1", group_org_unit_id: "group-1" },
    "group"
  ),
  { class_org_unit_id: "class-1", group_org_unit_id: "group-1" },
  "新运营接口仍应支持组织 ID 参数"
);
assert.deepEqual(
  api._test.buildOpsRosterParams(
    {
      class_org_unit_id: "class-1",
      class_name: "圆融一班",
      center: "园区分中心"
    },
    "class"
  ),
  { class_org_unit_id: "class-1", group_org_unit_id: "" },
  "新平台同时返回组织 ID 和名称时必须优先使用组织 ID"
);
assert.equal(
  api._test.readableOpsError(
    {
      detail: [
        { loc: ["query", "center"], msg: "Field required" },
        { loc: ["query", "class_name"], msg: "Field required" }
      ]
    },
    "读取失败"
  ),
  "center：Field required；class_name：Field required",
  "结构化校验错误不应显示成 [object Object]"
);
assert.equal(
  api._test.normalizeOpsRosterData({
    data: { members: [{ name: "测试学员" }], version: { source_version: "v1" } }
  }).members.length,
  1,
  "旧运营接口的 data.members 名单应被正确读取"
);
assert.equal(
  api._test.normalizeOpsRosterData({
    data: [{ name: "测试学员" }]
  }).members.length,
  1,
  "新运营接口的 data 数组名单应保持兼容"
);
assert.equal(
  api._test.normalizeOpsRosterOptions({
    success: true,
    data: { classes: [{ id: "class-1" }], groups: [] }
  }).classes.length,
  1,
  "运营名单选项应兼容 data 包装"
);
const validRosterOptions = {
  success: true,
  data: {
    source: "PLATFORM_ORG_RELATIONS",
    query_mode: "ORG_UNIT_ID",
    fallback_mode: "FAIL_CLOSED",
    classes: [{ id: "class-1", member_count: 1 }],
    groups: [{ id: "group-1", parent_id: "class-1", member_count: 1 }],
    special_cohorts: []
  }
};
assert.equal(
  api._test.validateOpsRosterOptions(validRosterOptions).groups.length,
  1,
  "统一平台名单选项应通过组织层级校验"
);
assert.throws(
  () => api._test.validateOpsRosterOptions({
    success: true,
    data: {
      source: "PLATFORM_ORG_RELATIONS",
      query_mode: "ORG_UNIT_ID",
      fallback_mode: "FAIL_CLOSED",
      classes: [{ id: "class-1" }],
      groups: [{ id: "group-1", parent_id: "other-class" }]
    }
  }),
  /小组班级归属校验失败/,
  "小组与班级归属不一致时必须停止使用名单"
);
const validRosterMembers = {
  success: true,
  data: {
    source: "PLATFORM_ORG_RELATIONS",
    query_mode: "ORG_UNIT_ID",
    fallback_mode: "FAIL_CLOSED",
    member_count: 1,
    scope: {
      relation_type: "STUDY_GROUP",
      org_unit_id: "group-1",
      class_org_unit_id: "class-1"
    },
    members: [{
      member_code: "M0001",
      relation_type: "STUDY_GROUP",
      relation_org_id: "group-1"
    }]
  }
};
assert.equal(
  api._test.validateOpsRosterData(validRosterMembers, {
    class_org_unit_id: "class-1",
    group_org_unit_id: "group-1"
  }).members.length,
  1,
  "名单数量和组织归属一致时应允许导入"
);
assert.throws(
  () => api._test.validateOpsRosterData({
    ...validRosterMembers,
    data: { ...validRosterMembers.data, member_count: 2 }
  }, {
    class_org_unit_id: "class-1",
    group_org_unit_id: "group-1"
  }),
  /名单数量校验失败/,
  "接口数量与返回名单不一致时必须停止导入"
);
const sharedPhoneRoster = api._test.validateClassMeetingRoster([
  { name: "本人", phone: "13800000011" },
  { name: "代报名员工", phone: "13800000011" }
]);
assert.equal(sharedPhoneRoster.passed, true, "共用联系电话不能阻断班会名单创建");
assert.equal(sharedPhoneRoster.shared_phone_member_count, 2, "应记录共用联系电话人数供后台提示");
const invalidPhoneRoster = api._test.validateClassMeetingRoster([
  { name: "缺手机号", phone: "" },
  { name: "格式错误", phone: "23800000012" }
]);
assert.equal(invalidPhoneRoster.passed, false, "缺失或非法手机号必须阻断班会名单");
assert.equal(invalidPhoneRoster.missing_phone_count, 1);
assert.equal(invalidPhoneRoster.invalid_phone_count, 1);
assert.equal(
  api._test.isScheduledAttendanceSyncEvent({
    Type: "Timer",
    TriggerName: "attendanceSyncWeekdays0000"
  }),
  true,
  "只允许指定的工作日零点触发器启动平台同步"
);
assert.equal(
  api._test.validateRosterIntegrity({
    success: true,
    data: {
      source: "PLATFORM_ORG_RELATIONS",
      query_mode: "ORG_UNIT_ID",
      fallback_mode: "FAIL_CLOSED",
      class_member_count: 123,
      group_member_count: 80,
      group_class_mismatch_count: 0,
      invalid_relation_count: 0,
      passed: true
    }
  }).class_member_count,
  123,
  "定时任务应先核验名单数量、班级归属和失败关闭模式"
);
assert.throws(
  () => api._test.validateRosterIntegrity({
    success: true,
    data: {
      source: "PLATFORM_ORG_RELATIONS",
      query_mode: "ORG_UNIT_ID",
      fallback_mode: "FAIL_CLOSED",
      group_class_mismatch_count: 1,
      invalid_relation_count: 0,
      passed: false
    }
  }),
  /名单组织关系校验未通过/,
  "自动核验发现班级归属异常时必须停止定时同步"
);
assert.deepEqual(
  api._test.rosterIdentity([
    { center: "园区分中心", class_name: "圆融一班" },
    { center: "园区分中心", class_name: "圆融一班" }
  ]),
  {
    center: "园区分中心",
    class_name: "圆融一班",
    center_count: 1,
    class_count: 1
  },
  "Excel 名单应识别唯一分中心和班级"
);
assert.equal(
  api._test.findClassOption(
    [{ id: "class-1", name: "圆融一班", parent_id: "center-1" }],
    { center: "园区分中心", class_name: "圆融一班" }
  ).id,
  "class-1",
  "Excel 班级名称应能自动匹配运营班级选项"
);
assert.deepEqual(
  api._test.resolveOpsConnection({
    OPS_API_BASE: "https://seiwajyuku-ops-example.run.tcloudbase.com",
    OPS_ROSTER_API_KEY: "legacy-roster-key",
    SIGNIN_SERVICE_API_KEY: "platform-service-key"
  }),
  {
    base: "https://seiwajyuku-platform-api-287369-8-1453587887.sh.run.tcloudbase.com",
    apiKey: "platform-service-key"
  },
  "历史运营地址应自动迁移到返回组织 ID 的统一平台接口"
);

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
  const version = await request("/version", "GET");
  assert.equal(version.data.service, "signin");
  assert.equal(version.data.ok, false, "未经过发布脚本生成构建清单时版本接口必须明确标记未知");

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
  db.collections.events.push({ _id: "event-2", event_id: "batch-2", name: "同日班会", event_date: today, activity_type: "class_meeting", class_org_unit_id: "class-2", checkin_start_at: "2000-01-01T00:00:00.000Z", checkin_end_at: "2099-01-01T00:00:00.000Z", status: "active", lifecycle_status: "CONFIRMED" });
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
  db.collections.registrations.push({ _id: "reg-cancel", batch_id: "batch-2", name: "取消活动报名", phone: "13800000005", center: "", class_name: "一班", group_name: "一组" });

  const cancelled = await request("/event_lifecycle_update", "POST", {
    event_id: "batch-2", lifecycle_status: "CANCELLED", reason: "回归测试"
  }, token);
  assert.equal(cancelled.data.ok, true, "活动取消必须通过受保护生命周期接口完成");
  const addToCancelled = await request("/registration", "POST", {
    event_id: "batch-2", name: "取消后新增", phone: "13800000010"
  }, token);
  assert.equal(addToCancelled.data.ok, false, "已取消活动不得新增临时报名");
  const updateCancelledRegistration = await request("/attendance_status", "POST", {
    registration_id: "reg-cancel", status: "leave", note: "取消后修改"
  }, token);
  assert.equal(updateCancelledRegistration.data.ok, false, "已取消活动不得修改报名跟进状态");
  const deleteCancelledRegistration = await request("/registration_delete", "POST", {
    registration_id: "reg-cancel"
  }, token);
  assert.equal(deleteCancelledRegistration.data.ok, false, "已取消活动不得删除报名记录");
  const cancelledPublic = await request("/event", "GET");
  assert(!cancelledPublic.data.active_events.some(row => row.event_id === "batch-2"), "已取消活动不得进入公开签到候选");
  assert(!cancelledPublic.data.display_events.some(row => row.event_id === "batch-2"), "已取消活动不得显示在学员页");
  const restoredToDraft = await request("/event_lifecycle_update", "POST", {
    event_id: "batch-2", lifecycle_status: "DRAFT", reason: "回归测试"
  }, token);
  assert.equal(restoredToDraft.data.ok, true, "已取消活动应能退回草稿而不是直接恢复公开");
  const confirmedAgain = await request("/event_lifecycle_update", "POST", {
    event_id: "batch-2", lifecycle_status: "CONFIRMED", reason: "回归测试"
  }, token);
  assert.equal(confirmedAgain.data.ok, true, "满足日期、时间和组织校验的草稿活动可以确认举办");
  db.collections.events.find(row => row.event_id === "batch-2").status = "closed";
  const closedEventDisplay = await request("/event", "GET");
  assert(!closedEventDisplay.data.display_events.some(row => row.event_id === "batch-2"), "签到页不得显示今天已手动关闭的活动");
  assert(!closedEventDisplay.data.active_events.some(row => row.event_id === "batch-2"));
  const addToClosedEvent = await request("/registration", "POST", {
    event_id: "batch-2", name: "关闭活动测试", phone: "13800000009"
  }, token);
  assert.equal(addToClosedEvent.data.ok, false, "临时报名不得加入已关闭签到的活动");

  db.collections.events.push({ _id: "event-3", event_id: "batch-3", name: "未来课程", event_date: "2099-01-01", activity_type: "course", status: "active", lifecycle_status: "CONFIRMED", checkin_start_at: "2099-01-01T00:00:00.000Z", checkin_end_at: "2099-01-01T12:00:00.000Z" });
  db.collections.registrations.push({ _id: "reg-6", batch_id: "batch-3", name: "未来学员", phone: "13800000008" });
  const earlyCheckin = await request("/checkin", "POST", { name: "未来学员", phone: "13800000008" });
  assert.equal(earlyCheckin.data.ok, false, "未到签到开始时间不得签到");
  const earlyRegistration = await request("/registration", "POST", { event_id: "batch-3", name: "临时学员", phone: "13800000007" }, token);
  assert.equal(earlyRegistration.data.ok, true, "活动开始前应允许后台维护临时报名名单");
  assert(db.collections.registrations.some(row => row.batch_id === "batch-3" && row.phone === "13800000007"));
  const selectHistorical = await request("/event_update", "POST", { event_id: "batch-3", select: true }, token);
  assert.equal(selectHistorical.data.ok, true);
  const todayWorkspaceData = await request("/admin_events?page=1&page_size=20", "GET", undefined, token);
  assert.notEqual(todayWorkspaceData.data.today_selected_event_id, "batch-3", "选择未来活动后，今日工作台不得切换到非今日活动");
  assert(todayWorkspaceData.data.today_selected_item && todayWorkspaceData.data.today_selected_item.event_date === today, "今日工作台必须返回今天的活动候选");
  await request("/event_update", "POST", { event_id: "batch-1", select: true }, token);

  db.collections.events.push({ _id: "event-4", event_id: "batch-4", name: "已结束课程", event_date: "2000-01-01", activity_type: "course", status: "active", lifecycle_status: "CONFIRMED", checkin_start_at: "2000-01-01T00:00:00.000Z", checkin_end_at: "2000-01-01T12:00:00.000Z" });
  const endedRegistration = await request("/registration", "POST", { event_id: "batch-4", name: "结束后学员", phone: "13800000006" }, token);
  assert.equal(endedRegistration.data.ok, false, "已结束活动不得新增临时报名");

  const tomorrow = new Date(Date.parse(today + "T12:00:00+08:00") + 24 * 60 * 60 * 1000);
  const tomorrowKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(tomorrow);
  db.collections.events.push({
    _id: "event-tomorrow-boundary", event_id: "batch-tomorrow-boundary", name: "次日边界活动",
    event_date: tomorrowKey, activity_type: "course", status: "active", lifecycle_status: "CONFIRMED",
    checkin_start_at: `${today}T23:30:00.000Z`, checkin_end_at: `${tomorrowKey}T12:00:00.000Z`
  });
  const boundaryPublic = await request("/event", "GET");
  assert(!boundaryPublic.data.display_events.some(row => row.event_id === "batch-tomorrow-boundary"), "UTC 日期字符串为今天但中国业务日期为明天的活动不得显示");

  const cascadeEvents = [
    { event_id: "cascade-1", session_code: "MORNING", session_name: "上午", session_order: 1, checkin_start_at: "2099-02-01T00:00:00.000Z", checkin_end_at: "2099-02-01T01:30:00.000Z" },
    { event_id: "cascade-2", session_code: "AFTERNOON", session_name: "下午", session_order: 2, checkin_start_at: "2099-02-01T05:00:00.000Z", checkin_end_at: "2099-02-01T06:30:00.000Z" },
    { event_id: "cascade-3", session_code: "KONPA", session_name: "晚上空巴", session_order: 3, checkin_start_at: "2099-02-01T10:00:00.000Z", checkin_end_at: "2099-02-01T11:30:00.000Z" }
  ].map(item => ({ ...item, _id: "event-" + item.event_id, event_group_id: "cascade-group", name: "级联班会 - " + item.session_name, event_date: "2099-02-01", activity_type: "class_meeting", status: "active" }));
  db.collections.events.push(...cascadeEvents);
  const morningCascade = await request("/registration", "POST", { event_id: "cascade-1", name: "上午临时学员", phone: "13800000021" }, token);
  assert.equal(morningCascade.data.added_count, 3, "上午新增应自动同步至下午和空巴");
  assert.deepEqual(db.collections.registrations.filter(row => row.phone === "13800000021").map(row => row.batch_id).sort(), ["cascade-1", "cascade-2", "cascade-3"]);
  const afternoonCascade = await request("/registration", "POST", { event_id: "cascade-2", name: "下午临时学员", phone: "13800000022" }, token);
  assert.equal(afternoonCascade.data.added_count, 2, "下午新增应自动同步至空巴");
  assert.deepEqual(db.collections.registrations.filter(row => row.phone === "13800000022").map(row => row.batch_id).sort(), ["cascade-2", "cascade-3"]);
  const konpaOnly = await request("/registration", "POST", { event_id: "cascade-3", name: "空巴临时学员", phone: "13800000023" }, token);
  assert.equal(konpaOnly.data.added_count, 1, "空巴新增只应写入当前场次");
  assert.deepEqual(db.collections.registrations.filter(row => row.phone === "13800000023").map(row => row.batch_id), ["cascade-3"]);
  const konpaLate = await request("/attendance_status", "POST", {
    registration_id: db.collections.registrations.find(row => row.phone === "13800000023")._id,
    status: "late"
  }, token);
  assert.equal(konpaLate.data.ok, false, "空巴不应设置迟到状态");

  db.collections.checkins.push({ _id: "checkin-cascade", batch_id: "cascade-2", registration_id: db.collections.registrations.find(row => row.phone === "13800000022" && row.batch_id === "cascade-2")._id, checked_at: new Date().toISOString() });
  const deletedCascadeGroup = await request("/clear_all", "POST", { event_id: "cascade-1" }, token);
  assert.equal(deletedCascadeGroup.data.ok, true, "删除三场班会时应删除整个活动组");
  assert.equal(deletedCascadeGroup.data.deleted_count, 3);
  assert.deepEqual(deletedCascadeGroup.data.deleted_event_ids.sort(), ["cascade-1", "cascade-2", "cascade-3"]);
  assert(!db.collections.events.some(row => row.event_group_id === "cascade-group"), "三场班会的全部活动记录都必须删除");
  assert(!db.collections.registrations.some(row => ["cascade-1", "cascade-2", "cascade-3"].includes(row.batch_id)), "三场班会的全部报名都必须删除");
  assert(!db.collections.checkins.some(row => ["cascade-1", "cascade-2", "cascade-3"].includes(row.batch_id)), "三场班会的全部签到都必须删除");
  assert.equal(db.collections.event_audit_logs.filter(row => row.action === "event.deleted" && row.event_group_id === "cascade-group").length, 3, "三场删除必须为每个场次写入删除审计");

  const defaultDate = "2099-03-03";
  const defaultSessions = await request("/create_class_meeting_sessions", "POST", {
    event_date: defaultDate,
    event_name: "默认时间测试班会",
    org_unit_id: "center-default",
    class_org_unit_id: "class-default",
    roster_members: [{ name: "默认名单学员", phone: "13800000013", class_name: "默认班" }]
  }, token);
  assert.equal(defaultSessions.data.ok, true);
  const defaultSessionRows = db.collections.events.filter(row => row.event_group_id === defaultSessions.data.event_group_id).sort((a, b) => a.session_order - b.session_order);
  assert.deepEqual(defaultSessionRows.map(row => [row.session_code, row.checkin_start_at, row.scheduled_start_at, row.checkin_end_at, row.scheduled_end_at]), [
    ["MORNING", "2099-03-02T23:30:00.000Z", "2099-03-03T01:00:00.000Z", "2099-03-03T02:30:00.000Z", "2099-03-03T04:00:00.000Z"],
    ["AFTERNOON", "2099-03-03T04:10:00.000Z", "2099-03-03T05:30:00.000Z", "2099-03-03T07:00:00.000Z", "2099-03-03T09:00:00.000Z"],
    ["KONPA", "2099-03-03T09:10:00.000Z", "2099-03-03T10:00:00.000Z", "2099-03-03T12:30:00.000Z", "2099-03-03T12:30:00.000Z"]
  ], "班会三场默认时间应使用新的运营时间口径");

  const missingRosterSessions = await request("/create_class_meeting_sessions", "POST", {
    event_date: "2099-03-03",
    event_name: "缺少名单字段测试",
    org_unit_id: "center-missing-roster",
    class_org_unit_id: "class-missing-roster"
  }, token);
  assert.equal(missingRosterSessions.data.ok, false, "三场班会不得在缺少名单字段时创建");

  const eventsBeforeInvalidRoster = db.collections.events.length;
  const invalidRosterSessions = await request("/create_class_meeting_sessions", "POST", {
    event_date: "2099-03-04",
    event_name: "名单质量失败测试",
    org_unit_id: "center-invalid-roster",
    class_org_unit_id: "class-invalid-roster",
    roster_members: [{ name: "资料待完善", phone: "" }]
  }, token);
  assert.equal(invalidRosterSessions.data.ok, false, "班会创建接口必须阻断缺少手机号的名单");
  assert.equal(invalidRosterSessions.data.code, "ROSTER_QUALITY_INVALID");
  assert.equal(db.collections.events.length, eventsBeforeInvalidRoster, "名单质量失败时不得创建任何场次");

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
  const sharedPhoneSessions = await request("/create_class_meeting_sessions", "POST", {
    token,
    event_date: "2099-03-05",
    event_name: "共用联系电话测试班会",
    org_unit_id: "center-shared-phone",
    class_org_unit_id: "class-shared-phone",
    roster_members: [
      { name: "本人", phone: "13800000011", class_name: "测试班" },
      { name: "代报名员工", phone: "13800000011", class_name: "测试班" }
    ]
  });
  assert.equal(sharedPhoneSessions.data.ok, true, "共用联系电话不应阻断班会创建");
  assert.equal(
    db.collections.registrations.filter(row => row.event_group_id === sharedPhoneSessions.data.event_group_id).length,
    6,
    "共用联系电话名单仍应复制到三个签到场次"
  );
  const invalidSessionTimes = await request("/create_class_meeting_sessions", "POST", {
    token,
    event_date: today,
    event_name: "错误时间测试",
    org_unit_id: "center-1",
    class_org_unit_id: "class-1",
    morning_checkin_start: `${today}T10:00`,
    morning_scheduled_start: `${today}T09:00`,
    morning_checkin_end: `${today}T09:30`,
    morning_scheduled_end: `${today}T12:00`
  });
  assert.equal(invalidSessionTimes.data.ok, false, "三场次时间顺序错误时必须拒绝创建");

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

  const paginationSeed = Array.from({ length: 620 }, (_, index) => ({
    _id: "pagination-event-" + index,
    event_id: "pagination-batch-" + index,
    name: "历史分页活动 " + index,
    event_date: `2080-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    activity_type: index % 2 ? "course" : "group_meeting",
    status: "active",
    lifecycle_status: index % 3 === 0 ? "CONFIRMED" : "DRAFT",
    checkin_start_at: "2080-01-01T00:00:00.000Z",
    checkin_end_at: "2080-01-01T01:00:00.000Z"
  }));
  db.collections.events.push(...paginationSeed);
  const firstPage = await request("/admin_events?page=1&page_size=20", "GET", undefined, token);
  assert.equal(firstPage.data.ok, true);
  assert.equal(firstPage.data.page, 1);
  assert.equal(firstPage.data.page_size, 20);
  assert(firstPage.data.items.length <= 20, "活动列表每页不得超过 page_size");
  assert.equal(firstPage.data.has_more, true, "超过一页活动时必须返回 has_more");
  assert(!Object.prototype.hasOwnProperty.call(firstPage.data.items[0], "total"), "活动列表不得为每条历史活动读取报名统计");
  assert(!Object.prototype.hasOwnProperty.call(firstPage.data.items[0], "checked"), "活动列表不得为每条历史活动读取签到统计");
  const twentiethPage = await request("/admin_events?page=20&page_size=20", "GET", undefined, token);
  assert.equal(twentiethPage.data.items.length, 20, "第20页应能读取 620 条活动中的中间页");
  const lastPage = await request("/admin_events?page=32&page_size=20", "GET", undefined, token);
  assert(lastPage.data.items.length > 0 && lastPage.data.items.length <= 20, "最后一页应能读取活动尾部");
  assert.equal(lastPage.data.has_more, false);
  const filteredPage = await request("/admin_events?page=1&page_size=20&lifecycle_status=CONFIRMED&activity_type=course", "GET", undefined, token);
  assert(filteredPage.data.items.every(item => item.lifecycle_status === "CONFIRMED" && item.activity_type === "course"), "活动列表筛选必须在后端生效");
  const keywordPage = await request("/admin_events?page=1&page_size=20&keyword=" + encodeURIComponent("历史分页活动 619") + "&date_from=2080-01-01&date_to=2080-12-31", "GET", undefined, token);
  assert.equal(keywordPage.data.items.length, 1, "活动名称和日期筛选必须在后端生效");
  assert.equal(keywordPage.data.items[0].event_id, "pagination-batch-619");

  const sameDayEvents = Array.from({ length: 60 }, (_, index) => ({
    _id: "same-day-event-" + index,
    event_id: "same-day-batch-" + index,
    name: "同日稳定排序活动 " + index,
    event_date: "2078-06-06",
    activity_type: "course",
    status: "active",
    lifecycle_status: "DRAFT",
    created_at: `2078-06-06T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index).padStart(2, "0")}:00.000Z`
  }));
  db.collections.events.push(...sameDayEvents);
  const sameDayPages = [];
  for (const page of [1, 2, 3]) {
    const result = await request(`/admin_events?page=${page}&page_size=20&date_from=2078-06-06&date_to=2078-06-06`, "GET", undefined, token);
    sameDayPages.push(...result.data.items.map(item => item.event_id));
  }
  assert.equal(sameDayPages.length, 60, "同一天的 60 个活动应完整分页");
  assert.equal(new Set(sameDayPages).size, 60, "同一天跨页活动不得重复");

  const boundarySingles = Array.from({ length: 19 }, (_, index) => ({
    _id: "boundary-single-before-" + index,
    event_id: "boundary-single-before-" + index,
    name: "分页边界普通活动前 " + index,
    event_date: "2077-05-05",
    activity_type: "course",
    status: "active",
    lifecycle_status: "DRAFT",
    created_at: `2077-05-05T02:${String(index).padStart(2, "0")}:00.000Z`
  })).concat(Array.from({ length: 5 }, (_, index) => ({
    _id: "boundary-single-after-" + index,
    event_id: "boundary-single-after-" + index,
    name: "分页边界普通活动后 " + index,
    event_date: "2077-05-05",
    activity_type: "course",
    status: "active",
    lifecycle_status: "DRAFT",
    created_at: `2077-05-05T00:${String(index).padStart(2, "0")}:00.000Z`
  })));
  const boundaryGroup = [1, 2, 3].map(order => ({
    _id: "boundary-group-event-" + order,
    event_id: "boundary-group-batch-" + order,
    event_group_id: "boundary-group",
    session_order: order,
    session_name: ["上午", "下午", "晚上空巴"][order - 1],
    name: "跨页边界班会 - " + ["上午", "下午", "晚上空巴"][order - 1],
    event_date: "2077-05-05",
    activity_type: "class_meeting",
    status: "active",
    lifecycle_status: "DRAFT",
    created_at: "2077-05-05T01:00:00.000Z"
  }));
  db.collections.events.push(...boundarySingles, ...boundaryGroup, {
    _id: "legacy-draft-event",
    event_id: "legacy-draft-event",
    name: "缺少生命周期的历史活动",
    event_date: "2076-04-04",
    activity_type: "course",
    status: "active"
  });
  const boundaryPage1 = await request("/admin_events?page=1&page_size=20&date_from=2077-05-05&date_to=2077-05-05", "GET", undefined, token);
  const boundaryPage2 = await request("/admin_events?page=2&page_size=20&date_from=2077-05-05&date_to=2077-05-05", "GET", undefined, token);
  const boundaryRows = boundaryPage1.data.items.concat(boundaryPage2.data.items);
  assert.equal(boundaryRows.filter(item => item.event_group_id === "boundary-group").length, 1, "三场班会跨分页边界时只能出现一次");
  assert.equal(boundaryRows.find(item => item.event_group_id === "boundary-group").session_count, 3);
  assert.equal(new Set(boundaryRows.map(item => item.event_id)).size, boundaryRows.length, "跨页逻辑活动不得重复或遗漏");
  const legacyDraftPage = await request("/admin_events?page=1&page_size=20&lifecycle_status=DRAFT&keyword=" + encodeURIComponent("缺少生命周期") , "GET", undefined, token);
  assert.equal(legacyDraftPage.data.items.length, 1, "缺少 lifecycle_status 的旧活动应按草稿筛选出现");
  assert.equal(legacyDraftPage.data.items[0].lifecycle_status, "DRAFT");

  const pagedGroup = [1, 2, 3].map(order => ({
    _id: "paged-group-event-" + order,
    event_id: "paged-group-batch-" + order,
    event_group_id: "paged-group",
    session_order: order,
    session_name: ["上午", "下午", "晚上空巴"][order - 1],
    name: "分页边界班会 - " + ["上午", "下午", "晚上空巴"][order - 1],
    event_date: "2099-04-01",
    activity_type: "course",
    status: "active",
    lifecycle_status: "DRAFT",
    checkin_start_at: "2099-04-01T00:00:00.000Z",
    checkin_end_at: "2099-04-01T01:00:00.000Z"
  }));
  db.collections.events.push(...pagedGroup);
  const groupedList = await request("/admin_events?page=1&page_size=20&keyword=" + encodeURIComponent("分页边界班会"), "GET", undefined, token);
  assert.equal(groupedList.data.items.length, 1, "三场班会在活动列表中应合并为一行");
  assert.equal(groupedList.data.items[0].session_count, 3);
  const pagedGroupLifecycle = await request("/event_lifecycle_update", "POST", { event_group_id: "paged-group", lifecycle_status: "CONFIRMED", reason: "跨分页回归" }, token);
  assert.equal(pagedGroupLifecycle.data.ok, true, "活动组生命周期操作不得依赖当前分页结果");
  assert(db.collections.events.filter(row => row.event_group_id === "paged-group").every(row => row.lifecycle_status === "CONFIRMED"));

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
