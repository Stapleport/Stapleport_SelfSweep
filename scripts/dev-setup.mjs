// 本地 E2E 准备：给测试私钥注资（hardhat_setBalance）+ 向通道地址打款。
// 用法：node scripts/dev-setup.mjs <imputations地址> <treasury地址> [打款ETH数]
import { rpc } from '../src/lib/rpc.js';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, encodeFunctionData, formatEther } from 'viem';
import { ABI } from '../src/lib/tx.js';

const RPC_URL = 'http://127.0.0.1:8545';
const [imputations, treasury, amountEth = '0.5'] = process.argv.slice(2);
if (!imputations || !treasury) throw new Error('用法: node scripts/dev-setup.mjs <imputations> <treasury> [ETH]');
const payer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

// 1) 给 payer 注资 1000 ETH（hardhat cheat，无需知道富账户私钥）
await rpc(RPC_URL, 'hardhat_setBalance', [payer.address, '0x3635C9ADC5DEA00000']);
console.log(`payer ${payer.address} 注资完成`);

// 2) 算通道地址（密语 260825-000001，与 .dev.vars 号段一致）
const order = '260825-000001';
const path = keccak256(toBytes(order));
const data = encodeFunctionData({ abi: ABI, functionName: 'getwalletadd', args: [treasury, path] });
const channel = await rpc(RPC_URL, 'eth_call', [{ to: imputations, data }, 'latest']);
const channelAddr = '0x' + channel.slice(-40);
console.log(`通道 ${order} path=${path} 地址=${channelAddr}`);

// 3) 打款
const nonce = await rpc(RPC_URL, 'eth_getTransactionCount', [payer.address, 'pending']);
const raw = await payer.signTransaction({ to: channelAddr, value: BigInt(Number(amountEth) * 1e18), nonce: Number(nonce), gasPrice: 1500000000n, gas: 21000n, chainId: 31337 });
const txHash = await rpc(RPC_URL, 'eth_sendRawTransaction', [raw]);
console.log(`打款 tx=${txHash} amount=${amountEth} ETH`);

const bal = await rpc(RPC_URL, 'eth_getBalance', [channelAddr, 'latest']);
const tre = await rpc(RPC_URL, 'eth_getBalance', [treasury, 'latest']);
console.log(`通道余额=${formatEther(BigInt(bal))} ETH / 国库余额=${formatEther(BigInt(tre))} ETH`);
