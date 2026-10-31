const fs = require('fs');
const path = require('path');

// The MCP SDK as a build manifest needs it: the SDK pinned in the root package.json, and npm `overrides` pinning its
// dependencies to the versions yarn.lock installed in the root node_modules (the ones the tests ran against). The build
// installs have no lockfile, so without the overrides they would take the newest matching release at build time.
const root = path.join(__dirname, '..');
const sdk = '@modelcontextprotocol/server';
const transitive = ['@modelcontextprotocol/core', 'zod'];

// The copy nested under the SDK is the one it loads, so it wins over a hoisted copy another package may have pulled in.
function installedVersion(base, name) {
  const candidates = [
    path.join(base, 'node_modules', sdk, 'node_modules', name, 'package.json'),
    path.join(base, 'node_modules', name, 'package.json'),
  ];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error(`${name} is not installed under node_modules (needed by ${sdk}); run \`yarn install\` first.`);
  return JSON.parse(fs.readFileSync(found, 'utf8')).version;
}

module.exports = {
  dependencies: { [sdk]: require(path.join(root, 'package.json')).dependencies[sdk] },
  overrides: Object.fromEntries(transitive.map(name => [name, installedVersion(root, name)])),
  installedVersion,
};
