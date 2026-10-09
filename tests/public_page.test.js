const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const publicRoot = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

assert.equal(scripts.length, 1, "公开签到页应包含一个内联脚本");
assert.doesNotThrow(() => new Function(scripts[0]), "公开签到页内联脚本必须通过语法检查");
assert(html.includes("盛和塾｜江南"), "公开签到页应使用盛和塾江南品牌标识");
assert(html.includes("assets/jiangnan-logo.png"), "公开签到页应加载盛和塾江南 Logo");
assert(fs.existsSync(path.join(publicRoot, "assets", "jiangnan-logo.png")), "盛和塾江南 Logo 文件应存在");
assert(html.includes("确认签到"), "公开签到页主按钮应显示确认签到");
assert(!html.includes("查找我的报名"), "公开签到页不应再显示查找我的报名");
assert(!html.includes("进入签到"), "活动卡片不应再显示进入签到");

async function verifyActivityLink(query, expectedIds) {
  const elements = new Map();
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, innerHTML: "", textContent: "", appendChild() {}, addEventListener() {} });
  const events = [
    { event_id: "morning", event_group_id: "learning", name: "上午", checkin_status: "open" },
    { event_id: "afternoon", event_group_id: "learning", name: "下午", checkin_status: "upcoming" },
    { event_id: "other", name: "其他活动", checkin_status: "open" }
  ];
  const context = vm.createContext({
    URLSearchParams, window: { location: { search: query } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    fetch: async () => ({ json: async () => ({ display_events: events, active_events: events.filter(e => e.checkin_status === "open"), active_event_count: 2 }) }),
    setInterval: () => 1, clearInterval() {}, setTimeout() {}
  });
  // Loading the deployed inline script and exercising its real fetch/render path
  // verifies that refreshes cannot select another activity for a dedicated link.
  vm.runInContext(scripts[0], context);
  await context.init();
  await context.init();
  assert.deepStrictEqual(Array.from(context.activityDisplayEvents, e => e.event_id).sort(), [...expectedIds].sort());
  if (expectedIds.length === 1) assert.equal(context.selectedActivityEventId, expectedIds[0]);
  if (query) assert.equal(elements.get("submitBtn").disabled, query !== "?event_id=morning");
}

(async () => {
  await verifyActivityLink("", ["morning", "afternoon", "other"]);
  await verifyActivityLink("?event_id=morning", ["morning"]);
  await verifyActivityLink("?event_id=afternoon", ["afternoon"]);
  await verifyActivityLink("?event_id=missing", []);
  await verifyActivityLink("?event_id=%3Cscript%3E", []);
  console.log("public_page tests passed (dedicated event links and refresh isolation)");
})().catch(error => { console.error(error); process.exitCode = 1; });
