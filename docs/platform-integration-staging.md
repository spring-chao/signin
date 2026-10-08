# 平台签到隔离验证

只适用独立开发环境及合成数据。本次未发布、未触碰生产数据库或旧二维码流量。`cloudbaserc.json` 原生产环境/工作日触发器保持；`cloudbaserc.staging.json` 的无效占位符必须在部署至用户指定的独立测试环境时替换。

## 本地实际引擎 HTTP 入口

`scripts/staging/serve-engine.js` 加载实际 cloudfunc handlers，仅替换 SDK 初始化为合成、进程内事务数据库；没有真实 CloudBase 登录/数据库调用。它只监听127.0.0.1。数据库种子结构为 config/events/registrations/checkins/event_audit_logs 数组，报名 `_id` 必须明确，活动和场次使用同一实际 event_id。

使用独立合成密钥设置环境，运行：

```powershell
$env:SIGNIN_PLATFORM_API_KEY = '<synthetic-management-key>'
$env:SIGNIN_SERVICE_API_KEY = '<different-synthetic-reading-key>'
$env:SIGNIN_STAGING_PORT = '8766'
$env:SIGNIN_STAGING_SEED_FILE = '<absolute-synthetic-seed.json>'
$env:CHECKIN_ROSTER_API_BASE = 'http://127.0.0.1:8765'
$env:CHECKIN_ROSTER_API_KEY = '<synthetic-roster-reading-key>'
node scripts/staging/serve-engine.js
```

平台 `SIGNIN_API_BASE_URL` 指向该本地入口，平台管理配置 key 对应 signin_platform_api_key；所有密钥必须不同用途独立配置。HTTP 出站仅允许 loopback，本地平台停服能真实测试2秒失败、PENDING及恢复后增量拉取。`GET /__staging__/snapshot` 只查看合成状态；`POST /__staging__/retry` 令合成 PENDING 到期并实际调用 timer handler。进程退出数据丢失，不能证明云端持久化或使用真实业务名单。

## 独立云环境准备（未执行）

模板函数运行时配置 `SIGNIN_DEPLOYMENT_MODE=staging` 及 `SIGNIN_CLOUDBASE_ENV_ID`。此ID必须与模板 envId 的独立环境一致；空值、原生产ID、占位符/非法格式在任何 SDK init 前拒绝。staging 构建清单也启用相同环境防护。本地 adapter 明确为 local-isolated，完全拦截 SDK，不连接云环境。

创建合成数据专用的原有集合 config、events、registrations、checkins、event_audit_logs；没有新增业务集合。准备索引：

- checkins 复合索引 `sync_state ASC, sync_next_retry_at ASC`，支持 PENDING 有序40条重试；确认索引已生效后再启用 timer。
- registrations 原分页使用 `batch_id ASC, created_at ASC`；精确单条增量另涉及 batch_id/_id，按隔离 CloudBase 的查询诊断确认相应组合索引。
- checkins 的 batch_id/registration_id 精确查询及现有列表查询，按隔离环境查询诊断核验索引，不访问生产索引元数据。

函数 timeout 明确120秒，高于40条各最多2秒 HTTP 投递约80秒的预算；另需记录隔离云DB耗时并验证剩余余量。5分钟timer是 `0 */5 * * * * *`，原工作日完整同步为 `0 0 0 ? * MON-FRI *`，工作日任务不先运行逐条重试。模板环境变量不是生产 secrets 的替代品；按官方CLI配置环境变量语义核验部署合并/覆盖行为，确保独立环境服务key及出站key完整配置，不打印值。

## 可重复回归

```bash
node tests/checkin_api.test.js
node tests/course_checkin.test.js
node tests/admin_import_parser.test.js
node tests/public_page.test.js
node tests/platform_integration.test.js
npm ci --prefix cloudfunc --ignore-scripts --no-audit --no-fund
node tests/cloudbase_sdk_contract.test.js
```

CI包括原 API、课程/团队、Excel解析、公开页面，新服务认证/RBAC/组织祖先/并发/单条增量/平台故障/票据时钟差/云环境防护及真实官方 SDK 事务契约。SDK测试只替换网络 transport，运行安装包真实的 document、serializer、transaction 实现，不会连接CloudBase。

联合HTTP验收需覆盖：通过实际平台管理创建/编辑/关闭活动；可信名单和追加Excel预览；绑定会员扫活动码确认；早上/下午/空巴分别签到；普通来宾与团队兼容；同名不自动映射；20次并发只写一事实；平台真实停服后的原生确认及 PENDING；恢复后timer同步、活动参与/成长记录更新；越权与组织错误失败关闭；新旧入口 LEGACY 标签。小程序真实设备域名、独立云事务持久化和timer云配置尚待指定隔离环境后实测；生产切换另需授权。不以本地合成测试宣称真实设备或云环境验收完成。
