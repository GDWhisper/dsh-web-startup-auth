# 认证核心机制（node 半）

> 覆盖：会话认证、凭据与用户名净化、本机登录校验开关、信任判定、路由保护顺序与覆盖范围、tapIndex 注入、凭据文件。原生 cookie 补签桥接见 `native-auth-bridge.md`，设置面板前端行为见 `settings-section.md`。

## 会话认证

密码用 scrypt（随机盐，64 字节）散列存 `~/.dsh/web-auth.json`（含 `username` / `passwordHash` / `secret`）；会话 cookie `dsh_sid` = `base64url(JSON{u,e}).HMAC-SHA256(secret)`，14 天有效、`HttpOnly` + `SameSite=Lax`。`secret` 随机 32 字节，`auth-reset` 时轮换。

**有效期可调**：档位常量在 `src/session-limits.ts`（3/7/14/30/60/90/180 天，默认 14，无 node 依赖——client bundle 由 tsdown 内联它），持久化为 `web-auth.json` 的 `sessionMaxAgeDays` 字段（`getSessionMaxAgeDays`/`setSessionMaxAgeDays`，模仿 `requireLoopbackLogin` 的单次写模式，不轮换 secret）；`auth.ts` 的 `getSessionMaxAgeSec()` 在 `sessionCookieSet`/`buildSessionCookie` 时运行时读值，因此**调整只对新签发的会话生效**（exp 在签发时写死进 payload）。端点 `/api/auth/session-max-age`（GET/POST，模仿 `/api/auth/policy`：需认证、未注册 400、非法档位 400）。

## 用户名净化（issue #14）

`credential-store.ts` 的 `normalizeUsername` 剥除 C0 控制字符（0x00–0x1F）与 DEL（0x7F）再 trim（`trim()` 只剥空白，控制字符会原样入盘），register/login/change-username 入口统一走它，剥空则 400。

**`verifySession` 只验 HMAC+时效、不比对 payload 的 `u` 与存储 username**——因此改用户名（同改密码）必须轮换 `secret` 才能作废旧会话；`updateCredentials({ username?, password? })` 是统一的单次写+单次轮换入口，`resetPassword`/`changeUsername` 都是其薄封装。

## 本机登录校验开关（`requireLoopbackLogin`，issue #27）

默认 `false`（真回环请求隐式信任、本机免登录）。开关打开后 `isTrustedOrigin` 直接返回 `false`（`src/auth.ts:343`），本机也必须出示 `dsh_sid`——于是本机未登录的首页导航会走既有的 302 `/login` 路径。持久化位置是 `web-auth.json` 的 `requireLoopbackLogin` 字段（`getRequireLoopbackLogin`/`setRequireLoopbackLogin`，单次写、**不轮换 secret**），端点 `/api/auth/policy`（GET/POST，需认证）。

- **必须先有账号才能开**：`setRequireLoopbackLogin(true)` 在没有任何凭据时抛错（否则本机无人能登录、只剩 `auth-reset` 一条恢复路径），服务端回 400「请先注册管理员账号，再开启强制登录」。**因为 flag 寄存在凭据文件里，没有凭据就无处可写**——想支持"未注册也能开开关"就得给它独立存储，属于新的持久化状态，没做。
- **本机注册入口**（这段是 #27 的成因）：本机免登录时 `status.authenticated` 恒为 true，首页注入脚本不会跳 `/login`，浏览器里没有注册入口。补的两条：**①** 设置面板「认证」标签页在 `registered === false` 时显示红色引导卡片 + 「前往设置管理员账号」按钮跳 `/login`；未注册时点「本机登录校验」开关也先跳注册页（不再打 policy 吃 400）。**②** `src/login-page.ts` 的 status 检查必须是 `data.authenticated && data.registered` 才 `replace('/')`——只判 `authenticated` 会把隐式信任的本机访客弹回首页，**把浏览器里唯一的注册入口整段关掉**。
- **CLI 不能首次建号**：`runAuthReset` 在未注册时抛「尚未注册管理员账号，无需重置」（`src/startup.ts:145`）。首次只能走 `/api/auth/register`（页面上就是 `/login` 的注册表单）。
- **翻转开关的前端联动**（重读 status、四态账号卡）见 `settings-section.md`。

## 登录人机验证与限流

`slideVerification` 布尔开关，默认关闭。开启后 `/api/auth/login` 在比对密码**之前**要求先解出滑块拼图，失败计入限流预算。端点：`GET /api/auth/challenge`（**匿名**签发拼图，`/api/auth/` 前缀天然豁免）、`GET|POST /api/auth/challenge-policy`（需认证，字段 `slideVerification`）。持久化在 `web-auth.json`（`getSlideVerification`/`setSlideVerification`）。**它是装饰品**：答案就画在图上，实测 30 行脚本 100% 读出——别当安全边界。与「本机登录校验」同样的约束：**未注册时拒绝开启**（设置寄存在凭据文件里，为存设置创建该文件会让 `hasCredentials()` 判真、注册表单永久关闭）。

**限流是两层，形状不同**：每 IP（10 分钟 5 次失败 → 锁 30 秒，原有）挡单源；**全局指数退避**（所有客户端累计失败超 20 次后按台阶翻倍，封顶 5 分钟，1 小时窗口清零）挡分布式——一千个地址各试几次，没有一个会触发每 IP 限制。全局惩罚对**真回环调用者豁免**（`isTrustedOrigin`，本机登录校验关着时），否则攻击者能用它把管理员锁在自己机器外面；开了本机登录校验则不再豁免。成功登录**不**重置全局计数。429 带 `Retry-After`。

**验证必须在密码之前**：若先比密码，攻击者可用伪造的 `challengeId` 无限探测密码（密码错时根本不碰挑战）。代价是任何被拒的登录都已消耗挑战，所以登录页必须**每次失败都重取**。

完整机制、实测攻击数据、分层、局限与观察哨见 **`human-verification.md`**（改 `src/slider/`、限流或登录页拼图控件前必读）。

## `authenticated` 不等于「已登录」（退出登录在本机是空操作）

`isAuthorized()` = `isTrustedOrigin() || 有效会话`，本机免登录时第一项恒真，所以**点退出登录后 `authenticated` 依然是 true**——清掉的 `dsh_sid` 本来就没被用到，`GET /` 还会被静默补签回原生 cookie（浏览器页面导航走 200 跳板，见 `native-auth-bridge.md`），用户全程无感，回到认证页仍是「已登录」。前端把 `authenticated` 当「已登录」就会给出一个点了没任何效果的退出按钮。因此 status 端点（`src/auth.ts:545`）额外返回 **`session`（持有有效 `dsh_sid`）** 与 **`trusted`（靠本机隐式信任放行）**；`authenticated` 保持原义（tapIndex 跳转脚本、登录页、既有脚本都依赖它）。前端按 `session === true` 得 `signedIn`：`signedIn` 才显示「当前登录：xxx」+「退出登录」，否则显示「管理员账号：xxx」+ 一行说明「本机地址免登录……」且不渲染退出按钮。**username 取值同步改**：优先会话里的用户名，无会话才回落到 `getUsername()`（存储账号名，不是本调用者证明过的身份）。

## 信任判定：按请求，不按绑定地址（重要）

免认证（隐式信任）要求**两个条件同时成立**：TCP 对端地址（`req.socket.remoteAddress`，含 `::ffff:127.0.0.1` / `::1`）是回环 **且** `Host` 头 authority 是回环（`isTrustedOrigin`）。否则必须带有效会话 cookie。

- **为什么不能只看绑定地址**：`--host 127.0.0.1` + nginx 反代时，绑定地址是回环但访问者是远程的——只按绑定地址判定会让反代后的所有人免认证（issue #6 的第二种场景）。
- **为什么两个条件都要**：只看 `Host` 头 → LAN 攻击者伪造 `Host: 127.0.0.1` 即可绕过认证；只看对端地址 → 同机反代（从 127.0.0.1 连入）会被误判为本机用户。两者都满足的访问者本来就能连回环，免认证安全。
- **`X-Forwarded-For` 不采信**（客户端可伪造）。反代要让其客户端按远程处理，只需转发真实 `Host`（nginx 默认即 `proxy_set_header Host $host;`）；若把 `Host` 写死成回环，本插件就认为请求来自本机并放行——README 的安全说明里明确写了这条配置禁忌。
- **前端跳转必须与判定一致**：`tapIndex` 注入的首页脚本只在 `!authenticated` 时跳 `/login`。曾经额外要求 `registered`（`!registered || !authenticated`），导致回环模式下未注册时 `authenticated=true` 而首页仍跳 login、login 页又跳回首页的死循环（issue #6）。`authenticated` 语义已含回环信任，前端不要再叠加 `registered` 条件。
- **0.1.2 的回环体验闭环**：上游对回环也强制原生 cookie，但本机浏览器免登录体验不受影响——回环请求过 `isTrustedOrigin` 后由「原生 cookie 补签」的单跳补发 cookie（页面导航现在是 **200 跳板**，见 `native-auth-bridge.md`），用户无感。注意**补签只发生在 GET/HEAD**：回环下裸 `curl` GET `/`（不带 `Accept: text/html`，即非页面导航）不带 cookie 得到 **303 + Set-Cookie**（我方补签），而 POST 类 RPC 不跳转（303 会把 POST 变 GET）、直接撞上游原生闸门返回 **401**；远程（无 `dsh_sid`）则是页面导航 302 `/login`、RPC 401。CLI/脚本请走 `/api/auth/login` 换取 `dsh_sid` 会话——**启动打印的 token URL 会被我方登录墙拦下（远程拿到 302 `/login`），不是远程旁路**，也无需使用（见 README「全程无需接触启动打印的 token URL」）。

## 路由保护顺序（重要）

`web-auth` 在 `apply` 里同步包装 `webServer.register` 与 `webServer.registerUpgrade`，所以 `cordis.patch.yml` 必须给 `connection` 行追加 `inject: [webAuth]`，保证 auth 插件在 connection 注册 API 路由**之前**激活。改动 patch 时保持这个注入，否则 API 不设防。

## 覆盖范围（所有路由 + index fallback，含事后追溯）

包装**不只限 `/api` 前缀**——所有经 `webServer.register`/`registerUpgrade` 注册的路由（含第三方插件的非 `/api` channel，如 `/dsh-automation`、技能管理器）都做「认证 + 原生 cookie 补签（0.1.2）」；只有 `/login` 与 `/api/auth/*` 保持匿名。

**0.1.2 的 index.html 走 `webServer.registerFallback`（frontend-static），不在 exact/prefix 路由表里，必须单独包装**（fallback 是 webserver 的私有单座属性 + `registerFallback` 方法，包装方式 = 事后追溯替换私有 `fallback` 字段 + 包装 `registerFallback` 方法两路都做）——漏了它，远程/回环访问 `/` 都直接撞上游 `authorizeIndex` 的 401 纯文本（实测发现）。**fallback 包装只保护 index 入口路径（`/` 与 `/index.html`）**：其余 fallback 路径都是 dist 里的公开构建产物（favicon.svg、打包 JS/CSS），未认证 GET/HEAD 直接转发（登录页引用的 `/favicon.svg` 否则会 401 破图）；解析不了的请求目标保守走完整防护。

**关键坑**：cordis 的激活顺序**不是 bundle/树顺序**（动态 import 完成顺序不定，实测无论 bundle 怎么排，第三方插件都可能先于 web-auth 激活），所以包装必须在 apply 时**遍历 webserver 路由表（`exact`/`prefixes`/`upgrades` Map）把已注册的路由事后包装**（WeakSet 防重复），再包装未来的注册。只包装 `register` 而不做事后追溯时：先激活插件的路由（技能管理器 `/api/dsh-skills-manager`）、非 `/api` channel（`/dsh-automation/snapshot`）以及 WebSocket 升级（`/api/events.*`）都会绕过认证对远程用户开放。

## tapIndex 注入的 randomUUID polyfill

通过局域网 IP + 明文 HTTP 访问时页面处于非安全上下文，`crypto.randomUUID` 不存在，DSH 前端每个 RPC 都会抛错（表现为 "WebSocket is closed..." + 无限重连）。`web-auth` 通过 `webServer.tapIndex` 向 SPA 注入基于 `crypto.getRandomValues` 的 polyfill，在客户端 bundle 运行前生效。

## 凭据文件可覆盖

`credential-store.ts` 读 `process.env.DSH_WEB_AUTH_FILE`（默认 `~/.dsh/web-auth.json`）。测试用它指向临时文件，**不碰真实凭据**。

## 登录页品牌字标

`src/login-page.ts` 内联了从 `packages/client/ui-primitives/src/BrandWordmark.tsx` **原样提取**的 SVG（deepseek 字母 + HARNESS 徽章板，鲸鱼已删）。徽章字母的 `fill="var(--dsw-alias-label-primary-inverted)"` 与徽章板 `fill="var(--dsh-wordmark-plate)"` 都依赖页面 `:root` 变量——明色下板深字白、暗色下板浅字深；删除任一变量会看不见字。登录页是**独立文档**，不继承 shell 的 `--dsw-*` token，主题走 `@media (prefers-color-scheme: dark)`（系统偏好，不跟随应用内主题）。品牌元素必须**照搬原版 SVG**，不要用 CSS 手绘模拟。

## 测试要点（`tests/`）

- `tests/auth.spec.ts`：用 fake Context（mock `webServer`/`effect`）验证 `webAuth.authenticate`——真正回环请求放行、远程无 cookie 拒绝、有效 cookie 通过、过期 cookie 拒绝、同机反代（回环 IP + 公网 Host）需会话、伪造回环 Host 的远程请求不放行；`/api/auth/status` 的五种判定（本地未注册 / 反代未登录 / LAN 未登录 / 已登录带用户名 / **本机已注册但无会话：`authenticated:true` 而 `session:false`**，即退出登录后的本机状态）；认证端点（register/login/change-password/change-username：用户名净化、限速、密钥轮换、重签会话、旧/当前密码校验、同名 no-op 不轮换）；以及**原生 cookie 桥接**（0.1.2）：已认证页面导航缺原生 cookie → 200 跳板 + Set-Cookie + meta refresh 回原路径（非导航 GET 仍 303）、cookie 名随 authority（sha256）、值可 HMAC 校验对齐上游格式、回环免登录也补签、已带 cookie 直接转发、secret 缺席（fake provider 返回空）不 mint、非导航（POST RPC）不 303、未认证页面导航 → 302 /login、未认证 XHR → 401、登出清两 cookie、登录响应双 cookie。fake 的 `credentials` 服务通过 `fakeWebAuthContext(..., credentials)` 注入，secret 缓存按服务实例隔离（WeakMap）。
- fake 请求**必须同时给 `socket.remoteAddress` 和 `headers.host`**——信任判定两个都读，缺一个就按远程处理（`requestWithCookie` / `httpRequest` / `jsonRequest` 默认给回环值）。
- `tests/startup.spec.ts`：验证 `--host 0.0.0.0` 被接受、`webStartup` 服务值、`auth-reset` 子命令（改密/改用户名、密钥轮换、退出码）。
- `tests/challenge-store.spec.ts` / `tests/slider.spec.ts`：拼图验证（含几何自洽、二维容差边界、五种剪影轮换、纹理同源、缺口无描边、盲猜命中率）与全局退避台阶/回环豁免；清单见 `human-verification.md`。
- 每个测试 `beforeEach` 用 `mkdtempSync` + `DSH_WEB_AUTH_FILE` 隔离凭据文件，`afterEach` 清理。
- **注意**：`npm pack` / `npm publish` 会触发 `prepack`（typecheck + test + build 全跑），测试不过无法发布。
