// cordis.patch.yml 的纯文本增删逻辑（无副作用，便于脱离 profile 单测）。
//
// 语义依据 dsh-app-boot 的 applyEntryPatches：
//   · 带 id 的条目 = 覆盖已有条目（target by id）
//   · 新增插件必须用 `- insert:` 列表
// 因此这里生成/匹配的都是 insert 形式。

const ID = 'tool-browse';
const MARK = 'dsh-tool-browse：本地 Chrome 浏览工具';

/** 文件里是否已有该条目。 */
export function hasEntry(text) {
  return new RegExp(`^\\s*-\\s*id:\\s*${ID}\\s*$`, 'm').test(text);
}

/** 生成要写入的 patch 片段。 */
export function buildEntry({ scriptPath, pluginPath }) {
  return [
    `# ${MARK}（由 plugin/install.mjs 写入）`,
    `- insert:`,
    `    - id: ${ID}`,
    `      name: ${JSON.stringify(pluginPath)}`,
    `      config:`,
    `        scriptPath: ${JSON.stringify(scriptPath)}`,
    `        timeoutMs: 180000`,
    ``,
  ].join('\n');
}

/** 移除该条目（含其说明注释），并清理因此变空的 insert 块。 */
export function removeEntry(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (new RegExp(`^\\s*-\\s*id:\\s*${ID}\\s*$`).test(line)) {
      const idIndent = line.search(/\S/);
      i++;
      while (i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > idIndent)) i++;
      i--;
      continue;
    }
    if (line.includes(MARK)) continue;
    out.push(line);
  }
  const cleaned = [];
  for (let i = 0; i < out.length; i++) {
    if (/^-\s*insert:\s*$/.test(out[i])) {
      let j = i + 1;
      while (j < out.length && out[j].trim() === '') j++;
      // 后面没有更深的列表项 → 这个 insert 块已经空了，丢掉
      if (out[j] === undefined || !/^\s{2,}-\s/.test(out[j])) continue;
    }
    cleaned.push(out[i]);
  }
  return `${cleaned.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}

/** 追加或覆盖条目。 */
export function upsertEntry(text, entryBlock) {
  const base = hasEntry(text) ? removeEntry(text) : text;
  return `${base.replace(/\s*$/, '')}\n\n${entryBlock}`;
}
