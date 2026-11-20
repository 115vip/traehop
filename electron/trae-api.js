// Trae 国内版（Trae CN）为单区域部署，不存在 SG/US 分区。
// 以下基址均取自官方 D:\Program Files\Trae CN\resources\app\product.json：
//   bootConfig.iCube.normal / market.trae / iCubeAgent -> https://api.trae.com.cn
//   bootConfig.ug.trae / account.trae                  -> https://api.trae.cn
//   iCubeApp.nativeAppConfig.authDomain                -> https://www.trae.cn
// 原国际版基址 api-sg-central / api-us-east / ug-normal 在国内版不存在，会导致 fetch failed。
const API_BASE_SG = 'https://api.trae.com.cn';
const API_BASE_US = 'https://api.trae.com.cn';
const API_BASE_UG = 'https://api.trae.cn';
const WEB_ORIGIN = 'https://www.trae.cn';
// 国内版 cookie 换 Token 沿用国际版路径，实测确认（2026-10-21）：
//   POST {api.trae.com.cn|api.trae.cn}/cloudide/api/v3/common/GetUserToken + Cookie 头 -> 200，新 JWT 有效期 8 小时
//   /api/v2/GetUserToken 在国内版返回 404（那是 X-Cloudide-Token 头换 Token 的路径，cookie 方式不可用）
const GET_USER_TOKEN_PATH = '/cloudide/api/v3/common/GetUserToken';
// 国内版积分用量接口（bootConfig.ug.trae.normal 基址 + out/main.js _postApi(uo.ugApi,...)）
const CN_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';

function parseJwtPayload(token) {
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw new Error('无效的 JWT Token 格式');

  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (payload.length % 4)) % 4;
  payload += '='.repeat(pad);

  const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  return {
    userId: json.data?.id || json.sub || '',
    tenantId: json.data?.tenant_id || '',
    exp: json.exp || null,
  };
}

function isTokenExpired(token) {
  try {
    const { exp } = parseJwtPayload(token);
    if (!exp) return false;
    return exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

const SESSION_EXPIRING_SOON_MS = 3600000; // 1 hour — matches Trae token ExpiredAt semantics
const JWT_EXPIRING_SOON_MS = 3600000;

function parseExpiryMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return value > 1e12 ? value : value * 1000;
  }
  const ts = Date.parse(String(value));
  return Number.isNaN(ts) ? null : ts;
}

function getAccountSessionExpiryMs(account) {
  return parseExpiryMs(account?.tokenExpiredAt);
}

function getAccountJwtExpiryMs(token) {
  try {
    const { exp } = parseJwtPayload(token);
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function getAccountDisplayExpiryMs(account) {
  return getAccountSessionExpiryMs(account) ?? getAccountJwtExpiryMs(account?.token);
}

function isAccountTokenExpired(account) {
  if (!account?.token) return false;

  const sessionExp = getAccountSessionExpiryMs(account);
  if (sessionExp) return sessionExp < Date.now();

  if (isTokenExpired(account.token)) {
    return !(account.cookies && account.cookies.trim());
  }
  return false;
}

function isAccountTokenExpiringSoon(account) {
  if (!account?.token || isAccountTokenExpired(account)) return false;

  const sessionExp = getAccountSessionExpiryMs(account);
  if (sessionExp) {
    const remaining = sessionExp - Date.now();
    return remaining > 0 && remaining < SESSION_EXPIRING_SOON_MS;
  }

  // JWT is short-lived; cookie refresh handles it — only warn when refresh is unavailable.
  if (account.cookies && account.cookies.trim()) return false;

  const jwtExp = getAccountJwtExpiryMs(account.token);
  if (!jwtExp || jwtExp <= Date.now()) return false;
  return jwtExp - Date.now() < JWT_EXPIRING_SOON_MS;
}

function cleanCookies(cookies) {
  if (!cookies || typeof cookies !== 'string') return '';
  return cookies
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join('')
    .replace(/  +/g, ' ')
    .trim();
}

function detectApiBaseFromCookies(cookies) {
  const c = cleanCookies(cookies);
  if (c.includes('store-idc=useast') || c.includes('trae-target-idc=useast')) {
    return API_BASE_US;
  }
  if (c.includes('store-idc=alisg') || c.includes('trae-target-idc=alisg')) {
    return API_BASE_SG;
  }
  return API_BASE_SG;
}

function resolveExpiredAt(token, expiredAt) {
  if (expiredAt) return expiredAt;
  try {
    const { exp } = parseJwtPayload(token);
    if (exp) return new Date(exp * 1000).toISOString();
  } catch {
    /* ignore */
  }
  return null;
}

function parseGetUserTokenResponse(data) {
  const result = data?.Result || data?.result;
  if (!result) return null;
  const token = result.Token || result.token;
  if (!token) return null;
  const rawExpiredAt = result.ExpiredAt || result.expired_at || result.expiredAt || null;
  return {
    token,
    expiredAt: resolveExpiredAt(token, rawExpiredAt),
    userId: result.UserID || result.user_id || result.userId || '',
    tenantId: result.TenantID || result.tenant_id || result.tenantId || '',
  };
}

function expiredAtToUnix(expiredAt) {
  if (!expiredAt) return null;
  const ts = Date.parse(expiredAt);
  return Number.isNaN(ts) ? null : Math.floor(ts / 1000);
}

async function getUserToken(cookies) {
  const cleaned = cleanCookies(cookies);
  if (!cleaned) throw new Error('Cookie 为空，无法刷新 Token');

  const bases = [detectApiBaseFromCookies(cleaned), API_BASE_SG, API_BASE_US];
  const seen = new Set();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    Cookie: cleaned,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  let lastError = '刷新 Token 失败';
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);

    try {
      const res = await fetch(`${base}${GET_USER_TOKEN_PATH}`, {
        method: 'POST',
        headers,
        body: '{}',
      });

      if (!res.ok) {
        // 带上响应体里的业务错误码/信息（如 20113 Session 过期），否则 UI 只见裸状态码，
        // 无法区分「会话被吊销需续登」与「网络/服务异常」
        let detail = '';
        try {
          const errBody = await res.json();
          const e = errBody?.ResponseMetadata?.Error;
          if (e?.Code) detail = `（${e.Code} ${e.Message || ''}）`;
        } catch {
          /* 响应体非 JSON 时忽略 */
        }
        lastError = `GetUserToken 返回 ${res.status}${detail}`;
        continue;
      }

      const data = await res.json();
      if (data.ResponseMetadata?.Error?.Code) {
        lastError = data.ResponseMetadata.Error.Message || data.ResponseMetadata.Error.Code;
        continue;
      }

      const parsed = parseGetUserTokenResponse(data);
      if (!parsed) {
        lastError = 'GetUserToken 响应格式无效';
        continue;
      }

      const jwt = parseJwtPayload(parsed.token);
      return {
        ...parsed,
        tokenExp: jwt.exp || expiredAtToUnix(parsed.expiredAt),
      };
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}

// 国内版登录 cookie 的寿命写在 sid_guard 里：sid_guard=<session>%7C<签发秒>%7C<有效期秒>%7C<GMT 串>
// 实测样本：sid_guard=...%7C1792488722%7C5184000%7CSat%2C+19-Dec-2026... -> 签发+60 天到期
function parseCookieExpiryMs(cookies) {
  if (!cookies || typeof cookies !== 'string') return null;
  const m = decodeURIComponent(cookies).match(/sid_guard=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split('|');
  const issuedSec = Number(parts[1]);
  const lifetimeSec = Number(parts[2]);
  if (Number.isFinite(issuedSec) && Number.isFinite(lifetimeSec) && issuedSec > 0 && lifetimeSec > 0) {
    return (issuedSec + lifetimeSec) * 1000;
  }
  const gmt = Date.parse(parts[3] || '');
  return Number.isNaN(gmt) ? null : gmt;
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Authorization: `Cloud-IDE-JWT ${token}`,
  };
}

function normalizeUserInfo(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.Error) return null;
  return {
    name: result.ScreenName || result.screen_name || '',
    email: result.NonPlainTextEmail || result.non_plain_text_email || result.Email || result.email || '',
    avatarUrl: result.AvatarUrl || result.avatar_url || '',
    region: result.Region || result.region || 'CN',
  };
}

function mergeProfile(base, incoming) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

async function getUserInfoWithToken(token) {
  const endpoints = [API_BASE_SG, API_BASE_UG];
  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/cloudide/api/v3/trae/GetUserInfo`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ IfWebPage: true }),
      });
      const data = await res.json();
      if (data.ResponseMetadata?.Error?.Code) continue;
      const profile = normalizeUserInfo(data.Result || data.result);
      if (profile) return profile;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

async function getUserInfoWithCookies(cookies) {
  if (!cookies || !cookies.trim()) return null;
  const endpoints = [API_BASE_SG, API_BASE_UG];
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    Cookie: cookies.trim(),
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}/cloudide/api/v3/trae/GetUserInfo`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ IfWebPage: true }),
      });
      const data = await res.json();
      if (data.ResponseMetadata?.Error?.Code) continue;
      const profile = normalizeUserInfo(data.Result || data.result);
      if (profile?.email || profile?.name) return profile;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

async function resolveUserProfile(token, extras = {}) {
  const jwt = parseJwtPayload(token);
  let profile = {
    name: extras.name || extras.username || '',
    email: extras.email || '',
    avatarUrl: extras.avatarUrl || '',
    region: extras.region || 'CN',
  };

  if (extras.cookies) {
    const fromCookies = await getUserInfoWithCookies(extras.cookies);
    if (fromCookies) profile = mergeProfile(profile, fromCookies);
  }

  if (!profile.email || !profile.avatarUrl) {
    const fromToken = await getUserInfoWithToken(token);
    if (fromToken) profile = mergeProfile(profile, fromToken);
  }

  if (!profile.name) {
    profile.name = profile.email || `User_${jwt.userId.slice(0, 8)}`;
  }

  return {
    userId: jwt.userId,
    tenantId: jwt.tenantId,
    name: profile.name,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    region: profile.region || 'CN',
    tokenExp: jwt.exp,
  };
}

function createEmptySummary(isDollarBilling) {
  return {
    isDollarBilling,
    planType: 'Free',
    resetTime: 0,
    basicUsageUsed: 0,
    basicUsageLimit: 0,
    bonusUsageUsed: 0,
    bonusUsageLimit: 0,
    displayUsed: 0,
    displayLimit: 0,
    displayLeft: 0,
    exhausted: false,
    fastRequestUsed: 0,
    fastRequestLimit: 0,
    fastRequestLeft: 0,
    extraFastRequestUsed: 0,
    extraFastRequestLimit: 0,
    extraFastRequestLeft: 0,
    extraExpireTime: 0,
    extraPackageName: '',
    slowRequestUsed: 0,
    slowRequestLimit: 0,
    slowRequestLeft: 0,
    advancedModelUsed: 0,
    advancedModelLimit: 0,
    advancedModelLeft: 0,
    autocompleteUsed: 0,
    autocompleteLimit: 0,
    autocompleteLeft: 0,
  };
}

function parseEntitlementsToSummary(data) {
  const isDollarBilling = !!data.is_dollar_usage_billing;

  const packs = data.user_entitlement_pack_list || [];

  // 国内版（Trae CN）积分制字段：entitlement_base_info.quota.credits_limit（-1=无限）+ usage.credits_amount。
  // 解析逻辑对照国内版官方 cnCreditsUsage.js（out/main.js 内 NGe 函数）：任一包为 -1 即视为整体无限剩余。
  const isCredits = packs.some(
    (p) => p?.entitlement_base_info?.quota && 'credits_limit' in p.entitlement_base_info.quota
  );
  if (isCredits) {
    let hasAny = false;
    let unlimited = false;
    let limitSum = 0;
    let usedSum = 0;
    let remainSum = 0;
    for (const p of packs) {
      const limit = p?.entitlement_base_info?.quota?.credits_limit;
      const used = p?.usage?.credits_amount ?? 0;
      if (limit === -1) {
        hasAny = true;
        unlimited = true;
      } else if (typeof limit === 'number' && limit > 0) {
        hasAny = true;
        limitSum += limit;
        remainSum += Math.max(limit - used, 0);
      }
      if (typeof limit === 'number' && limit !== 0) usedSum += used;
    }
    if (hasAny) {
      const summary = createEmptySummary(isDollarBilling);
      summary.isCreditsBilling = data.is_credits_billing === true;
      summary.unlimited = unlimited;
      summary.planType = packs[0]?.display_desc || 'Free';
      summary.resetTime = packs[0]?.entitlement_base_info?.end_time || 0;
      summary.displayUsed = usedSum;
      summary.displayLimit = unlimited ? Infinity : limitSum;
      summary.displayLeft = unlimited ? Infinity : remainSum;
      summary.exhausted = false;
      return summary;
    }
  }

  const summary = createEmptySummary(isDollarBilling);

  for (const pack of packs) {
    const base = pack.entitlement_base_info || {};
    const usage = pack.usage || {};
    const quota = base.quota || {};

    if (pack.display_desc) {
      summary.planType = pack.display_desc.replace(/\s*plan$/i, '');
    }

    if (base.product_type === 2) {
      if (isDollarBilling) {
        summary.bonusUsageLimit += quota.bonus_usage_limit || quota.basic_usage_limit || 0;
        summary.bonusUsageUsed += usage.bonus_usage_amount || usage.basic_usage_amount || 0;
      } else {
        summary.extraFastRequestLimit += quota.premium_model_fast_request_limit || 0;
        summary.extraFastRequestUsed += usage.premium_model_fast_amount || 0;
      }
      summary.extraExpireTime = base.end_time || 0;
      const pkgExtra = base.product_extra?.package_extra;
      if (pkgExtra?.package_source_type === 6) {
        summary.extraPackageName = '2026 Anniversary Treat';
      }
    } else {
      if (!pack.display_desc) {
        summary.planType = base.product_id === 0 ? 'Free' : 'Pro';
      }
      summary.resetTime = base.end_time || 0;

      if (isDollarBilling) {
        summary.basicUsageLimit = quota.basic_usage_limit || 0;
        summary.basicUsageUsed = usage.basic_usage_amount || 0;
        summary.bonusUsageLimit = quota.bonus_usage_limit || 0;
        summary.bonusUsageUsed = usage.bonus_usage_amount || 0;
      }

      summary.fastRequestLimit = quota.premium_model_fast_request_limit || 0;
      summary.fastRequestUsed = usage.premium_model_fast_request_usage ?? usage.premium_model_fast_amount ?? 0;
      summary.fastRequestLeft = summary.fastRequestLimit - summary.fastRequestUsed;

      summary.slowRequestLimit = quota.premium_model_slow_request_limit || 0;
      summary.slowRequestUsed = usage.premium_model_slow_request_usage ?? usage.premium_model_slow_amount ?? 0;
      summary.slowRequestLeft = summary.slowRequestLimit - summary.slowRequestUsed;

      summary.advancedModelLimit = quota.advanced_model_request_limit || 0;
      summary.advancedModelUsed = usage.advanced_model_request_usage ?? usage.advanced_model_amount ?? 0;
      summary.advancedModelLeft = summary.advancedModelLimit - summary.advancedModelUsed;

      summary.autocompleteLimit = quota.auto_completion_limit || 0;
      summary.autocompleteUsed = usage.auto_completion_usage ?? usage.auto_completion_amount ?? 0;
      summary.autocompleteLeft = summary.autocompleteLimit - summary.autocompleteUsed;
    }
  }

  summary.extraFastRequestLeft = summary.extraFastRequestLimit - summary.extraFastRequestUsed;

  if (isDollarBilling) {
    summary.displayUsed = summary.basicUsageUsed + summary.bonusUsageUsed;
    summary.displayLimit = summary.basicUsageLimit + summary.bonusUsageLimit;
    summary.displayLeft = Math.max(0, summary.displayLimit - summary.displayUsed);
    summary.exhausted = summary.displayLimit > 0 && summary.displayUsed >= summary.displayLimit;
  } else {
    summary.displayUsed = summary.fastRequestUsed + summary.extraFastRequestUsed;
    summary.displayLimit = summary.fastRequestLimit + summary.extraFastRequestLimit;
    summary.displayLeft = Math.max(0, summary.displayLimit - summary.displayUsed);
    summary.exhausted = summary.displayLimit > 0 && summary.displayUsed >= summary.displayLimit;
  }

  return summary;
}

async function getUsageSummary(token) {
  if (isTokenExpired(token)) {
    throw new Error('Token 已过期');
  }

  const headers = buildHeaders(token);
  const endpoints = [API_BASE_UG, API_BASE_SG];
  let lastError = '获取额度失败';

  for (const base of endpoints) {
    try {
      // 国内版积分用量接口（product.json ugApi 基址 + out/main.js _postApi 实测路径）
      const res = await fetch(`${base}${CN_ENT_USAGE_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ require_usage: true, req_source: 1 }),
      });

      if (!res.ok) {
        lastError = `API 返回 ${res.status}`;
        continue;
      }

      const data = await res.json();
      if (data.code !== undefined && data.code !== 0) {
        lastError = `业务错误 code=${data.code}`;
        continue;
      }
      return parseEntitlementsToSummary(data);
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}

async function validateToken(token, extras = {}) {
  const jwt = parseJwtPayload(token);
  const headers = buildHeaders(token);
  const endpoints = [API_BASE_UG, API_BASE_SG];
  let lastError = 'Token 验证失败';

  for (const base of endpoints) {
    try {
      const res = await fetch(`${base}${CN_ENT_USAGE_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ require_usage: true, req_source: 1 }),
      });

      if (!res.ok) {
        lastError = `API 返回 ${res.status}`;
        continue;
      }

      const data = await res.json();
      if (data.code !== undefined && data.code !== 0) {
        lastError = `业务错误 code=${data.code}`;
        continue;
      }
      const pack = data.user_entitlement_pack_list?.[0];
      const userId = pack?.entitlement_base_info?.user_id || jwt.userId;
      const profile = await resolveUserProfile(token, {
        ...extras,
        region: pack?.entitlement_base_info?.region || extras.region || 'CN',
      });

      return {
        ...profile,
        userId,
        tenantId: jwt.tenantId || profile.tenantId,
        tokenExp: jwt.exp,
      };
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(lastError);
}

module.exports = {
  validateToken,
  resolveUserProfile,
  parseJwtPayload,
  getUsageSummary,
  getUserToken,
  isTokenExpired,
  isAccountTokenExpired,
  isAccountTokenExpiringSoon,
  getAccountDisplayExpiryMs,
  parseEntitlementsToSummary,
  cleanCookies,
  resolveExpiredAt,
  parseCookieExpiryMs,
};
