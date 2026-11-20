const path = require('path');
const os = require('os');

const DATA_SUBDIRS = [
  'User/globalStorage',
  'User/workspaceStorage',
  'Local Storage',
  'ModularData',
  'logs',
  'ahanet',
  'DIPS',
  'DIPS-wal',
  'SharedStorage',
  'SharedStorage-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
  'Cookies',
  'Cookies-journal',
  'Partitions',
  'Network Persistent State',
];

const WIN_APP_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'CachedData',
  'CachedExtensionVSIXs',
  'CachedConfigurations',
  'CachedProfilesData',
  'blob_storage',
  'Service Worker',
  'Session Storage',
  'WebStorage',
  'Crashpad',
];

function getMacConfig() {
  const home = os.homedir();
  const appSupport = path.join(home, 'Library/Application Support/Trae');
  return {
    platform: 'darwin',
    label: 'macOS',
    appSupportBase: appSupport,
    machineIdPath: path.join(appSupport, 'machineid'),
    defaultTraeApp: '/Applications/Trae.app',
    dataSubdirs: DATA_SUBDIRS,
    cachePaths: [
      path.join(home, 'Library/Caches/com.trae.app'),
      path.join(home, 'Library/Caches/com.trae.app.ShipIt'),
      path.join(home, 'Library/Caches/Trae'),
      path.join(home, 'Library/Saved Application State/com.trae.app.savedState'),
    ],
    winAppCacheDirs: [],
    preferenceFiles: [
      path.join(home, 'Library/Preferences/com.trae.app.plist'),
      path.join(home, 'Library/Preferences/com.trae.app.helper.plist'),
    ],
  };
}

function getWinConfig() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appSupport = path.join(appData, 'Trae CN');

  const programFiles = process.env.ProgramFiles || path.join('C:', 'Program Files');
  const programFilesX86 = process.env['ProgramFiles(x86)'] || `${programFiles} (x86)`;
  const traeAppCandidates = [
    path.join(localAppData, 'Programs', 'Trae CN', 'Trae CN.exe'),
    path.join(programFiles, 'Trae CN', 'Trae CN.exe'),
    path.join(programFilesX86, 'Trae CN', 'Trae CN.exe'),
  ];

  return {
    platform: 'win32',
    label: 'Windows',
    appSupportBase: appSupport,
    machineIdPath: path.join(appSupport, 'machineid'),
    defaultTraeApp: traeAppCandidates[0],
    traeAppCandidates,
    dataSubdirs: DATA_SUBDIRS,
    cachePaths: [
      path.join(localAppData, 'Trae CN'),
      path.join(localAppData, 'trae-updater'),
      path.join(localAppData, 'com.trae.app'),
    ],
    winAppCacheDirs: WIN_APP_CACHE_DIRS,
    preferenceFiles: [],
  };
}

function getPlatformConfig() {
  if (process.platform === 'darwin') return getMacConfig();
  if (process.platform === 'win32') return getWinConfig();
  return null;
}

function getScanPaths(config) {
  const paths = [config.appSupportBase, ...config.cachePaths];
  if (config.winAppCacheDirs.length) {
    for (const dir of config.winAppCacheDirs) {
      paths.push(path.join(config.appSupportBase, dir));
    }
  }
  return [...new Set(paths)];
}

module.exports = { getPlatformConfig, getScanPaths };
