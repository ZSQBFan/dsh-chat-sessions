#!/usr/bin/env node
// L2：真宿主 + 真原生 plugin manager 的生命周期验收。
//
// 它不做任何模拟——`test-support/native-lifecycle-harness.mjs` 由 Electron 的 node 模式启动，
// import 的是 app.asar 里的真实宿主，停用/启用走的是真实 `pluginManager.setPluginEnabled`。
//
// 前置（缺一项就报 NOT_RUN_BY_ENV 并以非 0 退出——退出码 0 的 skip 不算通过）：
//   LC_NATIVE_HOME     隔离 DSH_HOME 下的一次性目录（例如 <run>/home-native-<ts>）
//   LC_DSH_MODULES     宿主模块根，例如
//                      /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/
//   LC_DSH_APP         宿主可执行文件，默认 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
//   LC_PLUGIN_DIR      被安装的插件目录，默认本仓库根
//   LC_FROM_DEFAULT=1  该 HOME 第一次建 profile 时必填
//
// 也可以直接跑 harness 自己看细节：
//   ELECTRON_RUN_AS_NODE=1 LC_NATIVE_HOME=… LC_DSH_MODULES=… LC_PLUGIN_DIR=… \
//     "$LC_DSH_APP" test-support/native-lifecycle-harness.mjs
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = process.env.LC_DSH_APP ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const MODULES = process.env.LC_DSH_MODULES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
const HOME = process.env.LC_NATIVE_HOME ?? mkdtempSync(path.join(tmpdir(), 'lc-native-home-'));
const PLUGIN_DIR = process.env.LC_PLUGIN_DIR ?? import.meta.dirname;
const PORT = process.env.LC_NATIVE_PORT ?? '62311';

const missing = [];
if (process.env.LC_NATIVE_HOME === undefined) missing.push('LC_NATIVE_HOME');
if (process.env.LC_DSH_MODULES === undefined) missing.push('LC_DSH_MODULES');
// 没有显式环境时不假装跑过：写明缺什么，直接非 0 退出。
if (missing.length > 0 && process.env.LC_NATIVE_ALLOW_SKIP !== '1') {
  console.error(`NOT_RUN_BY_ENV: 缺少 ${missing.join(', ')}。这是真宿主验收，必须给隔离实例的绝对路径。`);
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

test('native host: 停用交接 / 启用恢复 / 重载保号', () => {
  assert.notEqual(payload, null, `harness 没有输出结果行；stderr 尾部：\n${run.err.slice(-4000)}`);
  const failed = payload.checks.filter((entry) => entry.pass !== true);
  assert.deepEqual(failed, [], `失败项：${JSON.stringify(failed, null, 2)}`);
  assert.equal(run.code, 0, `harness 退出码 ${run.code}`);
  assert.equal(payload.ok, true);
});
