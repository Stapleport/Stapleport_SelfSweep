// Imputations 合约参数组装 / 解码（纯函数，viem 编解码语义）。
// 改造自 SweepPay_Web_newui/src/core/imputations.js（前端批量面板同款算法），
// 保证与网页「密语-编号」通道完全对上账。
import { keccak256, toBytes } from 'viem';
import registry from '../../registry.json' with { type: 'json' };

export const imputationsAbi = registry.contracts.Imputations.abi;

export const NATIVE = '0x0000000000000000000000000000000000000000';
export const isNative = (token) => String(token).toLowerCase() === NATIVE;

// 与合约 getpath(string) 完全一致：path = keccak256(bytes(order))
export const orderToPath = (order) => keccak256(toBytes(order));

// 通道标识 = 密语-6位补零编号（与网页 seqorder.buildOrder 一致）
export const buildOrder = (secret, n) => `${secret}-${String(n).padStart(6, '0')}`;

// 号段 → order 列表（含端点；上限防误输大区间打爆 gas）
export function rangeOrders(secret, start, end, limit = 200) {
  const s = Math.max(1, Math.floor(Number(start) || 1));
  const e = Math.min(Math.floor(Number(end) || s), s + limit - 1);
  const out = [];
  for (let n = s; n <= e; n++) out.push(buildOrder(secret, n));
  return out;
}

// s_imputationinfo：{ treasury, tokentasks: [{ token, paths }] } —— 多币种一笔归集
export function buildImputationallArgs(treasury, tokenPaths /* Map<token, path[]> 或 entries */) {
  const tokentasks = [...tokenPaths.entries()].map(([token, paths]) => ({ token, paths }));
  return [{ treasury, tokentasks }];
}

// viem 解码 gettokensreceiveds：[{ accountinfos: [{path,token,account,balance,paid_total,received}], total_received }]
// 防御式提取：按 path 找字段，结构异常返回 null（tuple 下标：balance=3, paid_total=4, received=5）
function fieldOfPath(result, path, field, idx) {
  if (!Array.isArray(result)) return null;
  const want = path.toLowerCase();
  for (const group of result) {
    for (const info of group.accountinfos ?? group[0] ?? []) {
      const p = info?.path ?? info?.[0];
      if (typeof p === 'string' && p.toLowerCase() === want) {
        const v = info?.[field] ?? info?.[idx];
        return typeof v === 'bigint' ? v : BigInt(v ?? 0);
      }
    }
  }
  return null;
}

export const balanceOfPath = (result, path) => fieldOfPath(result, path, 'balance', 3);
export const receivedOfPath = (result, path) => fieldOfPath(result, path, 'received', 5);

// 多币种版：Map<token(小写), Map<path(小写), value>> —— 一次 gettokensreceiveds 带
// [{token, paths}] 多组时，同一路径在不同币种下各有一条记录
function mapByTokenPath(result, field, idx) {
  const m = new Map();
  if (!Array.isArray(result)) return m;
  for (const group of result) {
    for (const info of group.accountinfos ?? group[0] ?? []) {
      const p = info?.path ?? info?.[0];
      const tk = info?.token ?? info?.[1];
      if (typeof p !== 'string' || typeof tk !== 'string') continue;
      const key = tk.toLowerCase();
      let inner = m.get(key);
      if (!inner) { inner = new Map(); m.set(key, inner); }
      const v = info?.[field] ?? info?.[idx];
      inner.set(p.toLowerCase(), typeof v === 'bigint' ? v : BigInt(v ?? 0));
    }
  }
  return m;
}

export const balancesByTokenPath = (result) => mapByTokenPath(result, 'balance', 3);
export const receivedsByTokenPath = (result) => mapByTokenPath(result, 'received', 5);
