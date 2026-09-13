// 到账监控（需 STATE KV；未绑定 KV 则调用方整体跳过——归集本身不依赖它）。
// 口径与合约/前端一致：received = balance + paid_total，只增不减。
// 归集会把 balance 转成 paid_total，received 不变 → 归集不会造成「二次到账」误报。
// 首轮只落基线不通知（避免刚部署就把存量通道全报一遍）。
import { NATIVE, orderToPath, receivedsByTokenPath } from './lib/imputations.js';
import { callView } from './lib/tx.js';

// 返回到账事件数组 [{chainId, channel, token, path, delta, received}]
export async function monitorChain(env, cfg, chainId, chain) {
  const paths = cfg.orders.map(orderToPath);
  if (!paths.length) return [];
  const tokensToQuery = [NATIVE, ...cfg.tokens];
  const pathToChannel = new Map(paths.map((p, i) => [p.toLowerCase(), cfg.orders[i]]));

  const key = `baseline:${chainId}`;
  const prevRaw = await env.STATE.get(key);
  const firstRun = prevRaw === null;
  const prev = firstRun ? new Map() : new Map(Object.entries(JSON.parse(prevRaw)));

  const result = await callView(chain.rpcUrl, chain.imputations, 'gettokensreceiveds', [
    cfg.treasury,
    tokensToQuery.map((token) => ({ token, paths })),
  ]);
  const receiveds = receivedsByTokenPath(result);

  const arrivals = [];
  const next = {};
  let changed = false;
  for (const [token, perPath] of receiveds) {
    for (const [path, rec] of perPath) {
      const k = `${token}:${path}`;
      next[k] = rec.toString();
      const before = BigInt(prev.get(k) ?? '0');
      if (rec > before) {
        changed = true;
        if (!firstRun) {
          arrivals.push({
            chainId: Number(chainId),
            channel: pathToChannel.get(path) ?? path,
            token,
            path,
            delta: (rec - before).toString(),
            received: rec.toString(),
          });
        }
      }
    }
  }
  if (changed || firstRun) await env.STATE.put(key, JSON.stringify(next));
  return arrivals;
}
