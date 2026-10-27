const crypto = require("crypto");
const { documentData, requireDatabaseSuccess, checkinDocumentId } = require("./platform-service");

const TRIGGER = "classRosterBeforeStartOnce";
function isRosterTimer(event) {
  return Boolean(event && !event.httpMethod && !event.path &&
    String(event.Type || event.type || "").toLowerCase() === "timer" &&
    [TRIGGER, "classRosterBeforeStartEvery5Minutes"].includes(String(event.TriggerName || event.triggerName || "")));
}
function eligible(event, now = Date.now()) {
  const starts = Date.parse(event && event.checkin_start_at);
  return Boolean(event && event.activity_type === "class_meeting" && event.class_org_unit_id &&
    !event.group_org_unit_id && event.status !== "closed" &&
    event.lifecycle_status === "CONFIRMED" && Number.isFinite(starts) &&
    event.roster_auto_completed_for_start !== event.checkin_start_at &&
    starts > now && starts <= now + 120000);
}
const clean = value => String(value || "").trim();
function keys(row) {
  return [clean(row.platform_member_id || row.member_id) && "id:" + clean(row.platform_member_id || row.member_id),
    clean(row.member_code) && "code:" + clean(row.member_code)].filter(Boolean);
}
function home(row) {
  return row.attendance_role === "HOME_CLASS_MEMBER" ||
    (!row.attendance_role && ["ops_roster", "excel_upload"].includes(row.source));
}
async function all(db, name, filter) {
  const rows = [];
  for (let offset = 0; offset <= 10000; offset += 100) {
    const query = filter ? db.collection(name).where(filter) : db.collection(name);
    const result = await query.orderBy("_id", "asc").skip(offset).limit(100).get();
    requireDatabaseSuccess(result);
    if (offset + result.data.length > 10000) throw new Error("ROSTER_SCAN_LIMIT");
    rows.push(...result.data);
    if (result.data.length < 100) return rows;
  }
  throw new Error("ROSTER_SCAN_LIMIT");
}

// The only caller is the native timer. No browser-supplied roster or identity
// can enter this path. Each write rechecks the event and uses document transactions.
async function syncUpcomingRosters({ db, fetchRoster, registrationData, now = Date.now, deadline = Date.now() + 90000 }) {
  const result = { scanned: 0, synced: 0, added: 0, updated: 0, failed: 0, deferred: 0 };
  const events = (await all(db, "events", { activity_type: "class_meeting", lifecycle_status: "CONFIRMED" })).filter(item => eligible(item, now()))
    .sort((a, b) => Date.parse(a.checkin_start_at) - Date.parse(b.checkin_start_at));
  const rosters = new Map();
  for (const event of events) {
    if (Date.now() >= deadline) { result.deferred++; continue; }
    result.scanned++;
    const claimId = crypto.randomBytes(16).toString("hex");
    let claimed = false;
    try {
      const classId = clean(event.class_org_unit_id);
      claimed = await db.runTransaction(async tx => {
        const doc = tx.collection("events").doc(event._id);
        const latest = documentData(await doc.get());
        if (!eligible(latest, now()) || latest.checkin_start_at !== event.checkin_start_at ||
            clean(latest.class_org_unit_id) !== classId ||
            (latest.roster_auto_claim_id && Number(latest.roster_auto_claim_until) > now())) return false;
        requireDatabaseSuccess(await doc.update({ roster_auto_claim_id: claimId,
          roster_auto_claim_until: now() + 110000 }));
        return true;
      });
      if (!claimed) continue;
      if (!rosters.has(classId)) rosters.set(classId, fetchRoster(event));
      const roster = await rosters.get(classId);
      if (!roster.quality.passed || roster.members.some(member => !keys(member).length)) throw new Error("ROSTER_QUALITY_FAILED");
      const eventId = clean(event.event_id || event._id);
      if ((await all(db, "checkins", { batch_id: eventId })).length) continue;
      const existing = await all(db, "registrations", { batch_id: eventId });
      const byKey = new Map();
      for (const row of existing) for (const key of keys(row)) {
        if (byKey.has(key)) throw new Error("AMBIGUOUS_REGISTRATION_IDENTITY");
        byKey.set(key, row);
      }
      const rosterKeys = new Set();
      const plan = roster.members.map(member => {
        const memberKeys = keys(member);
        for (const key of memberKeys) {
          if (rosterKeys.has(key)) throw new Error("AMBIGUOUS_ROSTER_IDENTITY");
          rosterKeys.add(key);
        }
        const matches = new Set(memberKeys.map(key => byKey.get(key)).filter(Boolean));
        if (matches.size > 1) throw new Error("AMBIGUOUS_REGISTRATION_IDENTITY");
        const row = [...matches][0];
        if (row && clean(row.platform_member_id) && clean(member.member_id) && clean(row.platform_member_id) !== clean(member.member_id)) throw new Error("REGISTRATION_IDENTITY_CHANGED");
        return { member, row };
      });
      for (const { member, row } of plan) {
        if (Date.now() >= deadline) throw new Error("ROSTER_TIME_BUDGET");
        if (row && (!home(row) || row.actual_attendee_name)) continue;
        const desired = registrationData(member, event, "OPS_ROSTER_AUTO_SYNC");
        const fields = ["name", "registered_name", "phone", "center", "class_name", "group_name", "company", "member_code", "platform_member_id", "home_class_name"];
        const patch = Object.fromEntries(fields.map(key => [key, desired[key]]));
        if (row && fields.every(key => clean(row[key]) === clean(patch[key]))) continue;
        const id = row ? row._id : "roster_" + crypto.createHash("sha256").update(eventId + "\u001f" + keys(member)[0]).digest("hex").slice(0, 48);
        const changed = await db.runTransaction(async tx => {
          const eventDoc = tx.collection("events").doc(event._id);
          const current = documentData(await eventDoc.get());
          if (!eligible(current, now()) || clean(current.class_org_unit_id) !== classId ||
              current.checkin_start_at !== event.checkin_start_at || current.roster_auto_claim_id !== claimId ||
              clean(current.event_id || current._id) !== eventId) throw new Error("EVENT_CHANGED_OR_STARTED");
          const doc = tx.collection("registrations").doc(id);
          const latest = documentData(await doc.get());
          if (documentData(await tx.collection("checkins").doc(checkinDocumentId(eventId, id)).get())) return "";
          if (latest && (!home(latest) || latest.actual_attendee_name || clean(latest.batch_id) !== eventId)) return "";
          if (row && (!latest || keys(latest).join("|") !== keys(row).join("|"))) throw new Error("REGISTRATION_CHANGED");
          if (latest && fields.every(key => clean(latest[key]) === clean(patch[key]))) return "";
          requireDatabaseSuccess(latest ? await doc.update(patch) : await doc.set(desired));
          const auditId = "roster_" + crypto.randomBytes(16).toString("hex");
          requireDatabaseSuccess(await tx.collection("event_audit_logs").doc(auditId).set({
            action: "event.roster.auto_sync", event_id: eventId, actor: "scheduled_roster_sync",
            occurred_at: new Date(now()).toISOString(), added_count: latest ? 0 : 1,
            updated_count: latest ? 1 : 0, sync_scope: "TRUSTED_CLASS_UPCOMING_ONLY"
          }));
          // Serialize against lifecycle changes without modifying signup state.
          requireDatabaseSuccess(await eventDoc.update({ roster_auto_synced_at: new Date(now()).toISOString() }));
          return latest ? "updated" : "added";
        });
        if (changed) result[changed]++;
      }
      await db.runTransaction(async tx => {
        const doc = tx.collection("events").doc(event._id);
        const current = documentData(await doc.get());
        if (!current || current.roster_auto_claim_id !== claimId ||
            current.checkin_start_at !== event.checkin_start_at ||
            clean(current.class_org_unit_id) !== classId) throw new Error("EVENT_CHANGED");
        requireDatabaseSuccess(await doc.update({ roster_auto_completed_for_start: event.checkin_start_at,
          roster_auto_completed_at: new Date(now()).toISOString(), roster_auto_claim_id: "", roster_auto_claim_until: 0 }));
      });
      result.synced++;
    } catch (error) {
      // No member data, upstream response or credentials in timer results.
      result.failed++;
    } finally {
      if (claimed) {
        try { await db.runTransaction(async tx => {
          const doc = tx.collection("events").doc(event._id);
          const current = documentData(await doc.get());
          if (current && current.roster_auto_claim_id === claimId) {
            requireDatabaseSuccess(await doc.update({ roster_auto_claim_id: "", roster_auto_claim_until: 0 }));
          }
        }); } catch (error) { result.failed++; }
      }
    }
  }
  return { ok: result.failed === 0 && result.deferred === 0, action: "class_roster_before_start", ...result };
}
module.exports = { TRIGGER, isRosterTimer, eligible, syncUpcomingRosters };
