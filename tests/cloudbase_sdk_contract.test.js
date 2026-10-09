// Execute the official @cloudbase/database implementation. Only its outbound
// transport is replaced; document serializers and transaction code are real.
const assert = require("assert");
const path = require("path");
const packageRoot = path.resolve(process.argv[2] || "cloudfunc/node_modules/@cloudbase/database");
const sdkMetadata = require(path.resolve(process.argv[3] || "cloudfunc/node_modules/@cloudbase/node-sdk/package.json"));
assert.equal(sdkMetadata.version, "3.18.3");
assert.equal(sdkMetadata.dependencies["@cloudbase/database"], "1.4.3");
assert.equal(require(path.join(packageRoot, "package.json")).version, "1.4.3");
assert.equal(require("../cloudfunc/package.json").dependencies["@cloudbase/node-sdk"], "3.18.3");
const { Db } = require(packageRoot);
const { EJSON } = require(require.resolve("bson", { paths: [packageRoot] }));
const { persistCheckin, ensureCrossRegistration, documentData, requireDatabaseSuccess } = require("../cloudfunc/platform-service");
const { createScopedDatabase } = require("../cloudfunc/staging-database");
let requests = [], committed = {}, transactions = new Map(), nextId = 1, failAction = "", conflictOnce = false;
Db.reqClass = class IsolatedTransport {
  async send(action, params = {}) {
    requests.push({ action, params });
    if (action === failAction) { failAction = ""; return { code: "ISOLATED_STORAGE_ERROR", message: "synthetic failure" }; }
    if (action === "database.startTransaction") {
      const transactionId = "tx-" + nextId++;
      transactions.set(transactionId, structuredClone(committed));
      return { transactionId };
    }
    if (action === "database.abortTransaction") { transactions.delete(params.transactionId); return { ok: 1 }; }
    if (action === "database.commitTransaction") {
      if (conflictOnce) { conflictOnce = false; transactions.delete(params.transactionId); return { code: "DATABASE_TRANSACTION_CONFLICT" }; }
      committed = transactions.get(params.transactionId);
      transactions.delete(params.transactionId);
      return { ok: 1 };
    }
    const state = params.transactionId ? transactions.get(params.transactionId) : committed;
    const rows = state[params.collectionName] || (state[params.collectionName] = {});
    const query = EJSON.parse(params.query);
    if (action === "database.getDocument") return { data: { list: rows[query._id] ? [EJSON.stringify(rows[query._id])] : [] } };
    if (action === "database.modifyDocument") {
      const data = EJSON.parse(params.data);
      const existed = Boolean(rows[query._id]);
      if (params.merge) {
        if (existed) Object.assign(rows[query._id], data.$set || data);
      } else rows[query._id] = { ...data, _id: query._id };
      return { data: { updated: existed ? 1 : 0, upsert_id: !existed && params.upsert ? query._id : undefined } };
    }
    throw new Error("unexpected outbound SDK action: " + action);
  }
};
const db = new Db({ env: "ISOLATED_SYNTHETIC_FIXTURE", throwOnCode: false });
(async () => {
  const missing = await db.runTransaction(async transaction => await transaction.collection("fixtures").doc("missing").get());
  assert.strictEqual(missing.data, null, "transaction not-found is data:null");
  const raw = { marker: "raw", count: 1 };
  const callback = await db.runTransaction(async transaction => {
    const doc = transaction.collection("fixtures").doc("present");
    const written = await doc.set(raw);
    assert.equal(written.upserted[0]._id, "present");
    const found = await doc.get();
    assert.equal(Array.isArray(found.data), false);
    assert.equal(found.data.marker, "raw");
    const updated = await doc.update({ count: 2 });
    assert.equal(updated.updated, 1);
    return { callback: "returned-directly" };
  });
  assert.deepEqual(callback, { callback: "returned-directly" });
  const writes = requests.filter(request => request.action === "database.modifyDocument");
  assert.deepEqual(EJSON.parse(writes[0].params.data), raw, "set(raw) does not accept a data wrapper");
  assert.deepEqual(EJSON.parse(writes[1].params.data), { $set: { count: 2 } }, "update(raw) uses the official UpdateSerializer");
  assert(writes.every(request => request.params.transactionId));
  assert.equal(documentData(await db.collection("fixtures").doc("present").get()).count, 2, "non-transaction array reads remain supported");
  committed.events = { event: { _id: "event", status: "active" } };
  committed.registrations = { registration: { _id: "registration", batch_id: "session" } };
  conflictOnce = true;
  const row = { batch_id: "session", registration_id: "registration", actual_attendee_name: "Synthetic Member" };
  const saved = await persistCheckin(db, row, { actual_attendee_name: "Synthetic Member" }, { eventDocumentId: "event", validateEvent: event => event.status === "active" });
  assert.equal(saved.already, false);
  assert.equal(committed.checkins[saved.id].sync_state, "PENDING");
  assert.equal(committed.registrations.registration.actual_attendee_name, "Synthetic Member");
  assert.equal((await persistCheckin(db, row)).already, true);
  const cross = await ensureCrossRegistration(db, { batch_id: "session", platform_member_id: "22" });
  assert.equal(committed.registrations[cross.id].platform_member_id, "22");
  failAction = "database.getDocument";
  await assert.rejects(() => persistCheckin(db, { ...row, registration_id: "other" }), error => error.code === "ISOLATED_STORAGE_ERROR");
  committed.registrations.other = { _id: "other", batch_id: "session" };
  failAction = "database.modifyDocument";
  await assert.rejects(() => persistCheckin(db, { ...row, registration_id: "other" }), error => error.code === "ISOLATED_STORAGE_ERROR");
  assert.equal(Object.keys(committed.checkins).length, 1, "failed SDK writes roll back the fact");
  assert.throws(() => documentData({ code: "ISOLATED_STORAGE_ERROR" }), /DATABASE_OPERATION_FAILED/);
  assert.throws(() => requireDatabaseSuccess({ code: "ISOLATED_STORAGE_ERROR" }), /DATABASE_OPERATION_FAILED/);
  const prefix = "stg_signin_20261009_a1b2c3d4_";
  const formalSnapshot = structuredClone(committed);
  committed[prefix + "events"] = { event: { _id: "event", status: "active" } };
  committed[prefix + "registrations"] = { registration: { _id: "registration", batch_id: "session" } };
  const scoped = createScopedDatabase(db, prefix), firstRequest = requests.length;
  for (const ref of [scoped.collection("events"), scoped.collection("events").where({}).limit(1), scoped.collection("events").doc("event")]) {
    assert.equal(Object.isFrozen(ref), true);
    for (const key of ["_db", "database", "transaction", "_transaction", "collection"]) assert.equal(ref[key], undefined);
  }
  conflictOnce = true;
  const scopedSaved = await persistCheckin(scoped, row, { actual_attendee_name: "Synthetic scoped" }, { eventDocumentId: "event", validateEvent: event => event.status === "active", claimKey: "shared-test-identity" });
  assert.equal(scopedSaved.already, false, "the formal checkin with the same ID is invisible to the scoped engine");
  assert.equal(committed[prefix + "checkins"][scopedSaved.id].sync_state, "PENDING");
  assert.equal((await persistCheckin(scoped, row)).already, true);
  assert.equal(committed[prefix + "registrations"].registration.actual_attendee_name, "Synthetic scoped");
  assert.equal(Object.keys(committed[prefix + "config"]).length, 1);
  const scopedSnapshot = structuredClone(committed);
  await assert.rejects(() => scoped.runTransaction(async tx => { await tx.collection("checkins").doc("discard").set({ marker: "discard" }); throw new Error("scoped rollback"); }), /scoped rollback/);
  assert.deepEqual(committed, scopedSnapshot);
  for (const name of ["events", "registrations", "checkins", "fixtures"]) assert.deepEqual(committed[name], formalSnapshot[name]);
  assert(requests.slice(firstRequest).filter(request => request.params.collectionName).every(request => request.params.collectionName.startsWith(prefix)), "all real SDK serializers and transaction retries use the test collection names");
  assert.throws(() => scoped.collection(prefix + "checkins"), /STAGING_COLLECTION_NOT_ALLOWED/);
  await assert.rejects(() => scoped.runTransaction(tx => tx.collection("users")), /STAGING_COLLECTION_NOT_ALLOWED/);
  console.log("official CloudBase database 1.4.3 contract tests passed: pinned SDK 3.18.3; real serializers, retries, rollback and shared-resource test collection isolation; network transport isolated");
})().catch(error => { console.error(error); process.exitCode = 1; });
