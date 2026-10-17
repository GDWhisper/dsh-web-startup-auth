# 通配/IPv6 绑定支持（issue #35）

> 覆盖：`--host 0.0.0.0` / `--host ::` / 任意具体 IP 字面量的启动路径、webserver host schema 拓宽、`webStartup.trustedHosts` 富化、`--public-url`/TLS 门禁、升级观察哨。改 `src/ipv6-shim.ts`、`src/startup.ts` 的 `--host`/TLS 处理或 `cordis.patch.yml` 的 `connection` 行前必读。

## 两个时代与两堵墙

dsh 的 webserver host 值域在两个时代是**方向相反的两堵墙**（本插件双时代兼容的主要对象）：

| | 0.2.0 线（rc.2，已被 0.2.1 取代为基线） | 0.2.1 线（alpha.2 起，**当前基线 rc.2**） |
|---|---|---|
| `WebServer.Config.host` | `z.union([z.const('127.0.0.1'), z.const('0.0.0.0')])`：只收两个 IPv4 字面量，`::` 启动即 schema 校验失败 | `z.transform(z.string(), …具体 IP 字面量…).required()`：只收**一个具体** IPv4/IPv6 字面量，通配 `0.0.0.0`/`::` 被显式拒绝（plain `Error`：「binding every interface would expose remote code execution to the network」） |
| LAN 信任推导 | web-app `resolveLanTrust`：仅 `0.0.0.0` 绑定 → 枚举非 internal IPv4 接口地址，写入 `webRuntime.trustedHosts`，`connection` 行经 `!!js ctx.webRuntime.trustedHosts` 消费 | 整体删除（`webRuntime` 服务也删了）：`connection` 行改 `inject: [webStartup]` + `!!js ctx.webStartup.trustedHosts`，**LAN 推导移进 webStartup 提供方**——stock 不再推导，本插件接管 |
| 围栏（`isTrustedApiRequest`） | 回环 + `trustedHosts`，无绑定地址概念 | 新增 `isBindAddressAuthority`：监听方自己的绑定 IP（忽略端口）自动信任——**仅对具体绑定生效，通配仍无自动信任** |

本插件的目标不变（#35 起）：通配绑定与任意本机 IP 字面量都能启动，且远程客户端能过上游信任围栏、到得了登录页。两堵墙各需一套手术，且**两个时代都不拆**：

1. **schema 拓宽**：原地把 `Config.dict.host` 换成 `z.union([stock 成员, z.transform(z.string(), 任意 IPv4/IPv6 字面量断言)])`。
2. **围栏权威**：`startup` 把 `[...--trusted-host 值, ...lanHosts(host)]` 富化进 `webStartup.trustedHosts`，`connection` 行经官方表达式消费。通配绑定两时代都仍需要它；具体 IPv4 绑定在 0.2.0 线围栏是刚需、在 0.2.1 线被 `isBindAddressAuthority` 覆盖（重复条目无害，保持两时代同一份代码）。

`isTrustedOrigin`（本插件 auth 侧）与原生 cookie 补签对 IPv6 是现成的：Host 头 `[::1]` 在 `LOOPBACK_HOSTNAMES` 里、`requestAudience(headers, false)` 用 `new URL(...)` 规范化出方括号形式，与上游 `browser-auth.ts` 同一形状——auth/补签的 IPv6 路径零改动（0.2.1 的 secure 分支见 `native-auth-bridge.md`）。

## 三处改动

### 1. `src/ipv6-shim.ts`：schema 拓宽 + 绑定值域 + LAN 权威 + TLS 能力探测

**拓宽（`widenHostMember` / `ensureIpv6BindSupport`）**：

- `WebServer.Config` 是 schemastery 对象 schema，`dict` 是普通可写对象——把成员 `dict.host` 换成拓宽 union 即对**所有持有者**立即生效（fiber 启动时 `resolveConfig` 读的是 schema 对象引用本身，替换静态属性对新旧引用生效时机不一）。
- 第二成员域是 `isIPv4(v) || isIPv6(v)`：0.2.1 的通配经 **union fallthrough** 命中它——schemastery 的 union 对成员抛出的**一切**错误都只是收集（`catch (error) { messages.push(error) }`），0.2.1 成员抛的 plain `Error` 不例外。这条兜底语义用「抛 plain Error 的 stock 成员」fixture 钉死在 `tests/ipv6-shim.spec.ts`；将来 schemastery 副本若收窄这个 catch，通配启动会立刻红（E2E）。
- 新 union 成员必须**复制原成员的 `meta`**（尤其 `required`）：默认整的 union meta 为空，无 required 的 host 成员会让无 host 配置通过校验，object resolver 丢键后 `listen(port, undefined)` 绑全部接口。
- **拓宽哪一份实例（E2E 抓到的坑，最重要）**：插件以 `link:` 装进 profile，本仓库 `node_modules` 里有一份 `@deepseek-ai/dsh-host-webserver`，而 `webserver` 行从 **profile 根**解析出的是**另一份**（本机是 dsh CLI 自带的嵌套副本）。两份 = 两个 `WebServer` 类 = 两个 schema 对象；拓宽 import 来的那份，启动时校验用的仍是 stock schema（报错照旧），而单测看的是我们这份所以全绿。`ensureIpv6BindSupport(ctxBaseUrl(ctx))` 因此用 `createRequire(new URL('node_modules/.host-schema.cjs', baseUrl))` 从 **profile 根**解析并 `require`（Node ≥22.12 支持 require(esm)，与 row 的动态 import 同实例）那一份来拓宽；拿不到 baseUrl（单测）才回退到 import 的实例。**探测失败 → 返回 false → `startup` 对扩展值报人话错误**（fail-closed；`--host 127.0.0.1` 户零影响）。
- `widenHostMember` 校验 `dict` / `z.union` / `z.transform` / `z.ValidationError` 形态，任一项不满足返回 `false` 且**不动 schema**；成员上打 `Symbol` 标记保证同一 schema 只拓宽一次；进程内成功结果粘性（`ensureIpv6BindSupport` 模块级标志），失败不粘、后次可重试。

**`normalizeBindHost`（`--host` 值域）**：`127.0.0.1`、`0.0.0.0` 透传，任意**具体 IPv4 字面量**透传（0.2.1 CLI 的值域；0.2.0 线顺带放行），任意 IPv6 字面量（裸写或 `[::1]` 方括号形式）**统一输出规范拼写**（`fd00:0:0:0:0:0:0:1` → `fd00::1`、`0:0:0:0:0:0:0:0` → `::`）。规范化是硬要求不是化妆：围栏对**每个** `trustedHosts` 条目做装载期断言（`assertTrustedAuthority`：条目必须「WHATWG 解析不改写，大小写除外」），非规范拼写的条目让 `connection` 行**激活即抛**、整树起不来；通配判定（`lanHosts` 的 `canonical === '::'`）同样吃规范拼写。另拒两类：带 zone 的字面量（`fe80::1%eth0`，`isIPv6` 放行但 WHATWG 解析抛错）与 **IPv4-mapped**（`::ffff:192.168.1.5`——按 IPv4 绑定，客户端 `Host` 是 IPv4 裸形式，方括号 mapped 条目永远对不上）。DNS 名与畸形字面量照拒。非法值在 commander action 里被接住走 `program.error`（一行错误 + exit 1，与 stock 拒绝同形态）。

**`lanHosts(bindHost)`（围栏权威矩阵）**——补齐 stock 两时代都产不出的权威，且**绝不宽于套接字实际服务面**：

| 绑定 | 返回 | 理由 |
|---|---|---|
| `undefined` / `127.0.0.1` | `[]` | 回环绑定不服务远程、回环 Host 两时代围栏自带信任 |
| `0.0.0.0` | 非 internal IPv4 接口地址（裸写），按枚举序 | 与 0.2.0 线 `resolveLanTrust` 逐字同语义（rc.2 上等值替换；0.2.1 上 stock 推导已删，靠我们） |
| `::`（双栈通配） | 两个家族：IPv6 方括号 + IPv4 裸写 | 双栈套接字同时接 IPv4-mapped 客户端；stock 的 IPv4 推导只对 `0.0.0.0` 生效（第一版漏了 IPv4 面，实测 403 后补上） |
| 其他具体 IPv4 | `[自身]`（裸写） | 0.2.0 线围栏无绑定自动信任，是刚需；0.2.1 线重复无害 |
| 其他具体 IPv6 | `[自身]`（方括号规范拼写） | 同上 |
| 非字面量 | `[]` | 不会走到（`--host` 已被 normalizeBindHost 把关） |

条目一律**规范拼写 + 方括号（IPv6）+ 无端口**（WHATWG hostname 形态，围栏 `parseAuthority` 产出并比较的就是它；且必须过 `assertTrustedAuthority`）；`%zone` 后缀剥离（绑定地址与接口地址同规则）；接口枚举失败（`networkInterfaces()` 抛错）返回 `[]`——信任面收窄是 fail-closed，把 `connection` 激活炸掉不是。

**`supportsTlsConfig(baseUrl?)`（0.2.1 能力代理）**：`'tls' in bootWebServer(baseUrl)?.Config?.dict`——TLS 与 `--public-url` 同期上线，一个探测管两个 flag；**必须走 `bootWebServer` 的 profile 根解析**（同双实例坑），否则读到本仓库 rc.2 实例、门禁静默失效。

### 2. `src/startup.ts`：接线（trustedHosts 富化 + 门禁）

`apply()` 开头探测 `ensureIpv6BindSupport(ctxBaseUrl(ctx))` 与 `supportsTlsConfig(ctxBaseUrl(ctx))`，然后建 commander。action 里：

- `normalizeBindHost(options.host)`；**非 `127.0.0.1` 且拓宽失败 → `program.error`**（升级不兼容时唯一可见失败；`127.0.0.1` 两时代 stock 都收，不设门禁）。
- `--tls-cert`/`--tls-key` 必须成对（文案照搬上游 `must be supplied together`）、`--public-url` 经本地镜像 `parsePublicUrl` 校验（上游 `public-url.ts` 未导出子路径；升级先 re-diff，同补签镜像规矩）。
- `tls`/`publicUrl` 存在而 `supportsTlsConfig` 为 false → `program.error`（rc.2 上「需要 dsh ≥ 0.2.1」——TLS flag 落在明文监听上是安全意外，不静默）。
- `ctx.provide('webStartup', { …, trustedHosts: [...options.trustedHost ?? [], ...lanHosts(host)] })`——**富化后的完整权威表**，`--trusted-host` 值保持参数序在前。

**顺序保证**：`webserver` 行 `inject: [webStartup]`，我们的插件先于 webserver Service 激活，拓宽必在其配置校验之前生效；`connection` 行注入 `webServer`/`webStartup`/`webAuth`，全在我们之后。`auth-reset` 子命令路径不 provide `webStartup`（`--help` 同）。

### 3. `cordis.patch.yml`：connection 行走官方消费路径

```yaml
- id: connection
  inject: [webServer, webStartup, webAuth]
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

- **表达式两时代同一份**：0.2.1 线上与 stock 行**逐字一致**（上游注释即本范式：「The listener's bind IP is accepted separately from this list.」）；0.2.0 线上取代 `[...ctx.webRuntime.trustedHosts, …]` 的旧表达式——`webRuntime` 消费消失，信任表由我们的 startup 提供（rc.2 上与原 `resolveLanTrust + --trusted-host` 结果等值）。
- **`inject` 里必须列 `webStartup`**：cordis 对 `!!js` 表达式里的 `ctx.<服务名>` 访问做注入门禁——没在 `inject` 声明的服务访问直接抛 `cannot get property ... without inject`（E2E 抓过）。**`webAuth` 是排序红线**：保证 auth 插件在 connection 注册 API 路由之前激活（不设防与设防的区别，见 `auth-mechanics.md`「路由保护顺序」）。
- **`inject` 里必须列 `webServer`（E2E 抓出的回归，2026-10-12）**：connection 的 `HostConnectionService.register` 对**调用方上下文**执行 `owner.webServer.register(route)`，该属性访问按 connection 行的 inject 作用域过门禁——行里少了 `webServer`，第三方 `connection.rpc.handle` / `connection.fetch.register` 消费方（如 dsh-ntr，模块自身 `inject = ['webServer', 'connection']` 也救不了）激活即抛 `cannot get property "webServer" without inject`（connection lib 的 `register` 栈帧）。rc.2 / 0.2.1-alpha.2 / 0.2.1-rc.2 三代实测同样（栈帧行号随上游变动：alpha.2 = lib:712、rc.2 = lib:871，2026-10-17 复现）；**alpha.2 stock 行 `inject: [webStartup]` 同样有此缺口**，我们比 stock 多修一处。
- **行级 inject 与模块自身 inject 合并、非替换；patch 层之间则是替换**：loader 的 `Inject.resolve(fiber.entry.options.inject, fiber.inject)` 把行声明并进 fiber 已有的 inject 表（connection 模块自身的 `inject = ['credentials']` 不受影响）；但 profile 用户 patch 对同一行再写 `inject` 会**整体替换** bundle 层的列表（2026-10-12 实测：用户 patch 写 stock 形态 `[webStartup, webAuth]` → dsh-ntr 必炸）。三处（`webServer`/`webStartup`/`webAuth`）一个都不能少。
- 表达式不带双引号是刻意的：js-yaml 普通标量只在 `[` 开头或含 `: ` 时才需要引号，`ctx.webStartup.trustedHosts` 两者皆无（上游 stock 同写法）。

## 行为边界（对用户）

- `--host` 缺省 / `127.0.0.1`：**行为零变化**。
- `--host 0.0.0.0`：0.2.0 线信任表与原 `resolveLanTrust` 等值（我们接管了同一语义）；0.2.1 线恢复被 stock 拒绝的通配绑定。
- `--host <具体 IPv4>`（如 `192.168.1.5`）：新值域，两时代可启动；0.2.1 线围栏自动信任该绑定地址本身。
- `--host ::`：双栈（Linux `bindv6only=0`）同时监听 IPv6 与 IPv4-mapped，比 `0.0.0.0` 覆盖更全；`bindv6only=1` 系统上仅 IPv6。`--host ::1` 只监听 IPv6 回环（`http://[::1]:<端口>/`）。
- `--host` 拼写：非规范 IPv6 被规范化后放行；带 zone 与 IPv4-mapped 拒绝。非法值一行人话错误 + exit 1。
- `--public-url` / `--tls-cert`/`--tls-key`：**仅 0.2.1 线可用**；rc.2 上清晰报错（`需要 dsh >= 0.2.1`），绝不静默。TLS 监听上的 cookie 会带 `Secure` 且补签 audience 变 origin（`native-auth-bridge.md`）。
- LAN URL 打印：`resolveLanTrust`（0.2.0 线）只枚举 IPv4，`::` 启动时终端**只打印回环 URL**，局域网 IPv6 地址需手动拼 `http://[<地址>]:<端口>/`（README 已注明）。回环 URL 是上游硬编码的 `http://127.0.0.1:<端口>/`：`bindv6only=1` 系统上这个打印出来的 URL 本身也不通，用 `http://[::1]:<端口>/`。
- 报错文案：host 的 schema 报错末尾多一个 union 成员（`| string`），只在启动失败时可见。

## 升级观察哨（每次 bump dsh 先跑）

1. **diff `packages/host/webserver/src/index.ts` 的 `Config.host` 形状**（`dict` 结构、`~standard` 入口）：两种已知形状（0.2.0 union / 0.2.1 transform）都已在 `widenHostMember` 覆盖。形状再变 → widen 返回 `false` → 扩展 `--host` 报「当前 dsh 版本不支持」。**注意 0.2.1 的方向是明确收紧：widen 是永久特性，没有「上游放开后清理」的路径**（旧的清理清单期待已删除——本条目曾是它的载体）。
2. **两份实例的分歧**：`ctx.baseUrl`（profile 根）解析出的包 vs 本仓库 `node_modules` 的包。上游若改 `webserver` 行的解析方式，`ensureIpv6BindSupport`/`supportsTlsConfig` 的指路失效 → 表现是 schema 报错照旧 / 门禁误报不可用（都 fail-closed，靠哨 1 与实机发现）。仓库依赖与 dsh CLI 内嵌副本版本漂移时同理。
3. **diff `dsh-client-connection` 的围栏**（`api-request-trust.ts` 的 `parseAuthority`/`isTrustedAuthority`/`assertTrustedAuthority`/`isBindAddressAuthority`）：条目 shape（规范拼写 + 方括号 + 无端口 + 过装载期断言）的四条依据；`isBindAddressAuthority` 的具体绑定自动信任语义决定我们条目是否冗余（冗余不碍事，别删误判）。
4. **diff web-app patch 的 `connection` 行**（`inject` 与 `trustedHosts` 表达式）：我们的行是 stock 行的逐字镜像（+`webAuth`）。stock 若改行形状，我们的 `cordis.patch.yml` 同步跟。
5. **diff webserver 的 `Config.dict.tls` 成员与 webserver/web-runtime 行对 `webStartup.tls`/`publicUrl` 的消费**：`supportsTlsConfig` 探测与透传字段形状的依据（`tls` 成员被改名/移除 → 门禁失准）。
6. **`!!js` 表达式的注入门禁语义**（cordis loader `Inject.resolve` + config 插值）：上游若改 `ctx.<service>` 访问语义或行级 inject 合并规则（哨 3 依赖「合并非替换」），`connection` 行症状是启动 `cannot get property ... without inject` 或表达式静默取空。

> **0.2.0-rc.1 观察哨已跑（2026-09-28）**：哨 1–6（当时为 1–5 版）全部无触发——`webserver/src/index.ts`（含 `Config.host` union）逐字零 diff、`resolveLanTrust` 仍 IPv4-only、围栏三函数零 diff、`vendor/` cordis 零 diff；**清理清单不启动**。`--host ::` 双实例拓宽（哨 2）与围栏 403/401 分界（陌生 Host 403、双栈 IPv4 LAN 401）隔离实例实测通过，见 `docs/upgrade-dsh-0.2.0-playbook.md`「B」。
>
> **0.2.0-rc.2 观察哨已跑（2026-10-07）**：同样全部无触发——`webserver/src/index.ts`（含 `Config.host` union）对 `dsh-v0.2.0-rc.1` 零 diff，`resolveLanTrust` 仍是 IPv4-only，围栏三函数零 diff；`ensureIpv6BindSupport` 与 `lanHosts` 均不可拆。隔离实例实测：`--host ::` 正常启动 + 双栈围栏四项（`[::1]` 回环 401 / 陌生 `[2001:db8::99]` **403** / IPv4 LAN 401 / 本机全局 IPv6 401），见 `docs/upgrade-dsh-0.2.0-playbook.md` 的 rc.2 段落。
>
> **0.2.1-alpha.2 触发警报（2026-10-12，前瞻）**：master（=alpha.2）把 `Config.host` 换成「任意具体 IP 字面量的 `z.transform` + 通配硬拒」，并删除 `resolveLanTrust`/`webRuntime` 服务。哨 1/4/6 同时触发，且**不是清理而是返工**：哨 1 只满足一半（具体 IPv6 放开了、通配仍禁；当时 union 兜底只救 `::`，`0.0.0.0` 实测 schema `ValidationError`）；哨 4 变成整行重写（`webRuntime` 删除 → 旧表达式悬空，回环/`0.0.0.0`/`::` 三连败，插件完全无法启动）；stock 推导整体消失 → `lanHosts` 接管 `0.0.0.0` 侧。适配清单与落地记录见 `docs/upgrade-dsh-0.2.0-playbook.md`「0.2.1-alpha.2 前瞻审查」与「适配落地（双时代兼容）」。
>
> **适配已落地并通过双时代 E2E（2026-10-12）**：widen 第二成员域放宽为任意 IPv4/IPv6 字面量（union fallthrough 兜底，fixture 钉死）、`lanHosts` 补 `0.0.0.0`/具体 IPv4 行、`connection` 行落官方表达式（新增发现：inject 必须保留 `webServer`，见上「connection 行走官方消费路径」第 3 条；哨 3/6 的新验证点是 `isBindAddressAuthority` 与 patch 层替换语义）。实机结果见下节「双时代实机验收」。**注意哨 4 的含义已变**：我们的行不再是纯 stock 镜像——比 stock 多 `webServer`（修其缺口）与 `webAuth`（排序红线），diff 时勿把这两处当偏差删掉。
>
> **0.2.1-rc.1 / rc.2 观察哨已跑（2026-10-17，Phase 2 bump）**：alpha 线转入 `next` 正式通道（`next` = `0.2.1-rc.2`，`latest` 仍 = `0.2.0-rc.2`），依赖 bump 到 `^0.2.1-rc.1`。哨 1–6 全部无触发——webserver 的 `Config.host` transform 与 alpha.2 零 diff（rc.1 只**新增** `bindUrlHost`/`getOrigin()` 两个导出，host schema 本体未动）、`resolveLanTrust`/`webRuntime` 依旧不存在（我们本就自给自足）、围栏三函数零 diff、web-app `connection` 行与 alpha.2 逐字一致（rc.1→rc.2 仅多一个无关 client 行 `ui-deepseek-model-label-1017`）、`connection/request` waterfall 零动。**镜像对象零 diff**：`COOKIE_PAYLOAD_VERSION = 1`（浏览器 cookie 仍 v1）、`requestAudience`/`sessionCookie`/`cookieName`/`STORED_SECRET_VERSION`/`SECRET_BYTES`/`AUTH_RECORD_KEY`/`parsePublicUrl`/`authenticatedUrl` 全部逐字未变。rc.1→rc.2 之间 7 个关联包的 `lib/` **逐字节相同**（只 `package.json` 版本/peer 稳定化）。隔离实例三形态实测见下节「0.2.1-rc.2 实机验收」。

## 实机验收（E2E 记录，2026-09-27，dsh 0.1.7-rc.1 + 本插件 link）

隔离实例 `DSH_WEB_AUTH_FILE=/tmp/.../web-auth.json`，`dsh web --host :: --port 3111 --no-open`：

- **双栈监听**：`::` 绑定后 `curl http://127.0.0.1:3111/` 与 `curl -g "http://[::1]:3111/"` 均通（后者 303 是回环补签，符合文档）。
- **IPv6 LAN 权威过围栏**（关键）：`POST /api/rpc` + 有效 `dsh_sid` + `Host: [<本机 IPv6>]:3111` → **401**（围栏放行、撞上游原生 cookie 闸门；浏览器侧由补签桥接补证：GET 303 mint 后跟随请求拿到 404 not found，即上游接受了该 authority 的 cookie）。对照 `Host: [2001:db8::99]:3111` → **403 forbidden**（围栏拒绝）。两条合起来证明：IPv6 权威确实来自我们的 `lanHosts`，且围栏未被放宽。
- **双栈绑定的 IPv4 面**（安全审核后补的洞，第一版漏了）：`::` 绑定 + `Host: [<本机 IPv4>]:3113` + 会话 → 曾经 **403**（stock 的 IPv4 LAN 推导只对 `0.0.0.0` 生效，我们当时也只补 IPv6）。修复后 `lanHosts('::')` 同时给两个家族 → **401**（过围栏）。陌生 IPv6 Host 仍 403。
- **`0.0.0.0` 回归**（3112 端口）：启动正常；`Host: [<本机 IPv4>]:3112` + 会话 → 401（web-app 的 IPv4 LAN 推导经我们的表达式原样保留）；`Host: [<本机 IPv6>]:3112` → **403**（IPv4 绑定不加 IPv6 权威，符合设计）。
- **非法 host**：`dsh web --host example.com` → 一行中文错误 + exit 1（与 stock 拒绝 `0.0.0.0` 同形态）。

注意：`/api/auth/status` 等由本插件注册的路由**不经** `connection.admit`，探围栏必须打 `/api/rpc` 且用 **POST**（GET/HEAD 会被补签桥的 303 拦在围栏之前，根本到不了 `admit`）。

## 双时代实机验收（E2E 记录，2026-10-12，rc.2 依赖 + alpha.2 前瞻）

**rc.2**（作者 profile，`link:` 本插件构建产物，`DSH_WEB_AUTH_FILE` 隔离）：

- `--host 0.0.0.0`：十二探针全绿——回环 303 补签与 200 跳板、远程导航 302 `/login`、匿名 RPC 401、注册双 cookie、登录后 RPC 到 bridge 门后（404）、sid-only 401、陌生 Host 403、登出双清；`--dump-config` 显示 connection 行 `inject: [webServer, webStartup, webAuth]` + `trustedHosts: !!js ctx.webStartup.trustedHosts`（展开为字面列表，`webLanHosts` 消失）。**dsh-ntr canary 干净激活**（本行 inject 的 `webServer` 回归即由此抓出）。
- `--host <本机 LAN IPv4 字面量>`（新值域）：可启动；`Host:` 该字面量 + 会话 → 401（围栏放行——rc.2 围栏无 `isBindAddressAuthority`，全靠新 `lanHosts` 的 `[自身]` 条目）。
- `--host ::`：`127.0.0.1` 与 `[::1]` 双通；LAN IPv4、本机全局 IPv6 的 Host + 会话 → 401；陌生 `[2001:db8::99]` → 403。
- `--tls-cert`/`--public-url` 在 rc.2 → exit 1 人话报错（能力门禁生效，非静默 no-op）。

**alpha.2**（`/tmp/dsh-alpha-e2e` 0.2.1-alpha.2 实机，同上 link 构建产物）：

- 通配 `--host 0.0.0.0`（widen 恢复）与 `--host ::`：启动 + 登录墙（302/401）+ 围栏矩阵（LAN IPv4 401、本机全局 IPv6 401、陌生 IPv6 403）+ 回环补签（`127.0.0.1` 与 `[::1]` 各得 200 跳板）全绿。
- **TLS 自签全链**（`--tls-cert`/`--tls-key`；openssl 自签、SAN=LAN IP）：https 导航 → 200 跳板 + 补签 cookie 名为 `dsh-auth-` + base64url(sha256(**origin**))（`https://192.168.5.216:3132`）且带 `; Secure`；带真 cookie 二次导航 200 进 SPA；https 登录响应双 cookie 均带 `; Secure`（`dsh_sid` 亦加）；登出双 cookie 清除同样带 `; Secure`；https 下 POST 陌生 Host 403、LAN + 会话缺原生 cookie 401。
- `--public-url https://app.example.com/`：启动打印改用该 URL（`https://app.example.com/?token=…`）。
- flag 门禁：`--tls-cert` 单缺、`--tls-key` 单缺 → 成对报错 exit 1；畸形 `--public-url` → 校验报错 exit 1。
- dsh-ntr canary 双重钉死：`[webServer, webStartup, webAuth]` 干净启动；把 profile 用户 patch 覆写成 stock 形态 `[webStartup, webAuth]` → `dsh: warning: 1 entry did not activate` / `dsh-ntr: cannot get property "webServer" without inject`（connection lib:712）——同时证明 **stock 行同样有此缺口** 与 **patch 层之间是替换而非合并**。

## 0.2.1-rc.2 实机验收（E2E 记录，2026-10-17，Phase 2 bump 后）

隔离实例 `/tmp/dsh-021-e2e`（`@deepseek-ai/dsh@0.2.1-rc.2`，`DSH_HOME=/tmp/dsh-021-home`，profile `link:` 本插件构建产物 + dsh-ntr canary），`--dump-config`：`web-startup` disabled、connection 行 `inject: [webServer, webStartup, webAuth]` + `trustedHosts` 表达式、webserver 行新增 `tls: !!js ctx.webStartup.tls`。

**`--host 0.0.0.0`（端口 3199）**——十二探针全绿：回环 GET/ → **200 补签跳板**（cookie 名 = 该 audience 哈希，v1 payload）；远程 Host GET/ → **302 `/login`**；匿名 POST `/api/rpc` → **401**；匿名 `/api/auth/status` → `{"registered":false,"authenticated":false,"session":false,"trusted":false}`；注册/登录 → **双 cookie**（`dsh_sid` SameSite=Lax + 原生 cookie SameSite=Strict）；登录态 GET/ 远程 Host → **200**；登录态 POST `/api/rpc` → **404**（过围栏与原生 cookie 闸门、到达 bridge）；sid-only → **401**；陌生 Host + 会话 POST → **403**；陌生 Host + 会话 GET/ → **200 跳板**（150 B 跳板文档 + 为陌生 Host 签发的原生 cookie，非 SPA——与 rc.2/alpha.2 逐字节一致的非回归观察）；登出 → 双 cookie `Max-Age=0` 双清。

**`--host 192.168.5.216` + TLS 自签（端口 3212，openssl 自签 SAN=LAN IP）**——https 全链绿：注册/登录 → 双 cookie 均带 `; Secure`；原生 cookie 名 = `dsh-auth-` + base64url(sha256(**`https://192.168.5.216:3212`**))（https 下 audience 取 origin，与计算值吻合）；sid-only 页面导航 → **200 跳板** + `; Secure` 原生 cookie；带真 cookie → **200 真 SPA**（41031 B）；POST 陌生 Host → **403**；LAN + 会话缺原生 cookie → **401**；双 cookie POST → **404**；登出 → 双 cookie `Max-Age=0` 且均带 `; Secure`。

**`--host ::`（端口 3198，双栈）**——`127.0.0.1` 与 `[::1]` 各得 200 补签跳板且 **cookie 名互不相同**（按 audience 绑定）；LAN IPv4 与本机全局 IPv6 Host 无会话 GET/ → **302 `/login`**；匿名 POST → **401**；陌生 `[2001:db8::99]` + 会话 POST → **403**；LAN + 双 cookie POST → **404**；全局 IPv6 + 双 cookie POST → **401**（原生 cookie 绑在 LAN audience 上，换 Host 即失效，符合设计）；LAN GET/ + 双 cookie → **200**。

**flag 门禁**：`--tls-cert` 单缺 / `--tls-key` 单缺 → `error: --tls-cert and --tls-key must be supplied together`（exit 1）；畸形 `--public-url` → `error: --public-url must be an absolute http or https URL of the form http(s)://host[/prefix]`；含空格 → `must not contain ASCII whitespace or control characters`——三条文案与上游逐字一致。

**dsh-ntr canary**：`[webServer, webStartup, webAuth]` 干净激活（零 warning）；把 profile 用户 patch 覆写成 stock 形状 `[webStartup, webAuth]` → `dsh: warning: 1 entry did not activate` + `dsh-ntr (dsh-ntr): Error: cannot get property "webServer" without inject`，栈帧 **connection lib:871**（alpha.2 为 :712，上游行号变动、机制不变）。含 canary 的实例上复跑登录墙冒烟（注册/登录双 cookie、匿名 401、登录态 404、陌生 Host 403、`/login` 公开）全绿。

**探针踩坑记录（2026-10-17，非产品缺陷）**：① `grep -v '^#'` 会把 curl cookie jar 里 HttpOnly 行（`#HttpOnly_<domain>`）整行滤掉，导致后续探针静默丢 cookie——读 jar 勿滤 `#` 行；② `sed 's/.*=\([^;]*\).*/\1/'` 取 `Set-Cookie` 值时，贪婪 `.*=` 会咬到 `SameSite=`/`Max-Age=`，取回 `Strict`/`2592000` 之类——必须锚定前缀 `s/^[Ss]et-[Cc]ookie: <name>=\([^;]*\).*/\1/`。用错值时上游返回 **400**（webserver 顶层 listener 把 handler 异常转成 400），曾被误判为兼容性回归。

## 测试要点（`tests/`）

- `tests/ipv6-shim.spec.ts`：`widenHostMember` 在独立 fixture schema 上验拓宽（stock 两时代形状都过：union 与 plain-Error 拒绝通配的 transform；`::`/`::1`/`fd00::1`/具体 IPv4 ACCEPT 且值保持、`example.com` 仍拒、`port` 字段仍校验、其他成员默认值与 `required` 不变）、幂等、异形 schema 返回 false、**plain-Error 成员经 union fallthrough 的兜底 fixture**；`ensureIpv6BindSupport`（坏 baseUrl → false；无 baseUrl → 拓宽 import 实例；`vi.resetModules()` + 动态 import 验首次尝试语义与进程内幂等）；`supportsTlsConfig`（**无 baseUrl → true，因为导入的包就是 0.2.1 线**；坏 baseUrl → false；`mkdtemp` fixture profile 根的 webserver**不带** `tls` → false、带 `tls` → true）；`canonicalIpv6`（含拒 zone/DNS/畸形）；`normalizeBindHost` 值域（含**具体 IPv4 透传**、方括号归一、非规范拼写规范化、拒 DNS/zone/IPv4-mapped）；`lanHosts` 矩阵（mock `node:os`：`0.0.0.0` → 非 internal IPv4 列表、具体 IPv4 → `[自身]`、`::` → 双家族、规范拼写 + 方括号 + 无端口 + 过围栏装载期断言、接口枚举失败回 `[]`）。
- `tests/startup.spec.ts`：`--host ::`/`[::1]`/非规范拼写的 `webStartup.host` 归一；**trustedHosts 富化**（`0.0.0.0` → LAN 列表；`::` → `--trusted-host` 序在前 + 双家族；具体 IPv4 → `[自身]`）；`--public-url`/`--tls-cert`/`--tls-key` 透传（fixture 根）与门禁（**显式「无能力」fixture 根** → exit 1）；`--tls-cert` 单缺 → 成对报错；非法 `--public-url` → exit 1。
- **基线前移会改测试写法（2026-10-17 踩过）**：能力门禁的两个「不支持」断言原本靠「导入的 rc.2 webserver 无 `tls` 成员」成立；依赖 bump 到 0.2.1 后该探测**正确**返回 true，两个用例随即红。**这不是缺陷**——门禁按实际安装的 harness 判断，正是设计。修法是把「无能力」形状改成显式 fixture（`dict: { host: {} }`），而不是把断言反过来。凡以「当前安装的上游版本」为前提的断言都要这样显式化，否则下次 bump 又会红。
- **单测摸不到启动路径的那份实例**（双实例分歧，见观察哨 2）：「拓宽后通配能启动」「TLS 门禁真的按 profile 根的 webserver 判断」只有 E2E 能证明，单测全绿不等于能用——这正是本功能第一版翻车点。
- **`program.error` 在单测里可观测**：`dsh-cmdline` 的 `parseCmdline` 对整棵命令树 `exitOverride()` 并把 CommanderError 路由到 `ctx.appExit`（`configureExitAndOutput`）——单测以 `exitCodes` 观测 exit 1，非法 host/成对校验/门禁路径都被单测覆盖（旧说明「走 process.exit 单测不触达」已失效）。
