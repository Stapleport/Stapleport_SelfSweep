// Imputations 合约 calldata 编码与只读调用（薄适配，2026-09-16 收编 @stapleport/collect-kit）。
// 自建归集固定走 imputationall：多币种多通道一笔打包，费率按合约配置结算
// （用官方合约 = 3% 归协议方；自部署 Imputations = 全部回流自己，见 README 经济账）。
import registry from '../../registry.json' with { type: 'json' };
import * as kit from '@stapleport/collect-kit';

export const ABI = registry.contracts.Imputations.abi;

// s_imputationinfo：{ treasury, tokentasks: [{ token, paths }] } —— 多币种共用一笔交易
export const encodeImputationall = kit.encodeImputationallCalldata;

// 只读调用（view/pure），estimateGas 走 sweep.js 的原始 rpc
export const callView = (rpcUrl, to, functionName, args) =>
  kit.callView(rpcUrl, to, ABI, functionName, args);
