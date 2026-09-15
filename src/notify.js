// 通知（可选）：WEBHOOK_URL 配了才发，POST JSON。任何失败只打日志，绝不影响归集主流程。
// 到账事件需同时绑定 STATE KV（到账判定靠基线差，无 KV 无到账事件；归集事件不受此限）。
export async function notify(env, event) {
  const url = String(env.WEBHOOK_URL ?? '').trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'stapleport-selfsweep', at: Date.now(), ...event }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.log(`[selfsweep] webhook 通知失败：${e.message}`);
  }
}
