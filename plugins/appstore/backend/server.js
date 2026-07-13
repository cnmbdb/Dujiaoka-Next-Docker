const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
app.set('trust proxy', true);

const port = Number(process.env.PORT || 3010);
const title = process.env.APPSTORE_TITLE || 'Dujiaoka AppStore Expand';
const buttonText = process.env.APPSTORE_BUTTON_TEXT || '扩展应用商店';
const statusText = process.env.APPSTORE_STATUS_TEXT || '应用商店扩展开启';
const frontendUrl = process.env.APPSTORE_FRONTEND_URL || 'https://ets.txsw.top';
const frontendLoginPath = process.env.APPSTORE_FRONTEND_LOGIN_PATH || '/login';
const workdir = path.resolve(process.env.APPSTORE_WORKDIR || '/plugin/data');
const requestTimeoutMs = Number(process.env.APPSTORE_REQUEST_TIMEOUT_MS || 120000);
const targetRoot = path.resolve(process.env.APPSTORE_TARGET_ROOT || workdir);
const targetDataDir = path.resolve(process.env.APPSTORE_TARGET_DATA_DIR || path.join(targetRoot, 'data', 'appstore-expand'));
const pluginRoot = path.resolve(process.env.APPSTORE_PLUGIN_ROOT || path.join(targetRoot, 'plugins'));
const catalogApiUrl = process.env.APPSTORE_CATALOG_API_URL || new URL('/api/extensions', frontendUrl).toString();
const dockerComposeFile = process.env.APPSTORE_COMPOSE_FILE || path.join(targetRoot, 'docker-compose.yml');
const defaultCatalogTtlMs = Number(process.env.APPSTORE_CATALOG_TTL_MS || 300000);
const apiToken = String(process.env.APPSTORE_API_TOKEN || '');
const corePluginId = 'appstore';
const coreOnlyPermissions = new Set(['filesystem:plugins', 'docker:manage', 'plugins:manage']);
const skippedLifecyclePluginIds = new Set(String(process.env.APPSTORE_SKIP_LIFECYCLE_PLUGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean));
const devAutoEnablePlugins = String(process.env.APPSTORE_DEV_AUTO_ENABLE || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const publicDir = path.resolve(__dirname, '..', 'public');

const runtimeDir = path.join(workdir, 'runtime');
const downloadsDir = path.join(workdir, 'downloads');
const catalogCacheFile = path.join(runtimeDir, 'catalog-cache.json');
const stateFile = path.join(runtimeDir, 'extension-state.json');
const actionLogFile = path.join(runtimeDir, 'actions.ndjson');
const packagesDir = path.join(targetDataDir, 'packages');
const installsDir = path.join(targetDataDir, 'extensions');
const injectionsDir = path.join(targetDataDir, 'injections');
const embedsDir = path.join(targetDataDir, 'embeds');
const stagingDir = path.join(targetDataDir, 'staging');
const trashDir = path.join(targetDataDir, 'trash');
const pluginRegistryFile = path.join(targetRoot, 'data', 'plugins', 'registry.json');
const pluginNginxDir = path.join(targetRoot, 'data', 'plugins', 'nginx');

let setupPromise = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
}

function sanitizeSegment(value, fallback = 'extension') {
  const base = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || fallback;
}

function slugify(value, fallback = 'extension') {
  return sanitizeSegment(String(value || '').trim().toLowerCase(), fallback);
}

function isCorePlugin(plugin) {
  return String(plugin?.id || plugin?.slug || '').trim() === corePluginId;
}

function safeResolve(base, target = '.') {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(resolvedBase, target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path outside base directory: ${target}`);
  }
  return resolvedTarget;
}

function getProto(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwardedProto || req.protocol || 'http';
}

function getHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
}

function getOrigin(req) {
  return `${getProto(req)}://${getHost(req)}`;
}

function getHostname(req) {
  return getHost(req).replace(/:\d+$/, '');
}

async function ensureSetup() {
  if (!setupPromise) {
    setupPromise = (async () => {
      await Promise.all([
        fsp.mkdir(runtimeDir, { recursive: true }),
        fsp.mkdir(downloadsDir, { recursive: true }),
        fsp.mkdir(packagesDir, { recursive: true }),
        fsp.mkdir(installsDir, { recursive: true }),
        fsp.mkdir(injectionsDir, { recursive: true }),
        fsp.mkdir(embedsDir, { recursive: true })
      ]);
    })().catch(error => {
      setupPromise = null;
      throw error;
    });
  }
  return setupPromise;
}

async function readJson(file, fallback) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function readState() {
  await ensureSetup();
  return readJson(stateFile, { extensions: {} });
}

async function updateState(mutator) {
  const state = await readState();
  const nextState = await mutator(state) || state;
  await writeJson(stateFile, nextState);
  return nextState;
}

async function appendActionLog(entry) {
  await ensureSetup();
  await fsp.appendFile(actionLogFile, JSON.stringify(entry) + '\n', 'utf8');
}

function trimOutput(value, max = 6000) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function buildCommandList(action, extension, payload) {
  const sources = [
    payload?.commands,
    payload?.[`${action}Commands`],
    payload?.[`${action}_commands`],
    payload?.hooks?.[action],
    extension?.raw?.commands,
    extension?.raw?.hooks?.[action],
    extension?.commands,
    extension?.hooks?.[action]
  ].filter(Boolean);

  const list = [];
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === 'string') {
      list.push(source);
      continue;
    }
    if (Array.isArray(source)) {
      for (const item of source) {
        if (item) list.push(item);
      }
      continue;
    }
    if (typeof source === 'object') {
      if (typeof source[action] === 'string' || Array.isArray(source[action])) {
        const nested = source[action];
        if (Array.isArray(nested)) list.push(...nested.filter(Boolean));
        else list.push(nested);
      } else if (source.cmd || source.command) {
        list.push(source);
      }
    }
  }

  return list;
}

async function runCommands(action, extension, payload, extraContext = {}) {
  const commands = buildCommandList(action, extension, payload);
  if (!commands.length) return [];

  const results = [];
  for (const entry of commands) {
    const descriptor = typeof entry === 'string' ? { cmd: entry } : entry;
    const cwd = descriptor.cwd
      ? safeResolve(targetRoot, descriptor.cwd)
      : targetRoot;

    const env = {
      ...process.env,
      APPSTORE_ACTION: action,
      APPSTORE_EXTENSION_ID: String(extension.id),
      APPSTORE_EXTENSION_SLUG: extension.slug,
      APPSTORE_EXTENSION_NAME: extension.name,
      APPSTORE_TARGET_ROOT: targetRoot,
      APPSTORE_TARGET_DATA_DIR: targetDataDir,
      APPSTORE_WORKDIR: workdir,
      APPSTORE_COMPOSE_FILE: dockerComposeFile,
      ...Object.fromEntries(Object.entries(extraContext).map(([key, value]) => [key, String(value)])),
      ...(descriptor.env || {})
    };

    const startedAt = Date.now();
    try {
      let stdout = '';
      let stderr = '';
      if (descriptor.cmd || descriptor.command) {
        const command = descriptor.cmd || descriptor.command;
        const result = await execFileAsync('sh', ['-lc', command], {
          cwd,
          env,
          timeout: requestTimeoutMs,
          maxBuffer: 1024 * 1024 * 8
        });
        stdout = result.stdout || '';
        stderr = result.stderr || '';
      } else if (descriptor.file || descriptor.bin) {
        const file = descriptor.file || descriptor.bin;
        const args = Array.isArray(descriptor.args) ? descriptor.args.map(String) : [];
        const result = await execFileAsync(file, args, {
          cwd,
          env,
          timeout: requestTimeoutMs,
          maxBuffer: 1024 * 1024 * 8
        });
        stdout = result.stdout || '';
        stderr = result.stderr || '';
      } else {
        throw new Error('Unsupported command descriptor');
      }

      results.push({
        ok: true,
        cwd,
        command: descriptor.cmd || descriptor.command || `${descriptor.file || descriptor.bin} ${(descriptor.args || []).join(' ')}`.trim(),
        durationMs: Date.now() - startedAt,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    } catch (error) {
      results.push({
        ok: false,
        cwd,
        command: descriptor.cmd || descriptor.command || `${descriptor.file || descriptor.bin} ${(descriptor.args || []).join(' ')}`.trim(),
        durationMs: Date.now() - startedAt,
        stdout: trimOutput(error.stdout || ''),
        stderr: trimOutput(error.stderr || error.message || ''),
        error: error.message
      });
      throw Object.assign(new Error(`Command failed during ${action}: ${descriptor.cmd || descriptor.command || descriptor.file || descriptor.bin}`), {
        commandResults: results,
        cause: error
      });
    }
  }

  return results;
}

async function fetchJson(url, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCatalog(force = false) {
  await ensureSetup();
  if (!force) {
    try {
      const stat = await fsp.stat(catalogCacheFile);
      if (Date.now() - stat.mtimeMs < defaultCatalogTtlMs) {
        const cached = await readJson(catalogCacheFile, null);
        if (cached && Array.isArray(cached.items)) return cached.items;
      }
    } catch (_ignored) {}
  }

  try {
    const payload = await fetchJson(catalogApiUrl, Math.min(requestTimeoutMs, 30000));
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    await writeJson(catalogCacheFile, { fetchedAt: toIso(), source: catalogApiUrl, items });
    return items;
  } catch (error) {
    const cached = await readJson(catalogCacheFile, { items: [] });
    if (Array.isArray(cached?.items) && cached.items.length) return cached.items;
    throw error;
  }
}

function resolveDownloadUrl(candidate = {}) {
  const fields = [
    candidate.download_url,
    candidate.package_url,
    candidate.archive_url,
    candidate.bundle_url,
    candidate.mirror_url,
    candidate.source_url,
    candidate.url
  ];
  return fields.find(Boolean) || '';
}

function normalizeCatalogExtension(candidate, fallbackId) {
  const id = candidate?.id ?? fallbackId ?? candidate?.name ?? Date.now();
  const name = candidate?.name || candidate?.title || String(id);
  const slug = slugify(candidate?.slug || candidate?.code || candidate?.id || name, `extension-${id}`);
  const version = candidate?.version || candidate?.updated_at || candidate?.created_at || '';
  return {
    id: String(id),
    slug,
    name,
    version: String(version || ''),
    downloadUrl: resolveDownloadUrl(candidate),
    raw: candidate || {}
  };
}

async function resolveExtension(identifier, payload = {}, forceCatalog = false) {
  const explicit = payload.extension && typeof payload.extension === 'object'
    ? normalizeCatalogExtension(payload.extension, identifier)
    : null;
  if (explicit) return explicit;

  const needle = String(identifier || payload.extensionId || payload.id || payload.slug || payload.name || '').trim();
  if (!needle) {
    throw Object.assign(new Error('Missing extension identifier'), { statusCode: 400 });
  }

  const normalizedNeedle = slugify(needle, needle);
  const localPlugin = await readLocalPlugin(normalizedNeedle);
  if (localPlugin) return localPlugin;

  const items = await fetchCatalog(forceCatalog);
  const found = items.find(item => {
    const normalized = normalizeCatalogExtension(item);
    return [normalized.id, normalized.slug, normalized.name, String(item?.code || '')]
      .filter(Boolean)
      .some(value => slugify(value, value) === normalizedNeedle || String(value) === needle);
  });

  if (found) {
    return normalizeCatalogExtension(found, needle);
  }

  const state = await readState();
  const stateEntry = Object.values(state.extensions || {}).find(item => {
    if (!item) return false;
    return [item.id, item.slug, item.name]
      .filter(Boolean)
      .some(value => slugify(value, value) === normalizedNeedle || String(value) === needle);
  });

  if (stateEntry) {
    return normalizeCatalogExtension(stateEntry, needle);
  }

  throw Object.assign(new Error(`Extension not found in catalog: ${needle}`), { statusCode: 404 });
}

function buildFileNameFromUrl(url, fallbackBase) {
  try {
    const parsed = new URL(url);
    const fileName = path.basename(parsed.pathname || '');
    if (fileName && fileName !== '/' && fileName !== '.') return sanitizeSegment(fileName, fallbackBase);
  } catch (_ignored) {}
  return sanitizeSegment(fallbackBase, 'package.bin');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadToFile(url, file) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error('Download failed: empty response body');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
    const stat = await fsp.stat(file);
    return {
      contentType: response.headers.get('content-type') || '',
      size: stat.size,
      sha256: await sha256File(file)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function copyLocalSource(source, dest) {
  const absoluteSource = source.startsWith('file://') ? new URL(source) : source;
  const sourcePath = absoluteSource instanceof URL ? absoluteSource.pathname : safeResolve(targetRoot, absoluteSource);
  const stat = await fsp.stat(sourcePath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (stat.isDirectory()) {
    await fsp.cp(sourcePath, dest, { recursive: true, force: true });
  } else {
    await fsp.copyFile(sourcePath, dest);
  }
  const finalStat = await fsp.stat(dest);
  return {
    contentType: '',
    size: finalStat.size,
    sha256: finalStat.isFile() ? await sha256File(dest) : '',
    sourcePath
  };
}

async function extractPackage(packagePath, releaseDir) {
  await fsp.mkdir(releaseDir, { recursive: true });
  const stat = await fsp.stat(packagePath);
  if (stat.isDirectory()) {
    await fsp.cp(packagePath, releaseDir, { recursive: true, force: true });
    return { mode: 'directory-copy' };
  }

  const lower = packagePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    await execFileAsync('unzip', ['-oq', packagePath, '-d', releaseDir], {
      timeout: requestTimeoutMs,
      maxBuffer: 1024 * 1024 * 8
    });
    return { mode: 'zip-extract' };
  }

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await execFileAsync('tar', ['-xzf', packagePath, '-C', releaseDir], {
      timeout: requestTimeoutMs,
      maxBuffer: 1024 * 1024 * 8
    });
    return { mode: 'tar-gz-extract' };
  }

  if (lower.endsWith('.tar')) {
    await execFileAsync('tar', ['-xf', packagePath, '-C', releaseDir], {
      timeout: requestTimeoutMs,
      maxBuffer: 1024 * 1024 * 8
    });
    return { mode: 'tar-extract' };
  }

  const dest = path.join(releaseDir, path.basename(packagePath));
  await fsp.copyFile(packagePath, dest);
  return { mode: 'file-copy', file: dest };
}

async function writeFileSpecs(baseDir, files) {
  const written = [];
  for (const spec of files) {
    if (!spec || !spec.path) continue;
    const destination = safeResolve(baseDir, spec.path);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const content = spec.encoding === 'base64'
      ? Buffer.from(String(spec.content || ''), 'base64')
      : String(spec.content || '');
    await fsp.writeFile(destination, content);
    written.push(destination);
  }
  return written;
}

async function pathExists(file) {
  return fsp.access(file).then(() => true).catch(() => false);
}

function validatePluginManifest(manifest, expectedSlug = '') {
  if (!manifest || typeof manifest !== 'object') throw new Error('plugin.json must contain an object');
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported plugin schemaVersion');
  const id = slugify(manifest.id, '');
  if (!id || id !== manifest.id) throw new Error('plugin.json id must use lowercase letters, numbers and dashes');
  if (expectedSlug && id !== expectedSlug) throw new Error(`Plugin id mismatch: expected ${expectedSlug}, received ${id}`);
  if (!manifest.name || !manifest.version) throw new Error('plugin.json requires name and version');
  if (!manifest.icon || !String(manifest.icon).startsWith('public/')) {
    throw new Error('plugin.json requires icon pointing to a file inside public/');
  }
  if (!manifest.entrypoints?.compose) throw new Error('plugin.json requires entrypoints.compose');
  for (const action of ['install', 'enable', 'disable', 'uninstall']) {
    const hook = manifest.lifecycle?.[action];
    if (!hook || !String(hook).startsWith('hooks/')) throw new Error(`plugin.json requires lifecycle.${action}`);
  }
  return manifest;
}

function assertInstallPrivileges(manifest) {
  if (manifest.id === corePluginId) return;
  if (manifest.selfManaged === false) {
    throw new Error(`Only ${corePluginId} may declare selfManaged=false`);
  }
  const reservedPermissions = (manifest.permissions || []).filter(permission => coreOnlyPermissions.has(permission));
  if (reservedPermissions.length) {
    throw new Error(`Plugin requests App Store-only permissions: ${reservedPermissions.join(', ')}`);
  }
}

async function readLocalPlugin(slug) {
  const normalizedSlug = slugify(slug, '');
  if (!normalizedSlug) return null;
  const pluginDir = safeResolve(pluginRoot, normalizedSlug);
  const manifestFile = path.join(pluginDir, 'plugin.json');
  if (!(await pathExists(manifestFile))) return null;
  const manifest = validatePluginManifest(await readJson(manifestFile, null), normalizedSlug);
  return {
    ...normalizeCatalogExtension(manifest, normalizedSlug),
    id: normalizedSlug,
    slug: normalizedSlug,
    name: manifest.name,
    version: manifest.version,
    manifest,
    pluginDir,
    raw: manifest
  };
}

async function scanLocalPlugins() {
  await fsp.mkdir(pluginRoot, { recursive: true });
  const entries = await fsp.readdir(pluginRoot, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const plugin = await readLocalPlugin(entry.name);
      if (plugin) plugins.push(plugin);
    } catch (error) {
      plugins.push({
        id: entry.name,
        slug: entry.name,
        name: entry.name,
        version: '',
        pluginDir: safeResolve(pluginRoot, entry.name),
        manifestError: error.message,
        raw: { id: entry.name, name: entry.name }
      });
    }
  }
  return plugins;
}

async function findPackageRoot(stagedPath) {
  if (await pathExists(path.join(stagedPath, 'plugin.json'))) return stagedPath;
  const entries = await fsp.readdir(stagedPath, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  if (directories.length === 1) {
    const nested = path.join(stagedPath, directories[0].name);
    if (await pathExists(path.join(nested, 'plugin.json'))) return nested;
  }
  throw new Error('Plugin package must contain plugin.json at its root');
}

async function runLifecycleHook(extension, action, payload = {}) {
  const local = await readLocalPlugin(extension.slug);
  if (!local) throw Object.assign(new Error(`Plugin is not installed: ${extension.slug}`), { statusCode: 404 });
  if (skippedLifecyclePluginIds.has(local.slug)) {
    return { skipped: true, reason: `Lifecycle hooks are disabled for ${local.slug} in this runtime` };
  }
  const hookRelative = local.manifest.lifecycle?.[action];
  if (!hookRelative) return { skipped: true, reason: `No ${action} hook` };
  const hookFile = safeResolve(local.pluginDir, hookRelative);
  if (!(await pathExists(hookFile))) throw new Error(`Lifecycle hook not found: ${hookRelative}`);

  const startedAt = Date.now();
  const result = await execFileAsync('sh', [hookFile], {
    cwd: local.pluginDir,
    timeout: requestTimeoutMs,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME || '/tmp',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_ID: local.slug,
      PLUGIN_DIR: local.pluginDir,
      PLUGIN_DATA_DIR: path.join(local.pluginDir, 'data'),
      PROJECT_ROOT: targetRoot,
      PLUGIN_REMOVE_DATA: payload.remove_data === true || payload.removeData === true ? '1' : '0'
    }
  });
  return {
    ok: true,
    hook: hookRelative,
    durationMs: Date.now() - startedAt,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  };
}

function publicAssetUrl(plugin, assetPath) {
  const relative = String(assetPath || '').replace(/^public\//, '');
  return `/plugins/${plugin.slug}/static/${relative}`;
}

async function reloadAdminNginx() {
  try {
    const result = await execFileAsync('docker', ['exec', 'dujiao-next-admin', 'nginx', '-s', 'reload'], {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout: trimOutput(result.stdout), stderr: trimOutput(result.stderr) };
  } catch (error) {
    return { ok: false, error: error.message, stderr: trimOutput(error.stderr || '') };
  }
}

async function updatePluginRegistration(plugin, enabled) {
  const registry = await readJson(pluginRegistryFile, { schemaVersion: 1, plugins: {} });
  registry.schemaVersion = 1;
  registry.plugins = registry.plugins || {};
  if (enabled) {
    registry.plugins[plugin.slug] = {
      id: plugin.slug,
      name: plugin.name,
      version: plugin.version,
      enabled: true,
      scripts: (plugin.manifest.entrypoints?.public?.scripts || []).map(asset => publicAssetUrl(plugin, asset)),
      styles: (plugin.manifest.entrypoints?.public?.styles || []).map(asset => publicAssetUrl(plugin, asset)),
      admin: plugin.manifest.entrypoints?.admin || null
    };
  } else {
    delete registry.plugins[plugin.slug];
  }
  registry.updatedAt = toIso();
  await writeJson(pluginRegistryFile, registry);

  await fsp.mkdir(pluginNginxDir, { recursive: true });
  const targetConfig = path.join(pluginNginxDir, `${plugin.slug}.conf`);
  const sourceConfig = path.join(plugin.pluginDir, 'nginx.conf');
  if (enabled && await pathExists(sourceConfig)) {
    await fsp.copyFile(sourceConfig, targetConfig);
  } else {
    await fsp.rm(targetConfig, { force: true });
  }
  return {
    registryFile: pluginRegistryFile,
    nginxConfig: enabled && await pathExists(targetConfig) ? targetConfig : null,
    nginxReload: await reloadAdminNginx()
  };
}

async function syncDevPluginRegistrations() {
  if (!devAutoEnablePlugins.length) return [];
  const results = [];
  const state = await readState();

  for (const slug of devAutoEnablePlugins) {
    const plugin = await readLocalPlugin(slug);
    if (!plugin) continue;
    const existing = state.extensions?.[plugin.slug];
    const enabled = existing ? Boolean(existing.enabled) : true;
    const registration = await updatePluginRegistration(plugin, enabled);

    if (!existing) {
      const enabledAt = toIso();
      await updateState(snapshot => {
        snapshot.extensions[plugin.slug] = {
          id: plugin.id,
          slug: plugin.slug,
          name: plugin.name,
          version: plugin.version,
          installedAt: enabledAt,
          enabled,
          enabledAt,
          lastAction: 'dev-auto-enable',
          lastError: null
        };
        return snapshot;
      });
    }

    results.push({ plugin: plugin.slug, enabled, registration });
  }

  return results;
}

async function summarizeExtensionState(extension) {
  const state = await readState();
  const record = state.extensions?.[extension.slug] || {};
  const installRoot = safeResolve(pluginRoot, extension.slug);
  const injectFile = path.join(injectionsDir, `${extension.slug}.json`);
  const embedFile = path.join(embedsDir, `${extension.slug}.json`);

  const [installExists, injectExists, embedExists] = await Promise.all([
    fsp.access(path.join(installRoot, 'plugin.json')).then(() => true).catch(() => false),
    fsp.access(injectFile).then(() => true).catch(() => false),
    fsp.access(embedFile).then(() => true).catch(() => false)
  ]);

  return {
    extension,
    downloaded: Boolean(record.download?.path),
    installed: installExists || Boolean(record.installedAt),
    injected: injectExists || Boolean(record.injectedAt),
    embedded: embedExists || Boolean(record.embeddedAt),
    enabled: Boolean(record.enabled),
    record,
    paths: {
      installRoot,
      injectFile,
      embedFile
    }
  };
}

async function actionDownload({ extension, payload, actor }) {
  const downloadUrl = payload.download_url || payload.package_url || payload.url || extension.downloadUrl;
  if (!downloadUrl) {
    throw Object.assign(new Error(`No download URL configured for ${extension.name}`), { statusCode: 400 });
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const baseName = buildFileNameFromUrl(downloadUrl, `${extension.slug}-${stamp}.pkg`);
  const packageDir = path.join(packagesDir, extension.slug);
  const destination = path.join(packageDir, `${stamp}-${baseName}`);

  let meta;
  if (/^https?:\/\//i.test(downloadUrl)) {
    meta = await downloadToFile(downloadUrl, destination);
  } else {
    meta = await copyLocalSource(downloadUrl, destination);
  }

  // 标准插件只允许执行包内 manifest 声明的生命周期 hook。
  // 远程目录返回的 commands/hooks 不再在下载阶段执行。
  const commandResults = [];

  const record = {
    action: 'download',
    actor,
    at: toIso(),
    url: downloadUrl,
    path: destination,
    size: meta.size,
    sha256: meta.sha256,
    contentType: meta.contentType,
    commandResults
  };

  await updateState(state => {
    const current = state.extensions?.[extension.slug] || {};
    state.extensions[extension.slug] = {
      ...current,
      id: extension.id,
      slug: extension.slug,
      name: extension.name,
      version: payload.version || extension.version || current.version || '',
      download: record,
      downloadedAt: record.at,
      lastAction: 'download'
    };
    return state;
  });

  await appendActionLog({ extension: extension.slug, ...record });
  return record;
}

async function actionInstall({ extension, payload, actor }) {
  const state = await readState();
  const current = state.extensions?.[extension.slug] || {};
  let packagePath = payload.package_path || payload.packagePath || current.download?.path || '';
  const inlineFiles = Array.isArray(payload.files) ? payload.files : [];
  const installRoot = safeResolve(pluginRoot, extension.slug);
  const existingManifest = path.join(installRoot, 'plugin.json');

  if (!packagePath && !inlineFiles.length && (payload.auto_download === true || Boolean(extension.downloadUrl))) {
    const downloadRecord = await actionDownload({ extension, payload, actor });
    packagePath = downloadRecord.path;
  }

  const releaseName = sanitizeSegment(payload.release || payload.version || extension.version || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14), 'release');
  const releaseDir = path.join(stagingDir, `${extension.slug}-${releaseName}`);
  await fsp.rm(releaseDir, { recursive: true, force: true });

  let extraction = { mode: 'empty' };
  let manifest;
  let backupDir = '';
  const hasExistingPlugin = await pathExists(existingManifest);

  if (!packagePath && !inlineFiles.length && hasExistingPlugin) {
    manifest = validatePluginManifest(await readJson(existingManifest, null), extension.slug);
    extraction = { mode: 'existing-folder' };
  } else if (inlineFiles.length) {
    await fsp.mkdir(releaseDir, { recursive: true });
    await writeFileSpecs(releaseDir, inlineFiles);
    extraction = { mode: 'inline-files', count: inlineFiles.length };
  } else if (packagePath) {
    extraction = await extractPackage(packagePath, releaseDir);
  } else {
    throw Object.assign(new Error(`No install source provided for ${extension.name}`), { statusCode: 400 });
  }

  if (!manifest) {
    const packageRoot = await findPackageRoot(releaseDir);
    manifest = validatePluginManifest(await readJson(path.join(packageRoot, 'plugin.json'), null), extension.slug);
    assertInstallPrivileges(manifest);
    for (const requiredPath of ['docker-compose.yml', '.env.example', 'backend', 'admin', 'public', 'migrations', 'hooks']) {
      if (!(await pathExists(path.join(packageRoot, requiredPath)))) {
        throw new Error(`Plugin package is missing required path: ${requiredPath}`);
      }
    }
    if (!(await pathExists(safeResolve(packageRoot, manifest.icon)))) {
      throw new Error(`Plugin package icon does not exist: ${manifest.icon}`);
    }
    if (hasExistingPlugin && payload.replace !== true && payload.update !== true) {
      throw Object.assign(new Error(`Plugin already exists: ${extension.slug}`), { statusCode: 409 });
    }
    if (extension.slug === 'appstore' && hasExistingPlugin) {
      throw Object.assign(new Error('App Store cannot replace itself; use the host plugin runtime'), { statusCode: 409 });
    }

    if (hasExistingPlugin) {
      const backupRoot = path.join(pluginRoot, '.backups');
      await fsp.mkdir(backupRoot, { recursive: true });
      backupDir = path.join(backupRoot, `${extension.slug}-${releaseName}`);
      await fsp.rm(backupDir, { recursive: true, force: true });
      await fsp.rename(installRoot, backupDir);
    }

    try {
      await fsp.cp(packageRoot, installRoot, { recursive: true, force: true });
    } catch (error) {
      await fsp.rm(installRoot, { recursive: true, force: true });
      if (backupDir) await fsp.rename(backupDir, installRoot);
      throw error;
    } finally {
      await fsp.rm(releaseDir, { recursive: true, force: true });
    }
  }

  const installMeta = {
    extensionId: manifest.id,
    extensionSlug: extension.slug,
    extensionName: manifest.name,
    version: manifest.version,
    release: manifest.version || releaseName,
    installedAt: toIso(),
    installRoot,
    packagePath,
    extraction,
    backupDir,
    enabled: false
  };

  const lifecycle = await runLifecycleHook({ ...extension, slug: manifest.id }, 'install', payload);

  await updateState(stateSnapshot => {
    const existing = stateSnapshot.extensions?.[extension.slug] || {};
    stateSnapshot.extensions[extension.slug] = {
      ...existing,
      id: manifest.id,
      slug: extension.slug,
      name: manifest.name,
      version: manifest.version,
      download: existing.download || null,
      install: {
        ...installMeta,
        lifecycle
      },
      installedAt: installMeta.installedAt,
      enabled: false,
      lastAction: 'install'
    };
    return stateSnapshot;
  });

  await appendActionLog({
    extension: extension.slug,
    actor,
    action: 'install',
    at: installMeta.installedAt,
    installRoot,
    packagePath,
    lifecycle
  });

  return {
    ...installMeta,
    lifecycle
  };
}

async function actionInject({ extension, payload, actor }) {
  const baseDir = payload.target_dir || payload.targetDir
    ? safeResolve(targetRoot, payload.target_dir || payload.targetDir)
    : targetRoot;
  const writtenFiles = Array.isArray(payload.files) && payload.files.length
    ? await writeFileSpecs(baseDir, payload.files)
    : [];

  const manifest = {
    extensionId: extension.id,
    extensionSlug: extension.slug,
    extensionName: extension.name,
    injectedAt: toIso(),
    baseDir,
    files: writtenFiles,
    config: payload.config || {},
    notes: payload.notes || ''
  };

  await writeJson(path.join(injectionsDir, `${extension.slug}.json`), manifest);

  const commandResults = await runCommands('inject', extension, payload, {
    APPSTORE_INJECT_BASE_DIR: baseDir,
    APPSTORE_INJECT_MANIFEST: path.join(injectionsDir, `${extension.slug}.json`)
  });

  await updateState(state => {
    const current = state.extensions?.[extension.slug] || {};
    state.extensions[extension.slug] = {
      ...current,
      id: extension.id,
      slug: extension.slug,
      name: extension.name,
      injectedAt: manifest.injectedAt,
      injection: {
        ...manifest,
        commandResults
      },
      enabled: true,
      lastAction: 'inject'
    };
    return state;
  });

  await appendActionLog({
    extension: extension.slug,
    actor,
    action: 'inject',
    at: manifest.injectedAt,
    files: writtenFiles,
    commandResults
  });

  return {
    ...manifest,
    commandResults
  };
}

async function actionEmbed({ extension, payload, actor }) {
  const manifest = {
    extensionId: extension.id,
    extensionSlug: extension.slug,
    extensionName: extension.name,
    embeddedAt: toIso(),
    route: payload.route || '',
    mount: payload.mount || payload.target || 'admin-topbar-modal',
    iframe: payload.iframe || payload.src || '',
    config: payload.config || {}
  };

  await writeJson(path.join(embedsDir, `${extension.slug}.json`), manifest);

  const commandResults = await runCommands('embed', extension, payload, {
    APPSTORE_EMBED_MANIFEST: path.join(embedsDir, `${extension.slug}.json`)
  });

  await updateState(state => {
    const current = state.extensions?.[extension.slug] || {};
    state.extensions[extension.slug] = {
      ...current,
      id: extension.id,
      slug: extension.slug,
      name: extension.name,
      embeddedAt: manifest.embeddedAt,
      embed: {
        ...manifest,
        commandResults
      },
      enabled: true,
      lastAction: 'embed'
    };
    return state;
  });

  await appendActionLog({
    extension: extension.slug,
    actor,
    action: 'embed',
    at: manifest.embeddedAt,
    route: manifest.route,
    mount: manifest.mount,
    commandResults
  });

  return {
    ...manifest,
    commandResults
  };
}

async function actionCheck({ extension }) {
  return summarizeExtensionState(extension);
}

async function actionEnable({ extension, payload, actor }) {
  const local = await readLocalPlugin(extension.slug);
  if (!local) throw Object.assign(new Error(`Plugin is not installed: ${extension.slug}`), { statusCode: 404 });
  if (isCorePlugin(local)) {
    throw Object.assign(new Error(`${local.name} must be enabled by the host plugin runtime`), { statusCode: 409 });
  }
  const lifecycle = await runLifecycleHook(local, 'enable', payload);
  let registration;
  try {
    registration = await updatePluginRegistration(local, true);
  } catch (error) {
    await runLifecycleHook(local, 'disable', payload).catch(() => {});
    throw error;
  }
  const enabledAt = toIso();
  await updateState(state => {
    const current = state.extensions?.[local.slug] || {};
    state.extensions[local.slug] = {
      ...current,
      id: local.id,
      slug: local.slug,
      name: local.name,
      version: local.version,
      installedAt: current.installedAt || enabledAt,
      enabled: true,
      enabledAt,
      lastAction: 'enable',
      lastError: null
    };
    return state;
  });
  await appendActionLog({ extension: local.slug, actor, action: 'enable', at: enabledAt, lifecycle, registration });
  return { enabled: true, enabledAt, lifecycle, registration };
}

async function actionDisable({ extension, payload, actor }) {
  const local = await readLocalPlugin(extension.slug);
  if (!local) throw Object.assign(new Error(`Plugin is not installed: ${extension.slug}`), { statusCode: 404 });
  if (isCorePlugin(local)) {
    throw Object.assign(new Error(`${local.name} must be disabled by the host plugin runtime`), { statusCode: 409 });
  }
  const registration = await updatePluginRegistration(local, false);
  let lifecycle;
  try {
    lifecycle = await runLifecycleHook(local, 'disable', payload);
  } catch (error) {
    await updatePluginRegistration(local, true).catch(() => {});
    throw error;
  }
  const disabledAt = toIso();
  await updateState(state => {
    const current = state.extensions?.[local.slug] || {};
    state.extensions[local.slug] = {
      ...current,
      id: local.id,
      slug: local.slug,
      name: local.name,
      version: local.version,
      enabled: false,
      disabledAt,
      lastAction: 'disable',
      lastError: null
    };
    return state;
  });
  await appendActionLog({ extension: local.slug, actor, action: 'disable', at: disabledAt, lifecycle, registration });
  return { enabled: false, disabledAt, lifecycle, registration };
}

async function actionUninstall({ extension, payload, actor }) {
  const local = await readLocalPlugin(extension.slug);
  if (!local) throw Object.assign(new Error(`Plugin is not installed: ${extension.slug}`), { statusCode: 404 });
  if (isCorePlugin(local)) {
    throw Object.assign(new Error(`${local.name} must be uninstalled by the host plugin runtime`), { statusCode: 409 });
  }

  const stateBefore = await readState();
  if (stateBefore.extensions?.[local.slug]?.enabled) {
    await actionDisable({ extension: local, payload, actor });
  }
  const lifecycle = await runLifecycleHook(local, 'uninstall', payload);
  const uninstalledAt = toIso();
  let trashPath = '';
  if (payload.delete_files !== false && payload.deleteFiles !== false) {
    await fsp.mkdir(trashDir, { recursive: true });
    trashPath = path.join(trashDir, `${local.slug}-${uninstalledAt.replace(/[-:.TZ]/g, '')}`);
    await fsp.rename(local.pluginDir, trashPath).catch(async error => {
      if (error.code !== 'EXDEV') throw error;
      await fsp.cp(local.pluginDir, trashPath, { recursive: true, force: true });
      await fsp.rm(local.pluginDir, { recursive: true, force: true });
    });
  }

  await updateState(state => {
    const current = state.extensions?.[local.slug] || {};
    state.extensions[local.slug] = {
      ...current,
      enabled: false,
      installedAt: null,
      uninstalledAt,
      trashPath,
      lastAction: 'uninstall',
      lastError: null
    };
    return state;
  });
  await appendActionLog({ extension: local.slug, actor, action: 'uninstall', at: uninstalledAt, lifecycle, trashPath });
  return { installed: false, enabled: false, uninstalledAt, trashPath, lifecycle };
}

async function actionUpdate({ extension, payload, actor }) {
  const before = await summarizeExtensionState(extension);
  const download = await actionDownload({ extension, payload, actor });
  const install = await actionInstall({
    extension,
    payload: {
      ...payload,
      package_path: download.path,
      auto_download: false,
      update: true
    },
    actor
  });
  const enable = before.enabled
    ? await actionEnable({ extension, payload, actor })
    : null;

  return {
    updatedAt: toIso(),
    download,
    install,
    enable
  };
}

const actionHandlers = {
  download: actionDownload,
  check: actionCheck,
  install: actionInstall,
  enable: actionEnable,
  disable: actionDisable,
  uninstall: actionUninstall,
  delete: actionUninstall,
  update: actionUpdate
};

function getActor(req, payload) {
  return {
    requestedBy: payload.requestedBy || req.headers['x-appstore-actor'] || 'admin',
    remoteIp: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
    origin: req.headers.origin || ''
  };
}

function parseActionInput(req) {
  const body = req.body && typeof req.body === 'object' ? { ...req.body } : {};
  const action = req.params.action || body.action;
  const extensionId = req.params.extensionId || body.extensionId || body.extension_id || body.id || body.slug || body.name;
  const payload = body.payload && typeof body.payload === 'object'
    ? { ...body.payload }
    : Object.fromEntries(
        Object.entries(body).filter(([key]) => !['action', 'extensionId', 'extension_id', 'id'].includes(key))
      );
  const forceCatalog = body.forceCatalog === true || body.force === true || body.fresh === true;
  return { action, extensionId, payload, forceCatalog };
}

function mergeCatalogWithState(items, state) {
  return items.map(item => {
    const normalized = normalizeCatalogExtension(item);
    const local = state.extensions?.[normalized.slug] || null;
    return {
      ...item,
      appstore_state: local
        ? {
            downloadedAt: local.downloadedAt || null,
            installedAt: local.installedAt || null,
            injectedAt: local.injectedAt || null,
            embeddedAt: local.embeddedAt || null,
            enabled: Boolean(local.enabled)
          }
        : null
    };
  });
}

function buildPanelContext(req) {
  const panelOrigin = getOrigin(req);
  const frontend = new URL(frontendUrl);
  const iframeUrl = new URL(frontend.toString());
  iframeUrl.searchParams.set('dj_auto_login', '1');
  iframeUrl.searchParams.set('dj_embed', '1');
  iframeUrl.searchParams.set('dj_origin', panelOrigin);
  iframeUrl.searchParams.set('dj_domain', getHostname(req));
  iframeUrl.searchParams.set('dj_host', getHost(req));
  iframeUrl.searchParams.set('dj_login_origin', panelOrigin);
  iframeUrl.searchParams.set('dj_login_domain', getHostname(req));
  iframeUrl.searchParams.set('dj_login_path', frontendLoginPath);
  iframeUrl.searchParams.set('dj_api_base', `${panelOrigin}/plugins/appstore/api`);
  iframeUrl.searchParams.set('dj_panel_base', `${panelOrigin}/plugins/appstore`);
  iframeUrl.searchParams.set('dj_source', 'dujiao-next-admin');

  return {
    panelOrigin,
    frontendOrigin: frontend.origin,
    frontendUrl: iframeUrl.toString(),
    apiBase: `${panelOrigin}/plugins/appstore/api`,
    bridgeToken: apiToken,
    title,
    buttonText,
    statusText,
    frontendLoginPath
  };
}

function renderPanelHtml(req) {
  const context = buildPanelContext(req);
  const theme = String(req.query.theme || '').toLowerCase() === 'light' ? 'light' : 'dark';

  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1018;
      --surface: rgba(10, 16, 28, 0.92);
      --surface-soft: rgba(17, 24, 39, 0.92);
      --border: rgba(148, 163, 184, 0.18);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #22c55e;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f5f7fb;
      --surface: rgba(255, 255, 255, 0.96);
      --surface-soft: rgba(248, 250, 252, 0.96);
      --border: rgba(148, 163, 184, 0.28);
      --text: #0f172a;
      --muted: #475569;
      --accent: #16a34a;
      --shadow: 0 20px 50px rgba(15, 23, 42, 0.12);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      min-height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top left, rgba(34, 197, 94, 0.14), transparent 28%), var(--bg);
    }
    .shell {
      min-height: 100%;
      display: block;
      padding: 0;
      background: transparent;
    }
    .shell-head {
      display: none;
    }
    .shell-title {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .shell-title strong {
      font-size: 13px;
      line-height: 1.1;
    }
    .shell-title span {
      margin-top: 2px;
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .shell-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .shell-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-soft);
      color: inherit;
      text-decoration: none;
      transition: all .18s ease;
    }
    .shell-link:hover {
      border-color: rgba(34, 197, 94, 0.48);
      color: var(--text);
    }
    .shell-body {
      position: relative;
      height: 100vh;
      background: transparent;
    }
    .shell-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: transparent;
      box-shadow: none;
    }
    .shell-fallback {
      position: absolute;
      inset: 18px;
      display: none;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      background: var(--surface);
    }
    .shell-fallback.is-visible {
      display: block;
    }
    .shell-fallback h1 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    .shell-fallback p {
      margin: 0 0 14px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
    }
    @media (max-width: 720px) {
      .shell-head { padding: 0 10px; }
      .shell-title strong { font-size: 12px; }
      .shell-title span { display: none; }
      .shell-actions { gap: 6px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="shell-head">
      <div class="shell-title">
        <strong>${escapeHtml(buttonText)}</strong>
        <span>${escapeHtml(frontendUrl)}</span>
      </div>
      <div class="shell-actions">
        <span>自动登录域名: ${escapeHtml(getHostname(req))}</span>
        <a class="shell-link" href="${escapeHtml(context.frontendUrl)}" target="_blank" rel="noreferrer">新窗口打开</a>
      </div>
    </div>
    <div class="shell-body">
      <iframe
        id="appstore-frame"
        class="shell-frame"
        src="${escapeHtml(context.frontendUrl)}"
        referrerpolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
      ></iframe>
      <section id="shell-fallback" class="shell-fallback">
        <h1>扩展商店前端未能正常加载</h1>
        <p>如果远端站点拒绝被 iframe 嵌入，仍然可以通过新窗口继续访问商店；本地安装、下载、注入、嵌入、更新接口仍由当前容器提供。</p>
        <a class="shell-link" href="${escapeHtml(context.frontendUrl)}" target="_blank" rel="noreferrer">在新窗口打开商店</a>
      </section>
    </div>
  </div>
  <script>
    (function () {
      var cfg = ${JSON.stringify(context)};
      var frame = document.getElementById('appstore-frame');
      var fallback = document.getElementById('shell-fallback');
      var root = document.documentElement;
      var forwardThemeTimer = null;
      var lastTheme = root.getAttribute('data-theme') || '${theme}';

      function setTheme(theme) {
        if (theme !== 'light' && theme !== 'dark') return;
        lastTheme = theme;
        root.setAttribute('data-theme', theme);
      }

      function postToFrontend(message) {
        try {
          if (!frame.contentWindow) return;
          frame.contentWindow.postMessage(message, cfg.frontendOrigin);
        } catch (_ignored) {}
      }

      function buildContextPayload() {
        return {
          type: 'DJ_APPSTORE_CONTEXT',
          context: {
            title: cfg.title,
            buttonText: cfg.buttonText,
            statusText: cfg.statusText,
            apiBase: cfg.apiBase,
            panelOrigin: cfg.panelOrigin,
            frontendOrigin: cfg.frontendOrigin,
            frontendLoginPath: cfg.frontendLoginPath,
            autoLoginOrigin: cfg.panelOrigin
          }
        };
      }

      async function bridgeAction(message) {
        var endpoint = cfg.apiBase + '/extensions/' + encodeURIComponent(message.extensionId || '') + '/' + encodeURIComponent(message.action || '');
        if (!message.extensionId) {
          endpoint = cfg.apiBase + '/extensions/' + encodeURIComponent(message.action || '');
        }

        try {
          var response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-AppStore-Token': cfg.bridgeToken
            },
            body: JSON.stringify({
              extensionId: message.extensionId,
              action: message.action,
              payload: message.payload || {}
            })
          });
          var data = await response.json().catch(function () { return { ok: false, message: 'Invalid JSON response' }; });
          postToFrontend({
            type: 'DJ_APPSTORE_ACTION_RESULT',
            requestId: message.requestId || '',
            ok: response.ok && data.ok !== false,
            data: data
          });
        } catch (error) {
          postToFrontend({
            type: 'DJ_APPSTORE_ACTION_RESULT',
            requestId: message.requestId || '',
            ok: false,
            error: error && error.message ? error.message : 'Bridge request failed'
          });
        }
      }

      async function bridgeCatalog(message) {
        try {
          var response = await fetch(cfg.apiBase + '/extensions', { cache: 'no-store' });
          var data = await response.json();
          postToFrontend({
            type: 'DJ_APPSTORE_EXTENSIONS_RESULT',
            requestId: message.requestId || '',
            ok: response.ok,
            data: data
          });
        } catch (error) {
          postToFrontend({
            type: 'DJ_APPSTORE_EXTENSIONS_RESULT',
            requestId: message.requestId || '',
            ok: false,
            error: error && error.message ? error.message : 'Catalog request failed'
          });
        }
      }

      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (event.origin === cfg.panelOrigin) {
          if (data.type === 'DJ_APPSTORE_THEME') {
            setTheme(data.theme);
            postToFrontend({ type: 'DJ_APPSTORE_THEME', theme: data.theme });
          }
          return;
        }

        if (event.origin !== cfg.frontendOrigin) return;

        if (data.type === 'DJ_APPSTORE_REQUEST_CONTEXT') {
          postToFrontend(buildContextPayload());
          return;
        }
        if (data.type === 'DJ_APPSTORE_GET_EXTENSIONS') {
          bridgeCatalog(data);
          return;
        }
        if (data.type === 'DJ_APPSTORE_ACTION') {
          bridgeAction(data);
          return;
        }
      });

      var fallbackTimer = setTimeout(function () {
        fallback.classList.add('is-visible');
      }, 8000);

      frame.addEventListener('load', function () {
        clearTimeout(fallbackTimer);
        fallback.classList.remove('is-visible');
        postToFrontend({ type: 'DJ_APPSTORE_THEME', theme: lastTheme });
        postToFrontend(buildContextPayload());
      });

      if (forwardThemeTimer) clearInterval(forwardThemeTimer);
      forwardThemeTimer = setInterval(function () {
        postToFrontend({ type: 'DJ_APPSTORE_THEME', theme: lastTheme });
      }, 4000);
    })();
  </script>
</body>
</html>`;
}

function renderManageHtml(req) {
  const theme = String(req.query.theme || '').toLowerCase() === 'dark' ? 'dark' : 'light';
  const context = JSON.stringify({
    apiBase: '/plugins/appstore/api',
    actionToken: apiToken,
    theme
  }).replace(/</g, '\\u003c');
  const template = fs.readFileSync(path.join(publicDir, 'manage.html'), 'utf8');
  return template.replace(
    '<!--APPSTORE_MANAGE_CONTEXT-->',
    `<script>window.__APPSTORE_MANAGE__=${context};</script>`
  );
}

function requireActionToken(req, res, next) {
  if (!apiToken) {
    return res.status(503).json({ ok: false, message: 'APPSTORE_API_TOKEN is not configured' });
  }
  const provided = String(req.headers['x-appstore-token'] || '').trim();
  const expected = Buffer.from(apiToken);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({ ok: false, message: 'Invalid App Store action token' });
  }
  next();
}

function decodeEnvValue(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch (_ignored) {}
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function encodeEnvValue(value) {
  const text = String(value ?? '').replace(/\r?\n/g, '\\n');
  if (!text) return '';
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function parseEnvDocument(content) {
  const values = {};
  const keys = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(values, key)) keys.push(key);
    values[key] = decodeEnvValue(match[2]);
  }
  return { keys, values };
}

function renderEnvDocument(exampleContent, values) {
  const rendered = String(exampleContent || '').split(/\r?\n/).map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match || !Object.prototype.hasOwnProperty.call(values, match[1])) return line;
    return `${match[1]}=${encodeEnvValue(values[match[1]])}`;
  }).join('\n');
  return rendered.replace(/\n*$/, '') + '\n';
}

function isSecretEnvKey(key) {
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)(?:_|$)/i.test(String(key || ''));
}

async function readPluginEnvConfig(pluginId) {
  const normalizedId = slugify(pluginId, '');
  if (!normalizedId || normalizedId !== pluginId) {
    throw Object.assign(new Error('Invalid plugin id'), { statusCode: 400 });
  }
  const plugin = await readLocalPlugin(normalizedId);
  if (!plugin) throw Object.assign(new Error(`Plugin is not installed: ${normalizedId}`), { statusCode: 404 });

  const exampleFile = safeResolve(plugin.pluginDir, '.env.example');
  if (!(await pathExists(exampleFile))) {
    throw Object.assign(new Error(`${plugin.name} does not provide .env.example`), { statusCode: 409 });
  }
  const envFile = safeResolve(plugin.pluginDir, '.env');
  const exampleContent = await fsp.readFile(exampleFile, 'utf8');
  const currentContent = await fsp.readFile(envFile, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const defaults = parseEnvDocument(exampleContent);
  const current = parseEnvDocument(currentContent);
  if (!defaults.keys.length) {
    throw Object.assign(new Error(`${plugin.name} .env.example does not contain configurable keys`), { statusCode: 409 });
  }

  return {
    plugin,
    envFile,
    exampleFile,
    exampleContent,
    fields: defaults.keys.map(key => ({
      key,
      value: Object.prototype.hasOwnProperty.call(current.values, key) ? current.values[key] : defaults.values[key],
      defaultValue: defaults.values[key],
      secret: isSecretEnvKey(key)
    }))
  };
}

async function backupPluginEnv(config) {
  if (!(await pathExists(config.envFile))) return null;
  const backupDir = safeResolve(config.plugin.pluginDir, 'data/env-backups');
  await fsp.mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `${Date.now()}-${crypto.randomUUID()}.env`);
  await fsp.copyFile(config.envFile, backupFile);
  await fsp.chmod(backupFile, 0o600).catch(() => {});
  return backupFile;
}

async function writePluginEnvConfig(pluginId, submittedValues, reset = false) {
  const config = await readPluginEnvConfig(pluginId);
  const allowedKeys = new Set(config.fields.map(field => field.key));
  const values = submittedValues && typeof submittedValues === 'object' ? submittedValues : {};
  const unknownKeys = Object.keys(values).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw Object.assign(new Error(`Unknown environment key: ${unknownKeys[0]}`), { statusCode: 400 });
  }

  await backupPluginEnv(config);
  let content = config.exampleContent;
  if (!reset) {
    const mergedValues = Object.fromEntries(config.fields.map(field => [
      field.key,
      Object.prototype.hasOwnProperty.call(values, field.key) ? String(values[field.key] ?? '') : field.value
    ]));
    content = renderEnvDocument(config.exampleContent, mergedValues);
  }

  const temporaryFile = `${config.envFile}.tmp-${crypto.randomUUID()}`;
  await fsp.writeFile(temporaryFile, content, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporaryFile, config.envFile);
  await fsp.chmod(config.envFile, 0o600).catch(() => {});
  return readPluginEnvConfig(pluginId);
}

function renderPluginConfigHtml(req, plugin) {
  const theme = String(req.query.theme || '').toLowerCase() === 'dark' ? 'dark' : 'light';
  const context = JSON.stringify({
    apiBase: '/plugins/appstore/api',
    actionToken: apiToken,
    pluginId: plugin.id,
    pluginName: plugin.name,
    theme
  }).replace(/</g, '\\u003c');
  const template = fs.readFileSync(path.join(publicDir, 'config.html'), 'utf8');
  return template.replace(
    '<!--APPSTORE_CONFIG_CONTEXT-->',
    `<script>window.__APPSTORE_PLUGIN_CONFIG__=${context};</script>`
  );
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  const allowedOrigin = new URL(frontendUrl).origin;
  if (origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-AppStore-Actor,X-AppStore-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/static', express.static(publicDir));

app.use(['/api/extensions', '/api/plugins'], (req, res, next) => {
  if (req.method !== 'POST') return next();
  return requireActionToken(req, res, next);
});

app.get('/', (_req, res) => {
  res.json({
    service: 'dujiaoka-appstore-expand',
    mode: 'api-container',
    frontendUrl,
    workdir,
    targetRoot,
    targetDataDir
  });
});

app.get('/health', async (_req, res) => {
  await ensureSetup();
  res.json({
    status: 'ok',
    service: 'dujiaoka-appstore-expand',
    mode: 'api-container',
    frontendUrl,
    workdir,
    targetRoot,
    targetDataDir,
    pluginRoot
  });
});

app.get(['/inject.js', '/inject/appstore-expand.js'], async (_req, res, next) => {
  try {
    await ensureSetup();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.type('application/javascript');
    res.send(`window.__APPSTORE_EXPAND__=${JSON.stringify({ title, buttonText, statusText })};\n` +
      fs.readFileSync(path.join(publicDir, 'inject.js'), 'utf8'));
  } catch (error) {
    next(error);
  }
});

app.get('/panel', async (req, res, next) => {
  try {
    await ensureSetup();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html');
    res.send(renderPanelHtml(req));
  } catch (error) {
    next(error);
  }
});

app.get('/manage', async (req, res, next) => {
  try {
    await ensureSetup();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html');
    res.send(renderManageHtml(req));
  } catch (error) {
    next(error);
  }
});

app.get('/plugin-config/:pluginId', async (req, res, next) => {
  try {
    await ensureSetup();
    const pluginId = slugify(req.params.pluginId, '');
    if (!pluginId || pluginId !== req.params.pluginId) {
      throw Object.assign(new Error('Invalid plugin id'), { statusCode: 400 });
    }
    const plugin = await readLocalPlugin(pluginId);
    if (!plugin) throw Object.assign(new Error(`Plugin is not installed: ${pluginId}`), { statusCode: 404 });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html');
    res.send(renderPluginConfigHtml(req, plugin));
  } catch (error) {
    next(error);
  }
});

app.get('/api/extensions', async (req, res, next) => {
  try {
    const localPlugins = await scanLocalPlugins();
    let remoteItems = [];
    try {
      remoteItems = await fetchCatalog(req.query.fresh === '1');
    } catch (error) {
      if (!localPlugins.length) throw error;
    }
    const itemsBySlug = new Map();
    for (const item of remoteItems) {
      const normalized = normalizeCatalogExtension(item);
      itemsBySlug.set(normalized.slug, item);
    }
    for (const local of localPlugins) {
      itemsBySlug.set(local.slug, {
        ...local.raw,
        id: local.id,
        slug: local.slug,
        name: local.name,
        version: local.version,
        local: true,
        plugin_dir: local.pluginDir,
        manifest_error: local.manifestError || null
      });
    }
    const state = await readState();
    res.setHeader('X-AppStore-Source', catalogApiUrl);
    res.json(mergeCatalogWithState(Array.from(itemsBySlug.values()), state));
  } catch (error) {
    next(error);
  }
});

app.get('/api/plugins/local', async (_req, res, next) => {
  try {
    const state = await readState();
    const plugins = await scanLocalPlugins();
    res.json(mergeCatalogWithState(plugins.map(plugin => plugin.raw), state));
  } catch (error) {
    next(error);
  }
});

app.get('/api/plugins/:pluginId/env', requireActionToken, async (req, res, next) => {
  try {
    const config = await readPluginEnvConfig(req.params.pluginId);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
      ok: true,
      plugin: { id: config.plugin.id, name: config.plugin.name, version: config.plugin.version },
      fields: config.fields
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/plugins/:pluginId/env', async (req, res, next) => {
  try {
    const config = await writePluginEnvConfig(req.params.pluginId, req.body?.values, false);
    const at = toIso();
    await appendActionLog({
      extension: config.plugin.slug,
      actor: getActor(req, req.body || {}),
      action: 'config-save',
      at,
      keys: config.fields.map(field => field.key)
    });
    res.json({
      ok: true,
      savedAt: at,
      message: '插件配置已保存',
      plugin: { id: config.plugin.id, name: config.plugin.name, version: config.plugin.version },
      fields: config.fields
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/plugins/:pluginId/env/reset', async (req, res, next) => {
  try {
    const config = await writePluginEnvConfig(req.params.pluginId, {}, true);
    const at = toIso();
    await appendActionLog({
      extension: config.plugin.slug,
      actor: getActor(req, req.body || {}),
      action: 'config-reset',
      at,
      keys: config.fields.map(field => field.key)
    });
    res.json({
      ok: true,
      resetAt: at,
      message: '插件配置已重置为 .env.example 默认值',
      plugin: { id: config.plugin.id, name: config.plugin.name, version: config.plugin.version },
      fields: config.fields
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/plugins/upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res, next) => {
  const uploadStage = path.join(stagingDir, `upload-${crypto.randomUUID()}`);
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw Object.assign(new Error('请选择要上传的插件压缩包'), { statusCode: 400 });
    }

    let originalName = '';
    try {
      originalName = decodeURIComponent(String(req.headers['x-plugin-filename'] || ''));
    } catch (_ignored) {
      originalName = String(req.headers['x-plugin-filename'] || '');
    }
    const fileName = sanitizeSegment(originalName, 'plugin.zip');
    if (!/\.(zip|tar|tgz|tar\.gz)$/i.test(fileName)) {
      throw Object.assign(new Error('仅支持 .zip、.tar、.tgz 或 .tar.gz 插件包'), { statusCode: 400 });
    }

    await fsp.mkdir(uploadStage, { recursive: true });
    const stagedArchive = path.join(uploadStage, fileName);
    await fsp.writeFile(stagedArchive, req.body);
    const extractedDir = path.join(uploadStage, 'extracted');
    await extractPackage(stagedArchive, extractedDir);
    const packageRoot = await findPackageRoot(extractedDir);
    const manifest = validatePluginManifest(await readJson(path.join(packageRoot, 'plugin.json'), null));

    const packageDir = path.join(packagesDir, manifest.id);
    await fsp.mkdir(packageDir, { recursive: true });
    const storedArchive = path.join(packageDir, `${Date.now()}-${fileName}`);
    await fsp.copyFile(stagedArchive, storedArchive);

    const extension = {
      ...normalizeCatalogExtension(manifest, manifest.id),
      id: manifest.id,
      slug: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest,
      raw: manifest
    };
    const install = await actionInstall({
      extension,
      payload: { package_path: storedArchive },
      actor: getActor(req, { requestedBy: 'local-plugin-upload' })
    });

    res.status(201).json({ ok: true, plugin: extension, install });
  } catch (error) {
    next(error);
  } finally {
    await fsp.rm(uploadStage, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('/api/extensions/:extensionId', async (req, res, next) => {
  try {
    const extension = await resolveExtension(req.params.extensionId, {}, req.query.fresh === '1');
    const summary = await summarizeExtensionState(extension);
    res.json({ ok: true, ...summary });
  } catch (error) {
    next(error);
  }
});

app.post('/api/extensions/actions', async (req, res, next) => {
  try {
    const { action, extensionId, payload, forceCatalog } = parseActionInput(req);
    if (!action || !actionHandlers[action]) {
      throw Object.assign(new Error(`Unsupported action: ${action || 'unknown'}`), { statusCode: 400 });
    }
    const shouldResolveExtension = Boolean(extensionId || payload.extension);
    const extension = shouldResolveExtension ? await resolveExtension(extensionId, payload, forceCatalog) : null;
    if (!extension && action !== 'download') {
      throw Object.assign(new Error('extensionId is required'), { statusCode: 400 });
    }
    if (!extension) {
      throw Object.assign(new Error('Unable to resolve extension payload'), { statusCode: 400 });
    }
    const result = await actionHandlers[action]({
      extension,
      payload,
      actor: getActor(req, payload)
    });
    res.json({ ok: true, action, extension: extension || null, result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/extensions/:action', async (req, res, next) => {
  try {
    const { action, payload, forceCatalog } = parseActionInput(req);
    if (!action || !actionHandlers[action]) {
      throw Object.assign(new Error(`Unsupported action: ${action || 'unknown'}`), { statusCode: 400 });
    }
    const extensionId = req.body.extensionId || req.body.extension_id || req.body.id || req.body.slug || req.body.name;
    const extension = await resolveExtension(extensionId, payload, forceCatalog);
    const result = await actionHandlers[action]({
      extension,
      payload,
      actor: getActor(req, payload)
    });
    res.json({ ok: true, action, extension, result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/extensions/:extensionId/:action', async (req, res, next) => {
  try {
    const { action, payload, forceCatalog } = parseActionInput(req);
    if (!action || !actionHandlers[action]) {
      throw Object.assign(new Error(`Unsupported action: ${action || 'unknown'}`), { statusCode: 400 });
    }
    const extension = await resolveExtension(req.params.extensionId, payload, forceCatalog);
    const result = await actionHandlers[action]({
      extension,
      payload,
      actor: getActor(req, payload)
    });
    res.json({ ok: true, action, extension, result });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    ok: false,
    message: error.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
    commandResults: error.commandResults || undefined
  });
});

ensureSetup()
  .then(() => syncDevPluginRegistrations())
  .then(() => {
    app.listen(port, () => {
      console.log(`[appstore-expand] listening on :${port}`);
    });
  })
  .catch(error => {
    console.error('[appstore-expand] failed to initialize', error);
    process.exit(1);
  });
