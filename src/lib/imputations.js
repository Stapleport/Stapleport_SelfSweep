// Imputations 合约参数组装 / 解码（薄壳，2026-09-16 收编 @stapleport/collect-kit）。
// 通道命名/解码正典在 kit（与网页「密语-编号」通道完全对上账）；ABI 是本仓 registry 的
// 数据，留在本文件导出。
import registry from '../../registry.json' with { type: 'json' };

export const imputationsAbi = registry.contracts.Imputations.abi;

export {
  NATIVE,
  isNative,
  orderToPath,
  buildOrder,
  rangeOrders,
  buildImputationallArgs,
  balanceOfPath,
  paidOfPath,
  receivedOfPath,
  balancesByPath,
  receivedsByPath,
  balancesByTokenPath,
  receivedsByTokenPath,
  accountOfPath,
} from '@stapleport/collect-kit';
