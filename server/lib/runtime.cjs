const path = require('node:path');
const Module = require('node:module');

const repoRoot = path.resolve(__dirname, '..', '..');
const runtimeNodeModules = process.env.CODEX_RUNTIME_NODE_MODULES
  || 'C:\\Users\\Armaa\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules';

function registerRuntimeNodeModules() {
  if (runtimeNodeModules && !Module.globalPaths.includes(runtimeNodeModules)) {
    Module.globalPaths.unshift(runtimeNodeModules);
  }
  if (!module.paths.includes(runtimeNodeModules)) {
    module.paths.push(runtimeNodeModules);
  }
}

function resolveRepoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

module.exports = {
  registerRuntimeNodeModules,
  resolveRepoPath,
  repoRoot,
  runtimeNodeModules
};
