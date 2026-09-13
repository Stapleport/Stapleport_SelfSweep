// config.js 纯函数单测：node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvList, parseMinSweep, humanToRaw, resolveOrders, loadConfig, isAddress } from '../src/config.js';
import { NATIVE } from '../src/lib/imputations.js';

test('parseCsvList：小写化 + 去空', () => {
  assert.deepEqual(parseCsvList(' A, b ,,0xABC '), ['a', 'b', '0xabc']);
  assert.deepEqual(parseCsvList(''), []);
  assert.deepEqual(parseCsvList(null), []);
});

test('parseMinSweep：native 别名 + 非法回落', () => {
  const m = parseMinSweep('{"native":"0.01","0xAbC0000000000000000000000000000000000001":"100"}');
  assert.equal(m.get(NATIVE), '0.01');
  assert.equal(m.get('0xabc0000000000000000000000000000000000001'), '100');

  // 非法 JSON / 空串 → 默认原生币 0.01
  for (const bad of ['', 'not json', '{}', '{"native":"-5"}', '{"native":"abc"}']) {
    const fb = parseMinSweep(bad);
    assert.equal(fb.get(NATIVE), '0.01');
  }
  // 数字形式也接受
  assert.equal(parseMinSweep('{"native":0.5}').get(NATIVE), '0.5');
});

test('humanToRaw：按 decimals 缩位、超位截断', () => {
  assert.equal(humanToRaw('0.01', 18), 10n ** 16n);
  assert.equal(humanToRaw('100', 18), 100n * 10n ** 18n);
  assert.equal(humanToRaw('1.5', 6), 1_500_000n);
  assert.equal(humanToRaw('0.1234567', 6), 123456n); // 第 7 位小数截断
  assert.equal(humanToRaw('7', 0), 7n);
  assert.throws(() => humanToRaw('-1', 18));
  assert.throws(() => humanToRaw('0x10', 18));
});

test('resolveOrders：显式 csv 优先，号段含端点且有上限', () => {
  const a = resolveOrders({ CHANNEL_ORDERS: 'shop-000001, shop-000002' });
  assert.deepEqual(a.orders, ['shop-000001', 'shop-000002']);

  const b = resolveOrders({ CHANNEL_SECRET: '260825', CHANNEL_FROM: '3', CHANNEL_TO: '5' });
  assert.deepEqual(b.orders, ['260825-000003', '260825-000004', '260825-000005']);

  // 大区间被钳到 200
  const c = resolveOrders({ CHANNEL_SECRET: 's', CHANNEL_FROM: '1', CHANNEL_TO: '99999' });
  assert.equal(c.orders.length, 200);

  // 无密语无显式 → 空
  assert.deepEqual(resolveOrders({}).orders, []);
});

test('loadConfig：空串回落 + treasury 归一化', () => {
  const good = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const cfg = loadConfig({
    TREASURY: good,
    CHAIN_IDS: '31337, 7156777',
    MIN_SWEEP: '{"native":"0.5"}',
    IMPUTATIONS_31337: '0x528749edd316c3734680889982B278A83b07EB29',
    IMPUTATIONS_999: 'not-an-address', // 非法 → 覆盖无效
  });
  assert.equal(cfg.treasury, good.toLowerCase());
  assert.deepEqual(cfg.chainIds, ['31337', '7156777']);
  assert.equal(cfg.minSweep.get(NATIVE), '0.5');
  assert.equal(cfg.imputations('31337'), '0x528749edd316c3734680889982B278A83b07EB29');
  assert.equal(cfg.imputations('999'), null);
  assert.equal(cfg.bufferX10, 12);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.webhookUrl, null);

  // treasury 空/非法 → null（worker 记 not_configured 后空转）
  assert.equal(loadConfig({ TREASURY: '' }).treasury, null);
  assert.equal(loadConfig({ TREASURY: '0x123' }).treasury, null);
  assert.equal(isAddress(good), true);
});
