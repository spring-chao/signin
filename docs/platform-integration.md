# 统一平台签到引擎接口（开发契约）

本仓库仍是到场事实写入方。新平台处理登录、RBAC、组织权限、微信身份绑定、操作审计及参与记录同步；服务化网关内部复用旧管理 handler 和同一签到确认逻辑。原 H5 姓名、团队名额、外班确认、旧码访问、重复报名名额及三场班会规则保留。没有执行生产部署、业务数据写入或入口切换。

## 服务认证与管理范围

管理及身份桥接均要求服务端 `X-API-Key: SIGNIN_PLATFORM_API_KEY`，不接受旧管理员 token、读取密钥或短时签到票据。浏览器/小程序不得持有此密钥。读取及即时同步使用独立的 `SIGNIN_SERVICE_API_KEY`；出站名单读取沿用 `CHECKIN_ROSTER_API_KEY` / 原兼容配置。

`POST /ops/v1/manage/{operation}`：

```json
{
  "payload": {"event_id": "activity-id"},
  "actor": {"id": "operator-id", "permissions": ["attendance:view"]},
  "allowed_org_unit_ids": ["authorized-group-id"]
}
```

`actor` 和已展开的组织范围必须由平台认证后构造；`null` 表示平台已授权全局范围。引擎复核操作必要权限与最具体归属：小组优先于班级，班级优先于分中心。org_unit_id可使用最细class/group自身，或兼容经过核验的真实父班/分中心。小组权限不要求同时拥有父班/分中心权限；父级选项仅展示上下文，不扩张授权。创建及修改组织时通过平台严格组织关系核验真实祖先链，名称不参与身份或组织匹配。三场活动组操作复核全部场次范围。

| 操作 | 必要权限 | 行为 |
| --- | --- | --- |
| admin_events、event_detail、stats、class_roster_reconciliation、ops_roster_options | attendance:view | 复用查询，限制组织范围 |
| create_event、create_class_meeting_sessions | attendance:create | 空名单普通活动；小组/班会只使用可信组织名单 |
| upload | attendance:create + attendance:import | 原完整导入创建流程；追加使用 import_apply |
| upload_preview、import_preview、import_apply、ops_roster_members、sync_class_roster | attendance:import | 原名单解析/预览；追加校验预览及名单快照 |
| event_update 元数据 | attendance:update | 编辑名称、日期、类型、时间、组织展示及归属 |
| event_update status/select | attendance:manage | 开关签到/兼容选中；混合元数据须同时有 update |
| event_lifecycle_update CONFIRMED/DRAFT | attendance:update | 确认举办、退回草稿 |
| event_lifecycle_update CANCELLED | attendance:manage | 取消；其他状态拒绝 |
| registration、registration_delete、manual_checkin | attendance:manage | 临时名额、删除未签到报名、人工确认 |
| attendance_status | attendance:status | 预计迟到/请假跟进，实际到场后以签到事实为准 |
| export | attendance:export | 原导出结构，由平台进行脱敏格式化 |
| display_settings | attendance:manage 且全局范围 | 仅 show_group/show_dinner_table |

不开放 reset、clear_all、admin_password、任意 settings 写入及万能管理入口。组织或场次时间在签到开始或产生事实后不能修改；已有普通活动仅在尚未开始且无签到时追加名单，班级/小组名单走原可信名单规则。人工确认继续遵守原公开签到时间/活动状态，仅针对明确个人报名；团队占位必须现场确认实际参加人，不允许后台代填联系人为到场人。

管理 mutation 记录 actor、action、target、timestamp、脱敏 before/after，并返回 `audit={actor,action,target,before,after,timestamp}` 供平台记录。一般响应和 audit 不包含完整手机号、备注、密码或密钥；名单预览仅返回工作流所需签名预览 token，export 交由平台处理原结构。`event_detail` 返回 `event`、可选组场次及每报名名额一行的 `rows`（registration_id、原报名/实际到场姓名、签到时间、角色、班级和 is_team），不通过姓名拼接。

## 已绑定身份与小程序原生确认

服务端桥接 `POST /ops/v1/member-checkin/events|lookup|confirm`。events 返回今日确认举办且开放/即将开始的候选；lookup 接受 `{event_id,member:null}` 仅查询公开元数据，返回 registration:null、can_checkin:false；已绑定 member 以 member_id 优先匹配，member_code 仅兼容无ID历史报名，不做姓名自动映射。同名、团队联系人和无报名身份不会被自动认作已报名学员。

lookup 提供 event、registration、registration_id、already_checked_in、can_checkin、checked_at；外班合法候选有 cross_class_member:true，无报名普通活动lookup为 ok:true、requires_fallback:true。绑定联系人匹配单个或多个团队名额时，lookup返回 ok:true、status:TEAM_FALLBACK、requires_fallback:true、can_checkin:false，不签发普通直签身份；非团队的重复稳定身份继续IDENTITY_CONFLICT拒绝。confirm发现无报名或团队位时必须409/ok:false，保留备用提示，不把无事实结果当作签到成功；预载票据后报名删除/变更也重新核验。今日未开放活动可显示 UPCOMING/notice，confirm 始终遵守原签到时间。确认成功才返回顶层 `sync_status='SYNCED'|'PENDING'`。

公开的 `POST /native/v1/checkin/confirm` 只接受 `{ticket}`。票据由平台已绑定上下文签发：

```text
base64url(payloadJSON) + '.' + base64url(HMAC_SHA256(payloadBase64, SIGNIN_PLATFORM_API_KEY))
payload = {purpose:'MEMBER_CHECKIN', event_id, member:{member_id,member_code,name,
  home_class_org_unit_id,class_org_unit_id,class_name,group_name,group_org_unit_id},
  iat:unixSeconds, exp:iat+300, binding_id, token_version}
```

iat/exp 必须是整数且签发时长严格300秒；只容许签发时钟领先引擎最多5秒，过期仍严格拒绝。票据不能用于管理，不记录在日志或二维码 scene，不接受客户端额外身份参数。context 预加载票据后，平台停止服务仍可直接请求引擎；外班规则使用签名的当前归属快照，仍复用已有确认逻辑。无票据或过期需重新获取上下文/使用现场兼容入口。签名授权错误是401；存储/引擎错误是503，不伪报身份绑定失效。

## 幂等事实与及时同步

全部现有确认入口共用原规则和事务写入器；每活动/报名的确定性 checkin 文档 ID 确保并发唯一，团队签名消费共享原子 claim，外班报名也使用确定性 ID。事务同时保存签到事实及 `sync_state=PENDING`、次数和下一重试时间，不把平台成功作为写入前提。SDK 不支持事务时失败关闭，SDK 返回 code 错误不会被当作写入成功。

提交后最多等待2秒即时通知 `POST /api/v1/attendance/sync/immediate`，body 仅 `{event_id,registration_id}`、读取密钥认证。平台据此拉取引擎事实，不能提交任意事实。只确认 `success:true` 且 data.status 为 SUCCESS/COMPLETED；失败保留 PENDING 与退避重试，成功标记 DELIVERED。并发失败计数不会回退已经 DELIVERED 的记录。

`attendanceSyncRetryEvery5Minutes` 每次按下一重试时间最多投递40条，保留原工作日00:00完整增量同步触发器作为事实兜底；原工作日任务不叠加逐条重试，沿用原时间预算。已部署配置仍未改变，新增短周期触发器只写在隔离 staging 模板。

原 `/ops/v1/attendance/sessions` 和 `/records` 可选 `event_id` 缩小范围；records 再可选 `registration_id` 精确单条（须有 event_id 或 session_id，两者都有时必须一致）。不带新参数的 cursor 和字段行为保持。参与记录保留活动/场次、原报名/实际到场、权威 member ID/code/source；未绑定团队实际参加人不会继承联系人的ID。外班到场继续记录学习事实、score_eligible:false，学分由平台政策处理。引擎的“预计迟到”是跟进状态，真实迟到、早退和学分沿用平台同步规则，前端不另推断。
