# 盛和塾签到系统 (Seiwajyuku Sign-in System)

微信扫码签到的轻量级云签到系统，基于腾讯云 CloudBase 部署。

## 使用方式

### 学长签到（微信扫码）

1. 打印二维码：`static/checkin_qr.png`
2. 学长用微信扫一扫，打开签到页
3. 输入报名时的**姓名 + 11位手机号**
4. 点击确认签到，验证通过即签到成功

### 管理后台（更换活动）

1. 浏览器打开：`https://{你的域名}/v3/admin.html`
2. 输入管理密码登录（默认 `shenghe2024`）
3. 上传新的 Excel 报名表（支持互动吧导出的 `.xls` / `.xlsx`）
4. 系统自动替换报名数据，清空签到记录

> **Excel 格式要求**：第一行为表头，从第5行开始读取数据，列顺序为：姓名、手机号、公司、分中心。

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
tcb hosting deploy public/index.html /v3/index.html -e {你的环境ID}
tcb hosting deploy public/admin.html /v3/admin.html -e {你的环境ID}
# 如果旧二维码或书签使用根目录、v2 地址，请同步覆盖，避免进入旧版后台：
tcb hosting deploy public/index.html /index.html -e {你的环境ID}
tcb hosting deploy public/admin.html /admin.html -e {你的环境ID}
tcb hosting deploy public/index.html /v2/index.html -e {你的环境ID}
tcb hosting deploy public/admin.html /v2/admin.html -e {你的环境ID}
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

### 8. 生成二维码

访问 `https://{你的环境ID}.tcloudbaseapp.com/v3/index.html`，用任何二维码生成器生成二维码打印即可。

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

## 技术说明

- **为何用 URL 编码**：腾讯云 HTTP 访问服务在转发 POST body 时可能损坏中文字符，通过前端 `encodeURIComponent` + 云函数 `decodeURIComponent` 绕过此问题。
- **为何选 CloudBase 而非 Vercel**：Vercel 在国内微信浏览器中可能被屏蔽，CloudBase 国内节点直接可用。
- **数据库权限**：云函数使用 admin SDK，拥有完整读写权限，前端不直接访问数据库。

## License

MIT
