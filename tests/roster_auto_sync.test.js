const assert = require("node:assert/strict");
const { createAtomicDatabase } = require("./support/atomic_database");
const { syncUpcomingRosters, isRosterTimer, TRIGGER } = require("../cloudfunc/roster-auto-sync");
const { checkinDocumentId } = require("../cloudfunc/platform-service");
const NOW = Date.parse("2026-10-27T00:00:00Z");
const event = (id, patch = {}) => ({ _id: id, event_id: id, activity_type: "class_meeting",
  class_org_unit_id: "class-a", status: "active", lifecycle_status: "CONFIRMED",
  checkin_start_at: new Date(NOW + 120000).toISOString(), ...patch });
const member = (id, patch = {}) => ({ member_id: id, member_code: "M" + id,
  name: "验收学长" + id, group_name: "新小组", ...patch });
function registrationData(m, e) {
  return { batch_id: e.event_id, platform_member_id: m.member_id, member_code: m.member_code,
    name: m.name, registered_name: m.name, group_name: m.group_name,
    phone: "", center: "测试中心", class_name: "测试班", company: "", home_class_name: "测试班",
    attendance_role: "HOME_CLASS_MEMBER", attendance_status: "pending" };
}
function setup(events = [event("morning"), event("afternoon")]) {
  const db = createAtomicDatabase({ events, registrations: [], checkins: [], event_audit_logs: [] });
  const options = { db, now: () => NOW, registrationData,
    fetchRoster: async () => ({ quality: { passed: true }, members: [member("1"), member("2")] }) };
  return { db, options };
}
async function main() {
  assert(isRosterTimer({ Type: "Timer", TriggerName: TRIGGER }));
  assert(!isRosterTimer({ Type: "Timer", TriggerName: TRIGGER, httpMethod: "POST" }));
  assert(!isRosterTimer({ Type: "Timer", TriggerName: TRIGGER, path: "/" }));
  assert(!isRosterTimer({ Type: "Timer", TriggerName: "unrelated" }));
  {
    const { db, options } = setup();
    let requests = 0;
    const fetch = options.fetchRoster;
    options.fetchRoster = async e => { requests++; return fetch(e); };
    const first = await syncUpcomingRosters(options);
    assert.equal(first.added, 4);
    assert.equal(requests, 1, "same-class scenes share the validated source read");
    assert.equal(db.collections.event_audit_logs.length, 4);
    const again = await syncUpcomingRosters(options);
    assert.equal(again.added + again.updated, 0);
    assert.equal(db.collections.registrations.length, 4);
    const reg = db.collections.registrations[0];
    reg.name = "旧姓名"; reg.group_name = "旧小组"; reg.attendance_status = "leave"; reg.attendance_note = "已有跟进";
    assert.equal((await syncUpcomingRosters(options)).scanned, 0, "completed scenes never refresh again");
    db.collections.events.find(e => e.event_id === reg.batch_id).checkin_start_at = new Date(NOW + 119000).toISOString();
    const refreshed = await syncUpcomingRosters(options);
    assert.equal(refreshed.updated, 1, "explicitly rescheduled scenes get one new synchronization");
    assert.equal(reg.name, "验收学长1");
    assert.equal(reg.group_name, "新小组");
    assert.equal(reg.attendance_status, "leave");
    assert.equal(reg.attendance_note, "已有跟进");
  }
  {
    const { db, options } = setup([event("one")]);
    await Promise.all([syncUpcomingRosters(options), syncUpcomingRosters(options)]);
    assert.equal(db.collections.registrations.length, 2, "overlapping timers cannot duplicate new members");
    assert.equal(db.collections.event_audit_logs.length, 2);
  }
  {
    const excluded = [event("open", { checkin_start_at: new Date(NOW).toISOString() }),
      event("ended", { checkin_start_at: new Date(NOW - 1).toISOString() }),
      event("closed", { status: "closed" }), event("cancelled", { lifecycle_status: "CANCELLED" }),
      event("draft", { lifecycle_status: "DRAFT" }), event("course", { activity_type: "course" }),
      event("no-org", { class_org_unit_id: "" }), event("group", { group_org_unit_id: "g1" }),
      event("future", { checkin_start_at: new Date(NOW + 120001).toISOString() })];
    const { db, options } = setup(excluded);
    options.fetchRoster = async () => { throw new Error("must not request"); };
    assert.equal((await syncUpcomingRosters(options)).scanned, 0);
    assert.equal(db.collections.registrations.length, 0);
  }
  {
    const { db, options } = setup([event("checked")]);
    db.collections.checkins.push({ _id: "old-fact", batch_id: "checked", registration_id: "old" });
    assert.equal((await syncUpcomingRosters(options)).added, 0);
    assert.equal(db.collections.checkins.length, 1);
  }
  {
    const { db, options } = setup([event("one")]);
    options.fetchRoster = async () => ({ quality: { passed: false }, members: [member("1")] });
    assert.equal((await syncUpcomingRosters(options)).failed, 1);
    assert.equal(db.collections.registrations.length, 0);
    options.fetchRoster = async () => { throw new Error("upstream failed with private contents"); };
    assert(!JSON.stringify(await syncUpcomingRosters(options)).includes("private"));
    assert.equal(db.collections.registrations.length, 0);
  }
  {
    const { db, options } = setup([event("one")]);
    options.fetchRoster = async () => ({ quality: { passed: true }, members: [member("1"), member("1")] });
    assert.equal((await syncUpcomingRosters(options)).failed, 1);
    assert.equal(db.collections.registrations.length, 0);
  }
  {
    const { db, options } = setup([event("one")]);
    const original = { _id: "guest", ...registrationData(member("1"), event("one")), attendance_role: "GUEST", name: "访客快照" };
    db.collections.registrations.push(original);
    assert.equal((await syncUpcomingRosters(options)).added, 1);
    assert.equal(original.name, "访客快照");
    assert.equal(db.collections.registrations.length, 2);
  }
  {
    const { db, options } = setup([event("one")]);
    const run = db.runTransaction;
    let calls = 0;
    db.runTransaction = callback => { if (++calls === 2) db.collections.events[0].checkin_start_at = new Date(NOW).toISOString(); return run(callback); };
    assert.equal((await syncUpcomingRosters(options)).failed, 1, "start-time race blocks every write");
    assert.equal(db.collections.registrations.length, 0);
  }
  {
    const { db, options } = setup([event("one")]);
    const run = db.runTransaction;
    let calls = 0;
    db.runTransaction = callback => ++calls === 2 ? run(async tx => {
      const result = await callback(tx);
      throw new Error("audit storage failed");
    }) : run(callback);
    assert.equal((await syncUpcomingRosters(options)).failed, 1);
    assert.equal(db.collections.registrations.length, 0, "audit failure rolls back the same member transaction");
    assert.equal(db.collections.event_audit_logs.length, 0);
  }
  {
    const { db, options } = setup([event("one")]);
    await syncUpcomingRosters(options);
    const reg = db.collections.registrations[0]; reg.name = "已签到姓名";
    db.collections.events[0].checkin_start_at = new Date(NOW + 119000).toISOString();
    const run = db.runTransaction;
    db.runTransaction = callback => { db.collections.checkins.push({ _id: checkinDocumentId("one", reg._id), batch_id: "one", registration_id: reg._id }); return run(callback); };
    await syncUpcomingRosters(options);
    assert.equal(reg.name, "已签到姓名", "concurrent check-in keeps its registration snapshot");
  }
  {
    const { db, options } = setup([event("one")]);
    const result = await syncUpcomingRosters({ ...options, deadline: Date.now() - 1 });
    assert.equal(result.deferred, 1);
    assert.equal(result.ok, false);
    assert.equal(db.collections.registrations.length, 0);
  }
  console.log("roster auto-sync regression passed (12 scenarios)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
