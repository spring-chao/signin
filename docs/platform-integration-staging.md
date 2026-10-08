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

### 独立打包入口与外部配置

仅使用 `scripts/release/prepare-staging.ps1`（PowerShell7及Node18+），旧通用prepare.ps1的staging模式会拒绝并提示新入口。脚本要求源码Git工作树干净且已提交；只复制tracked cloudfunc/public，忽略node_modules、临时证据与Git目录，只修改仓库外全新输出副本，拒绝符号链接把输出导回仓库。部署前仍要在输出目录执行lock依赖安装。

必须由外部明确提供：

- 独立CloudBase环境ID，及可操作该隔离环境的CLI登录/权限；不得使用原生产ID或占位符。
- staging平台HTTPS API基址（网关带/platform时保留前缀）、staging引擎HTTPS基址（可含/api）、staging兼容页HTTPS地址；禁止生产主机、非HTTPS、URL凭据、query/fragment、本机/IP/占位域名及非443端口。参数未提供时停止，不用测试fixture地址代替真实配置。
- 三个独立用途的服务key：SIGNIN_PLATFORM_API_KEY、SIGNIN_SERVICE_API_KEY、CHECKIN_ROSTER_API_KEY；兼容团队流程及旧后台另需ADMIN_PASSWORD_HASH。打包配置只保存外部环境变量引用，包和日志不保存密钥值。
- 相同地址/密钥在隔离平台端配置SIGNIN_API_BASE_URL、SIGNIN_LEGACY_URL、signin_platform_api_key及读取/名单连接；自定义域名HTTPS证书、HTTP网关路径、小程序合法域名按测试环境配置。

以下是填入真实已提供值后的命令，尚未执行，不包含真实密钥。运行前将各变量设为实际隔离地址，不能直接使用本段占位符：

```powershell
pwsh -File ./scripts/release/prepare-staging.ps1 -EnvId $stagingEnvId -PlatformUrl $platformHttpsBase -EngineUrl $engineHttpsBase -LegacyUrl $legacyHttpsPage
# 将脚本输出RELEASE_ROOT赋给$stagingBundle；四个secret在当前受控环境/密钥托管提供，不打印。
npm ci --prefix "$stagingBundle/cloudfunc" --ignore-scripts --no-audit --no-fund
tcb --version
tcb fn deploy --help
# 先在指定独立环境创建下述集合/索引，核验完整envVariables引用已解析，再部署。
tcb fn deploy checkinApi -e $stagingEnvId --config-file "$stagingBundle/cloudbaserc.json" --dir "$stagingBundle/cloudfunc" --install-dependency false
tcb fn deploy checkinApiSyncRetry -e $stagingEnvId --config-file "$stagingBundle/cloudbaserc.json" --dir "$stagingBundle/cloudfunc" --install-dependency false
tcb fn detail checkinApi -e $stagingEnvId
tcb fn detail checkinApiSyncRetry -e $stagingEnvId
tcb routes list -e $stagingEnvId
```

两函数使用同一源码SHA/SDKlock/独立数据库，checkinApi保留工作日timer，checkinApiSyncRetry仅运行5分钟重试，避免官方CLI所述单函数单trigger限制。输出cloudbaserc.json和cloudbaserc.staging.json相同，manifest与两个build-info包括独立环境/三地址及NOT_DEPLOYED状态。两静态页API常量替换为引擎测试基址；运行时staging无合法SIGNIN_LEGACY_URL时fallback_url为null，不会返回生产兼容页。生产未配置时仍使用既有默认地址。

网关仍需在该独立环境绑定checkinApi并验证路径透传；不把本事件函数改成--httpFn。依CLI实际版本/既有独立网关选择命令或控制台设置，不能沿用README的生产入口/旧生产二维码。只上传本输出目录的public副本到隔离静态站点。CLI环境变量合并/覆盖必须使用完整隔离配置，避免覆盖丢失secret；不要启用会打印请求参数的verbose模式。[官方部署命令](https://docs.cloudbase.net/cli-v1/functions/deploy)、[config-file通用选项](https://docs.cloudbase.net/en/cli-v1/global-options)、[函数配置与变量语义](https://docs.cloudbase.net/en/cli-v1/functions/configs)。

模板函数运行时配置 `SIGNIN_DEPLOYMENT_MODE=staging` 及 `SIGNIN_CLOUDBASE_ENV_ID`。此ID必须与模板 envId 的独立环境一致；空值、原生产ID、占位符/非法格式在任何 SDK init 前拒绝。staging 构建清单也启用相同环境防护。本地 adapter 明确为 local-isolated，完全拦截 SDK，不连接云环境。

创建合成数据专用的原有集合 config、events、registrations、checkins、event_audit_logs；没有新增业务集合。准备索引：

- checkins 复合索引 `sync_state ASC, sync_next_retry_at ASC`，支持 PENDING 有序40条重试；确认索引已生效后再启用 timer。
- registrations 原分页使用 `batch_id ASC, created_at ASC`；精确单条增量另涉及 batch_id/_id，按隔离 CloudBase 的查询诊断确认相应组合索引。
- checkins 的 batch_id/registration_id 精确查询及现有列表查询，按隔离环境查询诊断核验索引，不访问生产索引元数据。

两函数 timeout 明确120秒，高于重试40条各最多2秒 HTTP投递约80秒的预算；另需记录隔离云DB耗时并验证剩余余量。5分钟timer是 `0 */5 * * * * *`，原工作日完整同步为 `0 0 0 ? * MON-FRI *`，工作日任务不先运行逐条重试。源模板保留两timer定义供专用打包器拆分到独立函数；不能把源占位模板直接当作已部署配置。模板环境变量不是生产secrets的替代品。

## 可重复回归

```bash
node tests/checkin_api.test.js
node tests/course_checkin.test.js
node tests/admin_import_parser.test.js
node tests/public_page.test.js
node tests/platform_integration.test.js
node tests/staging_package.test.js
npm ci --prefix cloudfunc --ignore-scripts --no-audit --no-fund
node tests/cloudbase_sdk_contract.test.js
```

CI包括原 API、课程/团队、Excel解析、公开页面，新服务认证/RBAC/组织祖先/并发/单条增量/平台故障/票据时钟差/云环境防护、专用隔离打包及真实官方SDK事务契约。打包测试使用临时合成源码fixture与Git元数据替身，检查输出副本、拒绝危险参数、实际PowerShell入口、manifest、独立timer及源文件不变；fixture输出验收后删除，不是实际云部署包。SDK测试只替换网络transport，运行真实document、serializer、transaction实现，不连接CloudBase。

联合HTTP验收需覆盖：通过实际平台管理创建/编辑/关闭活动；可信名单和追加Excel预览；绑定会员扫活动码确认；早上/下午/空巴分别签到；普通来宾与团队兼容；同名不自动映射；20次并发只写一事实；平台真实停服后的原生确认及 PENDING；恢复后timer同步、活动参与/成长记录更新；越权与组织错误失败关闭；新旧入口 LEGACY 标签。小程序真实设备域名、独立云事务持久化和timer云配置尚待指定隔离环境后实测；生产切换另需授权。不以本地合成测试宣称真实设备或云环境验收完成。
