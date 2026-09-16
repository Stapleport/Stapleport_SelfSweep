// 归集执行：查余额 → 阈值判定 → 预检（估 gas/盈利/热钱包余量） → 本地签名 → 广播。
// 预检/签名/广播流程改造自 Stapleport_Executor/src/worker.js scanChain（同款口径），
// 差别：没有榜单——候选就是自己配置的通道号段；方法固定 imputationall（自归集，
// helper 份额不存在「赚回扣」一说，见 README 经济账）。
// 2026-09-15 收编：阈值判定/systeminfo/净得率 → @stapleport/worker-kit sweep-core；
// 估 gas 回落+eth_call 模拟/盈利/余量预检 → precheck（calldata 编码按 L2 留本仓 lib/tx.js）。
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import registry from '../registry.json' with { type: 'json' };
import { rpc, fmtNative } from './lib/rpc.js';
import { callView, encodeImputationall } from './lib/tx.js';
import {
  NATIVE,
  isNative,
  orderToPath,
  balancesByTokenPath,
} from './lib/imputations.js';
import { humanToRaw } from './config.js';
import {
  evaluateProfit,
  // 任务一（2026-09-15）：estimateGas/eth_call 预检收编
  gasPrecheck,
  effectiveGasPrice,
  gasReserveOk,
  // 任务二（2026-09-15）：归集决策链纯函数收编（calldata 编码按 README L2 留本仓）
  qualifyPaths,
  parseSystemInfo,
  netAfterFees,
} from '@stapleport/worker-kit';

// chainId → { rpcUrl, imputations }：registry.json 为底，RPC_URL_<id> / IMPUTATIONS_<id> 覆盖
// （registry 外的自部署链靠覆盖变量接入）
export function resolveChain(cfg, chainId) {
  const entry = registry.chains?.[String(chainId)];
  const rpcUrl = cfg.rpcUrl(chainId) ?? entry?.meta?.rpc ?? null;
  const imputations = cfg.imputations(chainId) ?? entry?.Imputations ?? null;
  return rpcUrl && imputations ? { rpcUrl, imputations } : null;
}

// 盈利判定（纯函数，可单测）：原生币净额 ≥ gas×价格×buffer/10 才出手。
// 公式已收编 @stapleport/worker-kit（与 Executor/HelperWorker 三仓归一，floor→ceil 统一）；
// 薄适配保本仓参数/返回形状。
// 纯 ERC20 组没有原生的可比口径，阈值即用户意志，不做这层检查（见 README）。
export function profitCheckNet({ netNative, gasUnits, gasPriceWei, bufferX10 = 12 }) {
  const r = evaluateProfit({ expectedNative: netNative, gasUnits, gasPriceWei, bufferX10 });
  return { ok: r.ok, costNative: r.costNative, requiredNative: r.requiredNative };
}

// ERC20 decimals 只读（isolate 内缓存；读失败回落 18 并记录）
const ERC20_DEC_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
const decimalsCache = new Map();
async function tokenDecimals(rpcUrl, token) {
  const hit = decimalsCache.get(token);
  if (hit !== undefined) return hit;
  let d = 18;
  try {
    const data = encodeFunctionData({ abi: ERC20_DEC_ABI, functionName: 'decimals' });
    const raw = await rpc(rpcUrl, 'eth_call', [{ to: token, data }, 'latest']);
    const v = Number(decodeFunctionResult({ abi: ERC20_DEC_ABI, functionName: 'decimals', data: raw }));
    if (Number.isFinite(v) && v >= 0) d = v;
  } catch (e) {
    console.log(`[selfsweep] token ${token} decimals() 读取失败（${e.message}），按 18 位换算阈值`);
  }
  decimalsCache.set(token, d);
  return d;
}

// 单链归集一轮。返回广播列表（通知由调用方负责）
export async function sweepChain(env, cfg, wallet, chainId) {
  const chain = resolveChain(cfg, chainId);
  if (!chain) {
    console.log(`[selfsweep] 链 ${chainId} 缺 rpc/imputations（registry 无此链且未设覆盖变量），跳过`);
    return [];
  }
  const { rpcUrl, imputations } = chain;
  if (!cfg.orders.length) return [];

  const paths = cfg.orders.map(orderToPath);
  const tokensToQuery = [NATIVE, ...cfg.tokens];

  // 一次批量读：所有通道 × 所有币种的在场余额（received 会把已归集部分累计进来，
  // 这里只看 balance = 通道里现在趴着的钱）
  const result = await callView(rpcUrl, imputations, 'gettokensreceiveds', [
    cfg.treasury,
    tokensToQuery.map((token) => ({ token, paths })),
  ]);
  const balances = balancesByTokenPath(result);

  // 阈值判定（判定数学已收编 @stapleport/worker-kit sweep-core.qualifyPaths）：
  // MIN_SWEEP 给谁设了阈值，谁才有资格；达标行里只收 balance>0 的通道。
  // human→raw 换算（含 ERC20 decimals 读链）留本壳，且只对「有余额记录」的币换算，
  // 保持原 decimals RPC 触发面不变
  const thresholds = new Map(); // token(小写) → raw BigInt
  for (const [token, thresholdHuman] of cfg.minSweep.entries()) {
    if (!balances.get(token)?.size) continue;
    const decimals = isNative(token) ? 18 : await tokenDecimals(rpcUrl, token);
    try {
      thresholds.set(token, humanToRaw(thresholdHuman, decimals));
    } catch (e) {
      console.log(`[selfsweep] MIN_SWEEP[${token}] 阈值非法（${e.message}），跳过该币`);
    }
  }
  // qualifying：token(小写) → { paths: 达标path[], total }，迭代序与 thresholds 一致
  const qualifying = qualifyPaths({ paths, balances, thresholds });
  if (!qualifying.size) return [];

  // 费率现读（不写死）：systeminfo → [owner, affiliate, helper, gas_price_reward, router]
  // 净得率 = 1 − 三费合计（imputationall 路径三费都从扫入额里扣；免费额度期内实际更高，
  // 这里按最保守口径做盈利预检）
  const info = await callView(rpcUrl, imputations, 'systeminfo', []);
  // 双形态归一（数组/对象）+ 三费合计已收编 @stapleport/worker-kit sweep-core.parseSystemInfo
  const { feeSumX18 } = parseSystemInfo(info);

  // qualifying 的值是 {paths, total}，与 lib 里 buildImputationallArgs 的纯数组约定不同，
  // 直接展开构造（多币种打包进同一笔 imputationall）
  const tokenTasks = [...qualifying.entries()].map(([token, q]) => ({ token, paths: q.paths }));
  const data = encodeImputationall(cfg.treasury, tokenTasks);

  // 预检① 真实 calldata 估 gas（@stapleport/worker-kit precheck.gasPrecheck，Bridge sendTx
  // 口径收编）：collect_auth 收紧且热钱包不在授权名单、余额为 0 等链上拒绝都会在这里现形。
  // 估 gas 异常回落 defaultGas + eth_call 模拟甄别——联盟链（78753 初代）eth_estimateGas
  // 有假阴性坑（Bridge NOTES 2026-09-13），模拟也 revert 才真弃单，省一笔必 revert 的 gas
  const gasPrice = effectiveGasPrice(await rpc(rpcUrl, 'eth_gasPrice', []));
  const pre = await gasPrecheck({
    rpcCall: (method, params) => rpc(rpcUrl, method, params),
    tx: { from: wallet.address, to: imputations, data },
    defaultGas: cfg.defaultGas,
  });
  const gas = pre.gas;
  if (pre.source === 'fallback') {
    if (!pre.simulate?.ok) {
      console.log(`[selfsweep] 链 ${chainId} estimateGas 失败（${pre.estimateError.message}）且 eth_call 模拟 revert（${pre.simulate?.error?.message ?? '无数据'}）——若你 set_collect_auth 收紧了授权，记得把热钱包 ${wallet.address} 加入授权名单`);
      return [];
    }
    console.log(`[selfsweep] 链 ${chainId} estimateGas 失败（${pre.estimateError.message}），eth_call 模拟通过——回落 defaultGas=${gas}（联盟链估 gas 假阴性坑）`);
  }

  // 预检② 盈利：组里含原生币才可比（净额 = 原生币总额 × 净得率，netAfterFees 已收编）；
  // 纯 ERC20 组只看阈值
  const nativeTotal = qualifying.get(NATIVE)?.total ?? null;
  if (nativeTotal !== null) {
    const netNative = netAfterFees(nativeTotal, feeSumX18);
    const profit = profitCheckNet({ netNative, gasUnits: gas, gasPriceWei: gasPrice, bufferX10: cfg.bufferX10 });
    if (!profit.ok) {
      console.log(`[selfsweep] 链 ${chainId} 原生币不划算：净额 ${fmtNative(netNative)} < gas 需 ${fmtNative(profit.requiredNative)}，本轮放弃`);
      return [];
    }
  }

  // 预检③ 热钱包余量：本单 gas × N 倍（gasReserveOk 已收编，与 Executor 同款口径）
  const cost = gas * gasPrice;
  const walletBal = BigInt(await rpc(rpcUrl, 'eth_getBalance', [wallet.address, 'latest']));
  if (!gasReserveOk(walletBal, cost, cfg.gasReserveX)) {
    console.log(`[selfsweep] 链 ${chainId} 热钱包余额 ${fmtNative(walletBal)} 不足（本单 gas≈${fmtNative(cost)} × ${cfg.gasReserveX} 倍预留），请充值`);
    return [];
  }

  const summary = [...qualifying.entries()]
    .map(([t, q]) => `${isNative(t) ? 'native' : `${t.slice(0, 8)}…`}:${fmtNative(q.total)}×${q.paths.length}path`)
    .join(' ');
  if (cfg.dryRun) {
    console.log(`[selfsweep][dry-run] chain=${chainId} 将归集 ${summary}，gas≈${gas} 成本≈${fmtNative(cost)} —— 未广播`);
    return [];
  }

  // 签名广播（legacy；nonce 从 pending 取，同 tick 内自增——虽然每链只发 1 笔，留好习惯）
  const nonce = BigInt(await rpc(rpcUrl, 'eth_getTransactionCount', [wallet.address, 'pending']));
  const rawTx = await wallet.signTransaction({
    type: 'legacy',
    chainId: Number(chainId),
    nonce: Number(nonce),
    gas,
    gasPrice,
    to: imputations,
    value: 0n,
    data,
  });
  const txHash = await rpc(rpcUrl, 'eth_sendRawTransaction', [rawTx]);
  console.log(`[selfsweep] 已广播 chain=${chainId} tx=${txHash} ${summary} 成本≈${fmtNative(cost)}`);
  return [
    {
      chainId: Number(chainId),
      treasury: cfg.treasury,
      tokens: [...qualifying.keys()],
      paths: [...qualifying.values()].flatMap((q) => q.paths),
      totalByToken: Object.fromEntries([...qualifying.entries()].map(([t, q]) => [t, q.total.toString()])),
      tx: txHash,
      gasCostNative: cost.toString(),
      at: Date.now(),
    },
  ];
}
