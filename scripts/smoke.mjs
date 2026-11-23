import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(import.meta.dirname, '..');

const REQUIRED_FILES = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'src/main.tsx',
  'src/App.tsx',
  'src/domain/types.ts',
  'src/infrastructure/config.ts',
  'tests/config/config.test.ts',
];

const REQUIRED_SCRIPTS = [
  'typecheck',
  'build',
  'test:config',
  'test:unit',
  'test:service',
  'test:contract',
  'test:e2e:mock',
  'test:browser',
  'test:nonfunc',
  'smoke',
];

let passed = 0;
let failed = 0;

function recordPass(name, detail) {
  passed += 1;
  console.log(`[PASS] ${name}${detail ? ` - ${detail}` : ''}`);
}

function recordFail(name, detail) {
  failed += 1;
  console.error(`[FAIL] ${name}${detail ? ` - ${detail}` : ''}`);
}

function runNpmScript(scriptName) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npm';
  const args = isWin ? ['/c', 'npm', 'run', scriptName] : ['run', scriptName];
  return spawnSync(cmd, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

// 1. Check required files
const missingFiles = REQUIRED_FILES.filter(
  (relPath) => !existsSync(resolve(rootDir, relPath))
);
if (missingFiles.length === 0) {
  recordPass('基线文件检查', `${REQUIRED_FILES.length} 个文件均存在`);
} else {
  recordFail('基线文件检查', `缺失: ${missingFiles.join(', ')}`);
}

// 2. Check required package.json scripts
try {
  const pkg = JSON.parse(
    readFileSync(resolve(rootDir, 'package.json'), 'utf8')
  );
  const scripts = pkg.scripts ?? {};
  const missingScripts = REQUIRED_SCRIPTS.filter((s) => !scripts[s]);
  if (missingScripts.length === 0) {
    recordPass('npm 脚本入口检查', `${REQUIRED_SCRIPTS.length} 个脚本均已配置`);
  } else {
    recordFail('npm 脚本入口检查', `缺失: ${missingScripts.join(', ')}`);
  }
} catch (err) {
  recordFail('npm 脚本入口检查', String(err));
}

// 3. Run typecheck
const typecheckRes = runNpmScript('typecheck');
if (typecheckRes.status === 0) {
  recordPass('npm run typecheck', '退出码 0');
} else {
  recordFail(
    'npm run typecheck',
    `退出码 ${typecheckRes.status}\n${typecheckRes.stderr || typecheckRes.stdout}`
  );
}

// 4. Run build & check dist/index.html
const buildRes = runNpmScript('build');
const distIndexPath = resolve(rootDir, 'dist/index.html');
if (
  buildRes.status === 0 &&
  existsSync(distIndexPath) &&
  statSync(distIndexPath).size > 0
) {
  recordPass('npm run build', '退出码 0，dist/index.html 已生成');
} else {
  recordFail(
    'npm run build',
    `退出码 ${buildRes.status}\n${buildRes.stderr || buildRes.stdout}`
  );
}

// 5. Run L0 config tests
const configTestRes = runNpmScript('test:config');
if (configTestRes.status === 0) {
  recordPass('npm run test:config', '退出码 0');
} else {
  recordFail(
    'npm run test:config',
    `退出码 ${configTestRes.status}\n${configTestRes.stderr || configTestRes.stdout}`
  );
}

console.log(`\nSmoke Summary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
