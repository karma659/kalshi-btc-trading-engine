#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set(['node_modules', 'past_trades', '.venv-ml', '__pycache__']);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectJavaScriptFiles(backendRoot).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`\nSyntax check failed: ${path.relative(backendRoot, file)}\n`);
    process.stderr.write(result.stderr || result.stdout || '');
  }
}

if (failed) process.exit(1);
console.log(`Syntax OK: ${files.length} JavaScript files`);
