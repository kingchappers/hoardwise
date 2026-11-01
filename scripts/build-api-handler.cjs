const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sdkRuntime = require('./sdk-runtime-deps.cjs');

// Ensure build/api directory exists
const apiBuildDir = path.join(__dirname, '../build/api');
if (!fs.existsSync(apiBuildDir)) {
  fs.mkdirSync(apiBuildDir, { recursive: true });
}

// Compile TypeScript handler to JavaScript
console.log('Compiling API handler...');
execSync(
  'tsc api-handler.ts --outDir build/api --module commonjs --skipLibCheck --strict --target es2020 --resolveJsonModule --esModuleInterop',
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
);

// Rename api-handler.js to index.js so Lambda can find it with handler "index.handler"
const apiHandlerPath = path.join(apiBuildDir, 'api-handler.js');
const indexPath = path.join(apiBuildDir, 'index.js');
if (fs.existsSync(apiHandlerPath)) {
  fs.renameSync(apiHandlerPath, indexPath);
}

// Create a minimal package.json for npm install to get all dependencies
const packageJsonPath = path.join(apiBuildDir, 'package.json');
const packageJson = {
  name: 'budget-app-api',
  version: '1.0.0',
  dependencies: {
    'jsonwebtoken': '^9.0.3',
    'jwks-rsa': '^3.2.1',
    '@aws-sdk/client-dynamodb': '^3.0.0',
    '@aws-sdk/lib-dynamodb': '^3.0.0',
    ...sdkRuntime.dependencies,
  },
  overrides: sdkRuntime.overrides,
};
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

// Install dependencies in build/api
console.log('Installing Lambda dependencies...');
execSync('npm install --production --ignore-scripts', { cwd: apiBuildDir, stdio: 'inherit' });

// Clean up package.json and package-lock.json (not needed in Lambda)
fs.unlinkSync(packageJsonPath);
const lockFilePath = path.join(apiBuildDir, 'package-lock.json');
if (fs.existsSync(lockFilePath)) {
  fs.unlinkSync(lockFilePath);
}

console.log('✓ API handler compiled to build/api/index.js');
console.log('✓ Dependencies installed to build/api/node_modules/');
