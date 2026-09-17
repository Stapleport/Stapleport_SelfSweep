// 直连链节点的 JSON-RPC 封装。本 Worker 是自建者自己的签名者，写方法（sendRawTransaction）
// 只应出现在本文件调用方；不要把这里的 rpc() 交给任何第三方服务。
// 2026-09-17 起传输层收编 @stapleport/worker-kit（五仓同源归一；kit 只做读写通道，
// 签名面永远留在各签名方仓——本仓）。原 fmtEther 死导出（零消费）随之删除。
export { rpc, fmtNative } from '@stapleport/worker-kit';
