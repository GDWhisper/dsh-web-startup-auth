# dsh 插件开发通用知识

> 本文件内容对任何 dsh 插件开发通用，可复用到其他 dsh 插件项目。母体参考：harness 源码位于作者本机 `~/coding/research/deepseek-harness`（路径约定见 `AGENTS.md` 头部；在你的机器上请替换为实际路径）。

**类型依赖注意**：`@deepseek-ai/dsh-host-webserver`（`WebServer`/`WebRoute` 类型）是独立 npm 包，源码不在 harness 仓库内，看 `node_modules/@deepseek-ai/dsh-host-webserver/` 的类型声明。

## dsh 是什么

dsh 是 DeepSeek Harness（作者本机源码根 `~/coding/research/deepseek-harness`，见 `AGENTS.md`「路径约定」）的 CLI 入口，一个**基于 cordis 的插件式 agent 框架——「一切皆插件」**。用户用 `dsh web` 启动 web 应用；应用由一组插件 bundle 按层叠加组合而成。

- **cordis**（`@deepseek-ai/cordis`）是框架内核：插件在 `Context` 上注册服务、监听事件、注入依赖。关键 API：`ctx.provide(key, value)`、`ctx.get(key)`、`ctx.effect(fn, label?)`（挂副作用）、`ctx.logger`。
- **profile** 是一个可启动的插件组合，位于 `$DSH_HOME/profiles/<name>/`（默认 `~/.dsh/profiles/`）。常见 profile：`web`、`headless`、`tui`。
- **bundle** = 一个 npm 包 + 一张 patch 配置层（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。安装进 profile 后 patch **自动应用**，无需手动编辑 profile 配置。

## 插件包的基本形态

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

## 前端插件（browser half）——给 DSH 界面注入 UI

DSH 的浏览器界面（SPA）**本身就是一组前端插件**：后端 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描所有 loader entry 的 `package.json` 的 `dsh.client` 声明，组合成 `window.__DSH_BOOT__` 注入 `index.html`，浏览器端 loader 按图加载每个包的 `lib/client.js` 并执行其 `apply`。**想给 DSH 界面加东西（设置面板标签页、菜单、按钮等），走的不是 `webServer.register`，而是这个前端插件机制**——一个 npm 包可以同时有 node half（`exports["."]`）和 browser half（`exports["./client"]`）。

要点与**踩过的坑**：

- 声明：`package.json` 加 `dsh.client: { platform: "web", inject: [依赖的前端插件包名] }` 和 `exports["./client"]`（`dsh.client` 与 `dsh.bundle` 的 patch 层互不排斥，可并存）。
- 打包：`lib/client.js` 由 `tsdown` 打包，格式为 `window.__ModuleLoader__.load({ id: 包名, factory: (require) => {…} })`；`react` / `react/jsx-runtime` / `@deepseek-ai/cordis` / `dsh-client-ui-slots` 保持 external（loader 模块表提供），其余依赖内联。
- **关键坑（客户端包必须插"包根行"）**：`ClientModuleRegistry` 用 loader entry 的 `name` 字段当**包名**去 resolve `package.json` 读 `dsh.client`。因此 `cordis.patch.yml` 里必须**插入一条 `name` 为纯包名（包根，如 `name: dsh-web-startup-auth`）的 entry**——只插子路径（`name: xxx/startup`）时该包永远不被识别为 client 包，`dsh.client` 声明形同虚设（本插件踩过，见「设置面板标签页」）。包根入口（`lib/index.js`）需导出 `apply()`（可为空，模仿 `@deepseek-ai/dsh-client-ui-settings` 的 node half），loader 才能激活该行。
- 设置面板是 **slot 贡献点机制**：`ui-settings` 声明 `settings.section` 契约（`packages/client/ui-settings/src/client/contract/slots.ts`），前端插件用 `ctx.slots.inject('settings.section', …)` 注册标签页（参考 `ui-settings-models/src/client/index.ts:118`）。

## bundle patch 机制

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

## profile 组成与插件安装/卸载

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

## 排查技巧

- `dsh --profile web --dump-config` 看组合后的插件树：确认 patch 生效、disabled 冲突、`# == <bundle>, patched by <bundle>` 标出的 patch 来源。
- 插件加载失败体现在 dsh 启动日志；`apply` 里抛错会中断启动。最常见的启动失败是 **`Cannot find module '.../lib/xxx.js'`——没构建**。
- 插件树里某行没有出现在 dump 输出，查 profile `package.json` 的 `dsh.profile.bundles` 是否有该包、patch 是否 `disabled`。
- **前端插件不生效时**：先 `curl -s <主机>:<端口>/ | grep -o '__DSH_BOOT__[^<]*'` 看 entry 里有没有你的包名；再**从该 entry 的 `url` 字段取真实地址**请求它（0.1.2 起是 `??<包名>/client.js&rev=…` 形态，0.1.7 起进一步改为**相对路径** `plugins/??<包名>/client.js&rev=…`；旧的平路径 `/plugins/<包名>/client.js` 早已 404），带会话时应 200。若包名不在 boot 图里，查 patch 是否有「包根行」（`name` 为纯包名）、包根入口是否导出了 `apply()`。
