#!/usr/bin/env node
// 把 dsh-tool-browse 安装进一个 DSH profile：
//   1) 把插件 + 整个 CLI（browse.mjs、lib/）拷到 <profile>/plugins/dsh-tool-browse/
//      —— 自包含，装完就不再依赖本仓库的位置，仓库可以随便挪/删
//   2) 在 <profile>/cordis.patch.yml 里追加一条 `- insert:` patch 指向该插件
// 在线 profile 的 patchReload=live，因此会自动重载、无需重启。
//
// 用法：
//   node plugin/install.mjs                     # 安装到 web profile
//   node plugin/install.mjs --profile web
//   node plugin/install.mjs --dry-run           # 只打印将要做的事
//   node plugin/install.mjs --force             # 覆盖已有条目的配置
//   node plugin/install.mjs --uninstall         # 卸载
//   node plugin/install.mjs --script /path/to/browse.mjs   # 用别处的 CLI（不推荐）

import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { buildEntry, hasEntry, removeEntry, upsertEntry } from './patch-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const PLUGIN_ID = 'tool-browse';
const PLUGIN_PKG = 'dsh-tool-browse';

const profile = opt('--profile', 'web');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profile);
const patchFile = join(profileDir, 'cordis.patch.yml');
const pluginDir = join(profileDir, 'plugins', PLUGIN_PKG);

const dryRun = has('--dry-run');
const uninstall = has('--uninstall');
const force = has('--force');

/** 仓库里的 CLI 源文件。 */
const srcCli = join(ROOT, 'browse.mjs');
const srcLib = join(ROOT, 'lib');

/** 安装后 CLI 落在插件目录内，`config.scriptPath` 指向它。 */
const installedScript = join(pluginDir, 'browse.mjs');

/** --script 可覆盖（例如想复用仓库里那份，方便改代码即时生效）。 */
const scriptPath = resolve(opt('--script', installedScript));

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`错误：${msg}`);
  process.exit(1);
};

// ---------- 前置检查 ----------
if (!existsSync(profileDir)) {
  die(`找不到 profile 目录：${profileDir}\n（用 --profile <名字> 指定；DSH_HOME=${dshHome}）`);
}
if (!existsSync(patchFile)) {
  die(`找不到 ${patchFile}；请先让该 profile 至少启动过一次，再重试。`);
}
if (!uninstall) {
  if (!existsSync(srcCli)) die(`找不到 ${srcCli}；请确认 install.mjs 位于 <仓库>/plugin/ 下。`);
  if (!existsSync(srcLib)) die(`找不到 ${srcLib}；browse.mjs 依赖 lib/ 目录。`);
}

const original = readFileSync(patchFile, 'utf8');

// ---------- 卸载 ----------
if (uninstall) {
  log(`profile:  ${profileDir}`);
  const after = removeEntry(original);
  if (after !== original) {
    if (dryRun) log('[dry-run] 会从 cordis.patch.yml 移除 tool-browse 条目');
    else {
      writeBackup(patchFile, original);
      writeFileSync(patchFile, after);
      log('✅ 已从 cordis.patch.yml 移除条目');
    }
  } else {
    log('ℹ️  cordis.patch.yml 里没有该条目');
  }
  if (existsSync(pluginDir)) {
    if (dryRun) log(`[dry-run] 会删除 ${pluginDir}`);
    else {
      rmSync(pluginDir, { recursive: true, force: true });
      log(`✅ 已删除 ${pluginDir}（含已拷贝的 browse.mjs 与 lib/）`);
    }
  }
  log('完成。live patch 会自动重载，工具随即从模型工具列表中消失。');
  process.exit(0);
}

// ---------- 安装 ----------
const entry = buildEntry({ scriptPath, pluginPath: join(pluginDir, 'index.mjs') });
const already = hasEntry(original);
const patched = already && !force ? original : upsertEntry(original, entry);
const patchChanged = patched !== original;

const libFiles = existsSync(srcLib) ? readdirSync(srcLib).filter((f) => f.endsWith('.mjs')) : [];

log(`profile:   ${profileDir}`);
log(`插件目录:  ${pluginDir}`);
log(`CLI 脚本:  ${scriptPath}`);
log(`patch:     ${already ? (force ? '覆盖已有条目' : '已存在，保持不变（--force 可覆盖）') : '新增 insert 条目'}`);
log(`dry-run:   ${dryRun ? '是（不写任何文件）' : '否'}`);
log('');

if (dryRun) {
  log('--- 将要写入 cordis.patch.yml 的片段 ---');
  log(entry);
  log('--- 将要复制的文件 ---');
  log(`${join(HERE, 'index.mjs')}   →  ${join(pluginDir, 'index.mjs')}`);
  log(`${join(HERE, 'package.json')} →  ${join(pluginDir, 'package.json')}`);
  if (scriptPath === installedScript) {
    log(`${srcCli}          →  ${installedScript}`);
    for (const f of libFiles) log(`${join(srcLib, f)} →  ${join(pluginDir, 'lib', f)}`);
  } else {
    log('（CLI 用 --script 指定，不拷贝）');
  }
  process.exit(0);
}

// 1) 插件本体
mkdirSync(pluginDir, { recursive: true });
copyFileSync(join(HERE, 'index.mjs'), join(pluginDir, 'index.mjs'));
copyFileSync(join(HERE, 'package.json'), join(pluginDir, 'package.json'));
log(`✅ 插件已写入：${join(pluginDir, 'index.mjs')}`);

// 2) CLI 本体（自包含：装完不依赖本仓库）
if (scriptPath === installedScript) {
  copyFileSync(srcCli, installedScript);
  mkdirSync(join(pluginDir, 'lib'), { recursive: true });
  for (const f of libFiles) copyFileSync(join(srcLib, f), join(pluginDir, 'lib', f));
  log(`✅ 浏览器 CLI 已写入：${installedScript}`);
  log(`   （lib/ 共 ${libFiles.length} 个文件；运行时状态会落在 ${join(pluginDir, '.browse')}）`);
}

// 3) patch
if (patchChanged) {
  writeBackup(patchFile, original);
  writeFileSync(patchFile, patched);
  log(`✅ patch 已更新：${patchFile}`);
  log('   （已备份到同目录 .bak-*；patchReload=live，运行中的 harness 会自动重载）');
} else {
  log('ℹ️  patch 未改动。');
}

log('');
log('验证方式：');
log('  · 在会话里调用 browse（例如 {"action":"status"}）');
log(`  · 或看配置树：dsh --profile ${profile} --dump-config | grep -A4 ${PLUGIN_ID}`);
log('  · 单独跑 CLI：node ' + scriptPath + ' status');
log('卸载：');
log(`  node ${join(HERE, 'install.mjs')} --uninstall`);

/** 写备份文件。 */
function writeBackup(file, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = `${file}.bak-${stamp}`;
  writeFileSync(target, content);
  log(`（备份：${target}）`);
}
