// 环境变量 → 运行配置（纯函数，可单测）。密钥 SWEEP_PRIVATE_KEY 不经过这里。
// 防 CF 面板坑：vars 很容易被存成空串，空/非法一律回落默认值（照 Executor config.js 的教训）。
import { NATIVE, rangeOrders } from './lib/imputations.js';

export function parseCsvList(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s) => ADDR_RE.test(String(s ?? '').trim());

// MIN_SWEEP：JSON { "native": "0.01", "0xtoken…": "100" } → Map<token小写, 人类可读数字符串>
// 未配置或非法 → 默认只挂原生币 0.01
export function parseMinSweep(jsonStr) {
  const fallback = new Map([[NATIVE, '0.01']]);
  const s = String(jsonStr ?? '').trim();
  if (!s) return fallback;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return fallback;
  }
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    const token = k.toLowerCase() === 'native' ? NATIVE : k.toLowerCase();
    // 人类可读十进制数（允许前导 0 / 小数；负数与非法格式丢弃）
    if (typeof v === 'string' || typeof v === 'number') {
      const str = String(v).trim();
      if (/^\d+(\.\d+)?$/.test(str) && Number(str) >= 0) m.set(token, str);
    }
  }
  return m.size ? m : fallback;
}

// 人类可读十进制 → raw BigInt（按 decimals 缩位）。小数位超出 decimals 时截断（不四舍五入）。
export function humanToRaw(human, decimals) {
  const str = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`bad amount: ${human}`);
  const d = Math.max(0, decimals | 0);
  const [int, frac = ''] = str.split('.');
  const fracCut = frac.slice(0, d).padEnd(d, '0');
  return BigInt(int + fracCut);
}

// 通道列表：CHANNEL_ORDERS 显式 csv 优先；否则 CHANNEL_SECRET + CHANNEL_FROM..TO 号段。
// 上限 200 条（paths 太长 calldata/gas 会爆，详见 README）
export function resolveOrders(env) {
  const explicit = parseCsvList(env.CHANNEL_ORDERS);
  if (explicit.length) return { orders: explicit, source: 'orders' };
  const secret = String(env.CHANNEL_SECRET ?? '').trim();
  if (!secret) return { orders: [], source: 'none' };
  return {
    orders: rangeOrders(secret, env.CHANNEL_FROM ?? 1, env.CHANNEL_TO ?? 20),
    source: 'range',
  };
}

function bigIntVar(v, fallback) {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  try {
    return BigInt(s);
  } catch {
    return fallback;
  }
}

export function loadConfig(env) {
  const treasury = isAddress(env.TREASURY) ? String(env.TREASURY).trim().toLowerCase() : null;
  const minSweep = parseMinSweep(env.MIN_SWEEP);
  return {
    treasury,
    chainIds: parseCsvList(env.CHAIN_IDS ?? '31337'),
    minSweep,
    // 要查询/归集的币种由 MIN_SWEEP 的键决定（"native" 之外的键 = ERC20 地址）：
    // 给哪个币设了阈值，哪个币才会被查询和归集，少一处要同步的配置
    tokens: [...minSweep.keys()].filter((t) => t !== NATIVE),
    ...resolveOrders(env),
    // 盈利安全边际 ×1.2：原生币净额 ≥ gas×价格×buffer 才出手（纯 ERC20 组只看阈值）
    bufferX10: Number(env.GAS_BUFFER_X10 ?? 12) || 12,
    maxPerTick: Math.max(1, Number(env.MAX_TX_PER_TICK ?? 1) | 0),
    // 热钱包余额需 ≥ 本单 gas × 该倍数（给失败重试留量）
    gasReserveX: Math.max(1, Number(env.WALLET_GAS_RESERVE_X ?? 3) | 0),
    // 估 gas 异常回落上限（联盟链估 gas 假阴性坑，Bridge DEFAULT_GAS 同款默认）
    defaultGas: bigIntVar(env.DEFAULT_GAS, 600000n),
    dryRun: String(env.DRY_RUN ?? 'false') === 'true',
    webhookUrl: String(env.WEBHOOK_URL ?? '').trim() || null,
    lockMs: Math.max(1, Number(env.TICK_LOCK_SECONDS ?? 55) || 55) * 1000,
    // 按链覆盖：env.RPC_URL_<chainId> / env.IMPUTATIONS_<chainId>（空串视为未设）
    rpcUrl: (chainId) => String(env[`RPC_URL_${chainId}`] ?? '').trim() || null,
    imputations: (chainId) => {
      const v = String(env[`IMPUTATIONS_${chainId}`] ?? '').trim();
      return isAddress(v) ? v : null;
    },
  };
}
