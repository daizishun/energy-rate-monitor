# 电费气费监测（维州）

维多利亚州住宅电费、燃气套餐比较工具：输入维州地址和用量，从澳洲能源监管局（AER）的 Consumer Data Right（CDR）公开接口拉取各零售商最新套餐，按当前用量算出年费排名、最优组合和走势。

React 前端 + Bun 服务端 + drizzle + SQLite。本地数据库初始是空的——没有预置任何家庭数据；首次启动自动建表并写入公开的零售商名单和通用默认用量，地址、用量和当前套餐都由使用者自己输入。

## 安装

需要 [Bun](https://bun.sh) 1.3+。

```bash
bun install
```

## 编译

```bash
bun run build        # 服务端 + 前端一起编译
bun run typecheck    # 类型检查（前端 + 服务端）
```

## 运行

```bash
bun run start        # 先编译，再启动服务器
```

默认监听 `http://localhost:3000`。打开后先在页面上方输入你的维州地址（例如 `12 Smith St, Melbourne VIC 3000`）：输入完整后工具会自动保存并按邮编判断电网和气网（可按电费账单在下拉框里改选），再填三个日均用量，点「立即刷新」即从 CDR 拉取该地址的套餐数据。

服务器启动时还会跑一次自动更新检查，之后每 24 小时检查一次；只有当距离上次成功抓取超过你设置的自动更新间隔（默认每周）时才会真正抓取。手动点「立即刷新」不受间隔限制。

也可以不编译直接从源码运行：`bun server/src/index.ts`（前端需先 `bun run build:client` 编译一次）。

## 环境变量

复制 `.env.example` 为 `.env` 再改（都有默认值，不填也能跑）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务器监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只本机访问可改成 `127.0.0.1` |
| `DATABASE_PATH` | `./app.db` | SQLite 数据库文件路径（`.gitignore` 已排除，不会进 Git） |

## 数据说明

- **电费、燃气套餐数据**来自 AER 的 CDR 公开接口（`cdr.energymadeeasy.gov.au`，与 Victorian Energy Compare 同源数据），无需密钥。接口返回的费率是不含 GST 的，工具按 ×1.1 换算成含税价；太阳能回购价按公布值计（不另加 GST）。套餐按配电网匹配，不按邮编——CDR 的覆盖邮编名单偶有漏列。
- **本地 SQLite 为空库**：首次启动执行 `drizzle/` 下的迁移自动建表，只写入两样公开内容——Victorian Energy Compare 的 33 家零售商名单，和通用默认用量（VDO 参考：电 4,000 kWh/年≈11 kWh/天，分时按峰 29% / 平 53% / 肩 18% 拆分；气 50,743 MJ/年≈139 MJ/天，AER 维州住宅基准）。不含任何家庭地址、用量或当前套餐。
- **地址建议**（输入框下拉）查 OpenStreetMap 的 Nominatim 和 Photon 两个免费地理编码服务，结果合并去重。
- **零售商备注翻译**：原版用模型服务把 CDR 里零售商的英文说明翻成中文；独立版没有接任何模型服务，刷新时翻译不可用，页面会显示「译文暂不可用」，零售商英文原文仍收在每条备注下方的「零售商原文」里点开可看。如需恢复翻译，在 `server/src/sdk.ts` 的 `inference.complete` 里接一个翻译服务即可。
- **VDO 参考价**：页面只在 AusNet 配电网的地址上显示 Victorian Default Offer 参考价（2026–27 年度），其他配电网没有已核实数据，不显示。

## 项目结构

```
client/                 React 前端（src/App.tsx 为主页面）
server/src/
  actions.ts            全部业务逻辑：CDR 抓取、计价、快照、地址管理
  index.ts              服务器入口：静态文件 + POST /actions
  db.ts                 drizzle + bun:sqlite 初始化、迁移、公开数据种子
  sdk.ts                原平台 SDK 的本地替代（action 定义、Ctx、翻译桩）
  schema.ts             drizzle 表结构
drizzle/                SQLite 迁移 0001~0011（首次启动自动执行）
```

## 许可

MIT（本项目代码）。套餐数据版权归各零售商 / AER 所有；VDO 数据来自 Essential Services Commission。
