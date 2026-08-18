---
name: dsh-plugin-made-easy
description: DeepSeek Harness（DSH）插件开发傻瓜书：从零到发布一个工具插件的全流程单文件模板。覆盖 bundle 形态选型、defineTool 完整契约（parameters DSL / output / execute / timeoutMs）、cordis.patch.yml 写法、package.json 的 dsh.bundle 声明、tsconfig 三件套构建、dsh plugin 挂载与 --dump-config / headless 任务验证、三层测试（契约/逻辑/真实管道）、npm pack 交付，以及 17 条实测踩坑速查。当要写 DSH 插件、注册工具、打包 bundle、挂 profile、跑端到端验证、排查 ctx.tools 报错或构建产物问题时参考。
license: MIT
metadata:
  author: whiteicey
  version: "2.0.0"
---

# DSH 插件开发傻瓜书（单文件版）

> 本文基于 deepseek-harness 仓库（快照 `0.1.0-rc.5`）的**源码级实现**与 9 个真实插件（time/encoding/json/calculator/csv/regex/markdown/diff/stat）的实测经验写成。所有命令、字段、错误语义都对着源码核对过。
> 阅读方式：**不会就照抄**。§4 是一套完整可编译的插件模板，§13 是交付前的一条龙验证。遇到报错先查 §12 踩坑速查表。

---

## 0. 30 秒 TL;DR

DSH 里**一切皆插件**：模型适配器、工具注册表、会话日志、Agent 循环本身都是插件（Cordis 微内核架构）。

一个**工具插件**（最常用的插件类型）= 5 个文件：

```
my-plugin/
├── package.json          # 声明 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── tsconfig.json         # 构建三件套（见 §5）
├── cordis.patch.yml      # 在 profile 里插入一行插件
├── src/index.ts          # 导出 name / inject / apply，ctx.tools.register(defineTool({...}))
└── src/impl.ts           # 纯逻辑（可测试）
```

然后 4 条命令交付：

```sh
npm install                                                    # 装 devDeps + peer
npm run typecheck && npm test && npm run build && npm pack     # 构建出 .tgz
dsh plugin --profile web add ./my-plugin                       # 挂进 web profile
dsh --profile web --dump-config | grep <你的工具行 id>          # 确认已挂载
```

**核心理念**：插件通过 `ctx` 注册能力（工具、事件监听、定时器），卸载时框架**自动清理**；`ctx.tools.register()` 返回 disposer，全部注册都是 effect，天然支持热替换（HMR）。

---

## 1. 三个核心概念（20 分钟就能懂的架构）

### 1.1 插件（Plugin）

导出 `apply` 函数的 TypeScript 模块。框架加载时调用 `apply(ctx, config)`，你通过 `ctx` 注册能力：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'          // 诊断信息里的标识（可选但推荐）

export function apply(ctx: Context) {
  console.log('[hello-plugin] plugin loaded!')   // 依赖就绪后才会执行
}
```

这就是一个**完整可运行**的插件。函数形态是默认推荐；对象形态（`export default { name, inject, apply }`）和类形态（`extends Service`）见 §8.2。

### 1.2 组合包（Bundle）

**你编写和分发的东西**。Bundle = 一个 npm 包 + 一张 patch 配置层（`cordis.patch.yml`），package.json 里声明：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Bundle 的实质就是这张 patch 列表——它告诉 DSH"把这个插件行插入到配置树里"。可以没有一行运行时代码，也可以附带运行时插件代码（工具插件两者都有）。

### 1.3 Profile

**用户启动的东西**。`$DSH_HOME/profiles/<name>/` 下的一个目录，包含：

```
profiles/<name>/
├── package.json          # 插件依赖 + "dsh": { "profile": { "bundles": [...] } }
├── cordis.yml            # 空根 []，每次启动由 DSH 重写，不要手改
├── cordis.patch.yml      # 用户自己的 patch 层（可手改，改完热替换）
├── pnpm-workspace.yaml
└── node_modules/         # profile fallback 链接（自动维护）
```

内置模板：`web` = `dsh-base` + `dsh-web-app`；`headless` = `dsh-base` + `dsh-headless`；自定义名字 = 只有 `dsh-base`。**web 与 headless 是不同 profile**——装在 web 不会自动出现在 headless 里。

### 1.4 启动时的层叠加顺序（必须记住）

启动时在**空条目列表**上按顺序应用 patch，**后写的行胜出**：

```
1. 每个 bundle 的 cordis.patch.yml（按 dsh.profile.bundles 列表顺序）
2. profile 自己的 cordis.patch.yml（用户层）
3. 家级 $DSH_HOME/cordis.patch.yml（本机偏好，压过每 profile 层）
4. 每个 --patch <file> 覆盖层（按 argv 顺序）
```

关键语义：**patch 是整值替换，不是深度合并**——用 `- id: xxx / config: {...}` 覆盖一行时，会替换该行**整个** config 值；你要覆盖一个多键 config 就必须重述所有键。`!!js` 表达式允许出现在 `config` 和 `disabled` 字段（写法是 `!!js`，不是 `!js`），其余元数据保持字面量。

---

## 2. 动手前检查清单

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 22.19 或 ≥ 24 | `node --version` |
| pnpm | 必须在 PATH 上（`dsh plugin` 是 pnpm 转发器） | `pnpm --version`（没有就 `npm i -g pnpm` 或 `corepack enable`） |
| dsh | 官方 npm 已发布 rc 线 | `npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh --version` |

其他须知：

- 不要 `npm i -g` 全局安装 dsh；用 `npx -p @deepseek-ai/dsh@<版本> dsh <命令>` 或装到本地 devDependency。
- **版本线要一致**：本文验证的外部开发者线是 `@deepseek-ai/dsh@0.0.1-rc.1`（peer：`@deepseek-ai/cordis@^4.0.1-rc.1`、`@deepseek-ai/dsh-tools@^0.0.1-rc.1`）。你插件里 peer 的 rc 线必须和你运行时用的 dsh 版本线匹配。
- 网络慢时公共包可走国内镜像（`registry.npmmirror.com`）；`@deepseek-ai` scope 仍需官方 registry（+ 只读 token，仅放环境变量，绝不写入项目 `.npmrc`）。

---

## 3. 选形态：这个插件该做成什么？

不是所有东西都是 bundle。按需求查这张矩阵（公测期 plugin_check 的 `schema` action 输出同源）：

| 需求 | 形态 | 识别标志 |
|---|---|---|
| 需要运行时逻辑（工具/服务/Web UI），随 profile 启动、`dsh plugin add` 安装 | **bundle**（本文默认） | package.json + `dsh.bundle.patch` → `cordis.patch.yml` |
| 要在「设置页插件面板」里 enable/disable，走 catalog 安装 | **registry 原生插件** | `dsh.plugin.json` 清单（可只有 `index.mjs`，无 package.json） |
| 纯提示词/流程型能力 | **skill** | `SKILL.md`（frontmatter + 正文 + references/） |
| 多个同风格插件打包 | **collection** | `catalog.json`（collection/plugins 字段） |
| 多包/基础设施仓库（无 bundle 入口） | **infra** | package.json 无 `main` |

判断口诀（9 个插件的实践）：

1. 模型**高频需要、确定性、可验证**的能力 → **工具插件**（零依赖纯函数）；
2. 需要**读文件/跑进程/查系统** → 工具插件 + `"types": ["node"]`；
3. 需要**面板生命周期** → registry 形态；
4. 需要**注入 UI/客户端** → bundle 的 client half；
5. 纯**流程/提示词** → skill。

本文教程按 bundle + 工具插件展开——这是 90% 场景。

---

## 4. 完整模板：零依赖 base64 工具插件（全程照抄）

目标：注册一个 `b64` 工具，模型可以调用 `encode` / `decode` 两个 action。**零运行时依赖**（只有 peer），确定性强（纯函数），正好演示 node types 的使用。

### 4.1 文件树

```
dsh-tool-b64/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
├── LICENSE                # MIT，可选
├── README.md              # 安装/用法/示例/边界说明（发布前必写，清单见 §10.4）
├── src/
│   ├── index.ts           # 插件入口：name/inject/apply + defineTool
│   └── impl.ts            # 纯逻辑（导出给测试）
└── tests/
    ├── register.spec.ts   # 注册契约测试（零依赖，vi.mock 屏蔽 dsh-tools）
    └── impl.spec.ts       # 逻辑测试
```

### 4.2 `package.json`（逐字段注释）

```jsonc
{
  "name": "dsh-tool-b64",
  "version": "0.1.0",
  "description": "DSH 工具插件：base64 编码/解码，零依赖，注册 b64 工具",
  "type": "module",                                   // 必须：ESM 全家桶
  "main": "lib/index.js",                             // 指向 tsc 产物
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",       // patch 文件必须可被解析到
    "./package.json": "./package.json"
  },
  "files": ["lib", "src", "cordis.patch.yml"],        // 打包内容（cordis.patch.yml 不能漏）
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run tests",
    "prepack": "npm run typecheck && npm test && npm run build"   // npm pack 前自动全绿
  },
  "peerDependencies": {                               // 宿主（dsh 运行时）提供，插件不打包它们
    "@deepseek-ai/cordis": "^4.0.1-rc.1",
    "@deepseek-ai/dsh-tools": "^0.0.1-rc.1"
  },
  "devDependencies": {                                // 自包含构建：干净 checkout 也能 install→build→test
    "@types/node": "^22.20.0",
    "typescript": "^5.7.0",
    "vitest": "^3.2.0"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // ← bundle 声明，dsh plugin 自动挂载的关键
  "license": "MIT"
}
```

要点：

- `dsh.bundle.patch` 是**被 `dsh plugin` 自动 reconcile 的关键**：装进 profile 的依赖只要声明了这个字段，就会被追加进 `dsh.profile.bundles` 层列表；没声明的包只是普通依赖，`dsh plugin` 会打警告且不激活任何层。
- `dependencies` 保持**空**。能用 node 内置解决的（Buffer/fs/crypto）绝不多引一个包——参数会进会话日志，工具应确定性、无副作用、无网络。

### 4.3 `tsconfig.json`（构建三件套）

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2024"],                      // isWellFormed 等新 API
    "module": "esnext",
    "moduleResolution": "bundler",
    "outDir": "lib",
    "rootDir": "src",
    "declaration": true,
    "declarationDir": "lib/types",
    "allowImportingTsExtensions": true,     // 允许 import './x.ts'（缺了报 TS5097）
    "rewriteRelativeImportExtensions": true, // 产物自动把 './x.ts' 改成 './x.js'（缺了运行时崩溃）
    "noEmitOnError": true,                  // 报错就绝不出产物（默认 false，报错也 emit！）
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]                       // Buffer 等 node API 类型
  },
  "include": ["src"],
  "exclude": ["tests", "lib"]
}
```

### 4.4 `cordis.patch.yml`

```yaml
# dsh bundle patch：在 profile 的空条目列表上插入一行。
# 注意：name 必须是包名（模块说明符），不是相对路径——运行时经 profile fallback 解析。
- insert:
    - id: tool-b64
      name: dsh-tool-b64
```

Patch 语法备忘（vendor/loader + include 的实测语义）：

- `- insert: [...]`：**不带 `id`** = 追加到条目列表末尾（最常用）；**带 `id`** = 目标是 `group: true` 的分组行，新行插入该组的 `config` 子树。
- `- id: xxx` + 任意键 = **update**：整体覆盖目标行同名键；`name` 字段若给出且与目标不符则跳过（防误伤）；找不到目标只 warn 不报错。
- `disabled: true` / `config: {...}` 是最常用覆盖；`config` 是**整值替换**。

### 4.5 `src/impl.ts`（纯逻辑）

```ts
export type B64Action = 'encode' | 'decode'

export interface B64Args {
  action: B64Action
  text: string
}

export function runAction(args: B64Args): string {
  switch (args.action) {
    case 'encode':
      return Buffer.from(args.text, 'utf8').toString('base64')
    case 'decode': {
      const normalized = args.text.replace(/\s+/g, '')
      const buf = Buffer.from(normalized, 'base64')
      // Buffer 不报错时会静默丢弃非法字符，重新编码比对才是严格校验
      if (buf.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
        throw new Error('b64: input is not valid base64')
      }
      return buf.toString('utf8')
    }
    default:
      throw new Error(`b64: unknown action ${String(args.action)}`)
  }
}
```

错误消息统一带 `工具名: 原因` 前缀——管道会把错误变成 `Error: b64: ...` 文本还给模型。

### 4.6 `src/index.ts`（插件入口）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runAction } from './impl.ts'

export const name = 'dsh-tool-b64'
export const inject = ['tools']        // 等 tools 服务就绪后才执行 apply

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'b64',                       // 工具名：全局唯一，模型可见
    description: 'Base64-encode text or decode base64 back to text. '
      + 'Use action "encode" to encode plain text into base64, '
      + 'or "decode" to decode a base64 string into text. '
      + 'Text is processed exactly as given, no newlines are added.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['encode', 'decode'],
        description: 'Operation to perform.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Text to encode, or base64 string to decode.',
      },
    },
    output: {
      schema: { type: 'string' },      // 规范输出：JSON 文本字符串
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {              // args 已被 defineTool 按 schema 校验过、有完整类型
      return runAction(args)
    },
    timeoutMs: 2000,                   // 协作式超时预算（见 §7.4）
  }))
}
```

约定（deepseek-harness 仓库规范）：函数插件用**命名导出** `name` / `inject` / `apply`，**没有 default export**。

### 4.7 `tests/register.spec.ts`（契约测试，零依赖可跑）

用 `vi.mock` 屏蔽 dsh-tools——不需要真的安装它就能验证契约；同时覆盖执行路径（只捕获 defineTool 会漏掉真 bug）：

```ts
import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
import { name, inject, apply } from '../src/index.ts'

describe('b64: plugin registration contract', () => {
  let captured: any
  const ctx: any = { tools: { register: (def: unknown) => { captured = def; return () => {} } } }

  it('exports the cordis plugin contract', () => {
    expect(name).toBe('dsh-tool-b64')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('registers the tool with schema + render', () => {
    apply(ctx)
    expect(captured.name).toBe('b64')
    expect(captured.parameters.action.required).toBe(true)
    expect(captured.parameters.action.enum).toEqual(['encode', 'decode'])
    expect(typeof captured.output.render).toBe('function')
    expect(captured.timeoutMs).toBeGreaterThan(0)
  })

  it('executes each action and surfaces errors', async () => {
    apply(ctx)
    // 正常路径：每个 action 至少一次
    expect(await captured.execute({ action: 'encode', text: 'hi' })).toBe('aGk=')
    expect(await captured.execute({ action: 'decode', text: 'aGk=' })).toBe('hi')
    // 错误路径：断言消息含工具名前缀
    await expect(captured.execute({ action: 'decode', text: '!!!' }))
      .rejects.toThrow(/b64: input is not valid base64/)
    await expect(captured.execute({ action: 'nope', text: 'x' }))
      .rejects.toThrow(/b64: unknown action/)
    // render 输出
    const blocks = captured.output.render({}, 'aGk=')
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'aGk=' })
  })
})
```

### 4.8 `tests/impl.spec.ts`（逻辑测试）

```ts
import { describe, expect, it } from 'vitest'
import { runAction } from '../src/impl.ts'

describe('b64: runAction', () => {
  it('encodes utf-8 text', () => {
    expect(runAction({ action: 'encode', text: 'hello' })).toBe('aGVsbG8=')
    expect(runAction({ action: 'encode', text: '你好' })).toBe('5L2g5aW9')
  })
  it('decodes base64 back to text', () => {
    expect(runAction({ action: 'decode', text: 'aGVsbG8=' })).toBe('hello')
    expect(runAction({ action: 'decode', text: '5L2g5aW9' })).toBe('你好')
  })
  it('rejects invalid base64', () => {
    expect(() => runAction({ action: 'decode', text: '!!!' })).toThrow(/not valid base64/)
  })
  it('rejects unknown actions', () => {
    expect(() => runAction({ action: 'rot13', text: 'x' } as never)).toThrow(/unknown action/)
  })
})
```

---

## 5. 构建（4 条命令 + 1 条验证）

```sh
npm install      # npm 7+ 会自动装 peerDependencies；装完 devDeps 与 lockfile 自包含
npm run typecheck    # 零错误
npm test             # vitest 全绿
npm run build        # tsc → lib/（index.js、impl.js、types/*.d.ts）
npm pack             # 产出 dsh-tool-b64-0.1.0.tgz（prepack 自动重跑 typecheck+test+build）
```

产物验证（**必须做**——`noEmitOnError` 只能挡类型错误，挡不住漏配 `rewriteRelativeImportExtensions`）：

```sh
# Linux/macOS / git-bash：产物里不允许残留 './x.ts' 相对导入
grep -rE "from './[^']+\.ts'" lib/ || echo "OK: 产物无 .ts 残留"

# Windows PowerShell 等价写法：
# if (Get-ChildItem lib -Recurse -Filter *.js | Select-String -Pattern "from '\./[^']+\.ts'") { throw "产物含 .ts 导入" } else { "OK: 产物无 .ts 残留" }
```

若产物 `lib/index.js` 里出现 `./impl.ts`，运行时 ESM 加载直接崩（`ERR_MODULE_NOT_FOUND`）——这是历史插件里最贵的一类 bug。

---

## 6. 挂载与验证

### 6.1 安装进 profile

```sh
# 开发期：link 源码目录（改完源码重构建即生效，无需重新 add）
dsh plugin --profile web add ./dsh-tool-b64
# 一次性任务要单独装到 headless（web/headless 是不同 profile！）
dsh plugin --profile headless add ./dsh-tool-b64

# 交付验证：装 tarball
# dsh plugin --profile compat add ./dsh-tool-b64-0.1.0.tgz
```

`dsh plugin` 的机制（源码核对）：它是 **pnpm 转发器**——先 `pnpm add`（cwd = profile 目录，相对路径先锚定到你的调用目录，Windows 用正斜杠 `C:/...`），成功后**按已安装状态 reconcile** `dsh.profile.bundles`：声明了 `dsh.bundle` 的依赖进层列表，移除的依赖出层列表。所以它需要 pnpm 在 PATH。profile 不存在时会自动初始化（内置模板或 `dsh-base`）。

### 6.2 验证挂载

```sh
dsh --profile web --dump-config | grep tool-b64
# 期望输出（# == 开头的注释行 + 你的工具行）：
# # == dsh-tool-b64
#   - id: tool-b64
#     name: dsh-tool-b64
```

`--dump-config` 打印"bundle 层 + profile 层 + 家级层 + --patch 层"合成后的完整树并退出；`--dump-default-config` 只打印 bundle 层。两者都不会真的启动 Agent。

### 6.3 端到端验证

```sh
# 一次性任务（当前版本的正确形态；旧快照的 dsh run 子命令已移除）
dsh --profile headless "用 b64 工具把字符串 hello world 编码成 base64"

# 交互式：起 web UI，打开 http://127.0.0.1:3080 对话里说
dsh web        # dsh web == dsh --profile web
```

headless 任务输出最后一条助手消息，退出码 0 = `completed`。web profile 没有一次性任务入口（会报错）——任务只走 headless。

### 6.4 热替换（HMR）

编辑 profile 的 `cordis.patch.yml`（或家级 patch）会被 watch 并**事务性重放**：框架卸载旧插件实例、加载新的。因为所有注册都是 effect 且自动清理，替换后不残留旧注册。改插件源码 → 重构建 → 重启进程生效（link 依赖不需要重新 add）。

### 6.5 卸载

```sh
dsh plugin --profile web remove dsh-tool-b64     # 同时移除依赖与层
```

---

## 7. defineTool 契约速查（照抄前先读这节）

### 7.1 parameters：参数 schema DSL

`parameters` 是一个对象，**隐式根是 open 的**；每个属性的 schema 里用 `required: true` 标记必填：

| type | 可用关键字 | 说明 |
|---|---|---|
| `string` | `enum?`, `const?` | 枚举/常量 |
| `number` / `integer` | `enum?`, `const?` | 数值 |
| `boolean` | `const?` | 布尔 |
| `null` | — | null |
| `array` | `items` | 元素 schema |
| `object` | `properties`, **`additionalProperties`（必填）** | 显式 object 节点必须声明 additionalProperties |
| `json` | — | 任意 JSON 值 |
| 联合 | `oneOf: [A, B, ...]` | 恰好匹配其一 |
| 通用注解 | `description`, `title`, `default`, `examples` | `default` 仅文档作用，不参与填充 |

**`args` 自动校验**：模型生成的参数在 `execute` 之前被 `defineTool` 按 schema 校验（类型、required、enum/const、oneOf、嵌套值），失败抛 `ToolArgsError`（code `INVALID_ARGS`）。所以 `execute` 里的 `args` 类型完整可信。但 DSL 表达不了的约束（非空串、正数、跨字段规则）要**在 execute 里自查**。

### 7.2 output：规范值 + 渲染

`output.schema` 声明**规范 JSON 值**（可 object/array/scalar/null 根）；`execute` 只返回这个规范值；`output.render(args, value)` 把它投影成给模型看的 `ContentBlock[]`。

**三种实测输出模式**（按返回形状选，别硬抄）：

| 模式 | output.schema | render | 适用 |
|---|---|---|---|
| A. JSON 文本字符串 | `{ type: 'string' }` | `(_a, v) => [{ type: 'text', text: v }]`（v 已是 JSON 字符串） | 多 action 返回形状统一成 JSON（csv/regex/markdown 等主流） |
| B. JSON 对象 | `{ type: 'json' }` | `JSON.stringify(v)` | 单 action 结构化结果（time/encoding/json） |
| C. 标量 | `{ type: 'number' }` | `String(v)` | 单值结果（calculator） |

选择原则：多 action 且统一 JSON → A（模型消费等价、实现测试最简单）；单值/单 action → B/C 更直接。

### 7.3 execute 契约（坑最多的地方）

- **签名**：`execute(args, exec): Promise<规范值>`。`args` 已校验、只读；`exec` 是执行身份对象，**`exec.signal` 是取消信号**（`AbortSignal`，做 IO 时传下去），`exec.agent` 可用于异步注入下一条模型消息。
- **抛错 = isError 结果，不是 reject**：管道把 execute 的 throw 捕获归一化为 `{ isError: true, content: [{ type: 'text', text: 'Error: <message>' }] }`，**`ctx.tools.execute()` 永不因工具体错误 reject**。驱动测试断言按 content 文本核对。基础设施失败用 throw；业务上的"非理想状态"（如进程退出码非零）放进规范值里表达。
- **只返回规范值**：不要从 execute 返回 content block，不要让调用方从散文里解析 id/字段——可编程的字段都进规范值，人类解释放 render。
- **注册是 effect**：`register()` 返回精确 disposer；插件卸载自动反注册。工具名全局唯一，同层重名注册失败；`run_code` 是保留名。
- **只有 name/description/parameters 发给模型**；`timeoutMs` 永不进模型上下文。

### 7.4 timeoutMs：协作式超时

`timeoutMs` 是**协作式**预算（由 `dsh-tool-call-timeout-policy` 强制执行）：只能取消"让出事件循环"的异步体。灾难性回溯（如 `(a+)+$` + 40KB）会占死事件循环，timeoutMs 救不了。需要**硬超时**就把同步执行放进可终止的 worker：

```ts
const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)
new Worker(workerUrl)   // 预算到期 worker.terminate()，报 '<tool>: execution timed out'
```

### 7.5 可选字段一览

| 字段 | 用途 |
|---|---|
| `timeoutMs?` | 协作式超时预算（正数） |
| `isConcurrencySafe?(args)` | 声明并发安全 |
| `finalizeContent?(exec, result)` | 同步的最后一步内容变换 |
| `presentationMeta?(args, value)` | 从规范值派生可回放的持久化卡片数据 |
| `presentCall?(args)` | 挂起态 UI 卡片（`{ card: 'generic' \| 'terminal' \| 'diff', ... }`） |
| `presentResult?(args, result)` | 完成态 UI 卡片（generic/terminal/diff/search/web） |

UI 卡片硬规则：presenter 是 `args`（+结果）的**纯函数**（无 IO、无时钟/随机）——它们会在流式**和会话日志回放**时执行。没写 presenter 的工具有通用卡片兜底。工具绝不 import UI/传输层类型。

---

## 8. 常用进阶

### 8.1 让插件接受配置（Config）

不要硬编码可调值。导出 `Config` 接口 + 同名 Schemastery schema，默认值写 schema 里；Cordis 加载时校验并填默认值：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)   // 用户值或 schema 默认值
}
```

不要导出普通对象当 Config——它不满足 Standard Schema 接口。用户在 patch 行里给 `config:` 键传值（见 §1.4：整值替换）。变更 config 触发 HMR 热替换。

### 8.2 插件三种形态

```ts
// 1. 函数（默认推荐）：命名导出 name / inject / apply，无 default export
// 2. 对象：
import type { Context } from '@deepseek-ai/cordis'
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}
// 3. 类（要向其他插件暴露服务时）：extends Service，static inject
import { Service, type Context } from '@deepseek-ai/cordis'
export default class MyService extends Service {
  static inject = ['tools']
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

### 8.3 手动清理资源（ctx.effect）

通过 `ctx` 注册的一切（事件、工具、定时器）自动清理；外部资源（网络连接等）用 `ctx.effect`：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('heartbeat'), 5000)
    return () => clearInterval(timer)   // 插件卸载时运行
  })
}
```

### 8.4 事件钩子（tools 管道扩展点）

| 事件 | 时机 | 模式 |
|---|---|---|
| `tools/pre-execute` | 派发前 allow/deny/ask 策略 | waterfall，**必须调 `next()`**，不调 = 短路链 |
| `tools/execute` | 包裹派发（加 deadline/重试/指标） | waterfall |
| `tools/post-execute` | 替换展示内容/返回值或阻止结果 | waterfall |
| `tools/result` | 观察不可变的归一化结果 | emit |

Waterfall 语义：每个监听器收到 `(payload, next)`，返回但不调 `next()` 会短路整条链。部署策略类逻辑优先做进 `tools/pre-execute` 而不是写死在工具里。

### 8.5 注入其他服务

`inject: ['tools', 'sessions', 'llm', ...]` 声明依赖后，框架保证就绪才调 `apply`，`ctx.<service>` 可直接用。完整服务清单查仓库的 `docs/subsystems/`。

---

## 9. 测试策略（三层）

1. **契约测试**（`register.spec.ts`，§4.7）：零依赖，验证 cordis 契约 + 工具定义形状 + **每个 action 的 execute 正常/错误路径** + render 输出。有副作用/多工具的插件额外验证 disposer 可逆、失败回滚。
2. **逻辑测试**（`impl.spec.ts`，§4.8）：纯逻辑逐边界用例（畸形输入、超限、空值……）。
3. **真实管道直调（tool-driver）**：绕过 LLM 直接打真实执行管道——与官方工具测试同构的最小服务栈：

```ts
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'          // default export = ToolRuntime (extends Service)
import { apply } from '../src/index.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt)          // ToolRuntime 依赖 systemPrompt 服务
await ctx.plugin(ToolRegistry)
await ctx.plugin({ apply })

const signal = new AbortController().signal
const result = await ctx.tools.execute({ callId: 'c1', name: 'b64', arguments: { action: 'encode', text: 'hi' }, signal })
// result: { isError, value, content: ContentBlock[] }
// 断言 content 文本（错误是 'Error: b64: ...'，不是 reject）
```

覆盖正常路径全 actions + 错误路径全分支 + 输入上限；配合 `dsh --profile headless "任务"` 做真实 LLM 端到端。注意：driver 经 `lib/` 加载时改完源码要先重建（见 §12 坑 14）。

隐私红线（诊断类工具读真实会话数据时）：真实文件只做手动差分（`it.skipIf`/opt-in 环境变量），不提交、不打日志、只读（前后 hash 校验字节不变）；正向单测用程序生成的最小 fixture。

---

## 10. 发布与交付

### 10.1 三种交付通道

| 通道 | 做法 | 适用 |
|---|---|---|
| **npm publish**（推荐） | `pnpm publish`/`npm publish` 时 `lib/` 已构建好；用户 `dsh plugin --profile X add your-package` 装预构建代码 | 公开发布 |
| **tarball** | `npm pack` → `dsh plugin add ./pkg-0.1.0.tgz` | 内部交付/验证 |
| **git 安装** | `dsh plugin add github:you/plugin#<sha>` | 私有分发（见下） |

git 安装的坑：git 安装拉的是**源码且不跑 build**。作者必须提供自包含的 `prepare` 脚本（pnpm 在 git 安装后运行它）；用户还需在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds: { your-package: true }` 授权（pnpm ≥10 默认阻止）。该授权意味着"允许该包代码在安装时于你机器上执行"——建议锁 commit。**能 npm/pack 就别 git**。

### 10.2 npm token 纪律

NPM_TOKEN 是只读临时令牌：只放环境变量或临时 userconfig，**绝不写入项目 `.npmrc`/提交/日志**。无发布权限时不要执行 `npm publish`，交付形态 = 公开仓库 + tarball + profile bundle 安装。

### 10.3 建仓注意（历史铁律）

- 组织仓库**默认 private**：`gh repo create --public` 可能被组织策略覆盖——建仓后显式 `gh repo view <org>/<repo> --json visibility` 确认；公开需要针对具体仓库的显式授权。
- 建仓/改可见性/hub 写入/commit/push 等**外部写操作默认只生成计划，执行前显式授权**；不把历史任务的授权延伸到新仓库。

### 10.4 README 内容清单（发布前必写）

按官方 Profile Bundle 生态方向，安装章节固定顺序：

1. **Profile Bundle（推荐）**：`dsh plugin --profile web add "C:/path/to/plugin"`（需要一次性任务再加 headless）；
2. **验证安装**：`dsh --profile web --dump-config | grep <row-id>`；
3. **运行验证**：`dsh --profile headless "用 <工具> 完成最小任务"`；
4. actions 表格 + 示例 + 边界说明（描述里写清楚：参数记入会话日志、敏感输入警告）；
5. 测试数标注（质量信号）；
6. 手动安装/旧版本兼容只作附录（不能作为默认安装流程）。

合规红线：row id 避开官方核心行（`tools`/`session`/`llm`/`web`/`permission`）；插件不通过替换官方入口获取能力；description ≤ 80 字符（hub 表格截断）。

---

## 11. 形态选型矩阵（速查）

| 需求 | 形态 | 关键文件 |
|---|---|---|
| 工具/服务/Web UI 运行时逻辑，随 profile 启动 | **bundle** | package.json（`dsh.bundle.patch`）+ cordis.patch.yml |
| registry 面板生命周期、catalog 安装 | **registry** | `dsh.plugin.json`（可无 package.json，仅 `index.mjs`） |
| 纯提示词/流程 | **skill** | `SKILL.md`（frontmatter + references/） |
| 多同风格插件打包 | **collection** | `catalog.json`；meta 包 `apply` 依次调子包 `apply`（原子回滚） |
| 双通道（官方 bundle + registry 增量兼容） | 双形态并存 | 安装通道互斥，文档注明 |

---

## 12. 踩坑速查表（17 条，全部实测）

| # | 症状 | 根因 | 解决方案 |
|---|---|---|---|
| 1 | `Property 'tools' does not exist on type 'Context'` | **双 Cordis**：unscoped `cordis` 与 `@deepseek-ai/cordis` 是两个模块，dsh-tools 类型只增强 scoped | 全链 scoped：import/peer 统一 `@deepseek-ai/cordis`，绝不同时出现两种 |
| 2 | `TS5097: import path can only end with '.ts'` | tsconfig 缺 `allowImportingTsExtensions` | 补上 + `rewriteRelativeImportExtensions` |
| 3 | 产物 `lib/index.js` 里还是 `./x.ts`，启动 `ERR_MODULE_NOT_FOUND` | 缺 `rewriteRelativeImportExtensions` | 重建并验证产物（§5） |
| 4 | `tsc` 报错却生成了坏产物 | `noEmitOnError` 默认 false，报错仍 emit | tsconfig 开 `noEmitOnError: true`；构建失败即停 |
| 5 | `TS2591: Cannot find name 'Buffer'` | 缺 node types | `"types": ["node"]` + devDeps `@types/node`；不想引 types 就手写实现（如自写字节计数） |
| 6 | `dsh run` 报错/不存在 | 当前版本已移除 `run` 子命令（旧快照命令） | 一次性任务用 `dsh --profile headless "task"` |
| 7 | `dsh: profile web takes no task` | web profile 无一次性任务入口 | 任务只走 headless profile |
| 8 | `dsh plugin` 报 pnpm not found | pnpm 不在 PATH | 装 pnpm（`npm i -g pnpm` / corepack） |
| 9 | git 安装的插件跑不起来 | git 安装不跑 build | `prepare` 脚本 + 用户 `allowBuilds` 授权；优先 npm publish / npm pack |
| 10 | 改 config 某个键后其他键"丢了" | patch 是**整值替换**非深合并 | 覆盖行重述该行所有键 |
| 11 | `dsh plugin add` 后插件没出现 | 包没声明 `dsh.bundle.patch`（只会是普通依赖 + 警告） | package.json 补 `"dsh": { "bundle": { "patch": "..." } }` |
| 12 | 工具名冲突/注册失败 | 工具名全局唯一、同层重名失败；`run_code` 保留 | 起名带插件前缀；row id 避开 `tools/session/llm/web/permission` |
| 13 | execute 抛错但驱动"没 reject" | 管道把 throw 归一化为 `isError` 结果（content = `Error: <msg>`） | 按 content 文本断言，别按 reject 断言 |
| 14 | driver 直连测试结果"像没改过" | driver 经 package.json `main` 加载 lib，改了 src 没重建 | 改源码后先 `npm run build` 再跑 driver；单测（直 import src）不受影响 |
| 15 | timeoutMs 拦不住死循环 | 协作式超时，同步灾难回溯占死事件循环 | 可终止 worker（§7.4）+ `worker.terminate()` |
| 16 | vitest 报 `Tests no tests` | 盘符小写（`c:/...`）或路径问题 | 路径盘符大写 `C:/...`；Windows 路径统一正斜杠 |
| 17 | 诊断会话文件"只有 header" | dsh 会话是**多帧 zstd** 追加写入，单帧 API 只解第一帧 | 用 `scanZstdFrames` + 逐帧 decoder（导入路径 `@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts`） |

---

## 13. 交付前验证闭环（一条龙，逐条跑）

```sh
# 1. 类型零错误
npm run typecheck

# 2. 产物干净（无 .ts 残留；PowerShell 等价写法见 §5）
npm run build && grep -rE "from './[^']+\.ts'" lib/ || echo "OK: 产物无 .ts 残留"

# 3. 可发布产物
npm pack          # prepack 已串联 typecheck+test+build；检查 tarball exports 指向存在

# 4. 已挂载（对 rc.1 consumer；web/headless 分开装）
dsh plugin --profile web add ./dsh-tool-b64-0.1.0.tgz
dsh plugin --profile headless add ./dsh-tool-b64-0.1.0.tgz
dsh --profile headless --dump-config | grep tool-b64

# 5. 端到端真实执行（一次性任务走 headless profile；自定义 profile 默认只有 dsh-base，
#    不含任务能力，所以 e2e 直接用 headless）
dsh --profile headless "用 b64 工具把 opencode 编码成 base64"

# 6. 测试全过
npm test
```

全部通过后：README 按 §10.4 清单补齐 → code review 一轮 → 授权后提交推送 → 确认仓库可见性。

---

## 14. 命令速查卡

```sh
# 启动
dsh web                                          # == dsh --profile web，UI 在 http://127.0.0.1:3080
dsh --profile headless "任务"                    # 一次性任务，exit 0 = completed
dsh --profile <name> --dump-config               # 打印合成配置树（不启动 Agent）
dsh --profile <name> --dump-default-config       # 只打印 bundle 层

# 插件管理（pnpm 转发器，需要 pnpm 在 PATH）
dsh plugin --profile <name> add <path|pkg|tgz>   # 安装；声明 dsh.bundle 的依赖自动进层列表
dsh plugin --profile <name> remove <pkg>         # 卸载（同时移除层）
dsh plugin --profile <name> update <pkg>         # 更新（新版本获得 dsh.bundle 声明也会自动激活）

# 开发期临时覆盖（不改 profile）
dsh web --patch ./my-overlay.yml                 # 追加覆盖层；patch 文件是可插拔配置层

# 插件开发
npm install && npm run typecheck && npm test && npm run build && npm pack
```

## 参考链接

- 官方教程：[第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md) · [开发工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md) · [插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.zh.md) · [打包安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)
- 工具编写参考：[adding-a-tool](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md) · [cordis-primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)
- 本文件的事实源：deepseek-harness 仓库源码（`packages/core/tools/src/`、`packages/bundle/`、`apps/cli/src/`、`vendor/include/`、`vendor/loader/`）+ 9 个真实插件仓库（omdsh-dev/dsh-tool-*）的构建/测试/交付记录。
