const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

console.log("public_page tests passed");
