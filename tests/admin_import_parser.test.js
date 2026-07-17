const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!match) throw new Error("admin inline script not found");

const elementStub = {
  addEventListener() {},
  classList: { add() {}, remove() {} },
  style: {},
  value: "",
  textContent: "",
  innerHTML: ""
};
const context = {
  console,
  document: {
    getElementById() { return elementStub; },
    querySelectorAll() { return []; }
  },
  fetch: async () => { throw new Error("network not available in parser test"); },
  alert() {},
  confirm() { return false; },
  prompt() { return null; },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};
vm.createContext(context);
vm.runInContext(match[1], context, { filename: "admin-inline.js" });

const shuffledRows = Array.from({ length: 20 }, () => []);
shuffledRows[0] = ["某某活动报名名单"];
shuffledRows[4] = ["制表时间", "2026-07-17"];
shuffledRows[12] = ["备注", "手机号码（必填）", "所属分中心", "公司名称", "报名人姓名", "小组名称"];
shuffledRows[13] = ["", "13800000001", "园区", "示例公司", "张三", "第一组"];

const detected = context.findHeaderRow(shuffledRows);
assert(detected, "应能找到不在前5行的表头");
assert.equal(detected.rowIndex, 12);
assert.equal(detected.columns.phone, 1);
assert.equal(detected.columns.center, 2);
assert.equal(detected.columns.company, 3);
assert.equal(detected.columns.name, 4);
assert.equal(detected.columns.group_name, 5);

const competingRows = [
  ["说明"],
  ["姓名", "手机号"],
  [],
  ["其他内容"],
  ["姓名（必填）", "工作单位", "联系电话", "班级名称", "小组名称"]
];
const best = context.findHeaderRow(competingRows);
assert.equal(best.rowIndex, 4, "多个候选表头时应选择识别字段更多的一行");
assert.equal(best.columns.name, 0);
assert.equal(best.columns.company, 1);
assert.equal(best.columns.phone, 2);
assert.equal(best.columns.class_name, 3);

const arbitraryOrder = context.detectColumns(["晚宴桌号", "企业", "mobile", "参会人姓名", "分部"]);
assert.equal(arbitraryOrder.dinner_table_num, 0);
assert.equal(arbitraryOrder.company, 1);
assert.equal(arbitraryOrder.phone, 2);
assert.equal(arbitraryOrder.name, 3);
assert.equal(arbitraryOrder.center, 4);

assert.equal(context.findHeaderRow([["姓名"], ["手机号"]]), null, "姓名和手机号必须在同一表头行");
const tooLate = Array.from({ length: 102 }, () => []);
tooLate[100] = ["姓名", "手机号"];
assert.equal(context.findHeaderRow(tooLate), null, "只扫描前100行以避免误识别正文");

console.log("admin Excel parser regression tests passed");
