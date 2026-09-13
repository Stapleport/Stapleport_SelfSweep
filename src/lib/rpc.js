// 直连链节点的 JSON-RPC 封装。本 Worker 是自建者自己的签名者，写方法（sendRawTransaction）
// 只应出现在本文件调用方；不要把这里的 rpc() 交给任何第三方服务。
export async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const { result, error } = await res.json();
  if (error) throw new Error(`rpc ${method}: ${error.message}`);
  return result;
}

export const fmtNative = (wei) => `${Number(BigInt(wei) / 10n ** 12n) / 1e6}`;
export const fmtEther = (wei) => `${Number(BigInt(wei) / 10n ** 14n) / 1e4}`;
