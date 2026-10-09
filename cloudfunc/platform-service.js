// The platform is a trusted service caller. Browser-supplied identity, scope,
// or a legacy admin token never activates this context.
const crypto = require("crypto");
const TRUSTED_CONTEXT = Symbol("platform-signin-context");
const MANAGEMENT_OPERATIONS = Object.freeze({
  admin_events: { method: "GET", permission: "attendance:view", list: true },
  event_detail: { method: "GET", permission: "attendance:view" },
  create_event: { method: "POST", permission: "attendance:create", create: true, mutation: true },
  import_preview: { method: "POST", permission: "attendance:import" },
  import_apply: { method: "POST", permission: "attendance:import", mutation: true },
  stats: { method: "GET", permission: "attendance:view" },
  class_roster_reconciliation: { method: "GET", permission: "attendance:view" },
  ops_roster_options: { method: "GET", permission: "attendance:view", list: true },
  ops_roster_members: { method: "POST", permission: "attendance:import", roster: true },
  event_update: { method: "POST", permission: "attendance:update", mutation: true },
  event_lifecycle_update: { method: "POST", permission: "attendance:update", mutation: true },
  create_class_meeting_sessions: { method: "POST", permission: "attendance:create", create: true, mutation: true },
  upload_preview: { method: "POST", permission: "attendance:import", create: true },
  upload: { method: "POST", permission: "attendance:import", create: true, mutation: true },
  registration: { method: "POST", permission: "attendance:manage", mutation: true },
  registration_delete: { method: "POST", permission: "attendance:manage", registration: true, mutation: true },
  attendance_status: { method: "POST", permission: "attendance:status", registration: true, mutation: true },
  sync_class_roster: { method: "POST", permission: "attendance:import", mutation: true },
  export: { method: "POST", permission: "attendance:export" },
  manual_checkin: { path: "/checkin/confirm", method: "POST", permission: "attendance:manage", registration: true, mutation: true },
  display_settings: { path: "/settings", method: "POST", permission: "attendance:manage", global: true, mutation: true }
});

function verifyServiceKey(headers, configured) {
  const supplied = String(headers && (headers["x-api-key"] || headers["X-API-Key"]) || "");
  const expected = String(configured || "");
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyCheckinTicket(ticket, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof ticket !== "string" || ticket.length > 4096) throw new Error("CHECKIN_TICKET_INVALID");
  const parts = ticket.split(".");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("CHECKIN_TICKET_INVALID");
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  const signature = Buffer.from(parts[1], "base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) throw new Error("CHECKIN_TICKET_INVALID");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (error) { throw new Error("CHECKIN_TICKET_INVALID"); }
  if (!payload || payload.purpose !== "MEMBER_CHECKIN" || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp - payload.iat !== 300 || payload.iat > nowSeconds + 5 || payload.exp <= nowSeconds || !String(payload.event_id || "").trim() || !payload.member || !String(payload.member.member_id || "").trim() || !String(payload.member.member_code || "").trim() || !String(payload.binding_id || "").trim() || !Number.isSafeInteger(payload.token_version) || payload.token_version < 1) throw new Error("CHECKIN_TICKET_INVALID");
  return payload;
}

function requiredManagementPermissions(spec, operation, payload = {}) {
  if (operation === "event_update") {
    const content = Object.keys(payload).filter(key => !["event_id", "status", "select"].includes(key));
    return [...new Set([...(content.length ? ["attendance:update"] : []), ...(payload.status !== undefined || payload.select !== undefined ? ["attendance:manage"] : [])])];
  }
  if (operation === "event_lifecycle_update") {
    const status = String(payload.lifecycle_status || "").toUpperCase();
    if (!["CONFIRMED", "DRAFT", "CANCELLED"].includes(status)) throw new Error("INVALID_LIFECYCLE_STATUS");
    return [status === "CANCELLED" ? "attendance:manage" : "attendance:update"];
  }
  if (operation === "upload") return ["attendance:create", "attendance:import"];
  return [spec.permission];
}

function normalizeManagementContext(body, spec, operation) {
  const actor = body && body.actor;
  const permissions = requiredManagementPermissions(spec, operation, body && body.payload || {});
  if (!permissions.length || !actor || !String(actor.id || "").trim() || !Array.isArray(actor.permissions) || permissions.some(permission => !actor.permissions.includes(permission))) {
    throw new Error("PLATFORM_PERMISSION_REQUIRED");
  }
  if (body.allowed_org_unit_ids !== null && !Array.isArray(body.allowed_org_unit_ids)) throw new Error("PLATFORM_SCOPE_REQUIRED");
  const allowed = body.allowed_org_unit_ids === null ? null : [...new Set(body.allowed_org_unit_ids.map(String).filter(Boolean))];
  if (spec.global && allowed !== null) throw new Error("PLATFORM_GLOBAL_SCOPE_REQUIRED");
  return { actor: { id: String(actor.id), permissions: actor.permissions }, allowed_org_unit_ids: allowed, management: true };
}

function eventInScope(item, trusted) {
  if (!trusted || !trusted.management || trusted.allowed_org_unit_ids === null) return true;
  // The most specific organization owns the activity. A class-scoped actor
  // cannot operate another class merely because both share a center.
  const owner = String(item && (item.group_org_unit_id || item.class_org_unit_id || item.org_unit_id) || "");
  return Boolean(owner && trusted.allowed_org_unit_ids.includes(owner));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(phone|phone_last4|attendance_note|reason|note|remark|password|token|preview_token|candidate_token)$|password_hash|secret|api_key/i.test(key)) continue;
    result[key] = redact(item);
  }
  return result;
}

function documentData(result) {
  requireDatabaseSuccess(result);
  return Array.isArray(result && result.data) ? result.data[0] : result && result.data;
}

function requireDatabaseSuccess(result) {
  if (result && result.code) {
    const error = new Error("DATABASE_OPERATION_FAILED");
    error.code = result.code;
    throw error;
  }
  return result;
}

function checkinDocumentId(eventId, registrationId) {
  return "ci_" + crypto.createHash("sha256").update(String(eventId) + "\u001f" + String(registrationId)).digest("hex").slice(0, 48);
}

async function ensureCrossRegistration(db, row) {
  const id = "cross_" + crypto.createHash("sha256").update(row.batch_id + "\u001f" + row.platform_member_id).digest("hex").slice(0, 48);
  if (typeof db.runTransaction !== "function") throw new Error("ATOMIC_CHECKIN_UNAVAILABLE");
  await db.runTransaction(async transaction => {
    const doc = transaction.collection("registrations").doc(id);
    if (!documentData(await doc.get())) requireDatabaseSuccess(await doc.set(row));
  });
  return { id };
}

async function persistCheckin(db, row, registrationPatch, options = {}) {
  if (!row.batch_id || !row.registration_id) throw new Error("CHECKIN_IDENTITY_REQUIRED");
  if (typeof db.runTransaction !== "function") throw new Error("ATOMIC_CHECKIN_UNAVAILABLE");
  const id = checkinDocumentId(row.batch_id, row.registration_id);
  return await db.runTransaction(async transaction => {
    if (options.eventDocumentId && options.validateEvent) {
      const event = documentData(await transaction.collection("events").doc(options.eventDocumentId).get());
      if (!event || !options.validateEvent(event)) throw new Error("CHECKIN_EVENT_CLOSED");
    }
    const claimDoc = options.claimKey ? transaction.collection("config").doc("claim_" + crypto.createHash("sha256").update(options.claimKey).digest("hex").slice(0, 48)) : null;
    const claim = claimDoc && documentData(await claimDoc.get());
    if (claim) {
      const claimed = documentData(await transaction.collection("checkins").doc(claim.checkin_id).get());
      if (claimed) return { id: claim.checkin_id, already: true, checkin: claimed };
    }
    const doc = transaction.collection("checkins").doc(id);
    const existing = documentData(await doc.get());
    if (existing) {
      if (options.team && existing.actual_attendee_name !== row.actual_attendee_name) throw new Error("CHECKIN_SLOT_CONSUMED");
      return { id, already: true, checkin: existing };
    }
    const regDoc = transaction.collection("registrations").doc(row.registration_id);
    let currentRegistration = documentData(await regDoc.get());
    if (!currentRegistration && options.guestRegistration) {
      currentRegistration = options.guestRegistration;
      requireDatabaseSuccess(await regDoc.set(currentRegistration));
    }
    if (!currentRegistration || String(currentRegistration.batch_id) !== String(row.batch_id)) throw new Error("CHECKIN_REGISTRATION_CHANGED");
    if (options.team && String(currentRegistration.actual_attendee_name || "").trim()) throw new Error("CHECKIN_SLOT_CONSUMED");
    // Fact and durable delivery state are one atomic document. An unavailable
    // platform cannot erase a successfully persisted attendance fact.
    const checkin = {
      ...row, sync_state: "PENDING", sync_attempts: 0,
      sync_next_retry_at: new Date().toISOString(), sync_last_error_code: ""
    };
    requireDatabaseSuccess(await doc.set(checkin));
    if (registrationPatch) requireDatabaseSuccess(await regDoc.update(registrationPatch));
    if (claimDoc) requireDatabaseSuccess(await claimDoc.set({ checkin_id: id, event_id: row.batch_id, registration_id: row.registration_id }));
    return { id, already: false, checkin };
  });
}

module.exports = {
  TRUSTED_CONTEXT, MANAGEMENT_OPERATIONS, verifyServiceKey, normalizeManagementContext,
  verifyCheckinTicket,
  requiredManagementPermissions,
  eventInScope, redact, documentData, requireDatabaseSuccess, checkinDocumentId, ensureCrossRegistration, persistCheckin
};
