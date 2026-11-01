// 内部 tick 口单测（调度器集成：binding 唤醒面 worker.fetch——/internal/tick）。
// 断言源=派单钉死语义：正确 token POST=200+执行摘要（含时间戳）；错 token=401（env 未配
// INTERNAL_TICK_TOKEN=fail-closed 也 401）；未知路径=404（/health 存活口既有语义零改动）；
// GET=last_run 只读查询+推进（同 token 门）。executeTick 不 mock——空 env 走「未配置
// TREASURY 空转」早退路径（零外部依赖零副作用，防真跑任务），鉴权/响应形状/锁回落才是本测对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const TOKEN = 'unit-tick-token';
const req = (path, { method = 'POST', token = TOKEN } = {}) =>
  new Request(`https://selfsweep.internal${path}`, { method, headers: token === null ? {} : { 'x-internal-token': token } });

test('tick 口：正确 token POST=200+执行摘要（空 env=未配 TREASURY 空转轮）', async () => {
  const res = await worker.fetch(req('/internal/tick'), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.ok(Number.isFinite(j.at) && j.at > 0, `摘要缺时间戳：${JSON.stringify(j)}`);
  assert.equal(j.executed, true); // 一轮 tick 调用完成（归集本体空转，细节在日志）
});

test('tick 口：锁回落轮 executed=false+reason=tick_locked（55s 默认锁窗内连点）', async () => {
  const res = await worker.fetch(req('/internal/tick'), { INTERNAL_TICK_TOKEN: TOKEN }); // 紧跟上轮
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.executed, false);
  assert.equal(j.reason, 'tick_locked');
});

test('tick 口：错 token=401（含 env 未配 INTERNAL_TICK_TOKEN 的 fail-closed）', async () => {
  const wrong = await worker.fetch(req('/internal/tick', { token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(wrong.status, 401);
  const unset = await worker.fetch(req('/internal/tick'), {});
  assert.equal(unset.status, 401);
  const none = await worker.fetch(req('/internal/tick', { token: null }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(none.status, 401); // 头缺失=不符
});

test('tick 口：未知路径与非 GET/POST 方法一律 404（token 对错不影响）', async () => {
  assert.equal((await worker.fetch(req('/internal/other'), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
  assert.equal((await worker.fetch(req('/nope', { token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
  assert.equal((await worker.fetch(req('/internal/tick', { method: 'DELETE' }), { INTERNAL_TICK_TOKEN: TOKEN })).status, 404);
});

test('tick 口：GET=last_run 只读查询（同 token 门；不触发执行）', async () => {
  const res = await worker.fetch(req('/internal/tick', { method: 'GET' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.last_run && Number.isFinite(j.last_run.at) && j.last_run.at > 0, `last_run 未落：${JSON.stringify(j)}`);
  const bad = await worker.fetch(req('/internal/tick', { method: 'GET', token: 'wrong' }), { INTERNAL_TICK_TOKEN: TOKEN });
  assert.equal(bad.status, 401);
});

test('回归：/health 存活口既有语义零改动（照旧 200 带 service 字段）', async () => {
  const res = await worker.fetch(new Request('https://selfsweep.internal/health'), {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.service, 'stapleport-selfsweep');
});
