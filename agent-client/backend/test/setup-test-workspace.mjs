// 让后端测试永远不写进开发者的真实 workspace：
// 每个测试进程分到自己的临时 workspace 根，退出时清理。
// 必须在任何模块 import ../src/paths.js 之前生效，因此通过 `--import` 预加载。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// biod 决策层在测试中必须是确定性的：不允许连 8790 或 spawn Python。
process.env.BIOFLOW_BIOD_DISABLED = '1';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(backendRoot, '.test-workspace', `pid-${process.pid}`);

fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
process.env.BIOFLOW_WORKSPACE_DIR = testRoot;
process.on('exit', () => {
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果；目录已被 gitignore。
  }
});

// 复刻 src/index.ts 的启动流程：工具子进程（`rg` / `Rscript` / `python`）靠
// `BIOAGENT_ENV_BIN` 找到仓库根的 `.bioenv`。缺了这一步，测试结果就取决于调用者的
// shell 是否激活过 scripts/activate-bioenv.sh——同一个套件在不同终端下结果不同。
// 必须在设好 BIOFLOW_WORKSPACE_DIR 之后再动态 import：该模块会加载 ../src/paths.js。
const { configureBioagentRuntimeEnvironment } = await import('../src/runtime_environment.js');
configureBioagentRuntimeEnvironment(process.env);
