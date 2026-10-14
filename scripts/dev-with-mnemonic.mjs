// 本地 dev 包装：给 SelfSweep 注入本地链私钥后起 wrangler dev。
// 用法：node scripts/dev-with-mnemonic.mjs [--print-args] [wrangler 额外参数...]
//
// SWEEP_PRIVATE_KEY 仅本地 31337 用，值=hardhat/anvil 公开测试私钥 acct0
// （公开常量、零价值、仅本地链，见 .dev.vars.example 与 hardhat 默认账户）。
// 生产：wrangler secret put SWEEP_PRIVATE_KEY（本脚本不参与生产）。
// 本脚本不 print 私钥、不写临时文件，只经 --var NAME:value 传参给子进程。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, '..'); // wrangler.jsonc 所在
const ENV_NAME = 'SWEEP_PRIVATE_KEY';
// hardhat/anvil acct0 公开测试私钥（零价值、仅本地 31337 链）。
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// 该公开测试键对应地址（仅供打码展示，公开常量）。
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const userArgs = process.argv.slice(2);
const printArgs = userArgs.includes('--print-args');
const passthrough = userArgs.filter((a) => a !== '--print-args');

const argv = ['npx', 'wrangler', 'dev', '--test-scheduled', ...passthrough, '--var', `${ENV_NAME}:${TEST_KEY}`];

if (printArgs) {
    // 私钥位打码：显示派生地址（公开），不显示私钥。
    const masked = argv.map((a) => (a.startsWith(`${ENV_NAME}:`) ? `${ENV_NAME}:${TEST_ADDR.slice(0, 6)}…${TEST_ADDR.slice(-4)}` : a));
    console.log('[dev-with-mnemonic] cwd:', REPO_DIR);
    console.log('[dev-with-mnemonic] argv:', masked.join(' '));
    console.log(`[dev-with-mnemonic] （${ENV_NAME} 值已打码；上行显示的是公开测试地址，非私钥）`);
    process.exit(0);
}

const child = spawn(argv[0], argv.slice(1), { cwd: REPO_DIR, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
