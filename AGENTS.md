# AGENTS.md

本文件是 dsh 插件（`dsh-web-startup-auth`）的入场指南。**先读「速览」，再看「通用 dsh 插件知识」，最后读本插件专属部分。** 前两部分通用，可复用到任何 dsh 插件开发；第三部分只针对本项目。

---

## 速览

- 这是一个 **dsh 插件包（bundle）**：**替换** dsh 原生的 Web 启动器 + 加一层登录认证，让 `dsh web --host 0.0.0.0` 可以安全地暴露到局域网/非回环接口。
- 由**三个插件入口**组成（`package.json` 的 `exports` 子路径分别暴露）：
  - `dsh-web-startup-auth/startup` → 插件 id `remote-web-startup`（`src/startup.ts`）：与原版 `@deepseek-ai/dsh-web-app/startup` 唯一区别是**不拒绝 `--host 0.0.0.0`**，提供同名 `webStartup` 服务。
  - `dsh-web-startup-auth/auth` → 插件 id `web-auth`（`src/auth.ts`）：登录/注册页、会话 cookie、`/api` 路由保护、原生浏览器认证 cookie 补签（dsh 0.1.2 上游自带的 `dsh-auth-*` 签名 cookie，见「原生浏览器认证桥接」）、`webAuth` 服务。
  - `dsh-web-startup-auth/client` → **前端插件**（`src/client/index.tsx`，打包产物 `lib/client.js`）：向 DSH 设置面板的 `settings.section` slot 注册「认证」标签页（退出登录 + 修改用户名 + 修改密码）。
- 插件 id：`remote-web-startup` / `web-auth`；npm 包名：`dsh-web-startup-auth`；目录：`/home/pax/coding/dsh-web-startup-auth`。
- 构建流水线：`src/*.ts` → `tsc` → `lib/*.js`，前端插件额外 `tsdown` → `lib/client.js`（**必须 `npm run build` 后插件才能加载**，`exports` 指向 `lib/`）。
- 测试：`npm test`（vitest），凭据文件用临时目录隔离（见「如何测试」）。
- 本 fork 的母体（原版 web-app bundle）在 `/home/pax/coding/research/deepseek-harness/packages/bundle/web-app/`，涉及对比/移植时先对照它。

---

## 第一部分：dsh 插件开发通用知识

### dsh 是什么

dsh 是 DeepSeek Harness（`/home/pax/coding/research/deepseek-harness`）的 CLI 入口，一个**基于 cordis 的插件式 agent 框架——「一切皆插件」**。用户用 `dsh web` 启动 web 应用；应用由一组插件 bundle 按层叠加组合而成。

- **cordis**（`@deepseek-ai/cordis`）是框架内核：插件在 `Context` 上注册服务、监听事件、注入依赖。关键 API：`ctx.provide(key, value)`、`ctx.get(key)`、`ctx.effect(fn, label?)`（挂副作用）、`ctx.logger`。
- **profile** 是一个可启动的插件组合，位于 `$DSH_HOME/profiles/<name>/`（默认 `~/.dsh/profiles/`）。常见 profile：`web`、`headless`、`tui`。
- **bundle** = 一个 npm 包 + 一张 patch 配置层（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。安装进 profile 后 patch **自动应用**，无需手动编辑 profile 配置。

### 插件包的基本形态

一个 dsh 插件就是一个 npm 包（ESM，`"type": "module"`）。入口模块导出：

```ts
export const name = 'remote-web-startup'   // 插件 id（全局唯一，patch/配置用它定位）
export const inject = ['cmdlineArgs']      // 声明注入的能力名（缺失时插件不启动）
export function apply(ctx: Context, config) { /* 挂载逻辑 */ }
```

关键约定：

- **服务提供**：插件用 `ctx.provide('webStartup', values)` 提供服务，下游行（如 webserver、connection）通过 `inject` 或 `ctx.get('webStartup')` 消费。**服务名是契约**——替换插件必须提供同名同型服务，下游才能无感切换。
- **路由注册**：Web 类插件通过 `ctx.webServer.register(route)` 注册 HTTP 路由（route 有 `kind: 'exact' | 'prefix'`、`path`、`handler(req, res)`）；`webServer.tapIndex(fn)` 可改写 SPA 的 `index.html`。
- **生命周期**：`ctx.effect(fn, label)` 里的 fn 在插件激活后执行；`apply` 里抛错会中断整个 profile 启动。
- **命令行解析**：用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline(ctx, commanderProgram)`，把 commander 命令接到 dsh 的 `cmdlineArgs` 服务上。

### 前端插件（browser half）——给 DSH 界面注入 UI

DSH 的浏览器界面（SPA）**本身就是一组前端插件**：后端 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描所有 loader entry 的 `package.json` 的 `dsh.client` 声明，组合成 `window.__DSH_BOOT__` 注入 `index.html`，浏览器端 loader 按图加载每个包的 `lib/client.js` 并执行其 `apply`。**想给 DSH 界面加东西（设置面板标签页、菜单、按钮等），走的不是 `webServer.register`，而是这个前端插件机制**——一个 npm 包可以同时有 node half（`exports["."]`）和 browser half（`exports["./client"]`）。

要点与**踩过的坑**：

- 声明：`package.json` 加 `dsh.client: { platform: "web", inject: [依赖的前端插件包名] }` 和 `exports["./client"]`（`dsh.client` 与 `dsh.bundle` 的 patch 层互不排斥，可并存）。
- 打包：`lib/client.js` 由 `tsdown` 打包，格式为 `window.__ModuleLoader__.load({ id: 包名, factory: (require) => {…} })`；`react` / `react/jsx-runtime` / `@deepseek-ai/cordis` / `dsh-client-ui-slots` 保持 external（loader 模块表提供），其余依赖内联。
- **关键坑（客户端包必须插"包根行"）**：`ClientModuleRegistry` 用 loader entry 的 `name` 字段当**包名**去 resolve `package.json` 读 `dsh.client`。因此 `cordis.patch.yml` 里必须**插入一条 `name` 为纯包名（包根，如 `name: dsh-web-startup-auth`）的 entry**——只插子路径（`name: xxx/startup`）时该包永远不被识别为 client 包，`dsh.client` 声明形同虚设（本插件踩过，见「设置面板标签页」）。包根入口（`lib/index.js`）需导出 `apply()`（可为空，模仿 `@deepseek-ai/dsh-client-ui-settings` 的 node half），loader 才能激活该行。
- 设置面板是 **slot 贡献点机制**：`ui-settings` 声明 `settings.section` 契约（`packages/client/ui-settings/src/client/contract/slots.ts`），前端插件用 `ctx.slots.inject('settings.section', …)` 注册标签页（参考 `ui-settings-models/src/client/index.ts:118`）。

### bundle patch 机制

dsh 的 profile 配置由多层 patch 叠加合成，`cordis.patch.yml` 就是插件的 patch 文件。顶层是 **YAML 数组**，每项一个 patch 条目（本项目 `cordis.patch.yml` 的四种写法全覆盖）：

```yaml
- id: web-startup          # 1. 按 id 禁用原插件
  disabled: true

- id: connection           # 2. 给现有行追加注入依赖
  inject: [webServer, webRuntime, webAuth]

- insert:                  # 3. 插入自己的插件
    - id: remote-web-startup
      name: dsh-web-startup-auth/startup
```

- `{ id, disabled: true }`：禁用某个插件。
- `{ id, inject: [...] }`：给某个已有行追加注入的能力名。
- `{ insert: [{ id, name }] }`：插入插件（`name` 是 npm 包名 + `/子路径`；**前端插件包必须插纯包名「包根行」**，见「前端插件（browser half）」）。
- patch 里允许 `!!js` 表达式（仅限 config 值和 disabled 字段），其他元数据保持字面量。

### profile 组成与插件安装/卸载

一个 profile 目录（如 `~/.dsh/profiles/web/`）里：

| 文件 | 作用 |
|---|---|
| `cordis.yml` | profile 根，通常是空数组；**不要直接编辑** |
| `cordis.patch.yml` | 用户 patch 层（组合顺序在所有 bundle 之后） |
| `package.json` | `dsh.profile.bundles` 数组列出该 profile 启用的 bundle；`dependencies` 里是插件包本体（本地路径用 `link:/abs/path`） |
| `node_modules/` | pnpm 安装的依赖（按 profile 各自安装） |
| `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 安装锁 |

**CLI（唯一子命令 `plugin`，转发给 profile 目录里的 pnpm，`--profile` 必填）：**

```sh
cd /path/to/plugin-package
dsh plugin --profile web add .          # 本地源码：写 bundles + link: 依赖 + pnpm install
dsh plugin --profile web add dsh-web-startup-auth@latest   # 已发布到 npm registry 时；升级旧版本必须显式 @<版本> 或 @latest——不带版本号时 pnpm 保留现有 spec（0.1.0 或 link:）不动
dsh plugin --profile web remove <package-name>      # 卸载
dsh web                                     # 启动（新插件需重启生效）
dsh --profile web --dump-config            # 打印组合后的完整插件树（排查 patch 是否生效）
```

- `add .` 是 `link:` 安装，改源码+重建即生效，不用重装；但**插件目录改名/移动后必须重新 add**。
- 包若未发布到 npm，`add <包名>` 会失败——未发布只能用本地路径/tarball。
- 源码安装（git clone）后必须 `npm install && npm run build`，因为 `lib/` 构建产物不入库。

### 排查技巧

- `dsh --profile web --dump-config` 看组合后的插件树：确认 patch 生效、disabled 冲突、`# == <bundle>, patched by <bundle>` 标出的 patch 来源。
- 插件加载失败体现在 dsh 启动日志；`apply` 里抛错会中断启动。最常见的启动失败是 **`Cannot find module '.../lib/xxx.js'`——没构建**。
- 插件树里某行没有出现在 dump 输出，查 profile `package.json` 的 `dsh.profile.bundles` 是否有该包、patch 是否 `disabled`。
- **前端插件不生效时**：先 `curl -s <主机>:<端口>/ | grep -o '__DSH_BOOT__[^<]*'` 看 entry 里有没有你的包名；再 `curl -s -o /dev/null -w "%{http_code}" <主机>:<端口>/plugins/<包名>/client.js` 应返回 200。若包名不在 boot 图里，查 patch 是否有「包根行」（`name` 为纯包名）、包根入口是否导出了 `apply()`。

---

## 第二部分：本插件 dsh-web-startup-auth

### 它做了什么（与原版的差异）

原版 `@deepseek-ai/dsh-web-app/startup`（`packages/bundle/web-app/src/startup.ts:69`）对 `--host 0.0.0.0` **硬拒绝**（`program.error('... intentionally not supported yet for safety ...')`）。本插件用两个子模块替换并补上认证：

1. **`remote-web-startup`**：行为与原版一致，只是**删掉 0.0.0.0 拒绝**。安全责任转移到 auth 插件。
2. **`web-auth`**：强制远程访问者登录——登录/注册页（`/login`）+ 签名会话 cookie + 全部 `/api` 路由保护（`/api/auth/*` 除外）。免认证的只有**真正的回环请求**（见「信任判定」），与启动参数无关。**dsh 0.1.2 起**上游自带浏览器认证且回环不豁免，本插件额外做「原生 cookie 补签」桥接（见「原生浏览器认证桥接」）——0.1.1 时代的「Host/Origin 回环改写」已随上游删除 `PRIVILEGED_METHODS` 而移除。
3. **`auth-reset` 子命令**：`dsh --profile web auth-reset [--password <pwd>] [--username <name>]`，重设管理员密码和/或修改用户名并**轮换签名密钥**（所有已发会话 cookie 立即失效）——忘记密码、忘记用户名、修复含控制字符用户名的恢复路径。只给 `--username` 时密码保持不变；都不给时交互式输入新密码（历史行为）。
4. **设置面板「认证」标签页**：前端插件通过 `ctx.slots.inject('settings.section', …)` 注册，提供退出登录（调 `/api/auth/logout`）、修改用户名与修改密码（分别调 `/api/auth/change-username` / `/api/auth/change-password`，服务端校验当前密码后轮换密钥并重签当前会话）。

### 关键机制（踩过的坑）

**会话认证**：密码用 scrypt（随机盐，64 字节）散列存 `~/.dsh/web-auth.json`（含 `username` / `passwordHash` / `secret`）；会话 cookie `dsh_sid` = `base64url(JSON{u,e}).HMAC-SHA256(secret)`，14 天有效、`HttpOnly` + `SameSite=Lax`。`secret` 随机 32 字节，`auth-reset` 时轮换。
**用户名净化（issue #14）**：`credential-store.ts` 的 `normalizeUsername` 剥除 C0 控制字符（0x00–0x1F）与 DEL（0x7F）再 trim（`trim()` 只剥空白，控制字符会原样入盘），register/login/change-username 入口统一走它，剥空则 400。**`verifySession` 只验 HMAC+时效、不比对 payload 的 `u` 与存储 username**——因此改用户名（同改密码）必须轮换 `secret` 才能作废旧会话；`updateCredentials({ username?, password? })` 是统一的单次写+单次轮换入口，`resetPassword`/`changeUsername` 都是其薄封装。

**信任判定：按请求，不按绑定地址（重要）**。免认证（隐式信任）要求**两个条件同时成立**：TCP 对端地址（`req.socket.remoteAddress`，含 `::ffff:127.0.0.1` / `::1`）是回环 **且** `Host` 头 authority 是回环（`isTrustedOrigin`）。否则必须带有效会话 cookie。
- **为什么不能只看绑定地址**：`--host 127.0.0.1` + nginx 反代时，绑定地址是回环但访问者是远程的——只按绑定地址判定会让反代后的所有人免认证（issue #6 的第二种场景）。
- **为什么两个条件都要**：只看 `Host` 头 → LAN 攻击者伪造 `Host: 127.0.0.1` 即可绕过认证；只看对端地址 → 同机反代（从 127.0.0.1 连入）会被误判为本机用户。两者都满足的访问者本来就能连回环，免认证安全。
- **`X-Forwarded-For` 不采信**（客户端可伪造）。反代要让其客户端按远程处理，只需转发真实 `Host`（nginx 默认即 `proxy_set_header Host $host;`）；若把 `Host` 写死成回环，本插件就认为请求来自本机并放行——README 的安全说明里明确写了这条配置禁忌。
- **前端跳转必须与判定一致**：`tapIndex` 注入的首页脚本只在 `!authenticated` 时跳 `/login`。曾经额外要求 `registered`（`!registered || !authenticated`），导致回环模式下未注册时 `authenticated=true` 而首页仍跳 login、login 页又跳回首页的死循环（issue #6）。`authenticated` 语义已含回环信任，前端不要再叠加 `registered` 条件。
- **0.1.2 的回环体验闭环**：上游对回环也强制原生 cookie，但本机浏览器免登录体验不受影响——回环请求过 `isTrustedOrigin` 后由「原生 cookie 补签」的 303 单跳补发 cookie（见下节），用户无感。注意 0.1.2 下**裸 `curl` 不带 cookie 调 `/api` 仍 401**（上游语义，本机也不例外）；CLI/脚本请用启动打印的 token URL 换取 cookie。

**路由保护顺序（重要）**：`web-auth` 在 `apply` 里同步包装 `webServer.register` 与 `webServer.registerUpgrade`，所以 `cordis.patch.yml` 必须给 `connection` 行追加 `inject: [webAuth]`，保证 auth 插件在 connection 注册 API 路由**之前**激活。改动 patch 时保持这个注入，否则 API 不设防。

**覆盖范围（所有路由 + index fallback，含事后追溯）**：包装**不只限 `/api` 前缀**——所有经 `webServer.register`/`registerUpgrade` 注册的路由（含第三方插件的非 `/api` channel，如 `/dsh-automation`、技能管理器）都做「认证 + 原生 cookie 补签（0.1.2）」；只有 `/login` 与 `/api/auth/*` 保持匿名。**0.1.2 的 index.html 走 `webServer.registerFallback`（frontend-static），不在 exact/prefix 路由表里，必须单独包装**（fallback 是 webserver 的私有单座属性 + `registerFallback` 方法，包装方式 = 事后追溯替换私有 `fallback` 字段 + 包装 `registerFallback` 方法两路都做）——漏了它，远程/回环访问 `/` 都直接撞上游 `authorizeIndex` 的 401 纯文本（实测发现）。**关键坑**：cordis 的激活顺序**不是 bundle/树顺序**（动态 import 完成顺序不定，实测无论 bundle 怎么排，第三方插件都可能先于 web-auth 激活），所以包装必须在 apply 时**遍历 webserver 路由表（`exact`/`prefixes`/`upgrades` Map）把已注册的路由事后包装**（WeakSet 防重复），再包装未来的注册。只包装 `register` 而不做事后追溯时：先激活插件的路由（技能管理器 `/api/dsh-skills-manager`）、非 `/api` channel（`/dsh-automation/snapshot`）以及 WebSocket 升级（`/api/events.*`）都会绕过认证对远程用户开放。

**原生浏览器认证桥接（dsh 0.1.2 起，替代旧「特权 API 回环放行」）**：0.1.2 上游自带浏览器认证（`packages/client/connection/src/browser-auth.ts`）：`/api` 闸门 = 信任围栏（`isTrustedApiRequest`，403）+ 原生签名 cookie 检查（`isAuthenticated`，401），`index.html` 也被 `authorizeIndex` 把守，**无回环豁免**（回环也要原生 cookie）。旧版靠「Host/Origin 改写绕过 `PRIVILEGED_METHODS`」的靶子（`PRIVILEGED_METHODS` 与 `authority:"loopback"` channel）**已被上游删除**——改写若还在反而自伤（原生按改写后 authority 找 cookie 名必 401），故 0.1.2 迁移时整段删除。新机制：**原生 cookie 补签**——凡通过我方认证（有效 `dsh_sid` 或真回环，`isTrustedOrigin`）的请求，若缺原生 cookie，则用上游存于 credentials 服务的签名密钥（`credentialKey('client-connection','browser-session')`，只读不建）按**请求的真实 authority**（`new URL('http://'+Host).host` 规范化）补发 `dsh-auth-<sha256(authority)>` cookie（值 = `v1.<base64url(payload)>.<base64url(HMAC)>`，30 天，格式逐字节对齐上游）。
- **页面导航（GET/HEAD）**缺原生 cookie → 包装器直接 **303 + Set-Cookie + Location 原路径**（上游 token 交换同款跳法），下一请求即过原生闸门；**RPC/静态资源** 不跳（303 会把 POST 变 GET），转发下游（浏览器已从页面跳拿到 cookie）。
- **未认证的页面导航** → 302 `/login`（上游只会回 401 纯文本，丑）；未认证 RPC/静态资源 → 401。
- **secret 缺席竞态**：connection 插件激活时才建 secret，可能晚于本插件——secret 缺席时本次不补签、下请求重试；**绝不自己创建**（密钥归上游）。缓存按 credentials 服务实例做 WeakMap，实例更换（重启/重装）自动失效。
- **补签是强耦合点**：cookie 格式、名称算法、存储 key 任一上游变更都要跟——升级 dsh 后第一步 diff `browser-auth.ts`（`docs/upgrade-dsh-0.1.2-playbook.md` 观察哨）。
- **`dsh_sid` 仍是唯一认证边界**：只带原生 cookie 不带 `dsh_sid` 的请求照样拒绝——原生 cookie 无账号、30 天不可撤销，登出/改密/`auth-reset` 的可撤销性全靠包装器兜住。登出响应除清 `dsh_sid` 外追加 `Max-Age=0` 的同名原生 cookie（名字可算、不需 secret）。

**「浏览器端 scope gate」isLoopback 覆盖——0.1.2 已退役删除（重要）**：rc.8–0.1.1 时代，DSH 前端 `connection.isLoopback` 由**浏览器地址栏 hostname** 判定（`connection/src/client/index.ts`；0.1.1 在 :228，0.1.2 同文件仍在），远程浏览器恒为 false → settings mirror 走 memory 模式、`settingsScope.bind()` 冻结 persistence → 插件配置卡片与 Models 页不可用。当时的解法是 node 侧 tapIndex 注入脚本在 connection `apply` 返回瞬间把 `isLoopback` 覆盖为恒 true（getter）+ 前端防御性重放 + mirror 兜底。
**0.1.2 起必须删除，覆盖会破坏 web boot（实测 2026-09-03 A/B）**：上游引入真实 cookie 认证后，远程浏览器已认证即可正常使用所有设置面（LAN 实测：通用设置/模型/插件/插件市场/认证五个 section 全部渲染，无 "settings are unavailable"），不再需要伪回环。强行覆盖反而导致 boot 失败——UI 显示 "web boot: 26 entries did not activate"（session/uiSession/remote.session 等核心服务链全部 pending，console 无单个 cause）。已从 `src/auth.ts` tapIndex 注入与 `src/client/index.tsx` 删除全部覆盖逻辑；`src/client/index.tsx` 简化为单层 `inject: ['slots']` 直接注册「认证」标签页，mirror 兜底一并移除。0.1.1 时代若需要恢复，参考 git 历史里 tapIndex 的 `installIsLoopbackOverride`。

**`crypto.randomUUID` polyfill**：通过局域网 IP + 明文 HTTP 访问时页面处于非安全上下文，`crypto.randomUUID` 不存在，DSH 前端每个 RPC 都会抛错（表现为 "WebSocket is closed..." + 无限重连）。`web-auth` 通过 `webServer.tapIndex` 向 SPA 注入基于 `crypto.getRandomValues` 的 polyfill，在客户端 bundle 运行前生效。

**登录页品牌字标**：`src/login-page.ts` 内联了从 `packages/client/ui-primitives/src/BrandWordmark.tsx` **原样提取**的 SVG（deepseek 字母 + HARNESS 徽章板，鲸鱼已删）。徽章字母的 `fill="var(--dsw-alias-label-primary-inverted)"` 依赖页面 `:root` 中定义的该变量（`#ffffff`）——删除会变黑看不见。

**凭据文件可覆盖**：`credential-store.ts` 读 `process.env.DSH_WEB_AUTH_FILE`（默认 `~/.dsh/web-auth.json`）。测试用它指向临时文件，**不碰真实凭据**。

**设置面板标签页（前端插件机制）**：DSH 的 SPA 本身就是一组「前端插件」——后端 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描所有已安装包的 `dsh.client` 声明，组合成 `window.__DSH_BOOT__`，浏览器 loader 按图加载每个包的 `lib/client.js` 并执行其 `apply`。设置面板是 slot 贡献点机制：`ui-settings` 声明 `settings.section` 契约（`packages/client/ui-settings/src/client/contract/slots.ts`），前端插件用 `ctx.slots.inject('settings.section', …)` 注册标签页（参考 `ui-settings-models/src/client/index.ts:118`）。本插件的 `src/client/index.tsx` 即按此注册「认证」标签页。要点：
- `package.json` 需声明 `dsh.client: { platform: "web", inject: [依赖包名] }` 与 `exports["./client"]`；`dsh.client` 与 `dsh.bundle`（patch 层）互不排斥。
- **必须插「包根行」**：`ClientModuleRegistry` 按 loader entry 的 `name`（patch 里 insert 的 `name` 字段）当包名去解析 `package.json` 读 `dsh.client`，所以 `cordis.patch.yml` 里除了 `remote-web-startup`/`web-auth` 两个子路径行，还插了一条 **`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`**（纯包名）。删掉它标签页就不会出现。`src/index.ts` 的空 `apply()` 就是为这个包根行存在的（模仿 `ui-settings` 的 node half）。
- `lib/client.js` 由 `tsdown`（`tsdown.config.ts`，模仿 harness 的 `clientBundle` preset）打包，格式为 `window.__ModuleLoader__.load({ id, factory })`；`react`/`@deepseek-ai/cordis`/`ui-slots` 保持 external（loader 模块表提供），其余依赖内联。
- 组件 props 必须匹配 `PropsRuntime<'settings.section'>`（owner share 是 `{ close }`），不能用裸 `SettingsSectionOwnerProps`。
- 前端插件：单层插件 `inject: ['slots']`（等 slots 服务就绪）直接注册「认证」标签页；标签页调 `/api/auth/*` 走普通 `fetch`，不走 connection RPC。**无 isLoopback 覆盖、无 mirror 兜底**（0.1.2 删除，见「浏览器端 scope gate」退役说明）。
- **0.1.2 客户端类型变化**：`@deepseek-ai/dsh-client-runtime` 包（旧 `ClientContext` 来源）已被上游删除，客户端插件直接 `import type { Context } from '@deepseek-ai/cordis'`（cordis 代理在运行时按服务名取属性）；`slots`/`settingsScope` 等 Context 成员的类型合并由消费方的 assembly 包提供，本插件用**窄结构断言**读取（见 `src/client/index.tsx` 注释）而不声明 merge，避免依赖未安装的类型包。
- 改了 `cordis.patch.yml` 或前端插件后**必须重启 `dsh web`**（patch 按包名缓存、不热加载）。

### 核心代码路径

| 文件 | 职责 |
|---|---|
| `src/startup.ts` | `remote-web-startup` 插件：commander 解析 `--host/--port/--trusted-host`，`provide('webStartup', values)`；`auth-reset` 子命令（`runAuthReset`）；`WEB_STARTUP_SERVICE` 常量 |
| `src/auth.ts` | `web-auth` 插件：登录页路由、`/api/auth/*` 端点（status/register/login/logout/change-password/change-username）、包装 `webServer.register`/`registerUpgrade`/`registerFallback` 做全路由保护（认证 + 原生 cookie 补签，见「原生浏览器认证桥接」）、`tapIndex` 注入 randomUUID polyfill + 未登录跳转、`provide('webAuth')` |
| `src/credential-store.ts` | 凭据持久化：scrypt 散列、`normalizeUsername`（剥 C0+DEL）/ `registerCredentials` / `validateCredentials` / `updateCredentials`（单次写+轮换）/ `resetPassword` / `changePassword` / `changeUsername` / `getUsername` / `signSession` / `verifySession` / `hasCredentials`；`DSH_WEB_AUTH_FILE` 覆盖 |
| `src/login-page.ts` | 自包含登录/注册页 HTML（黑白蓝风格 + brand wordmark SVG） |
| `src/client/index.tsx` | **前端插件**：向设置面板 `settings.section` 注册「认证」标签页（退出登录 + 修改用户名 + 修改密码 UI），打包为 `lib/client.js` |
| `tsdown.config.ts` | 前端插件打包配置（`window.__ModuleLoader__.load` 格式、external 列表） |
| `src/index.ts` | 仅类型导出（`WebStartupValues`、`AuthConfig`、`WebAuthService`） |
| `cordis.patch.yml` | bundle patch：禁用 `web-startup`、insert 三个插件（含包根行 `dsh-web-startup-auth`，客户端扫描必需）、`connection` 注入 `webAuth` |

### 如何修改

1. **改 `src/*.ts`（或 `src/client/*.tsx`），然后 `npm run build`**（`lib/` 是唯一被加载的产物：`tsc` 出 node 侧、`tsdown` 出前端 bundle；不构建等于没改）。
2. 想对照原版行为时看 harness 的 `packages/bundle/web-app/src/startup.ts`（原版 startup 逻辑）。
3. 涉及认证/信任语义时，对照 harness 的 `packages/client/connection/src/browser-auth.ts`（0.1.2 原生浏览器认证：cookie 格式、secret 存储——**本插件「原生 cookie 补签」是对它的精确镜像，升级 dsh 后先 diff 此文件**）、`api-request-trust.ts`（浏览器信任围栏，403 部分）与 `rpc-host.ts`（`requestRejection` 双闸门）。0.1.1 时代的 `PRIVILEGED_METHODS` 已在 0.1.2 删除。
4. 改动 `cordis.patch.yml` 时保持 `connection.inject: [webAuth]`（见「路由保护顺序」），并**保持「包根行」**（`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`，见「设置面板标签页」）——删除它前端插件不会进 boot 图。
5. 改前端标签页时对照 `ui-settings-models/src/client/index.ts`（slot 注册范本）与 `packages/client/ui-settings/src/client/contract/slots.ts`（`settings.section` 契约）；组件 props 用 `PropsRuntime<'settings.section'>`。
6. 改完跑测试（见下），**更新 README.md 和本文件的对应段落**。

### 如何测试

```sh
cd /home/pax/coding/dsh-web-startup-auth
npm install        # 首次
npm run typecheck  # tsc --noEmit
npm test           # vitest run tests
npm run build      # tsc，产物到 lib/；tsdown 打包前端 bundle 到 lib/client.js
```

- `tests/auth.spec.ts`：用 fake Context（mock `webServer`/`effect`）验证 `webAuth.authenticate`——真正回环请求放行、远程无 cookie 拒绝、有效 cookie 通过、过期 cookie 拒绝、同机反代（回环 IP + 公网 Host）需会话、伪造回环 Host 的远程请求不放行；`/api/auth/status` 的四种判定（本地未注册 / 反代未登录 / LAN 未登录 / 已登录带用户名）；认证端点（register/login/change-password/change-username：用户名净化、限速、密钥轮换、重签会话、旧/当前密码校验、同名 no-op 不轮换）；以及**原生 cookie 桥接**（0.1.2）：已认证页面导航缺原生 cookie → 303 + Set-Cookie + Location 原路径、cookie 名随 authority（sha256）、值可 HMAC 校验对齐上游格式、回环免登录也补签、已带 cookie 直接转发、secret 缺席（fake provider 返回空）不 mint、非导航（POST RPC）不 303、未认证页面导航 → 302 /login、未认证 XHR → 401、登出清两 cookie、登录响应双 cookie。fake 的 `credentials` 服务通过 `fakeWebAuthContext(..., credentials)` 注入，secret 缓存按服务实例隔离（WeakMap）。
- fake 请求**必须同时给 `socket.remoteAddress` 和 `headers.host`**——信任判定两个都读，缺一个就按远程处理（`requestWithCookie` / `httpRequest` / `jsonRequest` 默认给回环值）。
- `tests/startup.spec.ts`：验证 `--host 0.0.0.0` 被接受、`webStartup` 服务值、`auth-reset` 子命令（改密/改用户名、密钥轮换、退出码）。
- 每个测试 `beforeEach` 用 `mkdtempSync` + `DSH_WEB_AUTH_FILE` 隔离凭据文件，`afterEach` 清理。
- **注意**：`npm pack` / `npm publish` 会触发 `prepack`（typecheck + test + build 全跑），测试不过无法发布。

### 如何部署 / 卸载

```sh
# 部署（本地源码，link: 方式）
dsh plugin --profile web add /home/pax/coding/dsh-web-startup-auth
# 重启后生效
dsh web --host 0.0.0.0

# 卸载
dsh plugin --profile web remove dsh-web-startup-auth
dsh web
```

验证：浏览器访问 `http://<主机IP>:<端口>/` → 首次显示注册页（设置管理员账号密码），之后显示登录页；未登录访问 `/api/*` 返回 401。

忘记密码：`dsh --profile web auth-reset`（推荐，轮换密钥使旧会话失效）；或删除 `~/.dsh/web-auth.json` 重启后重新注册。

### 依赖更新（Renovate 机器人）

仓库挂了 **Mend 托管的 Renovate bot**（Community 免费计划，门户 `developer.mend.io/github/GDWhisper/dsh-web-startup-auth`），负责自动提依赖更新 PR。要点：

- **配置**：仓库根 `renovate.json`（`config:recommended` + `dependencyDashboard: true`）。三条定制规则：
  - `@deepseek-ai/dsh-*`（除 `cordis`/`schemastery`）**跟随 `next` dist-tag** 并 bump range——这些包的 `latest` 是占位版本，真正的发布在 `next` 上（见 renovate.json 内注释）。
  - **`react` / `@types/react` 禁用更新**（锁 18）：前端插件的 react 是 external，运行时用宿主 SPA 提供的 React 18（harness 锁 `^18.2.0`），本地升 19 会对不上运行时。改动这条前想清楚。
  - **`typescript` 限制在 `6.x`**（`allowedVersions`，不是 `enabled: false`——6.x 的 patch/minor 照提）：基准是**对齐 harness 的 `^6.0.3`**，不跟 `latest`。7.0 是原生（Go）端口，`bin` 里去掉了 `tsserver`、`package.json` 不再有 `main`/`types`（programmatic TS API 消失），编辑器选 "use workspace version" 会没有语言服务；`tsdown` 依赖链里的 `rolldown-plugin-dts` 会 import TS API（现在没炸只是因为 `tsdown.config.ts` 写了 `dts: false`）。
- **触发方式**：任务是**推送/手动触发**（Reason: `requested`），没有定时调度——推送到 main 才会跑。排查"机器人没动静"时别傻等。
- **Dependency Dashboard 是 issue #9**：bot 自动维护，汇总待合并/被限流（每小时最多开 2 个 PR）的更新；**不要关闭它**（关了会被重建）。被限流的更新会在后续运行自动补开，也可在 issue 里勾选复选框强制。
- **踩过的大坑：mend.io 的 Silent mode**。开启后任务照跑（jobs 全 DONE）但**零产出**——不开 PR、不建 Dashboard。表现为"任务成功却毫无动静"。在门户仓库 Settings 里关闭，再手动触发一轮即恢复。排查顺序：门户 Recent jobs → Silent 开关 → job 日志。
- **处理它的 PR**：分支 `renovate/*`、作者 `app/renovate`。本仓库**没有 PR 触发的 CI**（`publish.yml` 只在发布时跑），合并前必须本地验证：`npm install && npm run typecheck && npm test && npm run build`。major 更新要跑全链路。**当前基线**：`vitest ^4`（4.1.11，与 harness 的 `^4.1.8` 同代）、CI/`@types/node` 为 **24**、`typescript ^6.0.3`（对齐 harness，机器人给的 7.x 已拒）。
- **一次多个依赖 PR 时注意合并顺序**：它们的 `package.json` / `package-lock.json` 改动可能互相冲突（实测 #10 node + #12 vitest 能干净叠加，但 #11 typescript 最后合就同时冲突两处——它新增的 `@typescript/*` 条目块正好插在 #12 重写的 `@vitest/*` 区域里）。用 `git merge-tree --write-tree <a> <b>` 先试推演，冲突的那条改成手动 `npm install` 重生成 lock。合并后**务必在拉到的 main 上再跑一遍全链路**，不是只看单个 PR 的分支。
- **注意**：`package-lock.json` 的 registry 指向 npmmirror 的问题尚未处理（用户决定暂缓）；若 Dashboard 出现大量 "Failed to look up" 条目，先怀疑它。

### 本机环境备注

- **harness 源码**（dsh 本体）：`/home/pax/coding/research/deepseek-harness`。相关位置：
  - `packages/bundle/web-app/src/startup.ts` — 原版 web-startup（0.0.0.0 拒绝在 ~69 行）
  - `packages/bundle/web-app/src/index.ts` — web-app bundle（webserver 行、`webStartup` 服务消费方）
  - `packages/client/connection/src/browser-auth.ts` — 0.1.2 原生浏览器认证（原生 cookie 签名/校验；本插件「补签」的镜像对象）
  - `packages/client/connection/src/rpc-host.ts` — `requestRejection` 双闸门（403 信任围栏 + 401 原生 cookie）
  - `packages/client/connection/src/api-request-trust.ts` — 浏览器信任围栏（DNS rebinding / 跨站防护）
  - `packages/client/ui-primitives/src/BrandWordmark.tsx` — 登录页品牌字标 SVG 的出处
  - `packages/client/modules/src/index.ts` — `ClientModuleRegistry`（前端插件 boot 图组合、`/plugins/??<id>/client.js&rev=…` 分发、`dsh.client` 扫描）
  - `packages/client/ui-settings/src/client/contract/slots.ts` — `settings.section` 等设置面板 slot 契约
  - `packages/client/ui-settings-models/src/client/index.ts:118` — 前端插件向 `settings.section` 注册标签页的范本
  - `packages/client/tsdown.client.ts` — 前端插件 bundle 的 `clientBundle` preset（`tsdown.config.ts` 的模仿对象）
  - `packages/bundle/web-app/cordis.patch.yml` — 前端插件「包根行」的官方写法（如 `id: ui-settings / name: '@deepseek-ai/dsh-client-ui-settings'`）
- `@deepseek-ai/dsh-host-webserver`（`WebServer`/`WebRoute` 类型）是独立 npm 包，源码不在仓库内，看 `node_modules/@deepseek-ai/dsh-host-webserver/` 的类型声明。
- profile 现状：`~/.dsh/profiles/web/` 以 `link:/home/pax/coding/dsh-web-startup-auth` 安装；`dsh.profile.bundles` 含 `dsh-web-startup-auth`。改动后重启 `dsh web` 生效。

---

## 约定（本项目内）

- **版本跟进基线**：README 声明跟进官方 `next` dist-tag（不跟 `alpha`）。当前基线 dsh 0.1.2-rc.1（迁移执行中/已完成见 `docs/upgrade-dsh-0.1.2-playbook.md`）；上游再出 `next` 新版本时按该手册「观察哨」核对（先 diff `browser-auth.ts`）。
- 文件：`src/*.ts` 与 `src/client/*.tsx`（源码，唯一修改入口）、`lib/`（构建产物，不入库但发布时由 `files` 字段带上）、`tsdown.config.ts`（前端 bundle 打包）、`cordis.patch.yml`（bundle patch）、`tests/*.spec.ts`（vitest）、`renovate.json`（依赖更新机器人配置，见「依赖更新（Renovate 机器人）」）、`README.md`（用户文档）。
- **改源码后必须 `npm run build`**（tsc + tsdown），否则 profile 里跑的还是旧产物；发布前必须保证 `npm pack` 全链路（prepack）通过。
- 不要为了「省事」改掉 `cordis.patch.yml` 里的 `connection.inject: [webAuth]`——它保证 auth 在 API 路由注册前生效，是安全边界的一部分。
- 同样不要删 `cordis.patch.yml` 里的**包根行**（`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`）——它是前端插件进 `__DSH_BOOT__` 的前提，删掉后设置面板「认证」标签页消失。
- 改动认证/信任逻辑时，先读 harness 里对应机制（`browser-auth.ts` 的原生 cookie 格式与 secret 存储、`rpc-host.ts` 双闸门、`api-request-trust.ts`）再动手，避免破坏「`dsh_sid`/回环信任 → 原生 cookie 补签」的等价性；**不要重建已被 0.1.2 删除的 Host/Origin 回环改写**。
- 登录页品牌元素必须**照搬原版 SVG**（可从 `BrandWordmark.tsx` 提取），不要用 CSS 手绘模拟。
