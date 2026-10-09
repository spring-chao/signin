const nodeAssert = require("assert"), Module = require("module");
let assertions = 0;
const assert = new Proxy(nodeAssert, {
  apply(target, receiver, args) { assertions++; return Reflect.apply(target, receiver, args); },
  get(target, key) { const value = target[key]; return typeof value === "function" ? (...args) => { assertions++; return value(...args); } : value; }
});
const { createAtomicDatabase } = require("./support/atomic_database");
const { COLLECTIONS, validateSharedStagingNamespace, resolveDatabaseScope, createScopedDatabase } = require("../cloudfunc/staging-database");
const { PRODUCTION_ENVIRONMENT_ID, legacyCheckinUrl } = require("../cloudfunc/staging-urls");
const { persistCheckin } = require("../cloudfunc/platform-service");
const prefix = "stg_signin_20261009_a1b2c3d4_";
const seed = Object.fromEntries(COLLECTIONS.map(name => [name, [{ _id: "production-sentinel", marker: name }]]));
for (const name of COLLECTIONS) seed[prefix + name] = [];
const raw = createAtomicDatabase(seed), before = structuredClone(seed);
const accesses = [], initialized = [];
const collection = raw.collection.bind(raw);
raw.collection = name => { accesses.push(name); return collection(name); };
const load = Module._load;
Module._load = function(name, parent, main) {
  if (name === "@cloudbase/node-sdk") return { init: options => { initialized.push(options.env); return { database: () => raw }; } };
  return load.call(this, name, parent, main);
};
const api = require("../cloudfunc/index");
Module._load = load;
process.env.SIGNIN_PLATFORM_API_KEY = "synthetic-shared-test-only";
process.env.SIGNIN_DEPLOYMENT_MODE = "staging-shared";
process.env.SIGNIN_CLOUDBASE_ENV_ID = PRODUCTION_ENVIRONMENT_ID;
process.env.CHECKIN_ROSTER_API_BASE = "https://stage-api.signin-fixture.net/platform";

async function request(path, method = "GET", body = {}) {
  const response = await api.main({ path, httpMethod: method, headers: { "X-API-Key": process.env.SIGNIN_PLATFORM_API_KEY }, body: JSON.stringify(body) });
  return { status: response.statusCode, data: JSON.parse(response.body || "{}") };
}

(async () => {
  for (const invalid of ["", "events", "stg_signin_20260230_a1b2c3d4_", "stg_signin_20261009_0000000_", prefix + "events", "../" + prefix, prefix.toUpperCase(), prefix + " "]) {
    assert.throws(() => validateSharedStagingNamespace(invalid), /SHARED_STAGING_NAMESPACE_REQUIRED/);
    process.env.SIGNIN_STAGING_NAMESPACE = invalid;
    await assert.rejects(() => request("/health"), /SHARED_STAGING_NAMESPACE_REQUIRED/);
    assert.equal(initialized.length, 0, "unsafe shared configuration rejects before SDK init");
  }
  assert.throws(() => resolveDatabaseScope({ mode: "staging-shared", environmentId: "different-env", namespace: prefix }), /SHARED_STAGING_ENVIRONMENT_MISMATCH/);
  assert.throws(() => resolveDatabaseScope({ mode: "production", environmentId: PRODUCTION_ENVIRONMENT_ID, namespace: prefix }), /STAGING_NAMESPACE_REQUIRES_SHARED_MODE/);
  assert.throws(() => resolveDatabaseScope({ mode: "staging", environmentId: PRODUCTION_ENVIRONMENT_ID }), /ISOLATED_STAGING_ENVIRONMENT_REQUIRED/);
  assert.equal(legacyCheckinUrl({}, "staging-shared"), null);
  assert.equal(legacyCheckinUrl({ SIGNIN_LEGACY_URL: "https://spring-chao.github.io/signin/" }, "staging-shared"), null);
  for (const mode of ["staging", "staging-shared"]) {
    assert.throws(() => api._test.resolveOpsConnection({ OPS_API_BASE: "https://seiwajyuku-ops-old.sh.run.tcloudbase.com", SIGNIN_DEPLOYMENT_MODE: mode }), /ISOLATED_STAGING_HTTPS_URL_REQUIRED/);
    assert.throws(() => api._test.resolveOpsConnection({ CHECKIN_ROSTER_API_BASE: "https://seiwajyuku-platform-api-287369-8-1453587887.sh.run.tcloudbase.com", SIGNIN_DEPLOYMENT_MODE: mode }), /ISOLATED_STAGING_HTTPS_URL_REQUIRED/);
    assert.equal(api._test.resolveOpsConnection({ CHECKIN_ROSTER_API_BASE: process.env.CHECKIN_ROSTER_API_BASE, CHECKIN_ROSTER_API_KEY: "test-roster", SIGNIN_DEPLOYMENT_MODE: mode }).base, process.env.CHECKIN_ROSTER_API_BASE);
  }
  process.env.SIGNIN_STAGING_NAMESPACE = prefix;
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal(initialized.at(-1), PRODUCTION_ENVIRONMENT_ID);
  assert.deepEqual(new Set(accesses), new Set(COLLECTIONS.map(name => prefix + name)));
  const version = await request("/version");
  assert.equal(version.data.storage_scope, "SAME_ENVIRONMENT_TEST_COLLECTIONS");
  assert.equal(version.data.staging_namespace, prefix);
  const permissions = ["attendance:view", "attendance:create"];
  const empty = await request("/ops/v1/manage/admin_events", "POST", { actor: { id: "test-operator", permissions }, allowed_org_unit_ids: null, payload: {} });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.items.length, 0, "formal sentinel events are not visible to the test engine");
  const date = "2030-10-09";
  const created = await request("/ops/v1/manage/create_event", "POST", {
    actor: { id: "test-operator", permissions }, allowed_org_unit_ids: null,
    payload: { event_name: "Synthetic shared-resource test", event_date: date, activity_type: "course", org_unit_id: "synthetic-center", checkin_start_at: date + "T08:00", checkin_end_at: date + "T10:00", scheduled_start_at: date + "T09:00", scheduled_end_at: date + "T12:00" }
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.ok, true);
  assert.equal(raw.collections[prefix + "events"].length, 1);
  const scoped = createScopedDatabase(raw, prefix);
  assert.equal(Object.isFrozen(scoped), true);
  for (const ref of [scoped.collection("events"), scoped.collection("events").where({}).limit(1), scoped.collection("events").doc("test")]) {
    assert.equal(Object.isFrozen(ref), true);
    for (const key of ["_db", "database", "transaction", "_transaction", "collection"]) assert.equal(ref[key], undefined);
  }
  for (const invalid of ["users", prefix + "events", "events/registrations", "__proto__", {}, ""]) {
    const count = accesses.length;
    assert.throws(() => scoped.collection(invalid), /STAGING_COLLECTION_NOT_ALLOWED/);
    assert.equal(accesses.length, count, "invalid collection does not reach the raw SDK");
    await assert.rejects(() => scoped.runTransaction(tx => tx.collection(invalid)), /STAGING_COLLECTION_NOT_ALLOWED/);
    assert.equal(accesses.length, count);
  }
  raw.collections[prefix + "registrations"].push({ _id: "test-registration", batch_id: "test-event" });
  const previousConfigCount = raw.collections[prefix + "config"].length;
  const saved = await persistCheckin(scoped, { batch_id: "test-event", registration_id: "test-registration", actual_attendee_name: "Synthetic" }, { actual_attendee_name: "Synthetic" }, { claimKey: "test-claim" });
  assert.equal(saved.already, false);
  assert.equal((await persistCheckin(scoped, { batch_id: "test-event", registration_id: "test-registration" })).already, true);
  assert.equal(raw.collections[prefix + "checkins"].length, 1);
  assert.equal(raw.collections[prefix + "config"].length, previousConfigCount + 1);
  assert.equal(raw.collections[prefix + "registrations"][0].actual_attendee_name, "Synthetic");
  const committed = structuredClone(raw.collections);
  await assert.rejects(() => scoped.runTransaction(async tx => { await tx.collection("checkins").doc("rollback").set({ marker: "discard" }); throw new Error("synthetic rollback"); }), /synthetic rollback/);
  assert.deepEqual(raw.collections, committed);
  api._test.setPlatformRequestHandler(async () => { throw new Error("synthetic platform outage"); });
  const failedRetry = await api.main({ Type: "Timer", TriggerName: "attendanceSyncRetryEvery5Minutes" });
  assert.equal(failedRetry.attempted_count, 1);
  assert.equal(failedRetry.delivered_count, 0);
  assert.equal(raw.collections[prefix + "checkins"][0].sync_state, "PENDING");
  assert.equal(raw.collections[prefix + "checkins"][0].sync_attempts, 1);
  raw.collections[prefix + "checkins"][0].sync_next_retry_at = new Date(0).toISOString();
  api._test.setPlatformRequestHandler(async () => ({ success: true, data: { status: "SUCCESS" } }));
  const recoveredRetry = await api.main({ Type: "Timer", TriggerName: "attendanceSyncRetryEvery5Minutes" });
  assert.equal(recoveredRetry.attempted_count, 1);
  assert.equal(recoveredRetry.delivered_count, 1);
  assert.equal(raw.collections[prefix + "checkins"][0].sync_state, "DELIVERED");
  assert(accesses.every(name => name.startsWith(prefix)), "every engine read, management write and transaction access stays in test collections");
  for (const name of COLLECTIONS) assert.deepEqual(raw.collections[name], before[name], "formal sentinel collection remains unchanged: " + name);
  console.log("shared staging isolation tests passed: " + assertions + " assertions; real engine handlers, query/write/transaction/rollback isolation; synthetic transport only");
})().catch(error => { console.error(error); process.exitCode = 1; });
