const path = require('path');

// The MCP SDK as a build manifest needs it: the SDK pinned in the root package.json, and npm `overrides` pinning its
// dependencies to the versions yarn.lock installed in the root node_modules (the ones the tests ran against). The build
// installs have no lockfile, so without the overrides they would take the newest matching release at build time.
const root = path.join(__dirname, '..');
const sdk = '@modelcontextprotocol/server';
const transitive = ['@modelcontextprotocol/core', 'zod'];

const installedVersion = name => require(path.join(root, 'node_modules', name, 'package.json')).version;

module.exports = {
  dependencies: { [sdk]: require(path.join(root, 'package.json')).dependencies[sdk] },
  overrides: Object.fromEntries(transitive.map(name => [name, installedVersion(name)])),
};
