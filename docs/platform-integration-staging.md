# 平台签到隔离验证

只适用隔离测试资源及合成数据。本次未发布生产版本，未触碰生产数据库或旧二维码流量。`cloudbaserc.json` 原生产环境/工作日触发器保持；默认 staging 模式仍要求独立环境。用户明确优先复用已购标准版后，增加以下显式同环境测试集合模式，打包器输出仍只代表准备；本任务的明确资源授权与实际部署状态见下节，不能由工具凭据推导其他写入许可。

## 2026-10-10 已授权测试部署的实际状态

用户已明确授权在现有 CloudBase 标准版内创建专用测试资源，本任务已执行 `staging-shared` 部署：命名空间 `stg_signin_20261009_70716ba4_` 的五个集合、专用测试 SQL 库、两个测试函数、专用 API 与独立旧 H5 容器。原集合、原函数、正式流量和二维码均未修改。两个容器最小 0、最大 1 实例，没有升级套餐；同环境命名空间隔离仍共享配额与故障范围。

当前引擎应用提交为 `e874d0a046c8cb4be7c1201254090134dc7cbf09`，CI 37963059670 regression 通过。两个实际定时器为工作日零点兜底与五分钟增量重试。专用云函数实际同步依赖故障期间，旧 H5 查找、确认及重复确认正常，事实保存 PENDING；恢复完整配置并调用同一定时处理器后 DELIVERED。恢复后的函数 Active 与原专用配置一致。

旧 H5 已在独立测试容器运行，活动链接固定 event_id；不存在、无效或尚未开放的指定场次不会跳到其他活动。HTTP 和实际部署脚本场次过滤已验证，浏览器界面因工具超时尚未完成。小程序 web-view 仍待业务域名配置，当前复制备用链接提示已经验证；微信原生直扫路径使用现有网关且保留 urlCheck，不依赖 web-view。

平台小程序版本 `2026.10.10.1` 官方上传成功，开发者手机预览码已生成；无有效绑定用户在同页填写姓名确认来宾，已绑定用户显示本人确认。新测试活动已有一条微信来宾事实，约 2.2 秒后送达专用 SQL 库；尚未确认来源于用户手机。当前自动化目标仍为 devtools，手机实际扫描/页面反馈、公众平台体验版选择与旧 H5 浏览器界面均未记为通过。

实际证据保存在同工作区 `outputs/signin-integration-20261007/` 的交付报告及脱敏 JSON；私有配置不进入仓库。以下章节说明可重复准备命令和历史验证方式，“未执行”描述针对独立 EnvId 模式示例，不否定本节已授权的同环境专用资源部署。

## 复用现有标准版的测试准备

`-SharedNamespace` 显式选择 `staging-shared`。目前只接受已核验的现有环境 `shengheshu-d2g2zyyl99f6c6fc2`，命名空间格式必须为 `stg_signin_YYYYMMDD_8位小写hex_`，日期须有效。普通 staging 不传此参数时仍拒绝该生产环境 ID；生产/未知模式误带命名空间也在 SDK 初始化前拒绝。

新增 `cloudfunc/staging-database.js` 将 config、events、registrations、checkins、event_audit_logs 的普通查询与事务统一映射到带该前缀的五个测试集合。SDK 仅向处理器暴露这些集合及所需命令/事务入口，未知集合或已加前缀的输入拒绝，失败事务和 SDK 自动重试均保持映射。原业务文档 ID、幂等键与签到算法保持不变。测试模式的名单/同步 URL 必须显式配置合法测试 HTTPS 地址，禁止沿用 OPS 旧配置回退到生产平台。

打包器生成与现有 checkinApi 不同的函数名，如 `checkinStg20261009a1b2c3d4` 和其 `SyncRetry` 副本；清单记录物理集合映射及 `NOT_DEPLOYED`。两函数仍分别使用原工作日兜底与五分钟重试触发器。私有变量引用改用 SIGNIN_STAGING_PLATFORM_API_KEY、SIGNIN_STAGING_SERVICE_API_KEY、SIGNIN_STAGING_ROSTER_API_KEY、SIGNIN_STAGING_ADMIN_PASSWORD_HASH，避免顺手取用现有生产服务密钥。平台测试副本需使用相同测试密钥和独立测试 SQL 库，不能将测试名单/同步指向现有正式平台。

生成副本示例（仅准备，不创建资源或部署）：

```powershell
pwsh -File ./scripts/release/prepare-staging.ps1 -EnvId $existingStandardEnvId -SharedNamespace $testNamespace -PlatformUrl $testPlatformHttps -EngineUrl $testEngineHttps -LegacyUrl $testLegacyHttps
```

同环境没有独立 EnvId 所提供的资源和故障隔离；该模式只隔离签到集合访问，并要求独立的测试平台数据库。需要在现有正式环境新增上述测试集合、索引、函数和测试网关路由时，应先核验该新增写入范围与资源操作的具体授权，不将“标准版容量足够”解释为修改现有业务数据/函数的批准。现有原集合、生产函数配置、线上码与生产 CloudRun 流量均不在目标范围。本文没有证明云端集合已存在、云事务/定时器已验收、HTTPS 已通或手机预览已上传。

验证入口新增 `node tests/shared_staging.test.js`；真实处理器在合成 adapter 中验证普通读写、无生产哨兵数据泄漏、事务回滚、PENDING 失败重试与恢复投递。`tests/cloudbase_sdk_contract.test.js` 使用实际固定版本 SDK，覆盖相同文档 ID 的两个集合空间、事务冲突重试、claim 和回滚，所有出站 transport 均为合成替身，未连接云数据库。CI 包含这两个入口与同环境打包测试。

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
