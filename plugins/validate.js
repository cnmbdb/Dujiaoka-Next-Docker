#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = __dirname;
const requiredDirectories = ['backend', 'admin', 'public', 'migrations', 'hooks'];
const lifecycleActions = ['install', 'enable', 'disable', 'uninstall'];
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function fail(id, message) {
  throw new Error(`[${id}] ${message}`);
}

function assertRelativePath(id, value, label) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    fail(id, `${label} must be a safe relative path`);
  }
}

function validatePlugin(pluginDir) {
  const manifestFile = path.join(pluginDir, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const id = manifest.id || path.basename(pluginDir);
  if (manifest.schemaVersion !== 1) fail(id, 'schemaVersion must be 1');
  if (!idPattern.test(id) || id !== path.basename(pluginDir)) fail(id, 'id must match the plugin folder name');
  if (!manifest.name || !manifest.description) fail(id, 'name and description are required');
  if (!versionPattern.test(manifest.version || '')) fail(id, 'version must be semantic versioning');
  if (!manifest.compatibility?.pluginApi || !manifest.compatibility?.dujiaoNext) fail(id, 'compatibility is required');
  if (!Array.isArray(manifest.permissions)) fail(id, 'permissions must be an array');

  for (const directory of requiredDirectories) {
    if (!fs.statSync(path.join(pluginDir, directory), { throwIfNoEntry: false })?.isDirectory()) {
      fail(id, `missing directory: ${directory}`);
    }
  }
  assertRelativePath(id, manifest.entrypoints?.compose, 'entrypoints.compose');
  if (!fs.existsSync(path.join(pluginDir, manifest.entrypoints.compose))) fail(id, 'compose file does not exist');

  for (const action of lifecycleActions) {
    const hook = manifest.lifecycle?.[action];
    assertRelativePath(id, hook, `lifecycle.${action}`);
    if (!hook.startsWith('hooks/') || !fs.existsSync(path.join(pluginDir, hook))) {
      fail(id, `missing lifecycle hook: ${action}`);
    }
  }

  const publicEntries = manifest.entrypoints?.public || {};
  for (const [kind, entries] of Object.entries(publicEntries)) {
    if (!Array.isArray(entries)) fail(id, `entrypoints.public.${kind} must be an array`);
    for (const entry of entries) {
      assertRelativePath(id, entry, `entrypoints.public.${kind}`);
      if (!fs.existsSync(path.join(pluginDir, entry))) fail(id, `missing public asset: ${entry}`);
    }
  }
  if (manifest.icon) {
    assertRelativePath(id, manifest.icon, 'icon');
    if (!fs.existsSync(path.join(pluginDir, manifest.icon))) fail(id, `missing icon: ${manifest.icon}`);
  }
  return `${id}@${manifest.version}`;
}

const pluginDirs = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'plugin.json')))
  .map(entry => path.join(root, entry.name));

if (!pluginDirs.length) throw new Error('No plugins found');
const validated = pluginDirs.map(validatePlugin);
console.log(`Validated ${validated.length} plugins: ${validated.join(', ')}`);
