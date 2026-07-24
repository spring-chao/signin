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
2. 输入管理密码登录（默认 `shenghe2024`）
3. 填写活动名称、日期和活动类型，上传 Excel 报名表（支持互动吧导出的 `.xls` / `.xlsx`）
4. 系统新增独立活动，历史活动及签到记录不会被覆盖；可切换活动查看、导出、开放或关闭签到

活动进行中还可以在后台：

- 单独新增临时报名，填写姓名、手机号、分中心、班级、小组等信息，不覆盖现有名单；
- 查看未签到名单。分类维度按“分中心 → 班级 → 小组”择一使用：有分中心数据时按分中心，没有时才依次改用班级、小组；
- 苏州分中心统一为六个标准分中心：园区、姑苏相城、吴江、昆山、新吴、张家港；支持“园区”等模糊写法并自动归一为“园区分中心”；
- 电话确认后将未签到人员标记为“迟到”或“请假”，并记录选填备注；
- 删除姓名等信息填写错误的未签到报名，删除前必须再次确认；已签到报名不能删除；
- 学长之后完成实际签到，最终状态自动以“已签到”为准。

新增“班会/班级学习会”或“小组学习会”时，可不上传 Excel：选择活动类型后，后台会显示“从运营系统添加班级名单”或“从运营系统添加小组名单”。所选名单来自运营系统当前有效主归属；如发现手机号不完整，会停止导入并提示先修正。观摩人员在活动创建后通过“新增临时报名”追加。

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

### 4. 部署云函数

```bash
tcb fn deploy checkinApi -e {你的环境ID} --dir cloudfunc --force
```

### 5. 部署静态页面

```bash
tcb hosting deploy public/index.html /index.html -e {你的环境ID}
tcb hosting deploy public/index.html /v2/index.html -e {你的环境ID} # 兼容已印刷的旧二维码
tcb hosting deploy public/index.html /v3/index.html -e {你的环境ID} # 兼容已印刷的旧二维码
tcb hosting deploy public/admin.html /admin.html -e {你的环境ID}
# 后台只保留 /admin.html，旧版入口应删除：
tcb hosting delete /v2/admin.html -e {你的环境ID}
tcb hosting delete /v3/admin.html -e {你的环境ID}
```

### 6. 配置 HTTP 访问服务

在 CloudBase 控制台 → HTTP 访问服务 → 新建路由：

- 路径：`/api/*`
- 目标：云函数 `checkinApi`

### 7. 创建数据库集合

在 CloudBase 控制台 → 数据库 → FlexDB → 新建集合：

- `config` — 存储活动名称等配置
- `registrations` — 存储报名数据
- `checkins` — 存储签到记录
- `events` — 存储活动名称、日期、类型和开放状态

### 8. 生成二维码

新制作二维码统一使用 `https://{你的环境ID}.tcloudbaseapp.com/index.html`；已经印刷并指向 `/v2/index.html` 或 `/v3/index.html` 的旧二维码继续兼容。

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
| `/api/checkin` | POST | 签到（姓名+手机号） |
| `/api/stats` | GET | 签到统计数据 |
| `/api/registration` | POST | 后台新增单条临时报名 |
| `/api/registration_delete` | POST | 后台删除尚未签到的单条报名 |
| `/api/attendance_status` | POST | 后台标记未签到、迟到或请假 |
| `/api/upload` | POST | 管理后台导入 Excel |
| `/api/reset` | POST | 清空签到记录 |
| `/api/clear_all` | POST | 清空全部数据 |

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
```

## 技术说明

- **为何用 URL 编码**：腾讯云 HTTP 访问服务在转发 POST body 时可能损坏中文字符，通过前端 `encodeURIComponent` + 云函数 `decodeURIComponent` 绕过此问题。
- **为何选 CloudBase 而非 Vercel**：Vercel 在国内微信浏览器中可能被屏蔽，CloudBase 国内节点直接可用。
- **数据库权限**：云函数使用 admin SDK，拥有完整读写权限，前端不直接访问数据库。

## License

MIT
