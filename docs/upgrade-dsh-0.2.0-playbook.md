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

---

# dsh 0.2.0-rc.2 复审（2026-10-07）

> 同一套方法论（静态 diff + 构建探针 + 隔离实例实机）。harness 源码 fetch 到 `origin/master`（`5badb15009`，含 0.2.1-alpha.1 发布），npm dist-tags：`next` = `0.2.0-rc.2`、`latest` = `0.2.0-rc.2`、`alpha` = `0.2.1-alpha.1`。**本次是「已发布版本复审」**：rc.2 已上线（`latest`+`next` 双指向），caret 范围 `^0.2.0-rc.1` 的用户会被动解析到它，故 bump 不是可选项。

## 结论

**插件存活，源码零改动。** rc.1 → rc.2 的全部 16 项观察哨耦合点**零 diff**；构建探针 213/213、`lib/` 产物逐字节未变；隔离实例登录墙/补签/`auth-reset`/client bundle/双栈围栏全部实测通过。

## 观察哨（rc.1 → rc.2）

| 耦合点 | 结论 |
|---|---|
| `browser-auth.ts` / `api-request-trust.ts` / `rpc-host.ts` | 零 diff——cookie 格式、围栏三函数、双闸门语义全部不变 |
| `host/webserver/src/index.ts`（含 `Config.host` union） | 零 diff——IPv6 shim 与 `lanHosts` 围栏仍必需，`ipv6-bind.md` 清理清单不启动 |
| `web-app/src/startup.ts` 的 0.0.0.0 拒绝 | 零 diff（rc.2 已发布产物）——`remote-web-startup` 替换仍是刚需 |
| patch 目标行与 inject 语义 | `web-startup`(161)/`connection`(216) 行形状逐字不变；dump-config 实测四注入 + `trustedHosts` 表达式正确 |

## 与 master 源码的差异（重要：rc.2 已发布产物 ≠ master）

上游 master 引入了 `--public-url`（公网反代前缀剥离）能力，`web-app/src/startup.ts` +25、`src/index.ts` +27、`cordis.patch.yml` +28/-10（新增 `schedule` / `ui-schedule` 行、`publicUrl` 配置）。**rc.2 已发布产物不含这些**（`npm view` + 隔离实例 `node_modules` 双重确认：`cordis.patch.yml` 无 `publicUrl` 行、`lib/startup.js` 无 `--public-url` 选项）。

该能力一旦随正式版到来，对本插件的影响已预先验证为**无**：

- `web-runtime` 行新增 `publicUrl: !!js ctx.webStartup.publicUrl`，而 web-app Config 是 `z.transform(z.string(), …)`（非 optional）；
- 用本地 schemastery 3.18.4 实测：`publicUrl: undefined` **被静默剔除**（返回对象无该 key，不抛校验错），上游源码 `?? undefined` 的注释亦印证"显式 YAML null = 未设置"；
- 我们的 `remote-web-startup` 不提供该字段，故 web-runtime 行求值与启动均正常。

## 构建探针（`/tmp/dsh-auth-probe-022`）

5 依赖 bump 到 `^0.2.0-rc.2`：typecheck 0 错 / **213/213** / `lib/client.js` 48.81 kB + map 68.71 kB（与 rc.1 产物逐字节一致，bump 是纯依赖动作）。

## 隔离实例实机（`DSH_HOME=/tmp/dsh022-home`，端口 3098/3099）

- `dsh plugin add` → 三行齐全；`--dump-config` → `web-startup` disabled、connection 四注入 + `webLanHosts` trustedHosts 表达式；
- `--host 0.0.0.0` 与 `--host ::` 均正常启动；
- 登录墙：匿名导航 302、匿名 API 401、注册 200 双 cookie、密码错 401、补签跳板 200、双 cookie 过闸门到 bridge **404 `not found`**、登出 Max-Age=0；
- client bundle：`plugins/??<boot 图>&rev=…` authed **200（10.47 MB，含本插件代码）** / 匿名 **401**；
- `auth-reset`：旧会话 LAN 下 401（secret 轮换生效）、新密码 200；
- 双栈围栏：`[::1]` 401 / 陌生 `[2001:db8::99]` **403** / IPv4 LAN 401 / 全局 IPv6 401——与 rc.1 记录逐字一致。

**排查记录（两个易误判为回归的现象）**：① 从回环登录的原生 cookie authority 绑的是 `127.0.0.1:3099`，换 LAN 地址访问必 401——上游行为，非本插件缺陷，用"从同一 authority 登录"的 cookie 重测即通；② client bundle 走 `plugins/??<ids>&rev=` 组合 URL（单包 `client.js` 直取会 404），`&rev=` 不可省。

## 待跟进项：0.2.1 线的 cordis peer 冲突（下次 bump 必须处理）

`@deepseek-ai/dsh-credentials@0.2.1-alpha.1` 要求 peer `@deepseek-ai/cordis@"~4.0.5-alpha.1"`，而我们装的是 cordis `4.0.4`、peer 声明 `^4.0.1` —— `npm install` 直接 **ERESOLVE**（`~4.0.4` 与 `^4.0.1` 都不接受 prerelease 的 4.0.5-alpha.1）。cordis 4.0.4 是 `latest`，4.0.5-alpha.1 已发布。

**影响**：当前 rc.2 无碍（三个核心依赖只要求 cordis `~4.0.4`）；等 0.2.1 正式版发布时若 cordis 仍走 4.0.5 线，bump 需**同步放宽我们的 `@deepseek-ai/cordis` peer 范围**。`@deepseek-ai/dsh` 门槛 `>=0.1.7-rc.1 <0.3.0-0` 本身不受影响（0.2.1 在范围内）。

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

---

# 0.2.1-alpha.2 前瞻审查（2026-10-12，基线 rc.2 不变）

> 惯例三层验证（静态 diff + 构建探针 + 隔离实例实机）。对照对象：`origin/master` = `dsh-v0.2.1-alpha.2` = `d743267388`（2026-10-09）。npm dist-tags：`next` = `latest` = **0.2.0-rc.2**（我们的基线，未变，rc.2 线零动作）；`alpha` = `0.2.1-alpha.2`。**本次是前瞻预警**——rc.2 基线全绿，但 alpha 线（即 master，0.2.1 正式版的候选形态）含三处破坏性改动，**插件在其上完全无法启动**（实测回环 / `0.0.0.0` / `::` 三连败）。bump 到 0.2.1 线之前必须先完成文末适配清单。

## 改动落点与核实

- 两个提交：`cb9a590c86`「Support concrete Web listener bind addresses」（2026-10-08 18:25）+ `ac080346f0`「Support native HTTPS Web listeners」（19:49）。**均晚于 rc.2 复审窗口**（当时 master = `5badb15009`，2026-10-03）→ 属观察哨之外的新地雷，随 alpha.2 发布。
- 源码与 npm 产物双核实：`dsh-host-webserver@0.2.1-alpha.2` 的 `lib/index.js` 含通配拒绝、`isWildcardHost`/`normalizeBindAddress`、`protocol` getter；`dsh-web-app@0.2.1-alpha.2` 的 `lib/*.js` 中 `webRuntime`/`resolveLanTrust` 计数 **0**，`cordis.patch.yml` 含 `tls: !!js ctx.webStartup.tls`、`publicUrl`、`connection` 行 `inject: [webStartup]`。

## 三处硬破坏（隔离实例实测，`/tmp/dsh-alpha-e2e` CLI + `DSH_HOME=/tmp/dsh-alpha-home`）

| # | 改动 | 实测失败形态 |
|---|---|---|
| 1 | **`webRuntime` 服务被删**（`resolveLanTrust`/`WebRuntimeValues` 一并移除；官方 `connection` 行改为 `inject: [webStartup]` + `ctx.webStartup.trustedHosts`）→ 我们 patch 的表达式 `[...ctx.webRuntime.trustedHosts, ...]` 悬空，connection 行永远 pending | `--host 127.0.0.1` 与 `--host ::`：`startup failed: 1 required plugin did not activate / connection (required) Missing services: webRuntime`——**连回环都起不来** |
| 2 | **host schema 反转**：`z.union([const('127.0.0.1'), const('0.0.0.0')])` → 任意**具体** IP 字面量（含 IPv6）的 `z.transform`，**通配 `0.0.0.0`/`::` 被拒绝**（CLI 与 schema 双层；理由仍是「暴露 RCE 到网络」，改为「绑定单个具体接口地址」）。我们的 union 兜底救得了 `::`（IPv6 成员），救不了 `0.0.0.0`（两成员都拒） | `--host 0.0.0.0`：`webserver (required) ValidationError: $.host expected string \| string but got "0.0.0.0"`，级联 11 行 pending |
| 3 | **LAN 信任推导移除**：上游不再从绑定推导 LAN 字面量（新语义：具体绑定地址由围栏 `isBindAddressAuthority` 免条目即受信；通配绑定已不存在）。我们 `lanHosts` 只补 IPv6 侧，IPv4 侧**依赖 stock 推导**——依赖源已消失 | 修掉 1/2 后仍会 403：通配绑定下 LAN IPv4 客户端到不了登录页 |

**次生变化**（非硬破坏，影响设计取舍）：TLS 新能力（`--tls-cert/--tls-key`、`webserver.protocol`、`browser-auth` scheme-aware——HTTP 路径逐字不变，HTTPS 下 cookie audience 变 `https://host` 的 origin 且带 `; Secure`，补签将来若透传 TLS 需镜像 secure 分支）；`--public-url`（rc.2 复审已预验无害，本次产物再确认）；`tsdown.client.ts` 仅内部重构。`browser-auth.ts`/`api-request-trust.ts`/`rpc-host.ts` 的全部改动均为 scheme/TLS/具体绑定语义，**纯 HTTP 路径逐字兼容**（观察哨 1–3 的 HTTP 结论仍成立）。

**未变（继续成立）**：`connection/request` waterfall 事件零动（观察哨 16 绿）；`slots.ts`/`client/modules`/`boot.ts` 零 diff（「认证」标签页注册契约不变）；`credentialKey`/`parseCmdline` API 保持；`@deepseek-ai/dsh` peer 门槛 `>=0.1.7-rc.1 <0.3.0-0` 覆盖 0.2.1；`dsh plugin add` 与 `--dump-config`（patch 三行套用）正常。

## 构建探针

- 本仓库（rc.2 依赖）：`typecheck` 0 错 / **213/213**——基线健康，无需动作。
- 探针材料留在 `/tmp/dsh-alpha-probe`（产物解包）、`/tmp/dsh-alpha-e2e`（alpha.2 CLI）、`/tmp/dsh-alpha-home`（隔离实例）；启动日志 `/tmp/boot-*.log`。

## 适配清单（bump 到 0.2.1 线前执行）

1. **patch 表达式自给自足**：`trustedHosts` 不再引用 `webRuntime`；LAN 枚举（通配绑定下 IPv4 + IPv6 全家族）全部由 `lanHosts` 承担，并合并 `ctx.webStartup.trustedHosts`（显式 `--trusted-host` 的官方来源）。
2. **shim 从「union 拓宽」改为「校验替换」**：保留 stock 对具体字面量的校验，同时放行 `0.0.0.0`/`::` 通配（`--host` CLI 同步）；`widenHostMember` 的旧形状探测（union）需适配新 `z.transform` 形状，失败分支保持 fail-loud。
3. **决定 `--public-url`/`--tls-cert`/`--tls-key` 的去向**：透传或显式拒绝（当前我们的替换 startup 不认这三个旗标，用户传入会报 unknown option）。
4. **若透传 TLS**：补签镜像 secure 分支（audience = `https://host` origin + `; Secure`）。
5. **cordis peer**：alpha.2 全部包要求 `~4.0.5-alpha.1`；cordis `latest` = 4.0.4、4.0.5 仍 prerelease（临时 dist-tag `dsh-0-2-1-alpha-1`）。`^4.0.1` 对 4.0.5 **稳定版**自动兼容——bump 前看 cordis 是否已出稳定版，否则放宽 peer（继承自 rc.2 复审的待跟进项）。

---

# 0.2.1 适配落地（双时代兼容，2026-10-12；基线仍是 rc.2）

> 设计原则（用户指定）：**尽量使用官方模块、最小侵入**。落法 = 走官方消费路径（LAN 信任由 `webStartup.trustedHosts` 提供、patch 表达式与 alpha.2 stock 逐字一致）、官方 flag 原样透传；只保留通配 bind 必需的 schema 手术与补签镜像。**Phase 1（已落地）= 在当前 rc.2 依赖上让代码双时代兼容**（rc.2 行为字节级不变、alpha.2 可正常启动）；Phase 2（延后）= 0.2.1 进 `next` 时 bump 5 个 `@deepseek-ai/dsh-*` 依赖（含 cordis peer 复核）。**发版打 tag 的触发时机也在此时**（2026-10-12 决定）：适配期成果只推 `main` 不打 tag，等 dsh 的 alpha 线转为 `next`/`latest` 正式通道再发版——详见 `docs/release-guide.md`「发版触发时机」。

## 断点 ↔ 官方路径映射

| 断点 | 适配落法 |
|---|---|
| `connection` 行表达式与注入悬空（`webRuntime` 删除） | patch 行改为 `inject: [webServer, webStartup, webAuth]` + `trustedHosts: !!js ctx.webStartup.trustedHosts`——表达式与 alpha.2 stock 逐字一致；rc.2 上取代 `ctx.webRuntime.trustedHosts` 消费。**一份静态 patch 两时代通用**。行级 inject 并入模块自身 inject（`Inject.resolve(fiber.entry.options.inject, fiber.inject)`）；**`webServer` 是 E2E 抓出的回归**：connection 的 `register` 以调用方上下文跑 `owner.webServer.register(route)`，行里少了它，第三方 `connection.rpc.handle` 消费方（dsh-ntr）激活即抛 `cannot get property "webServer" without inject`（rc.2 与 alpha.2 同样；alpha.2 stock `[webStartup]` 同缺口）。另实测：patch 层之间对同一行 `inject` 是**整体替换**（profile 用户 patch 覆写 bundle 层会丢 `webServer`） |
| LAN 信任来源消失（`resolveLanTrust` 删除；通配绑定围栏需要显式条目） | 推导移进本插件 startup：`trustedHosts = [...--trusted-host, ...lanHosts(host)]`。`lanHosts` 矩阵全量接管：`0.0.0.0`→非 internal IPv4（镜像原 stock 语义）、`::`→双家族、具体字面量→自身、回环→`[]`。删除 `webLanHosts` cordis 服务（LAN_HOSTS_SERVICE） |
| 通配 bind 被 schema 拒 | `widenHostMember` 第二成员域放宽为 `isIPv4(v) \|\| isIPv6(v)`——alpha.2 的通配 plain-Error 被 schemastery union **无条件捕获**（`catch (error) { messages.push(error) }`，rc.2 与 alpha.2 的 vendored 副本双核对），fallthrough 命中我们；rc.2 顺带放行具体 IPv4 字面量。fixture 测试钉死 union 语义（未来副本收窄会立刻红） |
| TLS / `--public-url` 官方新能力 | 官方 flag 透传 + 本地镜像校验（`parsePublicUrl` 25 行自包含，包未导出该子路径）；能力门禁 `supportsTlsConfig` 探测 **boot 路径那份实例**（`.host-schema.cjs` 同款技巧）的 `Config.dict` 是否含 `tls` 成员——rc.2 上明确报「需要 dsh ≥ 0.2.1」，不静默 no-op |
| 补签/TLS (secure) | 镜像 `requestAudience(headers, secure)`（https→`url.origin`，http→`url.host` 字节级不变）与 `; Secure`（`dsh_sid` set/clear、原生 cookie set/clear 全部贯通）；secure 源 = `ctx.get('webServer')?.protocol === 'https:'`（rc.2 无此字段→false；**不新增 inject**，避免启动排序被 webserver 门禁） |

## 落地清单（代码与测试）

- `cordis.patch.yml`、`src/ipv6-shim.ts`、`src/startup.ts`、`src/auth.ts` 四处源改动；测试 `tests/ipv6-shim.spec.ts` / `startup.spec.ts` / `auth.spec.ts` / `waterfall-integration.spec.ts`（https 变体 + fake `webServer.protocol`）。
- **E2E 抓出的 patch 回归（已修）**：`connection` 行的 `inject` 一度只写 `[webStartup, webAuth]`（照 alpha.2 stock 形态），rc.2 canary 实测 dsh-ntr 激活失败——`webServer` 必须保留（见上表），patch 注释已钉死原因；该修复只动 `cordis.patch.yml`（不在 lib/ 产物内，无需重新 build）。
- 单测证据：`npm run typecheck` 0 错；**229/229**（rc.2 依赖上——rc.2 行为不变由此保证）。`program.error` 单测经 `ctx.appExit`（`exitCodes`）观测——修正 `ipv6-bind.md` 旧说「单测不触达非法 host 路径」。
- 文档同步：`AGENTS.md`（红线 1/11、速览、基线 bullet）、`docs/agent/ipv6-bind.md`（机制重写 + 观察哨重写：删「上游放开后清理 widen」期待——0.2.1 是明确收紧，widen 变永久特性；connection 行三注入与 patch 层替换语义）、`auth-mechanics.md`（路由保护顺序 inject 表述 + 补签 TLS 测试要点）、`native-auth-bridge.md`（audience/secure 镜像点）、`architecture.md`、`dsh-plugin-basics.md`、README 双语（`--host` 值域 / 新 flag / TLS 简述）。

## 双时代 E2E 实录（2026-10-12，`npm run build` 后的构建产物）

**rc.2（作者 profile `link:` 本插件，`DSH_WEB_AUTH_FILE=/tmp/dsh-e2e-rc2/web-auth.json` 隔离）**：

- `--host 0.0.0.0` 十二探针全绿：回环 303 补签 / 200 跳板；远程导航 302 `/login`、匿名 RPC 401；注册响应双 cookie；`/api/auth/status` 匿名态与登录态字段正确；登录后 `POST /api/rpc` → **404**（过围栏与原生 cookie 闸门、到达 bridge）；sid-only（有会话缺原生 cookie）→ **401**；陌生 Host → **403**；登出双 cookie 双清（`Max-Age=0`）。
- `--dump-config`：`web-startup` disabled；connection 行 `inject: [webServer, webStartup, webAuth]` + `trustedHosts` 展开为字面列表（`webLanHosts` 无痕消失）；三行 insert 齐全——patch 组合两时代同一份。
- `--host 192.168.5.216`（具体 IPv4 字面量，新值域）：可启动；`Host: 该字面量` + 会话 → **401**（rc.2 围栏无 `isBindAddressAuthority`，靠新 `lanHosts` `[自身]` 条目放行）；陌生 Host → 403。
- `--host ::`：`127.0.0.1` 与 `[::1]` 双通（回环补签）；LAN IPv4 与全局 IPv6 Host + 会话 → 401；陌生 `[2001:db8::99]` → 403。
- 能力门禁：`--tls-cert`/`--public-url` 在 rc.2 → **exit 1** 人话报错。
- **dsh-ntr canary**：干净激活（旧的 `[webStartup, webAuth]` 行在此炸出 `cannot get property "webServer" without inject`，即上述回归的发现现场）。

**alpha.2（`/tmp/dsh-alpha-e2e` 0.2.1-alpha.2 实机，`DSH_HOME=/tmp/dsh-alpha-home`，profile 同 link 构建产物）**：

- 通配 `--host 0.0.0.0`：启动（boot 打印 `listening on 0.0.0.0`）+ 上述探针 A1–A8 全绿（303 补签、200 跳板、302/401、注册双 cookie、authed RPC 404、sid-only 401、陌生 Host 403）。
- 通配 `--host ::`：启动 + `127.0.0.1`/`[::1]` 回环补签（200 跳板、cookie 名 = 该 authority 的哈希）+ LAN IPv4 401 + 全局 IPv6 401 + 陌生 IPv6 403。
- **TLS 自签全链**（`--tls-cert/--tls-key`，openssl 自签 SAN=LAN IP，port 3132）：https 导航（会话有效、缺原生 cookie）→ **200 跳板** + `Set-Cookie: dsh-auth-<base64url(sha256("https://192.168.5.216:3132"))>=…; …; Secure`；带真 cookie 二次导航 → **200 进 SPA**；https 登录 → 200 `{"ok":true}` + 双 cookie（`dsh_sid` 带 `Max-Age=1209600; Secure`，原生 cookie 带 `; Secure`）；登出 → 双 cookie `Max-Age=0` 且均带 `; Secure`；https 下 POST 陌生 Host → 403，LAN + 会话缺原生 cookie → 401。
- `--public-url https://app.example.com/`：启动打印 `https://app.example.com/?token=…`（透传生效）。
- flag 门禁：`--tls-cert` 单缺 / `--tls-key` 单缺 → `error: --tls-cert and --tls-key must be supplied together`，exit 1；畸形 `--public-url` → `error: --public-url must not contain ASCII whitespace or control characters`，exit 1。
- **dsh-ntr canary 双重钉死**：`[webServer, webStartup, webAuth]` 干净启动；把 profile 用户 patch 覆写成 stock 形态 `[webStartup, webAuth]` → `dsh: warning: 1 entry did not activate` + `dsh-ntr (dsh-ntr): Error: cannot get property "webServer" without inject`（connection lib:712）——同时证明 stock 行同缺口与 patch 层替换语义；恢复后干净。

补充观察（分类为非回归）：会话有效但 `Host` 陌生时，**GET/HEAD** 会先被补签分支接走（303/200 跳板 + 为该陌生 Host 签发的原生 cookie），**POST** 才落到围栏 403——rc.2 与 alpha.2 行为逐字节一致（旧代码同路径），且跳板后的后续请求仍被围栏 403，cookie 无从生效。威胁模型上：浏览器只会在**该 Host 自己登录过**的 origin 带 `dsh_sid`，与「反代真实 Host + `--trusted-host`」的合法补签同一路径。
