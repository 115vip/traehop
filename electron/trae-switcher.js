const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { getPlatformConfig } = require('./platform-config');
const { getTraePath } = require('./account-store');
const { encryptString } = require('./trae-byte-crypto');

const execAsync = promisify(exec);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 切换串行化：killTrae 异步化后若允许重入，两次切换会交叉写 machineid / storage.json，
// 得到的结果账号不可预期。这里用一把锁把「卡死」换成「明确拒绝」。
let switching = false;

const AUTH_PROVIDER_ID = 'icube.cloudide';
const AUTH_KEY = `iCubeAuthInfo://${AUTH_PROVIDER_ID}`;
const ENTITLEMENT_KEY = `iCubeEntitlementInfo://${AUTH_PROVIDER_ID}`;
const SERVER_KEY = `iCubeServerData://${AUTH_PROVIDER_ID}`;

function generateMachineId() {
  return crypto.randomUUID();
}

function md5TelemetryId(input) {
  const h1 = crypto.createHash('sha256').update(input).digest();
  const h2 = crypto.createHash('sha256').update(input + h1.toString('hex')).digest();
  const combined = Buffer.concat([h1.subarray(0, 8), h2.subarray(0, 8)]);
  return combined.toString('hex');
}

function getTraeDataPath() {
  const config = getPlatformConfig();
  if (!config) throw new Error('仅支持 macOS 和 Windows');
  return config.appSupportBase;
}

// 原为 execSync 同步实现：tasklist/taskkill 单次 200~400ms，killTrae 内共调用 4 次，
// 叠加 timeout /t 1 后主进程事件循环被冻结约 2 秒，切换期间窗口完全无响应。
// 改为异步后事件循环可继续响应；唯一外部调用方 switch-check.checkBeforeSwitch 已是 async，同步改为 await 即可。
async function isTraeRunning() {
  if (process.platform === 'darwin') {
    try {
      await execAsync('pgrep -f "Trae.app/Contents/MacOS"', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Trae CN.exe" /NH', {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      return String(stdout || '').includes('Trae CN.exe');
    } catch {
      return false;
    }
  }
  return false;
}

async function killTrae() {
  if (!(await isTraeRunning())) return;

  if (process.platform === 'darwin') {
    try {
      await execAsync('osascript -e \'tell application "Trae" to quit\'', { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    await sleep(1500);
    if (await isTraeRunning()) {
      try {
        await execAsync('pkill -9 -f "Trae.app/Contents/MacOS"', { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
  } else if (process.platform === 'win32') {
    try {
      await execAsync('taskkill /IM Trae CN.exe', { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
    // 原为 execSync('timeout /t 1 /nobreak')：固定阻塞 1 秒且同步。改为不阻塞事件循环的等待。
    await sleep(1000);
    if (await isTraeRunning()) {
      try {
        await execAsync('taskkill /F /IM Trae CN.exe', { stdio: 'ignore', windowsHide: true });
      } catch {
        /* ignore */
      }
    }
  }

  if (await isTraeRunning()) {
    throw new Error('无法关闭 Trae IDE，请手动关闭后重试');
  }
}

function removeIfExists(targetPath, isDir = false) {
  if (!fs.existsSync(targetPath)) return;
  if (isDir) fs.rmSync(targetPath, { recursive: true, force: true });
  else fs.unlinkSync(targetPath);
}

function buildUserInfo(account) {
  const now = new Date();
  const expiredAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const refreshExpiredAt = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  const region = (account.region || 'CN').toUpperCase();
  const host =
    region === 'CN'
      ? 'https://api.trae.com.cn'
      : region === 'US'
        ? 'https://api-us-east.trae.ai'
        : 'https://api-sg-central.trae.ai';

  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');

  return {
    token: account.token,
    refreshToken: account.refreshToken || '',
    expiredAt: fmt(expiredAt),
    refreshExpiredAt: fmt(refreshExpiredAt),
    tokenReleaseAt: fmt(now),
    userId: account.userId,
    host,
    userRegion: { region, _aiRegion: region },
    account: {
      username: account.name,
      iss: '',
      iat: 0,
      organization: '',
      work_country: '',
      email: account.email,
      avatar_url: account.avatarUrl || '',
      description: '',
      scope: 'marscode',
      loginScope: 'trae',
      storeCountryCode: 'cn',
      storeCountrySrc: 'uid',
      storeRegion: region,
      userTag: 'row',
    },
  };
}

function buildEntitlementInfo() {
  return {
    identityStr: 'Free',
    identity: 0,
    isPayFreshman: false,
    isSupportCommercialization: true,
    hasPackage: false,
    enableEntitlement: true,
    detail: {
      can_gen_solo_code: false,
      fast_request_per: 1,
      in_wait: false,
      permission: 1,
      toast_read: false,
      toastRead: false,
      canGenSoloCode: false,
      fastRequestPer: 1,
      inWaitlist: false,
    },
  };
}

async function writeTraeLoginInfo(traePath, account) {
  const storageDir = path.join(traePath, 'User', 'globalStorage');
  fs.mkdirSync(storageDir, { recursive: true });
  const storagePath = path.join(storageDir, 'storage.json');

  let json = {};
  if (fs.existsSync(storagePath)) {
    try {
      json = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } catch {
      json = {};
    }
  }

  if (account.encryptedAuth && account.encryptedAuth.startsWith('dGMF')) {
    json[AUTH_KEY] = account.encryptedAuth;
  } else {
    const userInfo = buildUserInfo(account);
    json[AUTH_KEY] = await encryptString(JSON.stringify(userInfo));
  }

  if (account.encryptedEntitlement && account.encryptedEntitlement.startsWith('dGMF')) {
    json[ENTITLEMENT_KEY] = account.encryptedEntitlement;
  } else {
    json[ENTITLEMENT_KEY] = await encryptString(JSON.stringify(buildEntitlementInfo()));
  }

  if (account.encryptedServerData) {
    json[SERVER_KEY] = account.encryptedServerData;
  }

  fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
}

function resolveTraeAppPath() {
  const saved = getTraePath();
  if (saved && fs.existsSync(saved)) return saved;

  const config = getPlatformConfig();
  if (!config) throw new Error('未设置 Trae IDE 路径');

  if (process.platform === 'darwin') {
    const candidates = [
      config.defaultTraeApp,
      path.join(require('os').homedir(), 'Applications/Trae.app'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  if (saved) throw new Error('Trae IDE 路径无效，请在设置中重新配置');
  throw new Error('未找到 Trae IDE，请在设置中配置路径');
}

function openTrae() {
  const appPath = resolveTraeAppPath();
  if (process.platform === 'darwin') {
    spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
  }
}

function clearLoginCache(traePath) {
  const globalStorage = path.join(traePath, 'User', 'globalStorage');
  removeIfExists(path.join(globalStorage, 'state.vscdb.backup'));
  removeIfExists(path.join(traePath, 'Cookies-journal'));
  removeIfExists(path.join(traePath, 'Network', 'Cookies-journal'));
}

async function switchTraeAccount(account) {
  if (switching) throw new Error('切换正在进行中，请等待当前切换完成后再试');
  switching = true;
  try {
    return await doSwitchTraeAccount(account);
  } finally {
    switching = false;
  }
}

// 切换是「先写 machineid，再写 storage.json」的多步写操作。任何一步抛错都会留下
// machineid 已换、登录信息没换（或反之）的半切换状态，Trae 再启动时登录态就错乱了。
// 这里在动手之前快照两份文件，失败时整体回滚。
function snapshotTraeState(traePath) {
  const machineIdPath = path.join(traePath, 'machineid');
  const storagePath = path.join(traePath, 'User', 'globalStorage', 'storage.json');
  return {
    machineIdPath,
    storagePath,
    machineId: fs.existsSync(machineIdPath) ? fs.readFileSync(machineIdPath) : null,
    storage: fs.existsSync(storagePath) ? fs.readFileSync(storagePath) : null,
  };
}

function restoreTraeState(snapshot) {
  const restoreFile = (target, content) => {
    if (content === null) {
      removeIfExists(target);
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  try {
    restoreFile(snapshot.machineIdPath, snapshot.machineId);
    restoreFile(snapshot.storagePath, snapshot.storage);
  } catch (err) {
    // 回滚失败要大声说出来：此时磁盘上是半切换状态，用户需要知道手动检查
    console.warn('回滚 Trae 配置失败，请手动检查 machineid 与 storage.json:', err.message);
  }
}

async function doSwitchTraeAccount(account) {
  await killTrae();

  const traePath = getTraeDataPath();
  const snapshot = snapshotTraeState(traePath);
  try {
    return await applyTraeSwitch(traePath, account);
  } catch (err) {
    restoreTraeState(snapshot);
    throw new Error(`切换失败，已回滚 Trae 配置：${err.message}`);
  }
}

async function applyTraeSwitch(traePath, account) {
  const machineId = account.machineId || generateMachineId();

  fs.writeFileSync(path.join(traePath, 'machineid'), machineId, 'utf8');
  clearLoginCache(traePath);

  const globalStorage = path.join(traePath, 'User', 'globalStorage');
  fs.mkdirSync(globalStorage, { recursive: true });
  const storagePath = path.join(globalStorage, 'storage.json');

  let json = {};
  if (fs.existsSync(storagePath)) {
    try {
      json = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } catch {
      json = {};
    }
  }

  delete json['iCubeAuthInfo://usertag'];

  json['telemetry.machineId'] = md5TelemetryId(machineId);
  json['telemetry.sqmId'] = `{${generateMachineId().toUpperCase()}}`;
  json['telemetry.devDeviceId'] = generateMachineId();

  fs.writeFileSync(storagePath, JSON.stringify(json, null, 2), 'utf8');
  await writeTraeLoginInfo(traePath, account);

  // 原版为 execSync('sleep 0.5')：Windows cmd 无 sleep 命令，会抛错并中断后续 openTrae()，
  // 导致"切换实际成功却弹红色报错"。改为跨平台的无阻塞等待。
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    openTrae();
  } catch (err) {
    console.warn('自动打开 Trae 失败:', err.message);
  }

  return { machineId };
}

function scanTraePath() {
  const config = getPlatformConfig();
  if (!config) throw new Error('当前平台不支持');

  if (process.platform === 'darwin') {
    const candidates = [
      config.defaultTraeApp,
      path.join(require('os').homedir(), 'Applications/Trae.app'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error('未找到 Trae.app，请手动选择');
  }

  if (process.platform === 'win32') {
    for (const p of config.traeAppCandidates || [config.defaultTraeApp]) {
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error('请手动设置 Trae IDE 路径');
}

module.exports = {
  switchTraeAccount,
  scanTraePath,
  getTraeDataPath,
  isTraeRunning,
  openTrae,
  AUTH_KEY,
};
