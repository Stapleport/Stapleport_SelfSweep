// Imputations 合约 calldata 编码与只读调用。签名在 sweep.js 用 viem 账户完成，
// 私钥只在运行时内存出现。ABI 取自 registry.json（源头 Stapleport_hardhat/deployments/all.json）。
// 自建归集固定走 imputationall：多币种多通道一笔打包，费率按合约配置结算
// （用官方合约 = 3% 归协议方；自部署 Imputations = 全部回流自己，见 README 经济账）。
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import registry from '../../registry.json' with { type: 'json' };
import { rpc } from './rpc.js';

export const ABI = registry.contracts.Imputations.abi;

// s_imputationinfo：{ treasury, tokentasks: [{ token, paths }] } —— 多币种共用一笔交易
export function encodeImputationall(treasury, tokenTasks) {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'imputationall',
    args: [{ treasury, tokentasks: tokenTasks }],
  });
}

// 只读调用（view/pure），estimateGas 走 sweep.js 的原始 rpc
export async function callView(rpcUrl, to, functionName, args) {
  const data = encodeFunctionData({ abi: ABI, functionName, args });
  const raw = await rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest']);
  return decodeFunctionResult({ abi: ABI, functionName, data: raw });
}
