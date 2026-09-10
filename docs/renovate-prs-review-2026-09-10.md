# Renovate 依赖 PR 检查记录（2026-09-10）

> 触发：Renovate bot 一次提了 5 个依赖升级 PR（#15/#16/#19/#20/#24）。本文记录逐 PR 核查结果、合并冲突推演、配置缺口与推荐处置。核查全部基于本机实测（npm 产物对比 + 临时 worktree 全链路验证），不是猜测。

## PR 清单与结论

| PR | 内容 | 结论 | 依据 |
|---|---|---|---|
| #24 | `@types/node` → 24.13.4 | ✅ 可直合 | 仅锁文件改动（范围仍 `^24` 未变），与 CI 基线（node 24）一致 |
| #19 | `dsh-cmdline` → `^0.1.5-rc.1` | ✅ 可直合 | **运行时依赖**（`parseCmdline`），但 0.1.2-rc.1 vs 0.1.5-rc.1 的 npm 产物 `lib/` **逐字节一致**（仅 package.json/README 版本号变化）→ 零运行时风险 |
| #20 | `dsh-host-webserver` → `^0.1.5-rc.1` | ✅ 可直合 | 纯类型导入（`import type { WebServer, WebRoute, WebUpgradeRoute }`），类型产物两版本完全一致 |
| #16 | `dsh-client-ui-slots` → `^0.1.5-rc.1` | ✅ 可直合 | 仅类型声明**纯增量**：新增空 `ResourceProtocolMap` 合并接口，与 `PropsRuntime<'settings.section'>` 用法无关 |
| #15 | `dsh-client-ui-settings` → `^0.1.5-rc.1` | ✅ 可直合 | 产物完全一致（含 client 契约类型） |

## 合并态全链路验证（临时 worktree，非推送）

依序合并 5 个 PR + 手动补 `dsh-host-webserver`/`dsh-client-ui-slots`/`dsh-client-ui-settings` 的版本 bump（三者锁文件与先合并的 PR 冲突，见下节），`npm install` 重生成锁文件后：

- `npm run typecheck` ✅（tsc --noEmit 零错误）
- `npm test` ✅（93/93 通过）
- `npm run build` ✅（tsc + tsdown 均成功）

**运行时影响**：无。`dsh-cmdline` 产物一致（唯一运行时变更），`dsh_sid` 补签依赖的 `dsh-credentials` 未动。

## 合并冲突推演（重要）

- **两两 `git merge-tree --write-tree` 全部干净**（各 PR 只动 package.json 不同行 + 锁文件不同区域）；
- **但依序合并时锁文件冲突**：`#24 → #19` 干净，`#20` 起在 `package-lock.json` 冲突（与前次实测一致——多个依赖 PR 的锁文件区域在合并历史推进后互相重叠）。
- **处置**：按 AGENTS.md 既有经验——干净的直接 GitHub 合，冲突的本地手动 bump 版本 + `npm install` 重生成锁文件后一并推送。

## 发现的问题：Renovate 配置缺口

`renovate.json` 的 `matchPackageNames` 是**封闭清单**，漏了 `@deepseek-ai/dsh-credentials`：

- `dsh-credentials` 是**运行时依赖**（`src/auth.ts` 里 `credentialKey('client-connection','browser-session')` 读原生 cookie 密钥），其 `latest` dist-tag 是占位版本 `0.0.1-rc.1`、真版本在 `next`（`0.1.5-rc.1`）；
- 不在清单里 → Renovate 按默认规则看 `latest`（0.0.1-rc.1 < 当前 0.1.2-rc.1）→ **永不提 PR**（Dashboard #9 证实：dsh-credentials 行无 "Updates:" 箭头）；
- 后果：合并这批 PR 后它会**独留 `^0.1.2-rc.1`**，与其余 `@deepseek-ai/*` 形成版本偏斜。

**修复**：在 `matchPackageNames` 数组里补 `"@deepseek-ai/dsh-credentials"`（并考虑把 dsh-credentials 手动 bump 到 `^0.1.5-rc.1` 一起合，消除偏斜——`npm view` 确认其 `next` = `0.1.5-rc.1`）。

## 推荐处置

方案 A（推荐）：`#24`/`#19` GitHub 直合 → 本地依序合剩余三个 + 手动补 `dsh-credentials` bump + `npm install` 重生成锁 → 补 renovate.json 清单 → 全链路复核 → 推送。

方案 B：只合 `#24`，其余等 dsh-credentials 的 PR——不可行（配置缺口导致该 PR 不会出现）。

> 相关：dsh 0.1.5-rc.1 与本插件适配性检查见 `docs/upgrade-dsh-0.1.5-playbook.md`。
