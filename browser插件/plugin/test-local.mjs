#!/usr/bin/env node
// 本地验证 dsh-tool-browse：不加载 DSH，直接 import 插件、用假 ctx 注册，
// 然后真实执行工具（会驱动本机 Chrome），确认整条链路可用。
//
// 用法： node plugin/test-local.mjs [--live]
//   默认只做静态检查（导出、schema 编译、参数翻译）
//   --live 额外真实调用 browse 工具（会启动/复用 Chrome）
//
// 前置：能解析到 DSH 的插件 SDK（@deepseek-ai/dsh-tools）。装在 DSH 里之后直接跑；
// 在本仓库里跑则需要一个指向 SDK 的软链，脚本结尾会打印具体命令。

import { fileURLToPath } from 'node:url';

const LIVE = process.argv.includes('--live');

let mod;
try {
  mod = await import('./index.mjs');
} catch (e) {
  if (String(e?.message || e).includes('@deepseek-ai/dsh-tools')) {
    console.error('✗ 无法解析 @deepseek-ai/dsh-tools，跳过测试。\n');
    console.error('  本脚本需要一个能 import 到 DSH 插件 SDK 的环境：');
    console.error('    · 或者把本目录装进 profile：node plugin/install.mjs，然后在');
    console.error('      $DSH_HOME/profiles/<profile>/plugins/dsh-tool-browse/ 里跑；');
    console.error('    · 或者在仓库根建软链：');
    console.error('        mkdir -p node_modules');
    console.error('        ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai');
    process.exit(2);
  }
  throw e;
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ---------- 1. 插件导出契约 ----------
check('导出 name', mod.name === 'tool-browse', `name=${mod.name}`);
check('导出 inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject));
check('导出 apply', typeof mod.apply === 'function');
check('导出 buildArgv', typeof mod.buildArgv === 'function');

// ---------- 2. 参数翻译（buildArgv） ----------
const cases = [
  [{ action: 'open', url: 'https://example.cn/a', wait: 2000, json: true }, ['open', 'https://example.cn/a', '--wait', '2000', '--json']],
  [{ action: 'dom', selector: 'table tr', limit: 3, styles: true }, ['dom', 'table tr', '--limit', '3', '--styles']],
  [{ action: 'type', selector: '#q', text: '成都天气', enter: true }, ['type', '#q', '成都天气', '--enter']],
  [{ action: 'net', url: 'https://x.cn', type: 'xhr', bodies: 5 }, ['net', 'https://x.cn', '--type', 'xhr', '--bodies', '5']],
  [{ action: 'shot', out: 'shots/a.png', viewport: true }, ['shot', 'shots/a.png', '--viewport']],
  [{ action: 'status' }, ['status']],
];
for (const [input, expected] of cases) {
  let got;
  try { got = mod.buildArgv(input); } catch (e) { got = `THREW ${e.message}`; }
  check(`buildArgv ${input.action}`, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
}
// 缺少必填参数必须报错
try {
  mod.buildArgv({ action: 'open' });
  check('open 缺 url 应报错', false);
} catch { check('open 缺 url 会报错', true); }
try {
  mod.buildArgv({ action: '不存在' });
  check('未知动作应报错', false);
} catch { check('未知动作会报错', true); }

// ---------- 3. 用假 ctx 走一遍 apply（真实 schema 编译） ----------
let definition = null;
let section = null;
let disposed = 0;
const fakeCtx = {
  tools: { register: (d) => { definition = d; return () => { disposed++; }; } },
  systemPrompt: {
    getSectionOrder: (n) => (n === 'TOOL_WEB_FETCH' ? 2100 : undefined),
    section: (s) => { section = s; return () => {}; },
  },
};
mod.apply(fakeCtx, { scriptPath: fileURLToPath(new URL('../browse.mjs', import.meta.url)) });

check('注册了工具定义', !!definition);
check('工具名 = browse', definition?.name === 'browse', definition?.name);
check('parameters 是 JSON Schema', definition?.parameters?.type === 'object');
check('action 是 required 且带 enum',
  Array.isArray(definition?.parameters?.required) && definition.parameters.required.includes('action')
  && Array.isArray(definition?.parameters?.properties?.action?.enum),
  `enum 数=${definition?.parameters?.properties?.action?.enum?.length}`);
check('output 契约完整', typeof definition?.output?.render === 'function' && !!definition?.output?.schema);
check('声明了超时预算', Number.isFinite(definition?.timeoutMs), `${definition?.timeoutMs}ms`);
check('不可并发（浏览器单例）', definition?.isConcurrencySafe?.() === false);
check('注册了 system prompt 段', section?.name === 'tool:browse' && section?.order === 2100, section?.name);
check('prompt 文案非空', typeof section?.text === 'function' && section.text({}).length > 50);

// ---------- 4. 真实执行（可选） ----------
if (LIVE && definition) {
  const run = async (args) => {
    console.log(`\n--- 真实执行: browse ${args.action}${args.url ? ` ${args.url}` : ''} ---`);
    const t0 = Date.now();
    const value = await definition.execute(args, { signal: undefined });
    const parts = definition.output.render(args, value);
    console.log(`(${Date.now() - t0}ms, ok=${value.ok}, exit=${value.exitCode})`);
    console.log(parts[0].text.split('\n').slice(0, 12).join('\n'));
    return value;
  };

  const st = await run({ action: 'status' });
  check('status 执行成功', st.ok === true);

  const open = await run({ action: 'open', url: 'https://baike.baidu.com/item/人工智能', wait: 1500 });
  check('open 执行成功', open.ok === true);
  check('open 返回了正文', open.output.includes('人工智能'));

  const dom = await run({ action: 'dom', selector: 'h1', limit: 1, json: true });
  check('dom 执行成功', dom.ok === true);

  const outline = await run({ action: 'outline', selector: 'body', depth: 1, limit: 8 });
  check('outline 执行成功', outline.ok === true);

  const bad = await run({ action: 'open', url: 'https://this-host-should-not-resolve.invalid' });
  check('不可达域名返回失败而不是抛异常', bad.ok === false && typeof bad.output === 'string');
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
