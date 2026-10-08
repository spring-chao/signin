// Isolated local staging only: execute the actual engine against synthetic,
// process-local document storage. Never initialize the CloudBase SDK.
const fs = require("fs");
const http = require("http");
const Module = require("module");
const { createAtomicDatabase } = require("../../tests/support/atomic_database");
// This adapter replaces SDK initialization completely; its fixtures never
// resolve a real cloud environment, even when opened from a staging artifact.
process.env.SIGNIN_DEPLOYMENT_MODE = "local-isolated";
if (!process.env.SIGNIN_PLATFORM_API_KEY || !process.env.SIGNIN_SERVICE_API_KEY) throw new Error("Set two independent synthetic staging service keys");
if (process.env.SIGNIN_PLATFORM_API_KEY === process.env.SIGNIN_SERVICE_API_KEY) throw new Error("Staging service keys must be independent");
const seed = process.env.SIGNIN_STAGING_SEED_FILE ? JSON.parse(fs.readFileSync(process.env.SIGNIN_STAGING_SEED_FILE, "utf8")) : {};
const db = createAtomicDatabase({ config: [], events: [], registrations: [], checkins: [], event_audit_logs: [], ...seed });
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === "@cloudbase/node-sdk") return { init: () => ({ database: () => db }) };
  return originalLoad.call(this, name, parent, main);
};
const engine = require("../../cloudfunc/index");
Module._load = originalLoad;
const port = Number(process.env.SIGNIN_STAGING_PORT || 8766);
http.createServer(async (req, res) => {
  let raw = "";
  try {
    for await (const chunk of req) { raw += chunk; if (raw.length > 5 * 1024 * 1024) throw new Error("request too large"); }
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (url.pathname === "/__staging__/snapshot" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(db.collections)); return;
    }
    if (url.pathname === "/__staging__/retry" && req.method === "POST") {
      for (const row of db.collections.checkins) if (row.sync_state === "PENDING") row.sync_next_retry_at = "2000-01-01T00:00:00Z";
      const result = await engine.main({ Type: "Timer", TriggerName: "attendanceSyncRetryEvery5Minutes" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(result)); return;
    }
    const response = await engine.main({ path: url.pathname.replace(/^\/api(?=\/)/, ""), httpMethod: req.method, headers: req.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: raw });
    res.writeHead(response.statusCode, response.headers); res.end(response.body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, code: "ISOLATED_STAGING_ERROR" }));
  }
}).listen(port, "127.0.0.1", () => console.log("Isolated signin engine listening at http://127.0.0.1:" + port + " (synthetic in-memory state only)"));
