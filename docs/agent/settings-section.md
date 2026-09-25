# 设置面板「认证」标签页（前端插件 + UI 行为）

> 覆盖：前端插件机制在本项目的落地、slot 注册、导航图标 DOM 替换、暗黑模式 token、三个状态读的预取与未知态闸门、账号卡四态。通用前端插件知识见 `dsh-plugin-basics.md`。

## 机制总览

DSH 的 SPA 本身就是一组「前端插件」——后端 `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描所有已安装包的 `dsh.client` 声明，组合成 `window.__DSH_BOOT__`，浏览器 loader 按图加载每个包的 `lib/client.js` 并执行其 `apply`。设置面板是 slot 贡献点机制：`ui-settings` 声明 `settings.section` 契约（`packages/client/ui-settings/src/client/contract/slots.ts`），前端插件用 `ctx.slots.inject('settings.section', …)` 注册标签页（参考 `ui-settings-models/src/client/index.ts:118`）。本插件的 `src/client/index.tsx` 即按此注册「认证」标签页。

要点：

- `package.json` 需声明 `dsh.client: { platform: "web", inject: [依赖包名] }` 与 `exports["./client"]`；`dsh.client` 与 `dsh.bundle`（patch 层）互不排斥。
- **必须插「包根行」**：`ClientModuleRegistry` 按 loader entry 的 `name`（patch 里 insert 的 `name` 字段）当包名去解析 `package.json` 读 `dsh.client`，所以 `cordis.patch.yml` 里除了 `remote-web-startup`/`web-auth` 两个子路径行，还插了一条 **`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`**（纯包名）。删掉它标签页就不会出现。`src/index.ts` 的空 `apply()` 就是为这个包根行存在的（模仿 `ui-settings` 的 node half）。
- `lib/client.js` 由 `tsdown`（`tsdown.config.ts`，模仿 harness 的 `clientBundle` preset）打包，格式为 `window.__ModuleLoader__.load({ id, factory })`；`react`/`@deepseek-ai/cordis`/`ui-slots` 保持 external（loader 模块表提供），其余依赖内联。
- 组件 props 必须匹配 `PropsRuntime<'settings.section'>`（owner share 是 `{ close }`），不能用裸 `SettingsSectionOwnerProps`。
- 前端插件：单层插件 `inject: ['slots']`（等 slots 服务就绪）直接注册「认证」标签页；标签页调 `/api/auth/*` 走普通 `fetch`，不走 connection RPC。**镜像/持久化侧无需本插件处理**（远程 mirror host 化由 tapIndex 的 `__DSH_TRANSPORT__.ownsHost` hook 承担，见 `native-auth-bridge.md`「浏览器端 scope gate」）。
- **0.1.2 客户端类型变化**：`@deepseek-ai/dsh-client-runtime` 包（旧 `ClientContext` 来源）已被上游删除，客户端插件直接 `import type { Context } from '@deepseek-ai/cordis'`（cordis 代理在运行时按服务名取属性）；`slots`/`settingsScope` 等 Context 成员的类型合并由消费方的 assembly 包提供，本插件用**窄结构断言**读取（见 `src/client/index.tsx` 注释）而不声明 merge，避免依赖未安装的类型包。
- 改了 `cordis.patch.yml` 或前端插件后**必须重启 `dsh web`**（patch 按包名缓存、不热加载）。

## 翻转开关后必须重读 status（浏览器实测 2026-09-15）

`useAccountStatus` 用 nonce 触发重拉（`refresh()`），因为 policy 一变 `trusted` 就变，而组件只在挂载时读过一次——不刷新的话，打开开关后卡片仍写着「本机地址免登录」（开关已 on），是个事实错误。

**开启成功且当前无会话时直接跳 `/login`**：那一刻本浏览器的隐式信任已经撤掉，SPA 里所有受保护 RPC 都在 401，只刷新卡片等于留个半死的界面。账号卡因此是**四态**：`signedIn`（退出按钮）/ 免登录（`trusted === true`，说明文案、无按钮）/ 未登录且不受信（`前往登录` 按钮）/ **未知**（见下条）。

## 标签页的四个读都必须预取，且读不到时不得拿默认值充数（浏览器实测 2026-09-16）

认证页读四处后端状态——`/api/auth/status`（账号卡）、`/api/auth/policy`（登录要求开关）、`/api/auth/session-max-age`（有效期档位）、`/api/auth/challenge-policy`（拼图验证开关）。它们原本都在**面板挂载时**才发请求，于是出生在 SPA 启动请求波的正中间，要和其余请求抢同源 6 条连接。实测（资源计时）：请求自身只要 4-8ms（stalled 1ms + TTFB 2-5ms）、干净实例最慢的启动请求 74ms，但用户实机（会话/插件/工作区数据量大得多）会看到认证页停在「正在读取登录状态…」**十几秒**——等待不来自请求本身，而来自它排队的时机。

修复分两半：

**① 预取**：`startPrefetch` 通用工具在模块顶层（bundle 初始化执行模块体时）就发起读并缓存（`inflight` + settle 后的 `settled`），交给首个挂载的标签页**一次性消费**（`useState` 惰性初值）。实测三个请求都在 ~433ms 发出、面板打开**不新增请求**、首帧即正确（开关直接是 ON、账号卡直接是「当前登录：admin」）；重挂载与 `refresh()` 一律新发请求（实测关面板再开、翻转开关各新增 1 条），陈旧结果不会被当成当前状态。**新增读（如拼图验证开关）必须照这个模式加**：`readSlideVerification` + `takeSlideVerificationPrefetch` + 一个 `undefined` 表未知的 hook，不要退回挂载时请求。

**② 未知态不用默认值充数**：policy/session-max-age/challenge-policy 的 state 类型是 `boolean | undefined` / `number | undefined`，**`undefined` = 没读到**：开关此时 `disabled` + 半透明 + 文案「正在读取登录要求…」/「正在读取设置…」，档位显示「正在读取…」。**绝不能拿 `useState` 的默认值（`false` / 14 天）当渲染值**——那会让「实际已打开」的开关显示成关闭（用户实测反馈；本地复现：开关先 OFF 117ms 再 ON，实机则是十几秒），status 侧同理只走 `statusUnknown` / `failed` 两态。

**观察哨**：预取依赖「client bundle 被加载时即执行模块体」（tsdown 的 `__ModuleLoader__.load` 语义）——上游若改成惰性/按需执行 client bundle，预取会退化成挂载时请求（功能不受影响，只是等待回来）。

## 读不到状态时不得下结论（浏览器实测 2026-09-16）

`session`/`trusted` 在首次 status 应答之前是 `undefined`，而 `signedOut = !signedIn && trusted !== true` 在 `undefined` 时成立——于是刚登录完打开认证页会先渲染「当前未登录，或登录已失效。」+「前往登录」，`username` 还会回落成字面量「管理员」。实测热态只闪现 ~25ms（status 请求 4ms、无缓存问题），但**把 status 请求拦掉后这段错误文案会一直停留**，与"这个浏览器持有有效会话"的事实相反——用户报告的「登录成功后显示未登录、等一会儿才变回我设置的用户」正是这个窗口（"变回"的时刻 = 请求最终成功，或面板被重建）。

修复（`src/client/index.tsx`）：新增 `statusUnknown`（`failed || session === undefined || trusted === undefined`）——未知态**不渲染身份行、不渲染任何按钮**，只显示「正在读取登录状态…」；新增 `failed`（非 2xx 或网络错）显示「无法读取登录状态，请重新打开此设置页。」，同样不下"未登录"的结论；`setUsername` 改为每次应答**显式赋值**（有值设值、无值清空），避免旧身份残留到新状态。

**观察哨**：以后任何按 status 推断身份/登录态的新 UI 都必须先过 `statusUnknown` 这道闸。

## 导航图标靠 DOM 替换

标签页左侧那枚图标（盾牌+勾）**不是注册方能指定的**——`settings.section` 的 spec 只有 `{ id, order, label }`（`ui-slots` 的 `BaseOptions`/`KindOptions` 没有 `icon`，且写入 ledger 时按白名单拷贝，多余字段直接丢），图标由 shell 的 `ui-settings-general/src/client/SettingsRoot.tsx` 里 `navIcon(id)` 一条**硬编码 if-chain** 决定（只认 `models`/`agent-presets`/`plugins`，其余一律回落 `IconSettingsOutline16` 齿轮），安装产物 0.1.2-rc.1 已核对一致。

所以 `apply()` 里调 `installAuthNavIcon()`：`MutationObserver` + `requestAnimationFrame` 合并扫描，按 `nav button span` 的**文案等于 `SECTION_LABEL`** 定位本行（按钮不带 id 属性——React 的 `key` 不落 DOM），把行内 `<svg>` 换成内联盾牌+勾，并从原 svg 复制 `width`/`height`/`class`（保住 `.navIcon{flex:none}` 与 `currentColor` 配色），同时在按钮上打 `data-dsh-auth-nav-icon` 标记防重复。面板关闭即整行卸载，所以观察者要负责每次重新挂载；**匹配不上时退化为齿轮**，属纯装饰失败、不影响功能。

**观察哨**：上游若给 `settings.section` 加原生 `icon` 字段、改 `navIcon` 的 id 判定、或改了行结构（span/按钮嵌套、文案来源），这段就要跟着换或删掉。文案常量 `SECTION_LABEL` 与注册 `label` 共用，别分叉。

## 暗黑模式（issue #25）

标签页样式**不硬编码颜色**，全部走 shell 主题 token——`--dsw-alias-*` / `--dsw-specific-*`（定义于 ui-theme 的 `styles/design-platform.css`，随 `body[data-ds-dark-theme]` 明暗翻转；字面量仅作无主题组合时的浅色回退）。用到的 token：`bg-layer-1`（卡片）/ `bg-overlay`（开关关闭态）/ `border-l2`/`border-l3`/`label-primary`/`label-secondary`/`label-tertiary`/`button-info-fill`（品牌蓝，明 deepseek-500 暗 400）/`state-error-primary`/`state-success-primary`/`specific-input-major`（输入框）/`specific-menu`（退出确认浮层）。

**观察哨**：上游若改名/删除这些 token 或把 token 挪进 shadow DOM（继承断掉则回退生效、暗色失效），需跟着调；验证方式可参照 ui-theme 的 token 表在静态 harness 里渲染 `AuthSection` 对比明暗两态。

**登录页不在 shell 内**：用 `prefers-color-scheme` 独立明暗变量（见 `auth-mechanics.md`「登录页品牌字标」），与本条 shell token 体系并行，勿混用。
