# Stapleport SelfSweep

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Stapleport/Stapleport_SelfSweep)

**[English](#english) | [中文](#中文)**

An unattended auto-collection (sweep) worker for Stapleport merchants: it watches your payment channels on a schedule, and sweeps balances to your treasury once a per-token threshold is met — using **only the Imputations contract**. Your key, your worker: no Stapleport API, no backend, no database.

Where the official product has an executor sweep for you, SelfSweep lets you be your own executor with one Cloudflare Worker on the free tier.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Stapleport/Stapleport_SelfSweep)

**One click deploys the worker** to your Cloudflare account (free tier). It then idles safely until you configure three things — treasury, channel range, thresholds — and add one secret (the sweep key). Start with `DRY_RUN=true`, read the logs, then flip it off.

---

<a id="english"></a>

## English

### Highlights

- **Self-custodial signer** — the private key lives in a Cloudflare secret and only ever appears in worker memory; it signs `imputationall` calls and nothing else. Funds only ever move from your channels to your treasury.
- **Threshold-based auto sweep** — multi-token, multi-channel, packed into **one** `imputationall` transaction per tick; real-calldata `eth_estimateGas` pre-check rejects would-revert transactions before they cost you gas.
- **Fee-aware** — fee rates are read from the contract's `systeminfo()` every tick (never hardcoded), with a conservative profit pre-check for native-coin groups.
- **Arrival monitor + webhook** (optional) — bind a KV namespace and every fresh deposit is detected (monotonic `received` baseline diff) and pushed to your webhook, along with sweep sent/confirmed/failed events.
- **Stateless core** — no KV needed for sweeping: a failed transaction simply retries next tick. Zero bindings deploy and work.
- **Zero public surface** — `workers_dev: false`, no inbound routes at all; the only trigger is the cron schedule.
- **Channel model identical to the web app** — channels are `secret-6-digit-number` orders (path = `keccak256`), the exact same convention as the Stapleport web frontend.

### How it works (each tick)

1. **Monitor** *(optional, needs KV)* — batch-read `gettokensreceiveds` for all channels × tokens; diff against the stored baseline (`received = balance + paid_total`, monotonic) → arrival events → webhook.
2. **Decide** — for each token with a configured threshold: if the total in-channel balance ≥ threshold, the token qualifies; only paths with a positive balance are included.
3. **Sweep** — read fee rates from `systeminfo()` → build one multi-token `imputationall` → `eth_gasPrice` + real-calldata `eth_estimateGas` (reverts are caught here) → native-coin profit check (net ≥ gas×price×1.2) → hot-wallet reserve check → sign locally → `eth_sendRawTransaction`.
4. **Confirm** *(optional)* — next tick polls the receipt; success/failure is pushed to your webhook once.

### The economics — read this first

- **Whose contract you point at decides where the 3% goes.** `imputationall` deducts three fees from the swept amount: owner 0.5% + helper 1.5% + affiliate 1% (3% total).
  - **Official Imputations contract**: the 3% goes to the protocol. You net 97% − gas. Zero deployment effort, and while the contract's free-quota window is open (fewer than 5 lifetime collects **and** fewer than 30 lifetime paid channels) **all fees are waived**.
  - **Your own Imputations deployment** (you are the owner): all 3% flows back to you — net cost is gas only. Deploy via `ImputationsBatchDeployer` (two transactions) or the hardhat scripts in `Stapleport_hardhat/scripts/Imputations/`. SelfSweep doesn't care: point `IMPUTATIONS_<chainId>` at whichever address; rates are read live per tick.
- **Native coin is already automatic.** Once a channel is activated (first sweep registers it), every native-coin arrival is split 97/3 on the spot by the wallet contract's `receive()` hook — activated native channels always sit at zero. SelfSweep's real value is **ERC20** (which waits for a sweep), **timing** (thresholds amortize gas) and **notifications**.
- **Affiliate 1%**: unbound affiliates are pinned to "share goes to owner" on first collect. On the official contract that 1% goes to the protocol anyway; on your own deployment it comes back to you — nothing to configure.
- **Monitoring is poll-based.** The contract emits no Deposit event (only the opt-in `CollectEventMode` mode and LongSystemLog entries). The official API polls balances too.

### Quick Start

```bash
# 1. Install
npm install

# 2. Generate a dedicated hot-wallet key (gas money only — never your main funds)
openssl rand -hex 32   # prefix with 0x

# 3. Configure (see Configuration below), then set the key
npx wrangler login     # first time only
npx wrangler secret put SWEEP_PRIVATE_KEY

# 4. First deploy with DRY_RUN=true (edit wrangler.jsonc vars), watch the logs
npm run deploy

# 5. Satisfied? set DRY_RUN="false" and deploy again
```

You can watch runs in the Cloudflare dashboard (Workers → Logs) or via `wrangler tail`.

### Configuration

Everything lives in `wrangler.jsonc` vars (public, non-sensitive) + one secret. All parsers fall back on empty strings (the Cloudflare dashboard loves to save vars as `""`).

| Variable | Required | Description |
|---|---|---|
| `SWEEP_PRIVATE_KEY` | ✅ secret | Hot-wallet private key. Signs sweep transactions only, exists only in memory at runtime. `wrangler secret put SWEEP_PRIVATE_KEY` |
| `TREASURY` | ✅ | Treasury address (the owner of the channels; swept funds land here) |
| `CHAIN_IDS` | ✅ | Comma-separated chainIds, e.g. `"56,7156777"` |
| `CHANNEL_SECRET` / `CHANNEL_FROM` / `CHANNEL_TO` | pick one | Channel range: order = `secret-6-digit-number`, identical to the web app's "secret-number" channels |
| `CHANNEL_ORDERS` | pick one | Explicit full order names, comma-separated; takes precedence over the range |
| `MIN_SWEEP` | | JSON: token → human-readable threshold. `"native"` = native coin, other keys = ERC20 addresses (decimals are read from the chain at runtime). **Only tokens with a threshold are swept.** Default `{"native":"0.01"}` |
| `GAS_BUFFER_X10` | | Profit safety margin ×N/10 (default 12 = ×1.2). Applies to groups containing native coin |
| `MAX_TX_PER_TICK` | | Max broadcasts per chain per tick (default 1 — one multi-token pack is plenty) |
| `TICK_LOCK_SECONDS` | | In-memory tick lock (default 55s) |
| `DRY_RUN` | | `true` = log what would be broadcast, send nothing. **Run this first** |
| `WEBHOOK_URL` | | Optional notification webhook (see Notifications) |
| `RPC_URL_<chainId>` | | Override the RPC of that chain (required for chains not in the registry) |
| `IMPUTATIONS_<chainId>` | | Override that chain's Imputations address (your own deployment / non-registry chains) |

Default chain metadata (rpc/Imputations addresses) comes from `registry.json`, the same artifact other Stapleport components sync from `Stapleport_hardhat/deployments/all.json`. Your own deployments join via the two override variables — no need to touch the registry.

**KV (optional).** Default is commented out = fully stateless mode; sweeping works, you just don't get arrival notifications. To enable: `wrangler kv namespace create STATE`, put the returned id into `kv_namespaces` in `wrangler.jsonc`, redeploy.

### Notifications

With `WEBHOOK_URL` set, the worker POSTs JSON `{ "source": "stapleport-selfsweep", "at": ..., ...event }`:

| event | meaning | needs KV |
|---|---|---|
| `arrival` | fresh deposit detected on a channel (fields: `channel`, `token`, `delta`, `received`) | yes |
| `sweep_sent` | sweep transaction broadcast (`tx`, `tokens`, `paths`) | no |
| `sweep_confirmed` | receipt status = success | no |
| `sweep_failed` | receipt status = failure | no |
| `sweep_unconfirmed` | still no receipt after 24h | no |

Notification failures are logged and never affect sweeping.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in your config (gitignored)
npm run dev                      # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # trigger one tick
curl http://localhost:8787/health                         # runtime status
npm test                         # unit tests (config parsing, pure functions)
```

Full-loop against a local chain: start a hardhat node and deploy Imputations from `Stapleport_hardhat`, then point `.dev.vars` at it (`CHAIN_IDS=31337` + `RPC_URL_31337` + `IMPUTATIONS_31337`). `scripts/dev-setup.mjs <imputations> <treasury> [ETH]` funds the well-known test key via `hardhat_setBalance` and pays a channel. Note `wrangler dev` does **not** hot-reload `.dev.vars` — restart to apply config changes.

### Project Structure

```
├── src/
│   ├── worker.js          # entry: cron → tick; GET /health (local dev only)
│   ├── config.js          # env → config (pure functions, empty-string tolerant)
│   ├── monitor.js         # optional KV baseline-diff arrival detection
│   ├── sweep.js           # balance → threshold → prechecks → sign → broadcast
│   ├── notify.js          # optional webhook (never blocks sweeping)
│   └── lib/
│       ├── tx.js          # Imputations calldata encoding + read calls
│       ├── rpc.js         # JSON-RPC fetch wrapper (the only sendRawTransaction caller)
│       └── imputations.js # pure helpers: order→path, arg building, decode (same as the web app)
├── registry.json          # chain registry (synced from Stapleport_hardhat deployments)
├── scripts/dev-setup.mjs  # local E2E helper: fund test key + pay a channel
├── test/config.test.mjs   # unit tests (node --test)
└── wrangler.jsonc         # Cloudflare Workers config (all public vars)
```

### Security notes

- **Key discipline**: `SWEEP_PRIVATE_KEY` is a hot wallet — dedicated address, gas money only, keep ≥ `gas × 3` (`WALLET_GAS_RESERVE_X`), sweep excess out regularly. It signs `imputationall` calls and should never hold your main funds.
- **Never put the key in vars** (wrangler.jsonc / dashboard env vars). Secret or `.dev.vars` (gitignored) only.
- Don't set thresholds too low: every sweep costs real gas; a threshold should cover several times the gas cost.
- A workerd restart drops the in-memory pending-receipt table — you lose a notification, never funds (chain state decides; unswept balances retry next tick).

### Free-tier Notes

- One Worker on cron: well within the free tier (workers-free cron CPU is fine for sign-and-broadcast; the fee rates read + batch balance read are 2–3 subrequests per chain per tick).
- Free KV has a daily write limit; the baseline is at most one write per chain per tick and only when something changed.
- `TICK_LOCK_SECONDS` guards against overlapping ticks within one isolate; cross-isolate overlap is tolerated by design (worst case: a duplicate sweep attempt that finds an empty channel and does nothing).

---

<a id="中文"></a>

## 中文

一个给 Stapleport 商户用的无人值守自动归集 Worker：定时盯住你的收款通道，达到按币种设定的阈值就自动把余额归集到国库——**只用 Imputations 合约**。私钥在你手里、Worker 在你账号里：不依赖 Stapleport API、没有后端、没有数据库。

官方产品里「托管执行者替你按归集按钮」，SelfSweep 让你用自己的一个免费版 Cloudflare Worker 当自己的执行者。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Stapleport/Stapleport_SelfSweep)

**一键把 Worker 部署到你的 Cloudflare 账号（免费版即可）。** 部署后它会安全空转，直到你配好三件事——国库、通道号段、阈值——并写入一把密钥（归集私钥）。先用 `DRY_RUN=true` 跑几轮看日志，确认无误再关掉。

### 特性

- **自托管签名核**：私钥只存于 Cloudflare secret、只在运行时内存出现；只签 `imputationall` 调用，资金路径只有「你的通道 → 你的国库」。
- **阈值自动归集**：多币种、多通道打包成**一笔** `imputationall`；真实 calldata 估 gas 预检，会 revert 的交易在花钱之前就被拦下。
- **费率感知**：每 tick 现读合约 `systeminfo()`，绝不写死费率；原生币组带保守盈利预检。
- **到账监控 + webhook**（可选）：绑定 KV 后，新到账（`received` 只增不减口径做基线差）即时推送 webhook，归集的发送/成功/失败也有事件。
- **核心无状态**：归集不依赖 KV——失败的交易下一 tick 自动重试；零绑定即可部署运行。
- **零公网面**：`workers_dev: false`、没有任何入站路由，唯一触发方式是 cron。
- **通道模型与网页完全一致**：通道 = `密语-6位编号`（path = keccak256），与 Stapleport 网页端同一套约定。

### 每个 tick 做什么

1. **监控**（可选，需 KV）：批量读 `gettokensreceiveds`（所有通道 × 币种），与基线做差（`received = balance + paid_total`，只增不减）→ 到账事件 → webhook。
2. **判定**：配了阈值的币种，通道在场余额合计 ≥ 阈值即入选；只收余额 > 0 的通道。
3. **归集**：现读费率 → 构建一笔多币种 `imputationall` → `eth_gasPrice` + 真实 calldata 估 gas（revert 在这里被拦）→ 原生币盈利检查（净额 ≥ gas×价格×1.2）→ 热钱包余量检查 → 本地签名 → `eth_sendRawTransaction`。
4. **确认**（可选）：下一 tick 查回执，成功/失败各推送一次 webhook。

### 经济账 —— 务必先读

- **指向谁的合约，决定 3% 归谁。** `imputationall` 从扫入额里扣三笔费：owner 0.5% + helper 1.5% + affiliate 1%（合计 3%）。
  - **官方 Imputations 合约**：3% 归协议方，你净得 97% − gas。零部署成本，且合约的**免费额度**窗口内（累计归集 < 5 次**且**累计付费通道 < 30 笔）三费全免。
  - **自己部署的 Imputations**（owner = 你）：3% 全部回流自己，净成本只剩 gas。可用 `ImputationsBatchDeployer`（两笔交易）或 `Stapleport_hardhat/scripts/Imputations/` 的脚本部署。SelfSweep 不关心你指向谁：`IMPUTATIONS_<chainId>` 填哪个地址就按谁的走，费率每 tick 现读。
- **原生币其实已经自动了。** 通道首次归集即被合约登记激活，此后原生币到账会被钱包合约的 `receive()` 钩子当场 97/3 分发（激活通道的原生币余额恒为 0）。SelfSweep 的主战场是 **ERC20**（趴账等归集）、**归集时机**（阈值摊薄 gas）和**到账通知**。
- **affiliate 1%**：不绑推荐人时，首次归集会把这 1% 固化为「归 owner」。官方合约下这 1% 本来就归协议方；自部署下它回流你自己——无需任何配置。
- **监控只能轮询**：合约没有 Deposit 事件（只有可选的 `CollectEventMode` 事件模式和 LongSystemLog 链上日志），官方 API 同样选择轮询余额。

### 快速开始

```bash
# 1. 安装
npm install

# 2. 生成专用热钱包私钥（只放 gas，绝不放主资产）
openssl rand -hex 32   # 前面加 0x

# 3. 配置（见下文配置表），然后写入密钥
npx wrangler login     # 首次登录
npx wrangler secret put SWEEP_PRIVATE_KEY

# 4. 首次部署保持 DRY_RUN=true（改 wrangler.jsonc vars），看日志
npm run deploy

# 5. 确认无误后改 DRY_RUN="false" 再部署一次
```

日志在 Cloudflare 后台（Workers → Logs）看，或 `wrangler tail`。

### 配置

全部配置在 `wrangler.jsonc` vars（公开非敏感）+ 一把 secret。所有解析对空串回落（CF 面板很容易把 var 存成空串）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `SWEEP_PRIVATE_KEY` | ✅（secret） | 热钱包私钥。只签名归集交易，只在运行时内存出现。`wrangler secret put SWEEP_PRIVATE_KEY` |
| `TREASURY` | ✅ | 国库地址（通道归属者，归集资金最终回到这里） |
| `CHAIN_IDS` | ✅ | 逗号分隔 chainId，如 `"56,7156777"` |
| `CHANNEL_SECRET` / `CHANNEL_FROM` / `CHANNEL_TO` | 二选一 | 通道号段：order = `密语-6位补零编号`，与网页「密语-编号」完全一致 |
| `CHANNEL_ORDERS` | 二选一 | 显式列通道全名（逗号分隔），优先于号段 |
| `MIN_SWEEP` | | JSON：token → 人类可读阈值。`"native"` 表示原生币，其余键为 ERC20 地址（decimals 运行时从链上读）。**给谁设了阈值才归集谁**。默认 `{"native":"0.01"}` |
| `GAS_BUFFER_X10` | | 盈利安全边际 ×N/10（默认 12 = ×1.2），只作用于含原生币的归集组 |
| `MAX_TX_PER_TICK` | | 每 tick 每链最多几笔（默认 1，一笔多币种打包够用） |
| `TICK_LOCK_SECONDS` | | tick 内存锁（默认 55s） |
| `DRY_RUN` | | `true` = 只打印将发的交易不广播。**上线前必跑** |
| `WEBHOOK_URL` | | 可选通知 webhook（见下文通知事件） |
| `RPC_URL_<chainId>` | | 覆盖该链 RPC（registry 外的链必填） |
| `IMPUTATIONS_<chainId>` | | 覆盖该链 Imputations 地址（自部署合约 / registry 外的链必填） |

链的默认 rpc / Imputations 地址来自 `registry.json`（与其他 Stapleport 组件一样同步自 `Stapleport_hardhat/deployments/all.json`）。自部署合约或新链用两个覆盖变量接入，不必改 registry。

**KV（可选）**：默认注释掉 = 纯无状态模式，归集照常工作，只是没有到账通知。启用：`wrangler kv namespace create STATE`，把返回的 id 填进 `wrangler.jsonc` 的 `kv_namespaces` 再部署。

### 通知事件

配了 `WEBHOOK_URL` 后，Worker 会 POST JSON `{ "source": "stapleport-selfsweep", "at": ..., ...事件字段 }`：

| event | 含义 | 需要 KV |
|---|---|---|
| `arrival` | 通道发现新到账（字段：`channel`、`token`、`delta`、`received`） | 是 |
| `sweep_sent` | 归集交易已广播（`tx`、`tokens`、`paths`） | 否 |
| `sweep_confirmed` | 回执成功 | 否 |
| `sweep_failed` | 回执失败 | 否 |
| `sweep_unconfirmed` | 24 小时仍无回执 | 否 |

通知失败只记日志，绝不影响归集主流程。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填配置（已 gitignore）
npm run dev                      # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # 手动触发一轮
curl http://localhost:8787/health                         # 运行状态
npm test                         # 单测（配置解析与纯函数）
```

本地链全链路：起 hardhat 节点并从 `Stapleport_hardhat` 部署 Imputations，然后 `.dev.vars` 指向它（`CHAIN_IDS=31337` + `RPC_URL_31337` + `IMPUTATIONS_31337`）。`scripts/dev-setup.mjs <imputations> <treasury> [ETH]` 用 `hardhat_setBalance` 给公开测试私钥注资并向通道打款。注意 `wrangler dev` **不会**热加载 `.dev.vars`——改配置要重启。

### 项目结构

```
├── src/
│   ├── worker.js          # 入口：cron → tick；GET /health（仅本地 dev）
│   ├── config.js          # env → 配置（纯函数，空串回落）
│   ├── monitor.js         # 可选：KV 基线差到账检测
│   ├── sweep.js           # 余额 → 阈值 → 预检 → 签名 → 广播
│   ├── notify.js          # 可选 webhook（绝不阻塞归集）
│   └── lib/
│       ├── tx.js          # Imputations calldata 编码 + 只读调用
│       ├── rpc.js         # JSON-RPC 封装（全仓唯一 sendRawTransaction 调用方）
│       └── imputations.js # 纯函数：order→path、参数组装、解码（与网页端同款）
├── registry.json          # 链注册表（同步自 Stapleport_hardhat 部署产物）
├── scripts/dev-setup.mjs  # 本地 E2E：注资测试私钥 + 给通道打款
├── test/config.test.mjs   # 单测（node --test）
└── wrangler.jsonc         # Cloudflare Workers 配置（全部为公开 vars）
```

### 安全须知

- **私钥纪律**：`SWEEP_PRIVATE_KEY` 是热钱包——专用地址、只放 gas、余额留够 `gas × 3`（`WALLET_GAS_RESERVE_X` 可调）、多余的 gas 定期扫走。它只签 `imputationall`，绝不该持有你的主资产。
- **绝不把私钥放进 vars**（wrangler.jsonc / 面板环境变量）。只走 secret 或 `.dev.vars`（已 gitignore）。
- 阈值别配太低：每笔归集都是真实 gas，阈值至少要覆盖 gas 成本的几倍。
- workerd 重启会丢内存里的在途回执表——丢的是通知，不丢资金（资金由链上状态决定，未归集的余额下一 tick 还会再试）。

### 免费额度与限制

- 单 Worker + cron：免费版绰绰有余（每 tick 每链只需 2–3 个子请求：读费率 + 批量读余额 + 广播）。
- 免费 KV 有每日写入限额；基线快照每链每 tick 最多一次写，且只在有变化时写。
- `TICK_LOCK_SECONDS` 防同 isolate 重叠；跨 isolate 重叠在设计上可容忍（最坏情况：对已空通道重复发起一次归集，什么也扫不到）。

## License

MIT
