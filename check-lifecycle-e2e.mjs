#!/usr/bin/env node
// 端到端（服务级）：真宿主 + 真插件 + 真原生 plugin manager，跑完整用户路径。
//
//   create → 写入用户文件 → 原生停用 → 会话回到「未分组」（不再被任何 workspace 认领）
//          → 目录/文件/会话日志原样 → 重新启用 → 挂回同一个房间
//
// 与 `check-lifecycle-native.mjs` 的区别：native 那一层断言的是账本与登记的条件语义；
// 这一层断言的是**用户看到的结果**——会话确实不再属于任何工作区、文件一个字节没动、
// 重新启用后仍然是同一批会话。它跑在真宿主上但不开浏览器；浏览器点击路径的证据在
// RUN-20261107-0410/evidence/gui/GUI-RUN.md（停用 → 未分组 → 继续聊天 → 启用恢复 → 重启保号）。
//
// 环境变量与 native 相同（LC_NATIVE_HOME / LC_DSH_MODULES / LC_PLUGIN_DIR / LC_FROM_DEFAULT）。
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = process.env.LC_DSH_APP ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const MODULES = process.env.LC_DSH_MODULES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
const HOME = process.env.LC_NATIVE_HOME ?? mkdtempSync(path.join(tmpdir(), 'lc-e2e-home-'));
const PLUGIN_DIR = process.env.LC_PLUGIN_DIR ?? import.meta.dirname;
const PORT = process.env.LC_NATIVE_PORT ?? '62313';

const missing = [];
if (process.env.LC_NATIVE_HOME === undefined) missing.push('LC_NATIVE_HOME');
if (process.env.LC_DSH_MODULES === undefined) missing.push('LC_DSH_MODULES');
if (missing.length > 0 && process.env.LC_NATIVE_ALLOW_SKIP !== '1') {
  console.error(`NOT_RUN_BY_ENV: 缺少 ${missing.join(', ')}。e2e 必须在隔离实例上跑。`);
  process.exit(1);
}

function runHarness() {
  return new Promise((resolve) => {
    const child = spawn(APP, [path.join(import.meta.dirname, 'test-support', 'native-lifecycle-harness.mjs')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LC_NATIVE_HOME: HOME,
        LC_DSH_MODULES: MODULES,
        LC_PLUGIN_DIR: PLUGIN_DIR,
        LC_NATIVE_PORT: PORT,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => resolve({code, out, err}));
  });
}

const run = await runHarness();
const line = run.out.split('\n').find((entry) => entry.startsWith('@@NATIVE@@ '));
const payload = line === undefined ? null : JSON.parse(line.slice('@@NATIVE@@ '.length));

test('e2e: 停用后回到未分组、文件零改动、启用后挂回', () => {
  assert.notEqual(payload, null, `harness 无结果行；stderr 尾部：\n${run.err.slice(-4000)}`);
  const checks = new Map(payload.checks.map((entry) => [entry.name, entry.pass === true]));
  // 用户可见结果：登记没了（=未分组）、目录与文件在、重启用后还是同一批会话。
  for (const name of [
    'disable-removes-registration',
    'disable-dir-intact',
    'disable-second-dir-intact',
    'disable-archive-persisted',
    'disable-pin-persisted',
    'enable-registers-room',
    'enable-attaches-session',
    'enable-attaches-second-session',
  ]) {
    assert.equal(checks.get(name), true, `子检查 ${name} 未通过；全部结果：${JSON.stringify(payload.checks)}`);
  }
  assert.equal(run.code, 0);

  // 独立文件清单校验：交接只动登记，不动磁盘。
  const {archivedCwd, pinnedCwd} = payload.evidence;
  for (const [dir, expected] of [[archivedCwd, 'native-user-data'], [pinnedCwd, 'native-user-data-2']]) {
    assert.equal(existsSync(path.join(dir, 'keep.txt')), true, `${dir}/keep.txt 不见了`);
    assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), expected);
    assert.equal(existsSync(path.join(dir, 'nested')), true, `${dir}/nested 不见了`);
  }
});
