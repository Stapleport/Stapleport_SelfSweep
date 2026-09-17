// 通知（可选）：WEBHOOK_URL 配了才发，POST JSON。任何失败只打日志，绝不影响归集主流程。
// 到账事件需同时绑定 STATE KV（到账判定靠基线差，无 KV 无到账事件；归集事件不受此限）。
// 2026-09-17 起走 kit notifyWebhook（信封/超时/失败不抛口径收编）。
import { notifyWebhook } from '@stapleport/worker-kit';

export function notify(env, event) {
  return notifyWebhook({
    url: String(env.WEBHOOK_URL ?? '').trim(),
    source: 'stapleport-selfsweep',
    payload: event,
    timeoutMs: 8000,
    log: (m) => console.log(`[selfsweep] ${m}`),
  });
}
