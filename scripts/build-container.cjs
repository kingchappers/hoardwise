const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Compiles the container server (and, through its imports, the API and static handlers), the same way the other build scripts do.
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build/container');
fs.rmSync(outDir, { recursive: true, force: true });

console.log('Compiling container server...');
execSync(
  'tsc container/bin.ts --outDir build/container --module commonjs --skipLibCheck --strict --target es2020 --resolveJsonModule --esModuleInterop',
  { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${path.join(root, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}` } },
);
// The repo root is "type": "module"; this marker lets the compiled CommonJS run. Its dependencies are the only packages the
// image needs at runtime (the rest load lazily and only in Lambda mode), installed here because the runtime stage ships no npm.
const { dependencies, overrides } = require('./sdk-runtime-deps.cjs');
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs', dependencies, overrides }, null, 2) + '\n');
console.log('Installing container runtime dependencies...');
// Needs npm and network access at build time (the Dockerfile's build stage has both).
execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: outDir, stdio: 'inherit' });
fs.rmSync(path.join(outDir, 'package-lock.json'), { force: true });

const entry = path.join(outDir, 'container', 'bin.js');
if (!fs.existsSync(entry)) throw new Error(`Expected ${entry} after compiling`);
console.log('Container server compiled to build/container/container/bin.js');
