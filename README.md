# SweepPay_SelfSweep — 自托管归集 Worker

一个可独立部署的 Cloudflare Worker：**只用 Imputations 合约**，cron 自动完成「监控到账 → 阈值判定 → 归集 → 通知」。零后端依赖（不碰 SweepPay_API / Manager / Supabase），适合方案①（去中心化收款）商户想要「无人值守自动归集」的场景——相当于把自己通道的归集按钮交给一个只属于你的机器人。

> 同一套合约，差别只在谁替你按归集按钮。这个 Worker 的私钥在你自己手里。

## 它做什么

每个 cron tick（默认 5 分钟，可改每分钟）：

1. **监控到账**（可选）：批量读 `gettokensreceiveds`，与 KV 基线做差（`received = balance + paid_total`，只增不减）→ 新到账即发 webhook 通知。不绑 KV 则跳过此步。
2. **阈值判定**：某个币的通道在场余额合计 ≥ 你配置的 `MIN_SWEEP` 阈值 → 触发。
3. **归集**：多币种多通道打包成**一笔** `imputationall` 交易；真实 calldata 估 gas 预检（合约会 revert 的情况在这里被拦下）、原生币盈利检查（净额 ≥ gas×价格×1.2）、热钱包余量检查 → 本地签名 → `eth_sendRawTransaction` 广播。
4. **确认/通知**（可选）：下一 tick 查回执，成功/失败各发一次 webhook。

## 经济账（务必先读）

- **用谁的合约，差 3%。** `imputationall` 归集扣三笔费：owner 0.5% + helper 1.5% + affiliate 1%（合计 3%，从扫入额里扣）。
  - 用**官方 Imputations 合约**：3% 归协议方，你净得 97% − gas。好处是零部署，且**免费额度**内（合约累计归集 < 5 次且累计通道 < 30 笔）三费全免。
  - 用**自己部署的 Imputations**（owner = 你）：3% 全部回流你自己，净成本只剩 gas。部署可走 `ImputationsBatchDeployer`（两笔交易）或 hardhat 两段式脚本，见 `SweepPay_hardhat/scripts/Imputations/`。本 Worker 不关心你指向哪个 Imputations——配置里填谁的地址就按谁的费率走（费率是每 tick 从合约 `systeminfo()` 现读的，不写死）。
- **原生币其实已经自动了。** 通道首次归集后会被合约登记激活，此后**原生币**到账即被钱包合约的 `receive()` 当场 97/3 自动分发给国库（这就是为什么激活通道的原生币余额恒为 0）。本 Worker 的主战场是 **ERC20**（趴账等归集）+ **归集时机**（阈值择时省 gas）+ **到账通知**。
- **affiliate 1%**：不设置推荐人会固化成「归 owner」。用官方合约这 1% 反正归协议方；自部署则归你自己，无需设置。
- 监控只能轮询：合约没有 Deposit 事件（只有可选的 `CollectEventMode` 事件模式和 LongSystemLog 链上日志）。官方 API 同样选择轮询。

## 快速开始

```bash
# 1. 安装
npm install

# 2. 准备一把专用热钱包私钥（只放 gas，别放主资产！）
openssl rand -hex 32   # 前面加 0x

# 3. 填配置（见下文「配置」），然后设置密钥
wrangler secret put SWEEP_PRIVATE_KEY

# 4. 先跑 dry-run 看会做什么（改 vars 里 DRY_RUN="true" 再 deploy，或本地 .dev.vars）
npm run deploy

# 5. 看日志确认无异常后，把 DRY_RUN 改回 "false" 重新 deploy
```

本地开发：

```bash
cp .dev.vars.example .dev.vars   # 填好配置
npm run dev                       # wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # 手动触发一轮
curl http://localhost:8787/health                          # 看运行状态
```

本地全链路联调（需要 hardhat 链）：起 `SweepPay_hardhat` 的本地节点并部署 Imputations，然后在 `.dev.vars` 指向它（`CHAIN_IDS=31337` + `RPC_URL_31337` + `IMPUTATIONS_31337`），用 `scripts/dev-setup.mjs <imputations> <treasury> [ETH]` 给测试私钥注资并向通道打款。注意 `hardhat_setBalance` 只能喂 well-known 测试私钥；真实助记词加密在仓外。

## 配置

全部走 wrangler vars（公开非敏感）+ secret（私钥）。vars 很容易被 CF 面板存成空串——所有解析都带空串回落，不用担心。

| 变量 | 必填 | 说明 |
|---|---|---|
| `SWEEP_PRIVATE_KEY` | ✅（secret） | 热钱包私钥。只用于签名归集交易，只在运行时内存出现 |
| `TREASURY` | ✅ | 国库地址（通道归属者，归集的资金最终回到这里） |
| `CHAIN_IDS` | ✅ | 逗号分隔 chainId，如 `"7156777"` 或 `"56,7156777"` |
| `CHANNEL_SECRET` / `CHANNEL_FROM` / `CHANNEL_TO` | 二选一 | 通道号段：order = `密语-6位补零编号`，与网页方案①的「密语-编号」完全一致 |
| `CHANNEL_ORDERS` | 二选一 | 显式列通道全名（逗号分隔），优先于号段 |
| `MIN_SWEEP` | | JSON：token → 人类可读阈值。`"native"` 表示原生币，其余键为 ERC20 地址。**给谁设了阈值才归集谁**。默认 `{"native":"0.01"}` |
| `GAS_BUFFER_X10` | | 盈利安全边际 ×N/10（默认 12 = ×1.2）。只作用于含原生币的归集组 |
| `MAX_TX_PER_TICK` | | 每 tick 每链最多几笔（默认 1，模板一笔多币种打包够用） |
| `TICK_LOCK_SECONDS` | | tick 内存锁（默认 55s） |
| `DRY_RUN` | | `true` = 只打印将发的交易不广播（上线前必跑） |
| `WEBHOOK_URL` | | 通知 webhook：POST `{source, event, ...}`，event ∈ arrival / sweep_sent / sweep_confirmed / sweep_failed / sweep_unconfirmed |
| `RPC_URL_<chainId>` | | 覆盖该链的 RPC（registry 外的链必填） |
| `IMPUTATIONS_<chainId>` | | 覆盖该链的 Imputations 地址（自部署合约 / registry 外的链必填） |

链的默认 rpc/imputations 来自 `registry.json`（源头是 `SweepPay_hardhat/deployments/all.json`，与 Executor/Web 同步；新链或自部署合约直接用覆盖变量接入，不必改 registry）。

**KV（可选）**：默认注释掉 = 纯无状态模式，归集照常工作，只是没有到账通知。需要到账通知时 `wrangler kv namespace create STATE` 并把返回 id 填进 wrangler.jsonc 的 `kv_namespaces`。

## 设计要点

- **核心无状态**：归集判定只看「在场余额 ≥ 阈值」，失败交易下一 tick 自动重试，不依赖任何持久化。
- **零公网面**：`workers_dev: false`，无任何入站路由（仅本地 dev 有 `/health` 看状态）。触发只来自 cron。
- **费率不写死**：每 tick 现读合约 `systeminfo()`，最保守口径做盈利预检（免费额度期内实际更划算）。
- **合约硬约束友好**：`collect_auth` 收紧的 treasury，把热钱包地址加入授权名单即可；没授权时 estimateGas 会 revert，Worker 会跳过并提示（白烧不了 gas）。

## 安全须知

- **私钥纪律**：`SWEEP_PRIVATE_KEY` 是热钱包——专用地址、只放 gas、余额留够 `单笔 gas × 3`（`WALLET_GAS_RESERVE_X` 可调）、定期把多余 gas 扫走。它签名的是 `imputationall`，**永远不该持有你的主资产**。
- **不要把私钥放进 vars**（wrangler.jsonc / CF 面板环境变量）。只走 `wrangler secret put` 或本地 `.dev.vars`（已 gitignore）。
- `MIN_SWEEP` 别配太低：每笔归集都是真实 gas，阈值至少要覆盖 gas 成本的几倍才划算。
- workerd 隔离重启会丢失「在途回执确认」的内存表——丢的是通知，不丢资金（资金由链上状态决定，未归集的余额下一 tick 还会再试）。
- 免费档 KV 有每日写入限额；基线快照每链每 tick 最多一次写，正常不会打满。免费层 CF Workers cron 的 CPU 限制对纯签名场景足够。

## 与其他仓的关系

- 只依赖 `SweepPay_hardhat` 的合约与部署产物（`registry.json`，与 `SweepPay_Executor`/Web 的同步机制相同）。
- 不依赖 `SweepPay_API` / `SweepPay_Manager` / `SweepPay_Executor`——那是方案③官方托管的三件套；本仓是你「自己当自己的 Executor」的最小闭环。
- 前端方案①的「开发接入」面板提供本仓的一键部署入口。
