// Stapleport_SelfSweep 入口：cron 触发归集 tick；HTTP 只留 /health 一条只读状态路由。
// 本 Worker 是自建者自己的签名核：私钥只进 wrangler secret / .dev.vars，零公网面（workers_dev:false）。
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from './config.js';
import { sweepChain, resolveChain } from './sweep.js';
import { monitorChain } from './monitor.js';
import { notify } from './notify.js';
import { rpc, fmtNative } from './lib/rpc.js';
import { receiptStatus, createTickLock } from '@stapleport/worker-kit';

// isolate 内存 tick 锁（照 Executor 口径：防同 isolate 重叠，跨 isolate 不强求）。
// 2026-09-17 起走 kit createTickLock（lockMs 首个 tick 时从 cfg 取；KV 事故案底见 kit lock.js）
let tickLock = null;
// 在途归集流水（内存）：下一 tick 查回执并通知；isolate 重启丢通知不丢资金
const pendingSweeps = new Map();
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export default {
  async scheduled(controller, env, ctx) {
    const cfg = loadConfig(env);
    tickLock ??= createTickLock({ lockMs: cfg.lockMs, tag: 'selfsweep' });
    if (!tickLock.tryAcquire()) return;
    await runTick(env, cfg, ctx);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const cfg = loadConfig(env);
      return Response.json({
        ok: true,
        service: 'stapleport-selfsweep',
        configured: Boolean(cfg.treasury) && cfg.orders.length > 0,
        treasury: cfg.treasury,
        chains: cfg.chainIds,
        channels: cfg.orders.length,
        tokens: ['native', ...cfg.tokens],
        kvState: Boolean(env.STATE),
        webhook: Boolean(cfg.webhookUrl),
        dryRun: cfg.dryRun,
      });
    }
    return new Response('not found', { status: 404 });
  },
};

async function runTick(env, cfg, ctx) {
  if (!cfg.treasury) return console.log('[selfsweep] 未配置 TREASURY，空转');
  const pk = String(env.SWEEP_PRIVATE_KEY ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return console.log('[selfsweep] 未配置 SWEEP_PRIVATE_KEY（wrangler secret put SWEEP_PRIVATE_KEY），空转');
  }
  const wallet = privateKeyToAccount(pk);

  await settlePending(env, cfg, ctx);

  for (const chainId of cfg.chainIds) {
    const chain = resolveChain(cfg, chainId);
    if (!chain) {
      console.log(`[selfsweep] 链 ${chainId} 缺 rpc/imputations（registry 无此链且未设 RPC_URL_<id>/IMPUTATIONS_<id>），跳过`);
      continue;
    }
    try {
      // 到账监控（可选）：先报新钱，再归集
      if (env.STATE) {
        const arrivals = await monitorChain(env, cfg, chainId, chain);
        for (const a of arrivals) {
          console.log(`[selfsweep] 到账 chain=${chainId} 通道=${a.channel} delta=${fmtNative(a.delta)}`);
          ctx.waitUntil(notify(env, { event: 'arrival', ...a }));
        }
      }

      const sent = await sweepChain(env, cfg, wallet, chainId);
      for (const s of sent) {
        pendingSweeps.set(s.tx, s);
        ctx.waitUntil(notify(env, { event: 'sweep_sent', ...s }));
      }
    } catch (e) {
      console.log(`[selfsweep] 链 ${chainId} tick 异常：${e.message}`);
    }
  }
}

// 在途回执确认：成功/失败各发一次通知后出表；超 TTL 视为未知（如 RPC 丢失回执）
async function settlePending(env, cfg, ctx) {
  for (const [tx, s] of pendingSweeps) {
    try {
      const chain = resolveChain(cfg, String(s.chainId));
      const receipt = chain ? await rpc(chain.rpcUrl, 'eth_getTransactionReceipt', [tx]) : null;
      const status = receiptStatus(receipt); // 'confirmed' | 'reverted' | 'pending'（Kit 收编口径）
      const now = Date.now();
      if (status === 'confirmed') {
        ctx.waitUntil(notify(env, { event: 'sweep_confirmed', tx, chainId: s.chainId, tokens: s.tokens }));
        pendingSweeps.delete(tx);
      } else if (status === 'reverted') {
        ctx.waitUntil(notify(env, { event: 'sweep_failed', tx, chainId: s.chainId, tokens: s.tokens }));
        pendingSweeps.delete(tx);
      } else if (now - s.at > PENDING_TTL_MS) {
        ctx.waitUntil(notify(env, { event: 'sweep_unconfirmed', tx, chainId: s.chainId }));
        pendingSweeps.delete(tx);
      }
    } catch (e) {
      console.log(`[selfsweep] 回执查询失败 tx=${tx}：${e.message}（留在途，下轮再查）`);
    }
  }
}
