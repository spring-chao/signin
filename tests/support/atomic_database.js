// A serializable in-memory document transaction double. It implements the
// documented SDK doc.get/set/update semantics and rolls back failed callbacks.
function enableAtomicTransactions(db) {
  const originalCollection = db.collection.bind(db);
  db.collection = name => {
    const query = originalCollection(name);
    const originalDoc = query.doc.bind(query);
    query.doc = id => {
      const doc = originalDoc(id);
      doc.get = async () => ({ data: (db.collections[name] || []).filter(row => row._id === id).map(row => ({ ...row })) });
      doc.set = async value => {
        const rows = db.collections[name] || (db.collections[name] = []);
        const index = rows.findIndex(row => row._id === id);
        const row = { ...value, _id: id };
        if (index < 0) rows.push(row);
        else rows[index] = row;
        return { id };
      };
      return doc;
    };
    return query;
  };
  let tail = Promise.resolve();
  db.runTransaction = callback => {
    const result = tail.then(async () => {
      const snapshot = structuredClone(db.collections);
      try { return await callback(db); }
      catch (error) {
        for (const key of Object.keys(db.collections)) delete db.collections[key];
        Object.assign(db.collections, snapshot);
        throw error;
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  return db;
}

function createAtomicDatabase(seed = {}) {
  const collections = structuredClone(seed);
  let nextId = 1;
  const rowsFor = name => collections[name] || (collections[name] = []);
  const db = { collections, collection(name) {
    let filter = {}, skip = 0, limit = Infinity, sorts = [];
    const query = {
      where(criteria) { filter = criteria; return query; },
      skip(value) { skip = value; return query; },
      limit(value) { limit = value; return query; },
      orderBy(field, direction) { sorts.push([field, direction]); return query; },
      async get() {
        const rows = rowsFor(name).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
        rows.sort((a, b) => {
          for (const [field, direction] of sorts) {
            const compared = String(a[field] || "").localeCompare(String(b[field] || ""));
            if (compared) return direction === "desc" ? -compared : compared;
          }
          return 0;
        });
        return { data: rows.slice(skip, skip + limit).map(row => ({ ...row })) };
      },
      async add(value) { const id = name + "-" + nextId++; rowsFor(name).push({ ...value, _id: id }); return { id }; },
      async update(value) { const rows = rowsFor(name).filter(row => Object.entries(filter).every(([key, expected]) => row[key] === expected)); rows.forEach(row => Object.assign(row, value)); return { updated: rows.length }; },
      doc(id) { return {
        async update(value) { const row = rowsFor(name).find(row => row._id === id); if (!row) throw new Error("document not found"); Object.assign(row, value); return { updated: 1 }; },
        async remove() { const rows = rowsFor(name), index = rows.findIndex(row => row._id === id); if (index >= 0) rows.splice(index, 1); return { deleted: index >= 0 ? 1 : 0 }; }
      }; }
    };
    return query;
  } };
  return enableAtomicTransactions(db);
}

module.exports = { enableAtomicTransactions, createAtomicDatabase };
