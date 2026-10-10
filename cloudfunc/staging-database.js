const { PRODUCTION_ENVIRONMENT_ID, validateStagingEnvironmentId } = require("./staging-urls");

const COLLECTIONS = Object.freeze(["config", "events", "registrations", "checkins", "event_audit_logs"]);

function validateSharedStagingNamespace(value) {
  const namespace = String(value || "");
  const match = /^stg_signin_(20\d{6})_([a-f0-9]{8})_$/.exec(namespace);
  if (!match) throw new Error("SHARED_STAGING_NAMESPACE_REQUIRED");
  const date = match[1];
  const parsed = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))));
  if (parsed.toISOString().slice(0, 10).replace(/-/g, "") !== date) throw new Error("SHARED_STAGING_NAMESPACE_REQUIRED");
  return namespace;
}

// Shared-resource testing is explicit. Ordinary staging still rejects the
// production environment, and a prefix accidentally added to production fails.
function resolveDatabaseScope({ environmentId, mode, namespace }) {
  if (mode === "staging-shared") {
    if (environmentId !== PRODUCTION_ENVIRONMENT_ID) throw new Error("SHARED_STAGING_ENVIRONMENT_MISMATCH");
    return { environmentId, namespace: validateSharedStagingNamespace(namespace) };
  }
  if (namespace) throw new Error("STAGING_NAMESPACE_REQUIRES_SHARED_MODE");
  if (mode === "staging") validateStagingEnvironmentId(environmentId);
  return { environmentId: environmentId || PRODUCTION_ENVIRONMENT_ID, namespace: "" };
}

function collectionMap(namespace) {
  namespace = validateSharedStagingNamespace(namespace);
  return Object.fromEntries(COLLECTIONS.map(name => [name, namespace + name]));
}

function createScopedDatabase(raw, namespace) {
  const names = Object.freeze(collectionMap(namespace));
  function scopedReference(reference) {
    const facade = {};
    for (const method of ["where", "limit", "skip", "orderBy", "doc"]) {
      if (typeof reference[method] === "function") facade[method] = (...args) => scopedReference(reference[method](...args));
    }
    for (const method of ["get", "add", "set", "update", "remove"]) {
      if (typeof reference[method] === "function") facade[method] = (...args) => reference[method](...args);
    }
    return Object.freeze(facade);
  }
  function scopedCollection(target, name) {
    if (typeof name !== "string" || !Object.hasOwn(names, name)) throw new Error("STAGING_COLLECTION_NOT_ALLOWED");
    return scopedReference(target.collection(names[name]));
  }
  if (!raw || typeof raw.collection !== "function" || typeof raw.runTransaction !== "function") throw new Error("STAGING_ATOMIC_DATABASE_REQUIRED");
  // Expose only the operations used by the engine. Neither the underlying DB
  // nor unrestricted transaction collection access is exposed to handlers.
  return Object.freeze({
    collection: name => scopedCollection(raw, name),
    command: raw.command,
    RegExp: typeof raw.RegExp === "function" ? raw.RegExp.bind(raw) : undefined,
    runTransaction: callback => {
      if (typeof callback !== "function") throw new Error("STAGING_TRANSACTION_CALLBACK_REQUIRED");
      return raw.runTransaction(transaction => callback(Object.freeze({
        collection: name => scopedCollection(transaction, name)
      })));
    }
  });
}

module.exports = { COLLECTIONS, validateSharedStagingNamespace, resolveDatabaseScope, collectionMap, createScopedDatabase };
