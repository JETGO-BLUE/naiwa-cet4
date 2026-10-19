'use strict';

// CI 与发布共用一份清单，并在复制后验证产物里的 manifest 引用。
const fs = require('node:fs');
const path = require('node:path');
const files = require('./runtime-files.json');
const root = path.resolve(__dirname, '..');

function validateRuntime(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const references = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || [])];
  for (const file of new Set([...files, ...references])) {
    if (!files.includes(file)) throw new Error('打包清单缺少 manifest 引用：' + file);
    if (!fs.existsSync(path.join(directory, file))) throw new Error('扩展运行文件缺失：' + file);
  }
  return files.length;
}

function stageRuntime(output) {
  validateRuntime(root);
  const target = path.resolve(output);
  if (target === root || root.startsWith(target + path.sep)) throw new Error('输出目录不能覆盖源码');
  for (const file of files) {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
  validateRuntime(target);
  return target;
}

if (require.main === module) {
  if (process.argv[2] === '--check') console.log('运行文件清单检查通过：' + validateRuntime(root) + ' 个文件');
  else if (process.argv[2]) console.log('扩展已打包到：' + stageRuntime(process.argv[2]));
  else throw new Error('用法：node scripts/package-extension.js --check 或 <输出目录>');
}
module.exports = { files, root, validateRuntime, stageRuntime };
