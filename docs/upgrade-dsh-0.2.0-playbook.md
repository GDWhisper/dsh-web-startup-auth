# dsh 0.2.0 适配性审查（0.2.0-rc.1）

> 对应 0.1.7 手册（`docs/upgrade-dsh-0.1.7-playbook.md`）的三层验证方法论：**静态 diff + 构建探针 + 隔离实例实机**。审查日期 2026-09-28，harness 源码拉至 `dsh-v0.2.0-rc.1`（`origin/master` = `4878cdabd8` = 该 tag），npm dist-tags：`next` = `0.2.0-rc.1`、`latest` = `0.1.7-rc.2`。
>
> 本次是**审查**：结论是「插件存活、源码零改动」；依赖 bump（`^0.1.7-rc.1` → `^0.2.0-rc.1`）是发版动作，已于同日随 v0.1.12 执行完毕（见「迁移动作」末尾的执行记录）。

## 结论速览

**插件存活，源码零改动。** 在 0.2.0-rc.1 上：`typecheck` 0 错误、`vitest` **201/201**、`tsdown` 构建通过；隔离实例（独立 `DSH_HOME=/tmp/dsh020-home` + 端口 3098/3099）上登录墙全链路、原生 cookie 补签、`auth-reset` 会话轮换、client bundle 闸门、`--host ::` 双栈启动与信任围栏、真实浏览器设置面板「认证」页**全部实测通过**，浏览器 54 请求 0 非 2xx。

⚠️ **依赖解析语义变化（与 0.1.7 那次相反）**：`^0.1.7-rc.1` 是 caret+prerelease 范围，**不会**自动解析到 0.2.x——0.2.0 的到来不会被动拉进来，bump 必须手动执行。这与 0.1.7 手册「稳定版一发布就会被解析进来」的紧迫性正好相反：**不 bump 不会坏，但会停留在 0.1.7-rc.2**（caret 当前解析到的 `latest`）。

**版本谱系事实**：`dsh-v0.1.7-rc.1` 是 `dsh-v0.1.7-rc.2` 的祖先，rc.2 又是 `dsh-v0.2.0-rc.1` 的祖先（同一条 master 线上的三次发布）。全部镜像对象文件在 **rc.1 → rc.2 → 0.2.0-rc.1 全程零 diff**，所以现有 caret 用户（解析到 rc.2）与 0.2.0 用户结论一致。

## 观察哨逐项（对照 0.1.7 手册的清单）

| # | 耦合点 | 0.1.7-rc.1 → 0.2.0-rc.1 | 结论 |
|---|---|---|---|
| 1 | `browser-auth.ts`（补签强耦合） | **零 diff** | ✅ cookie 名/格式/`credentialKey` 全部不变 |
| 2 | `api-request-trust.ts`（信任围栏） | **零 diff** | ✅ `parseAuthority`/`isTrustedAuthority`/`assertTrustedAuthority` 三条依据不变 |
| 3 | `rpc-host.ts`（双闸门） | **零 diff** | ✅ `requestRejection` 403+401 语义不变 |
| 4 | `web-app/src/startup.ts` 的 0.0.0.0 拒绝 | **零 diff** | ✅ 拒绝仍在 → `remote-web-startup` 替换仍是刚需 |
| 5 | patch 目标行与 inject 语义 | `web-app/cordis.patch.yml` 仅**增行**（telemetry/shortcuts/ui-settings-session-log，删一个 disabled 的 `ui-schedule`）；`web-startup`(161)、`connection`(216) 行形状逐字不变；`vendor/`（cordis/loader/include/schemastery）**整体零 diff** | ✅ 叠加语义不变（隔离实例 `--dump-config` 实测四注入 + trustedHosts 表达式组合正确） |
| 6 | webserver 三个注册口 | `host/webserver/src/index.ts` **零 diff** | ✅ `register`/`registerUpgrade`/`registerFallback` 与 `Config.host` schema（仍是 `'127.0.0.1' \| '0.0.0.0'`）不变 |
| 7 | `__DSH_TRANSPORT__` 钩子 | `client/connection` 包内仅 package.json/README 变；`client/web/src/boot.ts` 只加了 Electron 窗口拖拽（`window-drag/`） | ✅ 钩子读取与 `isLoopback` 判定逐字不变（浏览器实测 `ownsHost === true`） |
| 8 | 前端插件加载链 | `client/modules` 仅 package.json 变 | ✅ `__ModuleLoader__.load` / `dsh.client` 声明 / boot 图 URL 形状（`plugins/??<id>/client.js&rev=…`）不变 |
| 9 | 设置面板 slot | `slots.ts` 仅 `SettingsLauncherOwnerProps` **增字段**（`settingsOpen`/`settingsShortcut`，launcher 用） | ✅ `settings.section` 注册契约不变 |
| 10 | 导航图标 | `ui-settings-general/SettingsRoot.*` 有改动（新增快捷键行等） | ✅ DOM 注入式盾牌 SVG 实测仍在（属性序区别于上游图标，注入痕迹符合预期） |
| 11 | tsdown client preset | 仅 `INLINE_SAFE` 正则**增一项** | ✅ 我们的 `tsdown.config.ts` 自包含，不受影响 |
| 12 | 上游账号体系 | 0.2.0 无新增登录墙类能力 | ✅ 不是替代品 |
| 13 | 启动审计 | `web-app/src/index.ts` **零 diff** | ✅ fail-loud 因果链（auth 激活失败 → connection pending → 硬启动失败）保留，排查路径不变 |
| 14 | 版本与依赖面 | `dsh-credentials`/`dsh-cmdline` 源码零 diff（仅 package.json）；Node engine `^22.19.0 \|\| >=24.0.0`；React 仍 `^18.2.0`；schemastery 3.18.4 / cordis 4.0.4 满足我们的 peer/dep 范围 | ✅ 无阻塞 |
| 15 | webserver `host` schema 与 IPv6 拓宽 | schema 仍收窄（**上游未放开值域**）；`resolveLanTrust` 仍 IPv4-only；`profile-resolution/resolver.ts` 的变化只是错误信息重写 | ✅ shim 与围栏补齐**仍必需**，`ipv6-bind.md` 清理清单**不触发** |
| 16 | `connection/request` waterfall（0.2.0-rc.1 审查后新增闸门的耦合点） | **本次新增观察哨**：`connection/src/index.ts` 的 Events 声明（~57 行）与派发位置（`admit` 之后、bridge 之前）；0.2.0-rc.1 实测事件名/签名/位置与 0.1.7-rc.1 一致 | ✅ 闸门生效（集成测试走真实事件总线）；**每次升级必 diff 这两处**——事件改名/移位会让 waterfall 闸门静默失效（外层包装挡着未授权请求，冒烟电池看不出差别） |

**插件安装面（新增核查项）**：

- `plugin-compatibility.ts` 门槛**零改动**，且只查 `peerDependencies` 里的 `@deepseek-ai/dsh*`——本插件没声明这类 peer，**永远不会被「incompatible bundle」拒载**（双刃：也没有版本保护；将来若要保护可声明 peer，代价是每个新版本都要跟）。
- `plugin-manager/operations.ts` 新增 **run-record 锁**（`.plugin-manager/run.json`，前一个 `dsh plugin add/remove` 进程死后其 pnpm 树还在写 profile 时拒绝并发操作）：只影响安装操作的并发鲁棒性，与兼容性无关；`dsh plugin add` 流程实测正常。

## 构建探针（`/tmp/dsh-auth-probe-020`，不动本仓库）

仓库副本 5 个 `@deepseek-ai/dsh-*` 依赖 bump 到 `0.2.0-rc.1` 后：

- `npm run typecheck` → 0 错误；
- `npm test` → **201/201 通过**（6 个 spec）；
- `npm run build` → `lib/client.js` 48.81 kB / map 68.71 kB，构建成功。

## 隔离实例实机（`DSH_HOME=/tmp/dsh020-home`，`/tmp/dsh020/bin/dsh` = 0.2.0-rc.1）

`dsh plugin --profile web add <探针目录>` 从官方 web 模板初始化 profile；`--dump-config` 实测：`web-startup` disabled、`connection` inject `[webServer, webRuntime, webAuth, webLanHosts]` + `trustedHosts` 表达式、本插件三行齐全——patch 组合与 0.1.7 完全一致。

### A. 登录墙电池（端口 3099，`--host 0.0.0.0`，LAN `192.168.5.216`）

| 场景 | 结果 |
|---|---|
| 匿名 `GET /`（html 导航） | **302 → /login** |
| `/login`、`/api/auth/status` | 200 |
| 匿名 `/api/rpc` POST | **401** `{"error":"unauthorized"}`（本插件闸门） |
| 注册（首次） | 200，**2 个 Set-Cookie**（`dsh_sid` + 原生 `dsh-auth-<sha256(authority)>` 补签） |
| 密码错误 / 正确 | 401 / 200（登录响应下发双 cookie） |
| 仅 `dsh_sid` 的导航 | **200 + `Set-Cookie dsh-auth-*`**（补签跳板） |
| 双 cookie 重放 | 200，含 `__DSH_BOOT__` |
| 仅原生 cookie、无 `dsh_sid` | **302 → /login**（`dsh_sid` 仍是唯一边界） |
| client bundle 匿名 / 已认证 | **401 / 200**（48,850 B，`__ModuleLoader__.load` banner；`&rev=` 不可省，同 0.1.7） |
| 登出 | 双 cookie `Max-Age=0` |
| `auth-reset --password …` | 旧会话 **302**、旧密码 **401**、新密码 **200**（secret 轮换生效） |

### B. `--host ::` 与信任围栏（端口 3098，同实例双栈）

- **双实例拓宽哨点（`ipv6-bind.md` 观察哨 2）通过**：`--host ::` **正常启动**——`ensureIpv6BindSupport(ctx.baseUrl)` 拓宽的是 profile 根解析出的那份 schema，0.2.0 的 webserver 行解析方式未变。
- 围栏测试按 `ipv6-bind.md` 的姿势打 **POST `/api/rpc` + 有效 `dsh_sid`**（无会话会被本插件 401 拦在围栏之前；`/api/auth/status` 等本插件注册的路由不经 `connection.admit`，探不到围栏）：

| Host 头 | 结果 |
|---|---|
| `[::1]:3098`（回环） | 401（过围栏，撞上游原生 cookie 闸门） |
| `[2001:db8::99]:3098`（陌生 IPv6） | **403 forbidden**（围栏拒绝） |
| `192.168.5.216:3098`（双栈绑定下的 IPv4 LAN） | 401（`lanHosts('::')` 双家族覆盖，回归项） |
| `[240e:…:3c86]:3098`（本机全局 IPv6） | 401（`lanHosts` 枚举出的权威过围栏） |

- **回环隐式信任是设计行为**（易误判为回归，记录备查）：peer + `Host` 双回环的请求无会话即 `trusted:true`（`isTrustedOrigin`），`GET /` 直接 200 而非 302——只有**非回环**地址才走登录墙。

### C. 真实浏览器（chromium headless，LAN 地址）

- 登录表单 → 主界面完整加载；`__DSH_TRANSPORT__ === {"ownsHost":true}`；
- 0.2.0 新增的 **Preview Notice 与 API-key onboarding 弹窗**与登录墙共存正常（都在认证之后出现）；
- 设置面板导航 = **General / Models / Built-in plugins / Agent presets / 认证**；「认证」页六块齐全（账号 + 退出登录、修改用户名、修改密码、登录要求「本机登录校验」、人机验证「登录拼图验证」、会话有效期 14 天）；
- 「认证」导航行图标仍是我们的盾牌 SVG（`class="…navIcon"` 注入式，属性序与上游图标不同）；
- 「模型」页正常渲染（provider 卡片 + Add model provider），**无 `settings are unavailable`** → isLoopback 钩子生效；
- 全程 **54 个请求、0 个非 2xx**。

## 迁移动作（bump 时执行，可直接照抄 0.1.7 手册的清单）

1. `package.json` 5 个 `@deepseek-ai/dsh-*` 依赖 `^0.1.7-rc.1` → `^0.2.0-rc.1`，`npm install`；
2. 仓库层 `npm run typecheck && npm test && npm run build`；
3. `--dump-config` + 登录墙冒烟（本手册 A 表可直接复用，探针目录 `/tmp/dsh-auth-probe-020` 是同一套）；
4. baseline 文档四处同步（README 双语 / AGENTS / `native-auth-bridge`）；
5. 发版走 `docs/release-guide.md`。

**已执行（2026-09-28，随 v0.1.12）**：五步全部完成——5 依赖 bump 到 `^0.2.0-rc.1`（npm 解析到 0.2.0-rc.1，lock 根条目顺带同步 peer 声明）、全链路 213/213、隔离实例冒烟（dump-config 三行、登录墙 302、登录双 cookie、仅 `dsh_sid` 纯文本 401、仅原生 cookie JSON 401、双 cookie 过闸门到 bridge 404、补签 200 跳板）全绿、baseline 文档同步、发版走 release-guide。同批合并 Renovate #33（vitest 5.0.2）/#34（@types/node 24.19.0，均逐分支 `npm ci` + 全链路验证后 merge）。

**未决项（继承自 0.1.7 手册，不阻塞）**：真实 DeepSeek 账号 OAuth 回调端到端仍未实测（隔离实例无 DeepSeek 凭据）；0.2.0 上 `/oauth/callback` 路由仍由 P1 修复（v0.1.11）放行，回归测试覆盖「不被登录墙吃掉」一段。

## 可选改进落地（2026-09-28，审查同日执行）

审查产出的「可选改进」清单中两项已落地（其余项见审查讨论，未动）：

### 1. `@deepseek-ai/dsh` peer 版本门槛（新）

`package.json` 新增：

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.1.7-rc.1 <0.3.0-0", … },
"peerDependenciesMeta": { "@deepseek-ai/dsh": { "optional": true } }
```

- **作用**：dsh 的 `plugin-compatibility.ts`（0.2.0-rc.1 零改动）求值 `peerDependencies` 里所有 `@deepseek-ai/dsh*` 范围，超出范围的 bundle **整包跳过并打印原因**（fail-loud，version exemption 可强行放行）。此前无声明 = 永不拒载也没有保护，正是「cookie 格式变了但登录墙静默失效」这类盲区。
- **`-0` 后缀是坑（实测）**：加载器用 `semver.satisfies(..., { includePrerelease: true })`，裸 `<0.3.0` **会放行 `0.3.0-rc.1`**——恰好放过门槛要拦的那条线。`<0.3.0-0` 的 `-0` 排在所有 prerelease 标识符之前（数字标识符优先级最低），整条 0.3 线（含 rc）拒之门外。用 dsh CLI 内置 semver 逐版本验证（`0.1.5-rc.3`✗ / `0.1.7-rc.1`✓ / `0.1.7-rc.2`✓ / `0.2.0-rc.1`✓ / `0.2.0`✓ / `0.3.0-alpha.1`✗ / `0.3.0-rc.1`✗）。`tests/package-manifest.spec.ts` 三条用例钉死拼写，防后人「简化」。
- **`optional: true` 必须有**：npm 7+/pnpm 8+ 会自动安装非 optional 的 peer，会把整个 `@deepseek-ai/dsh` CLI（500+ 包）拖进每个 profile 的 `node_modules`。加载器不读 `peerDependenciesMeta`，门槛不受影响。实测：隔离 profile 安装后 `node_modules` 无 `@deepseek-ai/dsh`。
- **实测（dsh 0.2.0-rc.1 隔离 profile）**：`dsh plugin add` 正常、`--dump-config` 三行齐全、无 `skipping profile bundle` 诊断——0.2.0-rc.1 在范围内。

### 2. 共享 API 会话闸门挂上官方 `connection/request` waterfall（P4 落地，双层形态）

`src/auth.ts` 新增第 4b 节：`ctx.on('connection/request', …)` 监听器对无会话请求回 JSON 401、不调 `next()`（到不了 bridge）；有效会话/真回环放行。测试 `tests/auth.spec.ts`「connection/request waterfall gate」6 例（含「仅原生 cookie 必须死在闸门」——那正是 30 天不可撤销 cookie 不可单独当 API 凭据的断言）+ `tests/waterfall-integration.spec.ts` 3 例（**真实 cordis 事件总线**：跨 context 派发可达、veto 真的阻断链尾 bridge）。

**为什么是「双层」而不是「替换」**（P4 原文的「替代 monkey-patch」在实测约束下不成立，此处记录取舍）：

1. **mint 时序**：waterfall 在 `admit`（信任围栏 403 + 原生 cookie 401）**之后**派发，监听器运行时原生 cookie 已经被索取过了——补签必须发生在 admit 之前，只能留在注册包装层；
2. **覆盖面**：waterfall 只看得见共享 API（connection 的 `/api` bridge）；index、upgrade、第三方 channel 路由它根本看不到，注册层的默认拒绝不可少；
3. **互备（决定性）**：只挂 waterfall 等于把「monkey-patch 静默锈蚀」换成「事件静默锈蚀」（事件被改名 → 监听器永不触发 → 无闸门）。双层之下任一接缝单独失效，另一层仍然设防，最坏只损失补签/302 等 UX。

**行为零变化**：冒烟电池（隔离实例 3097）与改动前逐字一致——匿名 `/api` JSON 401（包装层先答）、仅 `dsh_sid` 纯文本 401（上游 admit）、仅原生 cookie JSON 401、双 cookie 穿过 waterfall 闸门到达 bridge（`not found` 404）。typecheck 0 错、**210/210**（+6 waterfall、+3 manifest）、`lib/` 重建入库。

**独立审查（同日，独立子代理）**：结论「修复后可合并」——waterfall 语义/跨 context 送达/semver 逐格/optional peer/行为零变化/lib 一致性全部核验属实，无安全绕过。审查指出并已修复：① 互备范围表述过宽（「不损失安全」只对共享 API 成立，index/upgrade/第三方 channel 是包装层独守——已收窄 `auth-mechanics.md` 与代码注释）；② `connection/request` 耦合点未进升级观察哨（已加**观察哨 #16** + `native-auth-bridge.md`/AGENTS 升级指针）；③ waterfall 测试缺真实总线验证、fake `on` 语义与 cordis 不符（已加集成测试、fake 改为累积注册+按 identity 移除）；④ README fail-loud 措辞夸大（范围是 minor 线粒度，同线 rc/alpha 会照常加载——已改）；⑤ manifest 测试补 semver 复跑命令；⑥ 顺手修正既有文档矛盾（`lib/` 入库与否，`architecture.md`/`dsh-plugin-basics.md`）。
