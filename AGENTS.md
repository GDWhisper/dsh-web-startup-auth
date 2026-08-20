# AGENTS.md

本文件是 dsh 插件（`dsh-web-startup-auth`）的入场指南。**先读「速览」，再看「通用 dsh 插件知识」，最后读本插件专属部分。** 前两部分通用，可复用到任何 dsh 插件开发；第三部分只针对本项目。

---

## 速览

- 这是一个 **dsh 插件包（bundle）**：**替换** dsh 原生的 Web 启动器 + 加一层登录认证，让 `dsh web --host 0.0.0.0` 可以安全地暴露到局域网/非回环接口。
- 由**三个插件入口**组成（`package.json` 的 `exports` 子路径分别暴露）：
  - `dsh-web-startup-auth/startup` → 插件 id `remote-web-startup`（`src/startup.ts`）：与原版 `@deepseek-ai/dsh-web-app/startup` 唯一区别是**不拒绝 `--host 0.0.0.0`**，提供同名 `webStartup` 服务。
  - `dsh-web-startup-auth/auth` → 插件 id `web-auth`（`src/auth.ts`）：登录/注册页、会话 cookie、`/api` 路由保护、`webAuth` 服务。
  - `dsh-web-startup-auth/client` → **前端插件**（`src/client/index.tsx`，打包产物 `lib/client.js`）：向 DSH 设置面板的 `settings.section` slot 注册「认证」标签页（退出登录 + 修改密码）。
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
2. **`web-auth`**：绑定非回环接口时强制登录——登录/注册页（`/login`）+ 签名会话 cookie + 全部 `/api` 路由保护（`/api/auth/*` 除外）。回环绑定（127.0.0.1 等）时隐式信任，不强制登录。
3. **`auth-reset` 子命令**：`dsh --profile web auth-reset [--password <pwd>]`，重设管理员密码并**轮换签名密钥**（所有已发会话 cookie 立即失效）——忘记密码的恢复路径。
4. **设置面板「认证」标签页**：前端插件通过 `ctx.slots.inject('settings.section', …)` 注册，提供退出登录（调 `/api/auth/logout`）与修改密码（调 `/api/auth/change-password`，服务端校验旧密码后轮换密钥并重签当前会话）。

### 关键机制（踩过的坑）

**会话认证**：密码用 scrypt（随机盐，64 字节）散列存 `~/.dsh/web-auth.json`（含 `username` / `passwordHash` / `secret`）；会话 cookie `dsh_sid` = `base64url(JSON{u,e}).HMAC-SHA256(secret)`，14 天有效、`HttpOnly` + `SameSite=Lax`。`secret` 随机 32 字节，`auth-reset` 时轮换。

**路由保护顺序（重要）**：`web-auth` 在 `apply` 里同步包装 `webServer.register` 与 `webServer.registerUpgrade`，所以 `cordis.patch.yml` 必须给 `connection` 行追加 `inject: [webAuth]`，保证 auth 插件在 connection 注册 API 路由**之前**激活。改动 patch 时保持这个注入，否则 API 不设防。

**覆盖范围（所有路由，含事后追溯）**：包装**不只限 `/api` 前缀**——所有经 `webServer.register`/`registerUpgrade` 注册的路由（含第三方插件的非 `/api` channel，如 `/dsh-automation`、技能管理器）都做「认证 + Host/Origin 回环改写」；只有 `/login` 与 `/api/auth/*` 保持匿名。**关键坑**：cordis 的激活顺序**不是 bundle/树顺序**（动态 import 完成顺序不定，实测无论 bundle 怎么排，第三方插件都可能先于 web-auth 激活），所以包装必须在 apply 时**遍历 webserver 路由表（`exact`/`prefixes`/`upgrades` Map）把已注册的路由事后包装**（WeakSet 防重复），再包装未来的注册。只包装 `register` 而不做事后追溯时：先激活插件的路由（技能管理器 `/api/dsh-skills-manager` → `forbidden host`）、非 `/api` channel（`/dsh-automation/snapshot` → 403 `forbidden`）、以及 WebSocket 升级（`/api/events.*` → 403，事件流连不上）都会对远程用户报错。

**特权 API 回环放行**：harness 的 `packages/client/connection/src/index.ts` 把 `settings.*`、`credentials.*`、`agentPreset.*`、`llm.discoverModels` 等 `PRIVILEGED_METHODS` 限制为**仅回环可访问**（注释原文：`until a real authentication layer exists`）；`rpc-host.ts` 的 `authority: "loopback"` channel（第三方 RPC）同样只认回环 Host。远程访问时这些接口返回 403。`web-auth` 的解法：认证通过后把请求 `Host`/`Origin` 头临时改写为 `127.0.0.1:<port>` 再转发给下游 handler（处理完还原）。**有效会话即认证层，等价于回环信任。**

**浏览器端 scope gate（rc.8 由前端插件化解，必须早于任何 scope bind）**：DSH 前端 `connection.isLoopback` 由**浏览器地址栏 hostname** 判定（`packages/client/connection/src/client/index.ts:106`），远程浏览器（域名/IP）恒为 false → `SettingsDescribeMirror` 用 memory 模式（`@deepseek-ai/dsh-client-ui-settings/lib/client.js:1340`，`ui-settings/settings-scope.ts:204`）且每个 `SettingsScopeController` 在 `bind()` 时按 `connection.isLoopback` 冻结 persistence（`settings-scope.ts:251`）——host 模式订阅 mirror 并 derive，memory 模式**不订阅不 derive**（`settings-scope.ts:990`）→ `status` 永远 `unavailable` → `PluginCard` 在 `!available` 时返回 null（`ui-settings-plugins/lib/client.js:206`），**整个卡片（header+body）都不渲染**。Models 页也走 `ctx.settingsScope.describe()`（共享 mirror），mirror memory 时 `load()`/`ensure()` 都短路 → Models 页抛 "settings are unavailable in this browser"。

**解法关键：覆盖 `isLoopback` 的时机必须早于 mirror 构造和所有 `bind()`，而前端插件的激活时序不可依赖。** 实测（2026-08-20）即使把根插件 `inject` 缩到 `['connection']`，**fiber 创建顺序取决于 bundle script 的异步加载完成顺序**（`web/src/boot.tsx` 注释明言 "Entry creation order carries no semantics"），本插件 bundle 在用户 patch 层、加载靠后，激活仍晚于 ui-settings 构造 mirror——mirror 已 memory，且**已绑定的 memory scope 无法事后修复**（不订阅 mirror、不 derive、实例藏在 ui-settings-plugins 的私有字段里），刷新也救不回。**因此权威解法放在 node 侧**：
1. **`src/auth.ts` 的 tapIndex 注入脚本**（与 randomUUID polyfill 同一注入点）：轮询等 `window.__ModuleLoader__.mode === 'live'`（`ClientModuleSystem.create()` 会把 HTML 安装的 queue 版 facade 的 `load` 替换为注册函数；**必须等 live 后再 hook，否则包装被 create 替换丢弃**）后包装 `loader.load`：对每个 bundle 的 `factory` 包一层，在 `exports.apply(ctx)` 返回后立即 `Object.defineProperty(connection, 'isLoopback', { configurable: true, get: () => true })`。connection 插件（`inject: []`）是 boot 最早激活的插件之一，其 apply 返回瞬间覆盖——**早于 cordis notify 任何依赖 fiber**（notify 在 apply 返回后的 `_updateState`/微任务才发生），所以 ui-settings 构造 mirror 和所有 `bind()` 读到的都是 true。包装对所有 bundle 幂等（反复 defineProperty 同一 getter）。
2. **`src/client/index.tsx` 根插件 `inject: ['connection']` + 子插件 `inject: ['slots', 'settingsScope']`**：防御层——若注入钩子未跑（future 版本 HTML 结构变化），根插件尽可能早地重放覆盖；子插件等两服务就绪后注册「认证」标签页并做 mirror 兜底（memory→host + load，仅对直读 mirror 的面有用）。

**为什么 getter 而非赋值**：`Object.defineProperty` getter 使**所有**未来读取恒为 true（mirror 构造、每次 bind、HMR 重载后重新读），赋值只覆盖当前值。rc.8 全代码树无对 `isLoopback` 的赋值（`grep -rn 'isLoopback\s*='` 仅读到引用），getter-only 安全。

**作用域**：此修复对**所有** `settingsScope.bind()`（不仅是插件配置页：还含 ui-conversation 的 `conversation` namespace settings、ui-theme、ui-locale 等）都生效——它们都按 `connection.isLoopback` 冻结 persistence。Models 页"settings are unavailable"也由同根因 + mirror 路径引发，根因修复后无需单独的 mirror 兜底（但保留作为防御层，HMR/版本差异时的安全网）。

**`crypto.randomUUID` polyfill**：通过局域网 IP + 明文 HTTP 访问时页面处于非安全上下文，`crypto.randomUUID` 不存在，DSH 前端每个 RPC 都会抛错（表现为 "WebSocket is closed..." + 无限重连）。`web-auth` 通过 `webServer.tapIndex` 向 SPA 注入基于 `crypto.getRandomValues` 的 polyfill，在客户端 bundle 运行前生效。

**登录页品牌字标**：`src/login-page.ts` 内联了从 `packages/client/ui-primitives/src/BrandWordmark.tsx` **原样提取**的 SVG（deepseek 字母 + HARNESS 徽章板，鲸鱼已删）。徽章字母的 `fill="var(--dsw-alias-label-primary-inverted)"` 依赖页面 `:root` 中定义的该变量（`#ffffff`）——删除会变黑看不见。

**凭据文件可覆盖**：`credential-store.ts` 读 `process.env.DSH_WEB_AUTH_FILE`（默认 `~/.dsh/web-auth.json`）。测试用它指向临时文件，**不碰真实凭据**。

**设置面板标签页（前端插件机制）**：DSH 的 SPA 本身就是一组「前端插件」——后端 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描所有已安装包的 `dsh.client` 声明，组合成 `window.__DSH_BOOT__`，浏览器 loader 按图加载每个包的 `lib/client.js` 并执行其 `apply`。设置面板是 slot 贡献点机制：`ui-settings` 声明 `settings.section` 契约（`packages/client/ui-settings/src/client/contract/slots.ts`），前端插件用 `ctx.slots.inject('settings.section', …)` 注册标签页（参考 `ui-settings-models/src/client/index.ts:118`）。本插件的 `src/client/index.tsx` 即按此注册「认证」标签页。要点：
- `package.json` 需声明 `dsh.client: { platform: "web", inject: [依赖包名] }` 与 `exports["./client"]`；`dsh.client` 与 `dsh.bundle`（patch 层）互不排斥。
- **必须插「包根行」**：`ClientModuleRegistry` 按 loader entry 的 `name`（patch 里 insert 的 `name` 字段）当包名去解析 `package.json` 读 `dsh.client`，所以 `cordis.patch.yml` 里除了 `remote-web-startup`/`web-auth` 两个子路径行，还插了一条 **`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`**（纯包名）。删掉它标签页就不会出现。`src/index.ts` 的空 `apply()` 就是为这个包根行存在的（模仿 `ui-settings` 的 node half）。
- `lib/client.js` 由 `tsdown`（`tsdown.config.ts`，模仿 harness 的 `clientBundle` preset）打包，格式为 `window.__ModuleLoader__.load({ id, factory })`；`react`/`@deepseek-ai/cordis`/`ui-slots` 保持 external（loader 模块表提供），其余依赖内联。
- 组件 props 必须匹配 `PropsRuntime<'settings.section'>`（owner share 是 `{ close }`），不能用裸 `SettingsSectionOwnerProps`。
- 前端插件：根插件只 `inject: ['connection']`（防御性覆盖 `isLoopback`，权威时机在 node 侧 tapIndex 注入，见「浏览器端 scope gate」），标签页注册与 mirror 兜底在子插件 `inject: ['slots', 'settingsScope']` 里（等两服务就绪）；标签页调 `/api/auth/*` 走普通 `fetch`，不走 connection RPC。
- 改了 `cordis.patch.yml` 或前端插件后**必须重启 `dsh web`**（patch 按包名缓存、不热加载）。

### 核心代码路径

| 文件 | 职责 |
|---|---|
| `src/startup.ts` | `remote-web-startup` 插件：commander 解析 `--host/--port/--trusted-host`，`provide('webStartup', values)`；`auth-reset` 子命令（`runAuthReset`）；`WEB_STARTUP_SERVICE` 常量 |
| `src/auth.ts` | `web-auth` 插件：登录页路由、`/api/auth/*` 端点（status/register/login/logout/change-password）、包装 `webServer.register` 做路由保护、`tapIndex` 注入 randomUUID polyfill + 登录重定向、Host/Origin 回环改写、`provide('webAuth')` |
| `src/credential-store.ts` | 凭据持久化：scrypt 散列、`registerCredentials` / `validateCredentials` / `resetPassword` / `changePassword` / `getUsername` / `signSession` / `verifySession` / `hasCredentials`；`DSH_WEB_AUTH_FILE` 覆盖 |
| `src/login-page.ts` | 自包含登录/注册页 HTML（黑白蓝风格 + brand wordmark SVG） |
| `src/client/index.tsx` | **前端插件**：向设置面板 `settings.section` 注册「认证」标签页（退出登录 + 修改密码 UI），打包为 `lib/client.js` |
| `tsdown.config.ts` | 前端插件打包配置（`window.__ModuleLoader__.load` 格式、external 列表） |
| `src/index.ts` | 仅类型导出（`WebStartupValues`、`AuthConfig`、`WebAuthService`） |
| `cordis.patch.yml` | bundle patch：禁用 `web-startup`、insert 三个插件（含包根行 `dsh-web-startup-auth`，客户端扫描必需）、`connection` 注入 `webAuth` |

### 如何修改

1. **改 `src/*.ts`（或 `src/client/*.tsx`），然后 `npm run build`**（`lib/` 是唯一被加载的产物：`tsc` 出 node 侧、`tsdown` 出前端 bundle；不构建等于没改）。
2. 想对照原版行为时看 harness 的 `packages/bundle/web-app/src/startup.ts`（原版 startup 逻辑）。
3. 涉及认证/信任语义时，对照 `packages/client/connection/src/api-request-trust.ts`（浏览器信任围栏，**明确不是认证层**）和 `packages/client/connection/src/index.ts`（`PRIVILEGED_METHODS` 回环限制）——本插件的「回环放行」是为了绕过后者。
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

- `tests/auth.spec.ts`：用 fake Context（mock `webServer`/`effect`）验证 `webAuth.authenticate`——回环放行、0.0.0.0 无 cookie 拒绝、有效 cookie 通过、过期 cookie 拒绝；以及认证端点（register/login/change-password：限速、密钥轮换、重签会话、旧密码校验）。
- `tests/startup.spec.ts`：验证 `--host 0.0.0.0` 被接受、`webStartup` 服务值、`auth-reset` 子命令（改密、密钥轮换、退出码）。
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

### 本机环境备注

- **harness 源码**（dsh 本体）：`/home/pax/coding/research/deepseek-harness`。相关位置：
  - `packages/bundle/web-app/src/startup.ts` — 原版 web-startup（0.0.0.0 拒绝在 ~69 行）
  - `packages/bundle/web-app/src/index.ts` — web-app bundle（webserver 行、`webStartup` 服务消费方）
  - `packages/client/connection/src/index.ts` — `PRIVILEGED_METHODS` 回环限制（~78 行注释）
  - `packages/client/connection/src/api-request-trust.ts` — 浏览器信任围栏（DNS rebinding / 跨站防护）
  - `packages/client/ui-primitives/src/BrandWordmark.tsx` — 登录页品牌字标 SVG 的出处
  - `packages/client/modules/src/index.ts` — `ClientModuleRegistry`（前端插件 boot 图组合、`/plugins/<id>/client.js` 分发、`dsh.client` 扫描）
  - `packages/client/ui-settings/src/client/contract/slots.ts` — `settings.section` 等设置面板 slot 契约
  - `packages/client/ui-settings-models/src/client/index.ts:118` — 前端插件向 `settings.section` 注册标签页的范本
  - `packages/client/tsdown.client.ts` — 前端插件 bundle 的 `clientBundle` preset（`tsdown.config.ts` 的模仿对象）
  - `packages/bundle/web-app/cordis.patch.yml` — 前端插件「包根行」的官方写法（如 `id: ui-settings / name: '@deepseek-ai/dsh-client-ui-settings'`）
- `@deepseek-ai/dsh-host-webserver`（`WebServer`/`WebRoute` 类型）是独立 npm 包，源码不在仓库内，看 `node_modules/@deepseek-ai/dsh-host-webserver/` 的类型声明。
- profile 现状：`~/.dsh/profiles/web/` 以 `link:/home/pax/coding/dsh-web-startup-auth` 安装；`dsh.profile.bundles` 含 `dsh-web-startup-auth`。改动后重启 `dsh web` 生效。

---

## 约定（本项目内）

- 文件：`src/*.ts` 与 `src/client/*.tsx`（源码，唯一修改入口）、`lib/`（构建产物，不入库但发布时由 `files` 字段带上）、`tsdown.config.ts`（前端 bundle 打包）、`cordis.patch.yml`（bundle patch）、`tests/*.spec.ts`（vitest）、`README.md`（用户文档）。
- **改源码后必须 `npm run build`**（tsc + tsdown），否则 profile 里跑的还是旧产物；发布前必须保证 `npm pack` 全链路（prepack）通过。
- 不要为了「省事」改掉 `cordis.patch.yml` 里的 `connection.inject: [webAuth]`——它保证 auth 在 API 路由注册前生效，是安全边界的一部分。
- 同样不要删 `cordis.patch.yml` 里的**包根行**（`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`）——它是前端插件进 `__DSH_BOOT__` 的前提，删掉后设置面板「认证」标签页消失。
- 改动认证/信任逻辑时，先读 harness 里对应机制（`PRIVILEGED_METHODS`、`api-request-trust.ts`）再动手，避免破坏「认证即回环信任」的等价性。
- 登录页品牌元素必须**照搬原版 SVG**（可从 `BrandWordmark.tsx` 提取），不要用 CSS 手绘模拟。
