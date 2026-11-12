const esbuild = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
module.exports = function load(relative) {
  const filename = path.resolve(__dirname, '..', relative);
  const result = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] });
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(result.outputFiles[0].text, filename); return loaded.exports;
};
