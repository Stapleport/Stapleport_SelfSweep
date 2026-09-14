// 归集执行：查余额 → 阈值判定 → estimateGas 预检 → 本地签名 → 广播。
// 预检/签名/广播流程改造自 Stapleport_Executor/src/worker.js scanChain（同款口径），
// 差别：没有榜单——候选就是自己配置的通道号段；方法固定 imputationall（自归集，
// helper 份额不存在「赚回扣」一说，见 README 经济账）。
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

// chainId → { rpcUrl, imputations }：registry.json 为底，RPC_URL_<id> / IMPUTATIONS_<id> 覆盖
// （registry 外的自部署链靠覆盖变量接入）
export function resolveChain(cfg, chainId) {
  const entry = registry.chains?.[String(chainId)];
  const rpcUrl = cfg.rpcUrl(chainId) ?? entry?.meta?.rpc ?? null;
  const imputations = cfg.imputations(chainId) ?? entry?.Imputations ?? null;
  return rpcUrl && imputations ? { rpcUrl, imputations } : null;
}

// 盈利判定（纯函数，可单测）：原生币净额 ≥ gas×价格×buffer/10 才出手。
// 纯 ERC20 组没有原生的可比口径，阈值即用户意志，不做这层检查（见 README）。
export function profitCheckNet({ netNative, gasUnits, gasPriceWei, bufferX10 = 12 }) {
  const costNative = BigInt(gasUnits) * BigInt(gasPriceWei);
  const requiredNative = (costNative * BigInt(bufferX10)) / 10n;
  return { ok: BigInt(netNative) >= requiredNative, costNative, requiredNative };
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

  // 阈值判定：MIN_SWEEP 给谁设了阈值，谁才有资格；达标行里只收 balance>0 的通道
  const qualifying = new Map(); // token(小写) → { paths: path[], total: BigInt }
  for (const [token, thresholdHuman] of cfg.minSweep.entries()) {
    const perPath = balances.get(token);
    if (!perPath?.size) continue;
    const decimals = isNative(token) ? 18 : await tokenDecimals(rpcUrl, token);
    let thresholdRaw;
    try {
      thresholdRaw = humanToRaw(thresholdHuman, decimals);
    } catch (e) {
      console.log(`[selfsweep] MIN_SWEEP[${token}] 阈值非法（${e.message}），跳过该币`);
      continue;
    }
    const hit = [];
    let total = 0n;
    for (const p of paths) {
      const bal = perPath.get(p.toLowerCase()) ?? 0n;
      if (bal > 0n) {
        hit.push(p);
        total += bal;
      }
    }
    if (hit.length && total >= thresholdRaw) qualifying.set(token, { paths: hit, total });
  }
  if (!qualifying.size) return [];

  // 费率现读（不写死）：systeminfo → [owner, affiliate, helper, gas_price_reward, router]
  // 净得率 = 1 − 三费合计（imputationall 路径三费都从扫入额里扣；免费额度期内实际更高，
  // 这里按最保守口径做盈利预检）
  const info = await callView(rpcUrl, imputations, 'systeminfo', []);
  const fees = Array.isArray(info)
    ? info
    : [info.owner_fee, info.affiliate_fee, info.helper_fee, info.gas_price_reward, info.router];
  const feeSumX18 = BigInt(fees[0]) + BigInt(fees[1]) + BigInt(fees[2]);

  // qualifying 的值是 {paths, total}，与 lib 里 buildImputationallArgs 的纯数组约定不同，
  // 直接展开构造（多币种打包进同一笔 imputationall）
  const tokenTasks = [...qualifying.entries()].map(([token, q]) => ({ token, paths: q.paths }));
  const data = encodeImputationall(cfg.treasury, tokenTasks);

  const gasPrice = BigInt(await rpc(rpcUrl, 'eth_gasPrice', []));
  // 预检① 真实 calldata 估 gas：collect_auth 收紧且热钱包不在授权名单、余额为 0 等
  // 链上拒绝都会在这里抛出，省一笔必 revert 的 gas
  let gas;
  try {
    gas = BigInt(
      await rpc(rpcUrl, 'eth_estimateGas', [{ from: wallet.address, to: imputations, data }])
    );
  } catch (e) {
    console.log(`[selfsweep] 链 ${chainId} estimateGas 失败（${e.message}）——若你 set_collect_auth 收紧了授权，记得把热钱包 ${wallet.address} 加入授权名单`);
    return [];
  }

  // 预检② 盈利：组里含原生币才可比（净额 = 原生币总额 × 净得率）；纯 ERC20 组只看阈值
  const nativeTotal = qualifying.get(NATIVE)?.total ?? null;
  if (nativeTotal !== null) {
    const netNative = (nativeTotal * (10n ** 18n - feeSumX18)) / 10n ** 18n;
    const profit = profitCheckNet({ netNative, gasUnits: gas, gasPriceWei: gasPrice, bufferX10: cfg.bufferX10 });
    if (!profit.ok) {
      console.log(`[selfsweep] 链 ${chainId} 原生币不划算：净额 ${fmtNative(netNative)} < gas 需 ${fmtNative(profit.requiredNative)}，本轮放弃`);
      return [];
    }
  }

  // 预检③ 热钱包余量：本单 gas × N 倍
  const cost = gas * gasPrice;
  const walletBal = BigInt(await rpc(rpcUrl, 'eth_getBalance', [wallet.address, 'latest']));
  if (walletBal < cost * BigInt(cfg.gasReserveX)) {
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
