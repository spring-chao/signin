# 盛和塾签到系统 (Seiwajyuku Sign-in System)

微信扫码签到的轻量级云签到系统，基于腾讯云 CloudBase 部署。

## 使用方式

### 学长签到（微信扫码）

1. 打印二维码：`static/checkin_qr.png`
2. 学长用微信扫一扫，打开签到页
3. 输入报名时的**姓名 + 11位手机号**
4. 点击确认签到；只命中一个开放活动时直接签到，同一天命中多个活动时先选择本次活动

### 管理后台（多活动管理）

1. 浏览器打开唯一后台入口：`https://{你的域名}/admin.html`
2. 输入管理员密码登录。生产环境不提供默认密码，密码摘要通过云函数环境变量 `ADMIN_PASSWORD_HASH` 配置。
3. 填写活动名称、日期和活动类型，上传 Excel 报名表（支持互动吧导出的 `.xls` / `.xlsx`）
4. 系统新增独立活动，历史活动及签到记录不会被覆盖；新活动默认是“草稿”，必须在后台“确认举办”后才会进入学员公开签到候选；可切换活动查看、导出、手动关闭或取消签到

活动进行中还可以在后台：

- 单独新增临时报名，填写姓名、手机号、分中心、班级、小组等信息，不覆盖现有名单；
- 查看未签到名单。分类维度按“分中心 → 班级 → 小组”择一使用：有分中心数据时按分中心，没有时才依次改用班级、小组；
- 苏州分中心统一为六个标准分中心：园区、姑苏相城、吴江、昆山、新吴、张家港；支持“园区”等模糊写法并自动归一为“园区分中心”；
- 电话确认后将未签到人员标记为“迟到”或“请假”，并记录选填备注；
- 删除姓名等信息填写错误的未签到报名，删除前必须再次确认；已签到报名不能删除；
- 学长之后完成实际签到，最终状态自动以“已签到”为准。

后台登录后默认进入“今日签到”工作区，只自动选择今天正在签到或即将开始的活动；“活动管理”提供按名称、状态、类型和日期筛选的历史活动分页列表，每页默认 20 条、最多 50 条，三场班会先合并为一个逻辑活动再分页；“系统设置”集中放置显示设置、密码和版本状态。历史活动列表只返回活动元数据，报名人数、签到人数和未签到名单仅在打开具体活动后通过统计接口读取。

新增“班会/班级学习会”或“小组学习会”时，可不上传 Excel：选择活动类型后，后台会显示“从运营系统添加班级名单”或“从运营系统添加小组名单”。所选名单唯一来自新运营平台的组织关系，并按班级/小组组织 ID 查询；接口不可用、数量不一致或组织归属异常时失败关闭，不回退到旧系统或名称文本查询。如发现手机号不完整，也会停止导入并提示先修正。观摩人员在活动创建后通过“新增临时报名”追加。

活动类型与运营管理系统统一，包括课程、班会/班级学习会、小组学习会、全国报告会、分中心季度报告会、班主任辅导员培训会、理事会、游学和其他。运营同步按活动分别传输名单和签到结果。

> **Excel 格式要求**：系统自动扫描工作表前 100 行，定位同时包含“姓名”和“手机号”的表头；表头不必在第一行，数据不必从第五行开始，各列顺序可以任意。姓名和手机号为必需列，公司、分中心、班级、小组、组号、桌号等按列名自动识别；无法可靠识别表头时会停止导入并提示检查，不会按固定位置猜测。

---

## 部署指南

### 前提条件

- 腾讯云账号
- Node.js 18+
- 安装 TCB CLI：`npm i -g @cloudbase/cli`

### 1. 创建 CloudBase 环境

在 [腾讯云 CloudBase 控制台](https://console.cloud.tencent.com/tcb) 创建一个按量付费环境，记录环境 ID。

### 2. 开启匿名登录

```bash
tcb env login set --anonymous-login true -e {你的环境ID}
```

或在控制台：云开发 → 身份认证 → 登录方式 → 开启匿名登录。

### 3. 修改配置文件

编辑项目根目录下的文件，将 `shengheshu-d2g2zyyl99f6c6fc2` 替换为你的环境 ID：

- **`cloudbaserc.json`** — `envId` 字段
- **`cloudfunc/index.js`** — `cloudbase.init({ env: "..." })` 中的 env
- **`public/index.html`** — `var API = "..."` 中的域名部分
- **`public/admin.html`** — `var API = "..."` 中的域名部分

### 4. 配置生产密钥

部署前必须通过 CloudBase 函数配置或密钥托管设置：

- `ADMIN_PASSWORD_HASH`：管理员密码的 SHA-256 十六进制摘要；
- `OPS_ROSTER_API_KEY`：签到系统读取运营名单的出站密钥；
- `SIGNIN_SERVICE_API_KEY`：运营平台读取签到数据的入站密钥；
- `OPS_API_BASE`：运营名单 API 地址。

入站和出站密钥不得复用，也不得写入仓库。

生产环境为 `checkinApi` 配置 `attendanceSyncWeekdays0000` 定时触发器，
Cron 为 `0 0 0 ? * MON-FRI *`。它只调用新运营平台的受保护同步入口，
在工作日 00:00 由新平台拉取签到数据，不改变扫码签到 HTTP 路由。
定时调用允许等待新平台冷启动和增量处理，云函数超时配置为 120 秒；
普通名单读取仍采用较短的 20 秒出站超时。

### 5. 生成可追溯发布包

发布必须从干净的 Git 工作树开始。脚本会把同一个完整 commit 写入云函数和静态托管的构建清单：

```powershell
$release = .\scripts\release\prepare.ps1 -Environment production
```

记录脚本输出的 `CLOUDFUNC_DIR`、`PUBLIC_DIR`、`COMMIT` 和 `VERSION`，后续部署只能使用该发布包目录。

### 6. 部署云函数

```bash
tcb fn deploy checkinApi -e {你的环境ID} --dir {CLOUDFUNC_DIR} --force
```

### 7. 部署静态页面

```bash
tcb hosting deploy {PUBLIC_DIR}/index.html /index.html -e {你的环境ID}
tcb hosting deploy {PUBLIC_DIR}/index.html /v2/index.html -e {你的环境ID} # 兼容已印刷的旧二维码
tcb hosting deploy {PUBLIC_DIR}/index.html /v3/index.html -e {你的环境ID} # 兼容已印刷的旧二维码
tcb hosting deploy {PUBLIC_DIR}/admin.html /admin.html -e {你的环境ID}
tcb hosting deploy {PUBLIC_DIR}/build-info.json /build-info.json -e {你的环境ID}
# 后台只保留 /admin.html，旧版入口应删除：
tcb hosting delete /v2/admin.html -e {你的环境ID}
tcb hosting delete /v3/admin.html -e {你的环境ID}
```

部署后必须核对 `GET /api/version` 和 `/build-info.json` 的完整 `commit` 相同；任一接口返回 `unknown` 或 commit 不一致时停止，不切换现场二维码流量。

### 7. 配置 HTTP 访问服务

在 CloudBase 控制台 → HTTP 访问服务 → 新建路由：

- 路径：`/api/*`
- 目标：云函数 `checkinApi`

实际 HTTP 访问域名以 `tcb routes list` 返回值为准。例如：

`https://{环境ID}-{AppID}.ap-shanghai.app.tcloudbase.com/api/event`

### 8. 创建数据库集合

在 CloudBase 控制台 → 数据库 → FlexDB → 新建集合：

- `config` — 存储活动名称等配置
- `registrations` — 存储报名数据
- `checkins` — 存储签到记录
- `events` — 存储活动名称、日期、类型和开放状态
- `event_audit_logs` — 存储活动确认、取消和退回草稿的生命周期审计记录

### 9. 生成二维码

新制作二维码统一使用 CloudBase 静态托管详情中显示的完整域名，例如 `https://{环境ID}-{AppID}.tcloudbaseapp.com/index.html`；已经印刷并指向 `/v2/index.html` 或 `/v3/index.html` 的旧二维码继续兼容。不要省略域名中的 `-{AppID}` 后缀，否则该地址无法访问。

---

## 项目结构

```
├── cloudbaserc.json      # TCB 部署配置
├── cloudfunc/            # 云函数
│   ├── index.js          # 云函数逻辑（签到/管理/统计）
│   └── package.json      # 云函数依赖
├── public/               # 静态页面（部署到 TCB 静态托管）
│   ├── index.html        # 签到页（微信扫码打开）
│   └── admin.html        # 管理后台（Excel 上传）
├── static/
│   └── checkin_qr.png    # 签到二维码（打印用）
└── README.md
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/event` | GET | 获取当前活动名称和报名人数 |
| `/api/version` | GET | 获取生产版本、Git commit 和部署时间 |
| `/api/admin_events` | GET | 管理后台活动元数据分页查询；支持 `page`、`page_size`、`keyword`、`lifecycle_status`、`activity_type`、`date_from`、`date_to` |
| `/api/checkin` | POST | 签到（姓名+手机号） |
| `/api/stats` | GET | 签到统计数据 |
| `/api/registration` | POST | 后台新增单条临时报名 |
| `/api/registration_delete` | POST | 后台删除尚未签到的单条报名 |
| `/api/attendance_status` | POST | 后台标记未签到、迟到或请假 |
| `/api/upload` | POST | 管理后台导入 Excel |
| `/api/reset` | POST | 清空签到记录 |
| `/api/clear_all` | POST | 永久删除当前活动；三场班会按 `event_group_id` 删除整个活动组并写入删除审计 |
| `/api/event_lifecycle_update` | POST | 后台确认、取消或退回活动草稿 |

### 签到请求示例

```json
POST /api/checkin
{
  "name": "%E7%9F%B3%E6%B5%B7%E7%94%B0",
  "phone": "13725275752",
  "_e": 1
}
```

> 注意：`name` 字段需 URL 编码（`encodeURIComponent`），`_e: 1` 表示已编码。

## 回归测试

```bash
node tests/checkin_api.test.js
node --check cloudfunc/index.js
node tests/admin_import_parser.test.js
```

## 技术说明

- **为何用 URL 编码**：腾讯云 HTTP 访问服务在转发 POST body 时可能损坏中文字符，通过前端 `encodeURIComponent` + 云函数 `decodeURIComponent` 绕过此问题。
- **为何选 CloudBase 而非 Vercel**：Vercel 在国内微信浏览器中可能被屏蔽，CloudBase 国内节点直接可用。
- **数据库权限**：云函数使用 admin SDK，拥有完整读写权限，前端不直接访问数据库。

## License

MIT
