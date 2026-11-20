/**
 * renderer.js 分区索引（1445 行单体，按「自顶向下 = 依赖方向」排列）
 *   6–53    格式化工具（计数/时间/额度文案）
 *   54–146  展示层纯函数（toast、unwrap、转义、用量指标 getUsageMetrics）
 *   147–215 列表筛选 / 排序 / 统计（filterAccounts、sortAccounts、computeStats）
 *   216–307 加载态与同步态（loadUsageHistory、renderExpiryAlerts、beginAccountsSync）
 *   308–439 渲染：概览、配额、标签（renderAccountTags、cookieTag、deviceTag）、卡片模板
 *   440–571 渲染主入口 renderUI + 用量加载（loadAllUsage、refreshAccounts）
 *   572–621 切换流程（confirmSwitchWarnings、handleSwitch、handleCleanSwitch、switchPage）
 *   622–697 清理 / 自动刷新 / 主题
 *   698–886 设置、添加账号、导入导出、详情弹窗
 *   887–    事件委托与初始化（见文件中部「Events」分隔标记）
 * 本文件不拆分模块：状态集中在 28–46 行的模块级变量，拆分需跨模块传递，风险高于收益。
 */
const api = window.traeAccounts;
const t = (key, params) => window.TraeHopI18n.t(key, params);
const localeTag = () => (window.TraeHopI18n.getLocale() === 'zh' ? 'zh-CN' : 'en-US');
const listSep = () => (window.TraeHopI18n.getLocale() === 'zh' ? '，' : ', ');

function formatFilterCount(filtered, total, selCount) {
  if (initialLoading || accountsSyncing) {
    return accountsSyncing ? t('common.syncing') : t('common.loading');
  }
  let text = filtered === total
    ? t('accounts.countTotal', { n: total })
    : t('accounts.countShowing', { shown: filtered, total });
  if (selCount) text += t('accounts.countSelected', { n: selCount });
  return text;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const accountList = $('#account-list');
const toast = $('#toast');
const addDialog = $('#add-dialog');
const exportDialog = $('#export-dialog');
const importDialog = $('#import-dialog');
const detailDialog = $('#account-detail-dialog');
const traePathEl = $('#trae-path');

let toastTimer = null;
let usageMap = {};
let allAccounts = [];
let addMode = 'browser';
let browserLoginActive = false;
let reloginAccountId = null;
let currentPage = 'overview';
let quotaFilter = 'all';
let accountSearch = '';
let accountSort = 'default';
let selectedIds = new Set();
let appSettings = {};
let autoRefreshTimer = null;
let lastRefreshTime = null;
let refreshDebounce = null;
let cleanCleaning = false;
let cleanScanned = false;
let lastBackupTs = null;
let cachedTraePath = null;
// Trae IDE 运行状态：仅当前账号卡片据此决定显示「打开 IDE」还是「运行中」
let traeRunning = false;
let traeRunningChecked = false;
// 运行中状态下低频轮询探测 IDE 退出：窗口持续聚焦时关掉 Trae 不产生任何事件，
// 依赖 focus 重查会卡死在「运行中」。仅此状态有轮询开销（单次 tasklist 约 200ms）。
const TRAE_RUNNING_POLL_MS = 5000;
let traeRunningPollTimer = null;

function updateTraeRunningPoll() {
  if (traeRunning && !traeRunningPollTimer) {
    traeRunningPollTimer = setInterval(() => syncTraeRunning(true), TRAE_RUNNING_POLL_MS);
  } else if (!traeRunning && traeRunningPollTimer) {
    clearInterval(traeRunningPollTimer);
    traeRunningPollTimer = null;
  }
}
let traceLaunching = false;
let initialLoading = true;
let accountsSyncing = false;
let accountsSyncMessage = '';
let importPending = null;

const RING_CIRCUMFERENCE = 327;

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

async function unwrap(promise) {
  const res = await promise;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortenPath(p) {
  const s = String(p);
  if (s.length <= 52) return s;
  const parts = s.split(/[/\\]/);
  if (parts.length > 3) return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
  return `…${s.slice(-48)}`;
}

function formatResetCountdown(resetTimeSec) {
  if (!resetTimeSec) return '—';
  const diff = resetTimeSec * 1000 - Date.now();
  if (diff <= 0) return t('time.resetSoon');
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return t('time.daysHours', { days, hours });
  const mins = Math.floor((diff % 3600000) / 60000);
  return hours > 0 ? t('time.hoursMins', { hours, mins }) : t('time.minsOnly', { mins });
}

function formatDateTime(resetTimeSec) {
  if (!resetTimeSec) return '—';
  return new Date(resetTimeSec * 1000).toLocaleString(localeTag(), {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatRefreshTime(date) {
  if (!date) return '—';
  return date.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(localeTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getUsageMetrics(usage) {
  const isDollar = !!usage?.isDollarBilling;
  const used = usage?.displayUsed ?? 0;
  const limit = usage?.displayLimit ?? 0;
  const left = usage?.displayLeft ?? Math.max(0, limit - used);
  const exhausted = !!usage?.exhausted;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  // 国内版积分制存在 credits_limit=-1（无限包），官方语义为剩余无限
  const fmtNum = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '∞');
  return {
    isDollar, used, limit, left, exhausted, pct,
    usedText: isDollar ? `$${Number(used).toFixed(2)}` : String(Math.round(used)),
    limitText: isDollar ? `$${Number(limit).toFixed(2)}` : fmtNum(limit),
    leftText: exhausted ? t('overview.exhausted') : isDollar ? `$${left.toFixed(2)}` : fmtNum(left),
    leftNum: left,
  };
}

function getAccountQuotaStatus(account) {
  if (account.tokenExpired) return 'no-quota';
  const u = usageMap[account.id];
  if (u?.loading) return 'unknown';
  if (u?.error) return 'no-quota';
  if (!u?.data) return 'unknown';
  const m = getUsageMetrics(u.data);
  if (m.exhausted || m.left <= 0) return 'no-quota';
  return 'has-quota';
}

function getQuotaLeftNum(account) {
  const u = usageMap[account.id]?.data;
  if (!u) return -1;
  return getUsageMetrics(u).leftNum;
}

function getQuotaUsedNum(account) {
  const u = usageMap[account.id]?.data;
  if (!u) return -1;
  return getUsageMetrics(u).used;
}

function filterAccounts(accounts) {
  let list = accounts;
  if (quotaFilter !== 'all') {
    list = list.filter((a) => {
      if (quotaFilter === 'expiring-soon') return a.tokenExpiringSoon && !a.tokenExpired;
      if (quotaFilter === 'expired') return a.tokenExpired;
      const status = getAccountQuotaStatus(a);
      if (quotaFilter === 'has-quota') return status === 'has-quota';
      if (quotaFilter === 'no-quota') return status === 'no-quota';
      return true;
    });
  }
  const q = accountSearch.trim().toLowerCase();
  if (q) {
    list = list.filter((a) =>
      [a.email, a.name, a.note, a.group].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  return sortAccounts(list);
}

function sortAccounts(list) {
  const copy = [...list];
  switch (accountSort) {
    case 'quota-desc':
      return copy.sort((a, b) => getQuotaLeftNum(b) - getQuotaLeftNum(a));
    case 'quota-asc':
      return copy.sort((a, b) => getQuotaLeftNum(a) - getQuotaLeftNum(b));
    case 'used-desc':
      // 与历史列表的「已用」口径对齐：看谁消耗得多，没有用量数据的排最后
      return copy.sort((a, b) => getQuotaUsedNum(b) - getQuotaUsedNum(a));
    case 'name':
      return copy.sort((a, b) => (a.email || a.name || '').localeCompare(b.email || b.name || ''));
    case 'expiry':
      return copy.sort((a, b) => getAccountExpirySortKey(a) - getAccountExpirySortKey(b));
    default:
      return copy;
  }
}

function getAccountExpirySortKey(account) {
  if (account.tokenExpiredAt) {
    const ts = Date.parse(account.tokenExpiredAt);
    if (!Number.isNaN(ts)) return ts;
  }
  return (account.tokenExp || 9999999999) * 1000;
}

/**
 * 概览统计。口径原则（2026-10-26 重做）：
 *  1) 账号按「会话状态」与「用量状态」两个维度分开统计，且必须闭合：
 *     expired + hasQuota + noQuota + unknown === total。
 *     旧实现把 tokenExpired 也算进 noQuota，导致「用量已满」里混着根本没刷新的过期号，
 *     且三项百分比加起来不到 100%，用户看不出剩下的账号去哪了。
 *  2) 积分与美元不能相加。只汇总「主计费类型」（账号数多的那种），另一种单独计数并在单位行标注。
 *  3) 无限包（displayLimit=Infinity）不能进总额累加，否则总额显示成 Infinity、使用率被算成 0%。
 */
function computeStats(accounts) {
  let hasQuota = 0, noQuota = 0, expired = 0, expiring = 0, unknown = 0;
  let nearestReset = 0;
  let dollarCount = 0, pointCount = 0, unlimitedCount = 0, withData = 0;
  const sum = { dollar: { used: 0, limit: 0, left: 0 }, point: { used: 0, limit: 0, left: 0 } };

  for (const a of accounts) {
    if (a.tokenExpired) { expired += 1; continue; }
    if (a.tokenExpiringSoon) expiring += 1;

    const status = getAccountQuotaStatus(a);
    if (status === 'has-quota') hasQuota += 1;
    else if (status === 'no-quota') noQuota += 1;
    else unknown += 1;

    const u = usageMap[a.id]?.data;
    if (!u) continue;
    withData += 1;
    if (u.isDollarBilling) dollarCount += 1; else pointCount += 1;
    const m = getUsageMetrics(u);
    if (!Number.isFinite(m.limit)) { unlimitedCount += 1; continue; }
    const bucket = u.isDollarBilling ? sum.dollar : sum.point;
    bucket.used += m.used; bucket.limit += m.limit; bucket.left += m.left;
    if (u.resetTime && (!nearestReset || u.resetTime < nearestReset)) nearestReset = u.resetTime;
  }

  // 主口径 = 账号数多的计费类型；平手时取积分（国内版默认）
  const mainIsDollar = dollarCount > pointCount;
  const main = mainIsDollar ? sum.dollar : sum.point;
  const excluded = mainIsDollar ? pointCount : dollarCount;
  const totalUsed = main.used, totalLimit = main.limit, totalLeft = main.left;

  const usedPct = totalLimit > 0 ? Math.min(100, Math.round((totalUsed / totalLimit) * 100)) : 0;
  const fmt = (v) => (mainIsDollar ? `$${v.toFixed(2)}` : String(Math.round(v)));
  return {
    total: accounts.length, hasQuota, noQuota, expired, expiring, unknown, withData,
    totalUsed, totalLimit, totalLeft, usedPct, nearestReset,
    mainIsDollar, unlimitedCount, excludedCount: excluded,
    // 比率分母用「会话正常的账号数」，避免过期号污染百分比
    counted: hasQuota + noQuota + unknown,
    fmt,
  };
}

async function loadUsageHistory() {
  const el = $('#usage-history');
  const header = document.querySelector('.history-header');
  try {
    const history = await unwrap(api.getUsageHistory());
    const rows = computeUsageDeltas(history);
    if (!rows.length) {
      el.innerHTML = `<p class="muted">${escapeHtml(
        history.length ? t('overview.historyNoDelta') : t('overview.historyEmpty')
      )}</p>`;
      el.classList.add('is-empty');
      header?.classList.add('hidden');
      return;
    }
    header?.classList.remove('hidden');
    el.classList.remove('is-empty');
    el.innerHTML = rows.slice(0, 20).map((r) => {
      const { account, delta, used, limit, gapMs, newCycle } = r;
      const isDollar = !!account.isDollarBilling;
      const fmt = (v) => (Number.isFinite(v) ? (isDollar ? `$${v.toFixed(2)}` : String(Math.round(v))) : '∞');
      // 消耗是扣减，用负号而不是正号
      const deltaText = `${Number.isFinite(delta) ? (isDollar ? `-$${delta.toFixed(2)}` : `-${Math.round(delta)}`) : '∞'}`;
      const parts = [t('overview.historyDeltaTitle', { delta: deltaText, used: fmt(used), limit: fmt(limit) })];
      if (newCycle) parts.push(t('overview.historyCycleSuffix'));
      if (Number.isFinite(gapMs)) parts.push(t('overview.historyGap', { gap: formatGap(gapMs) }));
      return `<div class="history-row" title="${escapeHtml(parts.join(' · '))}"><span class="history-email">${escapeHtml(
        account.email || '—'
      )}</span><span class="history-val">${escapeHtml(deltaText)}</span><span class="history-time">${formatTs(
        account.timestamp
      )}</span></div>`;
    }).join('');
  } catch { /* optional */ }
}

// 旧记录没有 used 字段（只存了 left/limit），兜底还原
function historyUsedOf(h) {
  if (Number.isFinite(h.used)) return h.used;
  const limit = Number.isFinite(h.limit) ? h.limit : Infinity;
  const left = Number.isFinite(h.left) ? h.left : 0;
  return Number.isFinite(limit) ? Math.max(0, limit - left) : NaN;
}

// 历史存的是「每次刷新时的累计用量」，用户要看的是「这一次花了多少」= 相邻两条之差
function computeUsageDeltas(history) {
  const byAccount = new Map();
  for (const h of history) {
    const key = h.accountId || h.email || '?';
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(h);
  }

  const rows = [];
  for (const list of byAccount.values()) {
    list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    let prev = null;
    for (const cur of list) {
      const used = historyUsedOf(cur);
      if (!Number.isFinite(used)) { prev = cur; continue; }

      let base;
      let newCycle;
      if (prev) {
        base = historyUsedOf(prev);
        if (!Number.isFinite(base)) { prev = cur; continue; }
        const cycleChanged = !!(prev.resetTime && cur.resetTime && prev.resetTime !== cur.resetTime);
        newCycle = used < base || cycleChanged;
      } else if (Number.isFinite(cur.prevUsed)) {
        // 首条没有前一条可参照（可能被 store 的 200 条上限挤掉），用写入时留档的基线还原
        base = cur.prevUsed;
        newCycle = used < base;
      } else {
        prev = cur; continue; // 无基线就不臆造消耗
      }
      const prevTs = prev ? prev.timestamp || 0 : 0;
      prev = cur;

      // 跨计费周期：累计值归零重算，差额会是负数，此时本条 used 就是新周期的消耗量
      const delta = newCycle ? used : used - base;
      if (!(delta > 0)) continue; // 0 消耗 = 刷新了但没用，不占列表

      rows.push({
        account: cur,
        delta,
        used,
        limit: Number.isFinite(cur.limit) ? cur.limit : Infinity,
        gapMs: prevTs ? (cur.timestamp || 0) - prevTs : NaN,
        newCycle,
      });
    }
  }
  return rows.sort((a, b) => (b.account.timestamp || 0) - (a.account.timestamp || 0));
}

function formatGap(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function renderExpiryAlerts() {
  const panel = $('#expiry-alerts');
  const list = $('#expiry-alert-list');
  if (appSettings.notifyTokenExpiry === false) {
    panel.classList.add('hidden');
    return;
  }

  const alerts = allAccounts
    .filter((a) => a.tokenExpired || (a.tokenExpiringSoon && !a.tokenExpired))
    .map((a) => {
      if (a.tokenExpired) {
        return {
          accountId: a.id,
          email: a.email || a.name,
          message: t('accounts.alertExpired'),
          action: t('accounts.relogin'),
          actionClass: 'btn-relogin-alert',
        };
      }
      if (a.hasCookies) {
        return {
          accountId: a.id,
          email: a.email || a.name,
          message: t('accounts.alertExpiringRefresh'),
          action: t('accounts.refreshToken'),
          actionClass: 'btn-refresh-token-alert',
        };
      }
      return {
        accountId: a.id,
        email: a.email || a.name,
        message: t('accounts.alertExpiringPrelogin'),
        action: t('accounts.prelogin'),
        actionClass: 'btn-relogin-alert',
      };
    });

  if (!alerts.length) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  list.innerHTML = alerts
    .map(
      (a) =>
        `<li><span>${escapeHtml(a.email || t('common.account'))}</span><span class="alert-msg">${escapeHtml(a.message)}</span><button class="btn-text ${a.actionClass}" data-id="${a.accountId}">${escapeHtml(a.action)}</button></li>`
    )
    .join('');
}

function accountsLoadingHtml(message) {
  return `<div class="page-loading page-loading-inline"><div class="loading-spinner" aria-hidden="true"></div><p class="loading-text">${escapeHtml(message)}</p></div>`;
}

function beginAccountsSync(message) {
  accountsSyncing = true;
  accountsSyncMessage = message;
  renderUI();
}

function endAccountsSync() {
  accountsSyncing = false;
  accountsSyncMessage = '';
}

function setAccountsToolbarBusy(busy) {
  ['#btn-export-accounts', '#btn-import-file', '#btn-import-trae', '#btn-refresh-usage', '#btn-add'].forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = busy;
  });
}

function updateOverview(accounts) {
  const loading = $('#overview-loading');
  const empty = $('#overview-empty');
  const content = $('#overview-content');
  const loadingText = loading?.querySelector('.loading-text');
  $('#nav-account-count').textContent = (initialLoading || accountsSyncing) ? '…' : accounts.length;

  if (initialLoading || accountsSyncing) {
    if (loadingText) {
      loadingText.textContent = initialLoading ? t('overview.detecting') : accountsSyncMessage;
    }
    loading?.classList.remove('hidden');
    empty.classList.add('hidden');
    content.classList.add('hidden');
    return;
  }

  loading?.classList.add('hidden');

  if (!accounts.length) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');

  const s = computeStats(accounts);
  const set = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
  const ratio = (n) => (s.counted ? `${Math.round((n / s.counted) * 100)}%` : '—');

  set('#stat-total', s.total);
  // 账号构成写进 meta，让「有额度 + 已用完 + 未刷新 + 过期 = 总数」能自己核对上
  const breakdown = [];
  if (s.noQuota) breakdown.push(`${t('overview.noQuota')} ${s.noQuota}`);
  if (s.unknown) breakdown.push(`${t('overview.unknown')} ${s.unknown}`);
  if (s.expired) breakdown.push(`${t('overview.tokenExpired')} ${s.expired}`);
  const totalMeta = breakdown.length ? breakdown.join(' · ') : t('overview.allHasQuota');
  set('#stat-total-meta', totalMeta);
  const totalMetaEl = $('#stat-total-meta');
  if (totalMetaEl) totalMetaEl.title = totalMeta;

  set('#stat-active', s.hasQuota);
  set('#stat-active-ratio', ratio(s.hasQuota));
  set('#stat-no-quota', s.noQuota);
  set('#stat-no-quota-ratio', ratio(s.noQuota));
  // 0 值不该借用告警配色：一个号都没用完时红色是误报
  $('#stat-no-quota')?.closest('.strip-stat')?.classList.toggle('zero', s.noQuota === 0);
  $('#stat-active')?.closest('.strip-stat')?.classList.toggle('zero', s.hasQuota === 0);

  // 一个账号的用量都没刷出来时，金额位一律显示「—」，而不是显示 0 让人以为额度真的用光了
  const hasAmount = s.withData > 0;
  // 同上：剩余合计为 0 只因无限包不计入，此时写 ∞，写 0 会被误读成「额度用光了」
  set('#stat-left', !hasAmount ? '—' : s.unlimitedCount && s.totalLeft === 0 ? '∞' : s.fmt(s.totalLeft));
  // 单位行要说明「这个数字是什么、哪些账号没算进来」，否则混合计费/无限包会误读。
  // 卡片窄：可见部分只留「主单位 + 不限量」，未计入账号走 title，避免出现半截省略号
  const unitBase = s.mainIsDollar ? t('overview.dollarUsage') : t('overview.fastRequests');
  let unitShort = unitBase;
  let unitFull = unitBase;
  if (s.unlimitedCount) {
    const u = ` · ${t('overview.unitUnlimited', { n: s.unlimitedCount })}`;
    unitShort += u; unitFull += u;
  }
  if (s.excludedCount) unitFull += ` · ${t('overview.unitExcluded', { n: s.excludedCount })}`;
  set('#stat-limit-unit', hasAmount ? unitShort : '—');
  const unitEl = $('#stat-limit-unit');
  if (unitEl) unitEl.title = hasAmount ? unitFull : '';

  // 会话状态：只报异常会话数，正常时明确写「全部正常」而不是丢一个 0 让人猜
  const abnormal = s.expired + s.expiring;
  const sessionParts = [];
  if (s.expired) sessionParts.push(`${t('overview.tokenExpired')} ${s.expired}`);
  if (s.expiring) sessionParts.push(`${t('overview.expiringSoon')} ${s.expiring}`);
  set('#stat-session', abnormal);
  set('#stat-session-meta', sessionParts.length ? sessionParts.join(' · ') : t('overview.sessionNormal'));
  const sessionCard = $('#stat-session')?.closest('.strip-stat');
  if (sessionCard) sessionCard.classList.toggle('alert', abnormal > 0);

  set('#stat-used', hasAmount ? s.fmt(s.totalUsed) : '—');
  // 无限包不进总额累加，总额因此可能是 0（全是无限包），此时直接写 ∞ 而不是 0
  set('#stat-limit', !hasAmount ? '—' : s.unlimitedCount && s.totalLimit === 0 ? '∞' : s.fmt(s.totalLimit));
  set('#stat-used-pct', hasAmount && s.totalLimit > 0 ? `${s.usedPct}%` : '—');
  set('#stat-reset', s.nearestReset ? `${formatResetCountdown(s.nearestReset)} · ${formatDateTime(s.nearestReset)}` : '—');
  set('#last-refresh-time', formatRefreshTime(lastRefreshTime));
  renderExpiryAlerts();

  const ring = $('#ring-progress');
  if (ring) {
    ring.style.strokeDashoffset = RING_CIRCUMFERENCE - (s.usedPct / 100) * RING_CIRCUMFERENCE;
    ring.style.stroke = s.usedPct >= 90 ? 'var(--red)' : s.usedPct >= 60 ? 'var(--amber)' : 'var(--primary)';
  }
}

function renderQuotaHtml(u) {
  if (u?.loading) return `<div class="quota-loading">${escapeHtml(t('common.loading'))}</div>`;
  if (u?.error) {
    return `<div class="quota-loading" style="color:var(--red)">${escapeHtml(u.error)}</div>`;
  }
  if (u?.data) {
    const m = getUsageMetrics(u.data);
    const color = m.exhausted || m.pct >= 80 ? 'var(--red)' : m.pct >= 50 ? 'var(--amber)' : 'var(--green)';
    // 右侧那个数字是「剩余」，行内没有位置写两个字，用 title 说明，避免被当成已用量
    const leftTitle = m.exhausted ? '' : t('accounts.quotaLeftTitle', { n: m.leftText });
    return `<div class="quota-text"><span><strong>${m.usedText}</strong> / ${m.limitText}</span><span class="quota-left ${m.exhausted ? 'exhausted' : ''}"${leftTitle ? ` title="${escapeHtml(leftTitle)}"` : ''}>${m.leftText}</span></div><div class="quota-bar"><div class="quota-bar-fill" style="width:${m.pct}%;background:${color}"></div></div>`;
  }
  return '<div class="quota-loading">—</div>';
}

function renderAccountTags(a) {
  const u = usageMap[a.id];
  const status = getAccountQuotaStatus(a);
  return [
    a.group ? `<span class="tag tag-group">${escapeHtml(a.group)}</span>` : '',
    u?.data ? `<span class="tag tag-plan">${escapeHtml(u.data.planType || 'Free')}</span>` : '',
    a.isCurrent ? `<span class="tag tag-current">${escapeHtml(t('accounts.tagCurrent'))}</span>` : '',
    a.tokenExpired ? `<span class="tag tag-expired">${escapeHtml(t('accounts.tagExpired'))}</span>` : '',
    a.tokenExpiringSoon && !a.tokenExpired ? `<span class="tag tag-warn">${escapeHtml(t('accounts.tagExpiring'))}</span>` : '',
    status === 'has-quota' ? `<span class="tag tag-ok">${escapeHtml(t('accounts.tagOk'))}</span>` : '',
    status === 'no-quota' && !a.tokenExpired ? `<span class="tag tag-exhausted">${escapeHtml(t('accounts.tagExhausted'))}</span>` : '',
    cookieTag(a),
    deviceTag(a),
  ].filter(Boolean).join('');
}

// 显示本机设备标识（x-device-id）。它是机器级的，正常情况下每张卡片应显示相同的值；
// 若切换账号后此处发生变化，说明设备指纹被改写。只读展示，不参与任何切换逻辑。
function deviceTag(a) {
  if (!a.deviceId) return '';
  return `<span class="tag tag-device" title="${escapeHtml(t('accounts.deviceIdTitle'))}">${escapeHtml(
    t('accounts.tagDevice', { id: a.deviceId })
  )}</span>`;
}

// Cookie 是国内版自动续 Token 的唯一凭据，把到期时间显性化，避免静默失效后才发现
const COOKIE_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function cookieTag(a) {
  if (!a.hasCookies || typeof a.cookieExpiredAt !== 'number') return '';
  const date = new Date(a.cookieExpiredAt);
  const text = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(localeTag(), { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (!text) return '';
  // Cookie 是国内版自动续 Token 的唯一凭据，到期只能重新浏览器登录。
  // 已过期 / 7 天内到期的标签做成可点击，直接拉起该账号的续登，省得用户先找按钮再找账号。
  if (a.cookieExpiredAt <= Date.now()) {
    return `<span class="tag tag-expired tag-relogin" data-id="${escapeHtml(a.id)}" role="button" title="${escapeHtml(
      `${t('accounts.cookieExpired')} · ${t('accounts.cookieReloginHint')}`
    )}">${escapeHtml(t('accounts.cookieExpired'))}</span>`;
  }
  const soon = a.cookieExpiredAt - Date.now() < COOKIE_EXPIRING_SOON_MS;
  const cls = soon ? 'tag-warn' : 'tag-plan';
  const clickable = soon ? ' tag-relogin' : '';
  const hint = soon ? ` · ${t('accounts.cookieReloginHint')}` : '';
  return `<span class="tag ${cls}${clickable}" ${soon ? `data-id="${escapeHtml(a.id)}" role="button"` : ''} title="${escapeHtml(
    (soon ? t('accounts.cookieExpiring', { date: text }) : t('accounts.cookieValid', { date: text })) + hint
  )}">${escapeHtml(
    soon ? t('accounts.cookieExpiring', { date: text }) : t('accounts.cookieValid', { date: text })
  )}</span>`;
}

function patchAccountCardUsage(id) {
  const account = allAccounts.find((a) => a.id === id);
  if (!account) return;
  const card = document.querySelector(`.account-card[data-id="${id}"]`);
  if (!card) return;
  const u = usageMap[id];
  const quotaEl = card.querySelector('.account-quota');
  const tagsEl = card.querySelector('.account-tags-row');
  if (quotaEl) quotaEl.innerHTML = renderQuotaHtml(u);
  if (tagsEl) tagsEl.innerHTML = renderAccountTags(account);
  const refreshBtn = card.querySelector('.btn-refresh-one');
  if (refreshBtn) {
    refreshBtn.disabled = !!u?.loading;
    refreshBtn.classList.toggle('is-loading', !!u?.loading);
  }
}

function renderAccountCard(a) {
  const u = usageMap[a.id];
  const hasEmail = !!(a.email && a.email.includes('@'));
  const title = hasEmail ? a.email : (a.name || `User ${a.id.slice(0, 8)}`);
  const sub = [a.group, hasEmail && a.name && a.name !== a.email ? a.name : '', a.note].filter(Boolean).join(' · ');

  const quotaHtml = renderQuotaHtml(u);
  const tags = renderAccountTags(a);

  const checked = selectedIds.has(a.id) ? 'checked' : '';

  return `
    <div class="account-card ${a.isCurrent ? 'current trace-ring' : ''} ${a.tokenExpired ? 'token-expired' : ''}" data-id="${a.id}" data-trace-state="idle">
      <label class="account-check"><input type="checkbox" class="account-select" data-id="${a.id}" ${checked} /></label>
      <div class="avatar">${a.avatarUrl ? `<img src="${escapeHtml(a.avatarUrl)}" alt="" />` : escapeHtml((title || '?').charAt(0).toUpperCase())}</div>
      <div class="account-main">
        <div class="account-head">
          <div class="account-head-text">
            <div class="account-title">${escapeHtml(title)}</div>
            ${sub ? `<div class="account-sub">${escapeHtml(sub)}</div>` : ''}
          </div>
        </div>
        ${tags ? `<div class="account-tags-row">${tags}</div>` : ''}
        <div class="account-quota">${quotaHtml}</div>
      </div>
      <div class="account-actions">
        <button class="btn-icon btn-detail" data-id="${a.id}" title="${escapeHtml(t('common.details'))}">⋯</button>
        <button class="btn-icon btn-refresh-one" data-id="${a.id}" title="${escapeHtml(t('common.refreshUsage'))}">↻</button>
        ${a.tokenExpired && a.hasCookies ? `<button class="btn btn-ghost btn-action btn-refresh-token" data-id="${a.id}" title="${escapeHtml(t('accounts.refreshToken'))}">${escapeHtml(t('accounts.refreshToken'))}</button>` : ''}
        ${a.tokenExpired ? `<button class="btn btn-ghost btn-action btn-relogin" data-id="${a.id}">${escapeHtml(t('accounts.relogin'))}</button>` : ''}
        <div class="account-switch-btns">
          ${a.isCurrent
            ? (traeRunning
              ? `<button class="btn btn-ghost btn-action" data-id="${a.id}" disabled title="${escapeHtml(t('accounts.openIdeRunningTitle'))}">${escapeHtml(t('accounts.ideRunning'))}</button>`
              : `<button class="btn btn-action btn-trace btn-open-trae" data-id="${a.id}" title="${escapeHtml(t('accounts.openIdeTitle'))}">${escapeHtml(t('accounts.openIde'))}</button>`)
            : `<button class="btn btn-primary btn-action btn-switch-account" data-id="${a.id}" ${(a.tokenExpired && !a.hasCookies) ? 'disabled' : ''} title="${escapeHtml(t('accounts.switchTitle'))}">${escapeHtml(t('common.switch'))}</button>`}
          <button class="btn btn-ghost btn-action btn-clean-switch" data-id="${a.id}" ${a.isCurrent || (a.tokenExpired && !a.hasCookies) ? 'disabled' : ''} title="${escapeHtml(a.isCurrent ? t('accounts.cleanSwitchTitleCurrent') : t('accounts.cleanSwitchTitle'))}">${escapeHtml(t('accounts.cleanSwitch'))}</button>
        </div>
        <button class="btn-icon btn-danger btn-remove" data-id="${a.id}" title="${escapeHtml(t('common.delete'))}">×</button>
      </div>
    </div>`;
}

function renderUI() {
  updateOverview(allAccounts);
  setAccountsToolbarBusy(accountsSyncing);
  const filtered = filterAccounts(allAccounts);
  const selCount = selectedIds.size;
  $('#filter-count').textContent = formatFilterCount(filtered.length, allAccounts.length, selCount);

  if (initialLoading || accountsSyncing) {
    accountList.innerHTML = accountsLoadingHtml(
      initialLoading ? t('overview.detecting') : accountsSyncMessage
    );
    return;
  }

  if (!allAccounts.length) {
    accountList.innerHTML = `<p class="empty">${escapeHtml(t('accounts.empty'))}</p>`;
    return;
  }
  if (!filtered.length) {
    accountList.innerHTML = `<p class="empty">${escapeHtml(t('accounts.emptyFilter'))}</p>`;
    return;
  }
  accountList.innerHTML = filtered.map(renderAccountCard).join('');
  syncSelectAllCheckbox();
  syncTraeRunning(false);
}

// 边框光条状态机：state 为 null 即回到初始（无光条）
function setTraceState(cardEl, state) {
  if (!cardEl) return;
  if (state) {
    cardEl.dataset.traceState = state;
    cardEl.classList.add('is-tracing');
  } else {
    cardEl.dataset.traceState = 'idle';
    cardEl.classList.remove('is-tracing');
  }
}

function clearTraceRing() {
  document.querySelectorAll('.trace-ring.is-tracing').forEach((el) => setTraceState(el, null));
}

// 查询 Trae 是否在运行。force=false 时仅首次查询，避免每次 renderUI 都跑一次 tasklist。
async function syncTraeRunning(force) {
  if (traeRunningChecked && !force) return;
  try {
    const running = await unwrap(api.isTraeRunning());
    traeRunningChecked = true;
    const v = !!running;
    if (v !== traeRunning) {
      traeRunning = v;
      renderUI();
    }
    updateTraeRunningPoll();
  } catch {
    // 探测失败时保持原值不动：轮询期间 tasklist 偶发失败若按「未运行」处理，
    // 会让「运行中」闪回「打开 IDE」，诱导重复拉起 IDE。无基线时下次 renderUI 再试。
  }
}

function syncSelectAllCheckbox() {
  const visible = filterAccounts(allAccounts).map((a) => a.id);
  const allSelected = visible.length > 0 && visible.every((id) => selectedIds.has(id));
  $('#select-all-accounts').checked = allSelected;
}

async function loadUsageForAccount(id) {
  try {
    const data = await unwrap(api.getAccountUsage(id));
    usageMap[id] = { data };
  } catch (err) {
    usageMap[id] = { error: err.message };
  }
}

async function refreshOneAccountUsage(id) {
  if (usageMap[id]?.loading) return;
  usageMap[id] = { loading: true };
  patchAccountCardUsage(id);
  await loadUsageForAccount(id);
  patchAccountCardUsage(id);
  lastRefreshTime = new Date();
  if (currentPage === 'overview') updateOverview(allAccounts);
}

async function loadAllUsage(silent = false) {
  if (!allAccounts.length) return;
  if (!silent) { for (const a of allAccounts) usageMap[a.id] = { loading: true }; renderUI(); }
  // 每账号完成即 patch 自己的卡片，不再收尾整表重绘：
  // 实测 100 账号全表 innerHTML 重建 19ms（超一帧），逐卡 patch 只改 quota/tags 两个小节点。
  // 约束：本函数不修改 tokenExpired / isCurrent / traeRunning，因此无需重建按钮区；
  //       若将来在此更新账号结构字段，必须改回 renderUI()。
  await Promise.allSettled(allAccounts.map(async (a) => {
    await loadUsageForAccount(a.id);
    patchAccountCardUsage(a.id);
  }));
  lastRefreshTime = new Date();
  updateOverview(allAccounts);
  updateAutoRefreshStatus();
  await loadUsageHistory();
}

function scheduleRefreshAccounts() {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => refreshAccounts(), 400);
}

async function refreshAccounts({ syncMessage = null } = {}) {
  const showSync = !!syncMessage;
  if (showSync) beginAccountsSync(syncMessage);
  try {
    try {
      const result = await unwrap(api.refreshExpiredTokens());
      if (result.refreshed > 0) showToast(t('toast.autoRefreshTokens', { n: result.refreshed }));
    } catch { /* ignore */ }
    let accounts = await unwrap(api.listAccounts());
    if (accounts.some((a) => !a.email)) {
      try { await unwrap(api.refreshProfiles()); accounts = await unwrap(api.listAccounts()); } catch { /* */ }
    }
    allAccounts = accounts;
    selectedIds = new Set([...selectedIds].filter((id) => accounts.some((a) => a.id === id)));
    initialLoading = false;
    if (showSync) endAccountsSync();
    renderUI();
    if (accounts.length) await loadAllUsage(true);
    renderUI();
  } catch (err) {
    initialLoading = false;
    endAccountsSync();
    renderUI();
    throw err;
  }
}

async function confirmSwitchWarnings(check) {
  if (!check.warnings?.length) return true;
  return confirm(t('confirm.switchWarnings', {
    warnings: check.warnings.map((w) => `• ${w}`).join('\n'),
  }));
}

async function handleSwitch(id, skipCheck = false) {
  if (!skipCheck) {
    const check = await unwrap(api.checkSwitch(id));
    if (!check.canSwitch) throw new Error(check.blockers.join('；'));
    if (!(await confirmSwitchWarnings(check))) return null;
  }
  const result = await unwrap(api.switchAccount(id, skipCheck));
  showToast(t('toast.switched', { email: result.email || t('common.account') }));
  await refreshAccounts();
  // 切换内部会 killTrae() 后重新 openTrae()，IDE 运行状态已变，须强制重查：
  // 否则切换前未运行时 traeRunning=false、退出探测轮询不启动，IDE 已被拉起
  // 却永远显示「打开 IDE」，用户再点会重复拉起（renderer.js updateTraeRunningPoll）。
  await syncTraeRunning(true);
  return result;
}

// 多账号时最常用的动作就是「切到还剩最多额度的那个」。数据已经在 usageMap 里，
// 没必要让用户自己逐个看进度条再挑；无限包（-1）按官方语义视为剩余最多。
function pickBestAccount() {
  let best = null;
  let bestLeft = -Infinity;
  for (const a of allAccounts) {
    if (a.tokenExpired) continue;
    const u = usageMap[a.id];
    if (!u?.data) continue;
    const m = getUsageMetrics(u.data);
    if (m.exhausted) continue;
    const left = Number.isFinite(m.leftNum) ? m.leftNum : Infinity;
    if (left > bestLeft) {
      bestLeft = left;
      best = a;
    }
  }
  return best;
}

async function handleSwitchBest() {
  const best = pickBestAccount();
  if (!best) {
    showToast(t('overview.switchBestNone'), true);
    return;
  }
  if (best.isCurrent) {
    showToast(t('overview.switchBestAlready', { name: best.name || best.email || t('common.account') }));
    return;
  }
  await handleSwitch(best.id);
}

async function handleCleanSwitch(id) {
  const check = await unwrap(api.checkSwitch(id));
  if (!check.canSwitch) throw new Error(check.blockers.join('；'));
  const msg = [
    t('common.advanced'),
    '',
    t('clean.cleanSwitchConfirm'),
    t('clean.cleanSwitchWarn'),
    '',
    ...(check.warnings.length ? [...check.warnings.map((w) => `• ${w}`), ''] : []),
    t('common.continue'),
  ].join('\n');
  if (!confirm(msg)) return;

  showToast(t('clean.cleanSwitchProgress'));
  const result = await unwrap(api.cleanAndSwitch(id));
  showToast(t('toast.cleanSwitched', { email: result.email || t('common.account') }));
  await refreshAccounts();
  // 同 handleSwitch：cleanAndSwitch 内部同样杀掉并重启 IDE，须强制重查运行状态
  await syncTraeRunning(true);
}

function switchPage(page) {
  currentPage = page;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  if (page === 'clean' && !cleanScanned && !cleanCleaning) scanCleanSize();
  if (page === 'overview') {
    loadUsageHistory();
    renderExpiryAlerts();
  }
}

async function scanCleanSize() {
  const sizeEl = $('#clean-scan-size');
  const itemsEl = $('#clean-scan-items');
  const platformEl = $('#clean-platform');
  sizeEl.textContent = t('common.scanning');
  itemsEl.innerHTML = '';
  platformEl.textContent = '';
  try {
    const data = await unwrap(api.scanClean());
    sizeEl.textContent = data.formatted;
    platformEl.textContent = data.platform || '';
    if (data.items?.length) {
      itemsEl.innerHTML = data.items.slice(0, 5).map((item) =>
        `<li><span class="clean-item-path" title="${escapeHtml(item.path)}">${escapeHtml(shortenPath(item.path))}</span><span class="clean-item-size">${escapeHtml(item.formatted)}</span></li>`
      ).join('');
      if (data.items.length > 5) itemsEl.innerHTML += `<li class="clean-item-more">${escapeHtml(t('clean.moreItems', { n: data.items.length - 5 }))}</li>`;
    }
    cleanScanned = true;
  } catch (err) {
    sizeEl.textContent = t('common.scanFailed');
    showToast(err.message, true);
  }
}

function appendCleanLog(msg) {
  const el = $('#clean-log');
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setCleanRunning(running) {
  cleanCleaning = running;
  $('#btn-start-clean').disabled = running;
  $('#btn-start-clean').textContent = running ? t('clean.cleaning') : t('clean.start');
  $('#btn-cancel-clean').classList.toggle('hidden', !running);
  $('#btn-rescan-clean').disabled = running;
}

async function handleClean() {
  if (cleanCleaning) return;
  if (!confirm(`${t('common.advanced')}\n\n${t('clean.confirmBody')}\n\n${t('common.continue')}`)) return;
  setCleanRunning(true);
  $('#clean-log').textContent = '';
  const unsub = api.onCleanLog(appendCleanLog);
  const res = await api.startClean();
  unsub();
  setCleanRunning(false);
  cleanScanned = false;
  if (res.ok && res.data?.success) {
    showToast(t('clean.done', { size: res.data.formatted }));
    await scanCleanSize();
    await refreshAccounts();
  } else if (res.ok && res.data && !res.data.success) {
    showToast(t('clean.cancelled'));
    await scanCleanSize();
  } else if (!res.ok) {
    appendCleanLog(t('clean.errorLog', { msg: res.error }));
    showToast(res.error, true);
  }
}

function setupAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (appSettings.autoRefreshEnabled && allAccounts.length) {
    autoRefreshTimer = setInterval(() => loadAllUsage(true), appSettings.autoRefreshIntervalMinutes * 60000);
  }
  updateAutoRefreshStatus();
}

function updateAutoRefreshStatus() {
  const el = $('#auto-refresh-status');
  if (!appSettings.autoRefreshEnabled) { el.textContent = t('settings.autoRefreshOff'); return; }
  el.textContent = t('settings.autoRefreshOn', { n: appSettings.autoRefreshIntervalMinutes })
    + (lastRefreshTime ? t('settings.autoRefreshLast', { time: formatRefreshTime(lastRefreshTime) }) : '');
}

function applyTheme(theme) {
  const mode = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('traehop-theme', mode); } catch { /* */ }
  const label = $('#theme-toggle-label');
  if (label) label.textContent = mode === 'dark' ? t('theme.darkMode') : t('theme.lightMode');
  $$('.theme-segment-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSettings({ theme: next });
}

/**
 * 开关与子项联动：功能关掉时，它下面的间隔/阈值不该还能改。
 * 之前「低用量提醒」关着也能调「剩余低于 5%」，用户会以为改了会生效。
 */
function syncSettingDependencies() {
  const pairs = [
    ['#setting-auto-refresh', '#setting-interval'],
    ['#setting-notify-quota', '#setting-quota-threshold'],
    ['#setting-auto-backup', '#setting-backup-interval'],
  ];
  for (const [toggleSel, dependentSel] of pairs) {
    const toggle = $(toggleSel);
    const dep = $(dependentSel);
    if (!toggle || !dep) continue;
    dep.disabled = !toggle.checked;
    dep.title = toggle.checked ? '' : t('settings.dependentDisabled');
  }
}

function refreshSettingsLabels() {
  $('#backup-dir').textContent = appSettings.autoBackupDir || t('common.notSet');
  $('#last-backup-time').textContent = lastBackupTs
    ? t('settings.lastBackup', { time: formatTs(lastBackupTs) })
    : t('settings.neverBackedUp');
  traePathEl.textContent = cachedTraePath || t('common.notConfigured');
}

async function loadSettings() {
  appSettings = await unwrap(api.getAppSettings());
  const lang = appSettings.language || window.TraeHopI18n.detectLocale();
  window.TraeHopI18n.initI18n(lang);
  $('#setting-language').value = lang;
  applyTheme(appSettings.theme);
  $('#setting-auto-refresh').checked = appSettings.autoRefreshEnabled;
  $('#setting-interval').value = String(appSettings.autoRefreshIntervalMinutes);
  $('#setting-notify-quota').checked = appSettings.notifyLowQuota;
  $('#setting-notify-expiry').checked = appSettings.notifyTokenExpiry;
  $('#setting-quota-threshold').value = String(appSettings.lowQuotaThreshold);
  $('#setting-auto-backup').checked = appSettings.autoBackupEnabled;
  $('#setting-backup-interval').value = String(appSettings.autoBackupIntervalHours);
  lastBackupTs = await unwrap(api.getLastBackup());
  refreshSettingsLabels();
  syncSettingDependencies();
  setupAutoRefresh();
}

async function saveSettings(partial) {
  appSettings = await unwrap(api.saveAppSettings(partial));
  setupAutoRefresh();
}

async function loadTraePath() {
  cachedTraePath = await unwrap(api.getTraePath());
  traePathEl.textContent = cachedTraePath || t('common.notConfigured');
}

function extractTokenPayload(input) {
  const trimmed = input.trim().replace(/[\r\n\t]/g, '');
  if (trimmed.startsWith('eyJ')) {
    const parts = trimmed.split('.');
    if (parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      return { token: trimmed, tokenExpiredAt: null };
    }
  }
  try {
    const json = JSON.parse(trimmed);
    if (json.Result?.Token) {
      return { token: json.Result.Token, tokenExpiredAt: json.Result.ExpiredAt || null };
    }
    if (json.result?.token) {
      return {
        token: json.result.token,
        tokenExpiredAt: json.result.expiredAt || json.result.expired_at || null,
      };
    }
    if (json.token) return { token: json.token, tokenExpiredAt: json.expiredAt || null };
    if (json.Token) return { token: json.Token, tokenExpiredAt: json.ExpiredAt || null };
  } catch { /* */ }
  const m = trimmed.match(/"Token"\s*:\s*"(eyJ[^"]+)"/) || trimmed.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const token = m ? (m[1] || m[0]) : null;
  if (!token) return null;
  const expiredMatch = trimmed.match(/"ExpiredAt"\s*:\s*"([^"]+)"/);
  return { token, tokenExpiredAt: expiredMatch?.[1] || null };
}

function updateAddDialogFooter() {
  $('#btn-submit-add').classList.toggle('hidden', addMode !== 'token');
  $('#btn-cancel-browser').classList.toggle('hidden', addMode !== 'browser' || !browserLoginActive);
}

function resetBrowserLoginState() {
  browserLoginActive = false;
  reloginAccountId = null;
  $('#btn-browser-login').disabled = false;
  $('#browser-login-status').classList.add('hidden');
  updateAddDialogFooter();
}

async function closeAddDialog() {
  if (browserLoginActive) await api.cancelBrowserLogin().catch(() => {});
  resetBrowserLoginState();
  addDialog.close();
}

function setAddMode(mode) {
  addMode = mode;
  $$('.add-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));
  $('#panel-browser').classList.toggle('hidden', mode !== 'browser');
  $('#panel-token').classList.toggle('hidden', mode !== 'token');
  $('#panel-trae').classList.toggle('hidden', mode !== 'trae');
  updateAddDialogFooter();
}

function openAddDialog() {
  $('#token-input').value = '';
  resetBrowserLoginState();
  setAddMode('browser');
  addDialog.showModal();
}

async function startRelogin(accountId, { advance = false } = {}) {
  reloginAccountId = accountId;
  const account = allAccounts.find((a) => a.id === accountId);
  const label = account?.email || account?.name || t('toast.targetAccount');
  try {
    await unwrap(api.startBrowserLogin(accountId));
    showToast(advance ? t('toast.prelogin', { label }) : t('toast.browserLogin', { label }));
  } catch (err) {
    showToast(err.message, true);
    reloginAccountId = null;
  }
}

function openExportDialog() {
  const ids = selectedIds.size ? [...selectedIds] : allAccounts.map((a) => a.id);
  exportDialog.dataset.ids = JSON.stringify(ids);
  $('#export-count-hint').textContent = t('exportDialog.hint', { n: ids.length });
  $('#export-encrypt').checked = false;
  $('#export-password').value = '';
  $('#export-password-wrap').classList.add('hidden');
  exportDialog.showModal();
}

function resetImportDialog() {
  importPending = null;
  $('#import-mode').value = 'skip';
  $('#import-password').value = '';
  $('#import-password-wrap').classList.add('hidden');
  const fileHint = $('#import-file-hint');
  fileHint.textContent = '';
  fileHint.classList.add('hidden');
  $('#btn-import-confirm').textContent = t('importDialog.pickFile');
}

function openImportDialog() {
  resetImportDialog();
  importDialog.showModal();
}

async function finishImport(content, mode, password) {
  const btn = $('#btn-import-confirm');
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('importDialog.importing');
  try {
    const result = await unwrap(api.importAccountsContent({ content, mode, password }));
    if (!result) return;
    const parts = [];
    if (result.imported) parts.push(t('toast.importAdded', { n: result.imported }));
    if (result.updated) parts.push(t('toast.importUpdated', { n: result.updated }));
    if (result.skipped) parts.push(t('toast.importSkipped', { n: result.skipped }));
    importDialog.close();
    resetImportDialog();
    switchPage('accounts');
    showToast(parts.length ? parts.join(listSep()) : t('toast.importNone'), !result.imported && !result.updated);
    await refreshAccounts({ syncMessage: t('sync.importedSync') });
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

async function openDetailDialog(id) {
  const a = allAccounts.find((x) => x.id === id);
  if (!a) return;
  $('#detail-account-id').value = id;
  $('#detail-group').value = a.group || '';
  $('#detail-note').value = a.note || '';
  $('#detail-machine-id').textContent = a.machineId || t('common.notBound');
  detailDialog.showModal();
}

/* ── Events ── */
$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchPage(btn.dataset.page)));

$$('.filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    quotaFilter = chip.dataset.filter;
    $$('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderUI();
  });
});

$('#account-search').addEventListener('input', (e) => { accountSearch = e.target.value; renderUI(); });
$('#account-sort').addEventListener('change', (e) => { accountSort = e.target.value; renderUI(); });

$('#select-all-accounts').addEventListener('change', (e) => {
  const visible = filterAccounts(allAccounts).map((a) => a.id);
  if (e.target.checked) visible.forEach((id) => selectedIds.add(id));
  else visible.forEach((id) => selectedIds.delete(id));
  renderUI();
});

document.body.addEventListener('change', (e) => {
  if (e.target.classList.contains('account-select')) {
    const id = e.target.dataset.id;
    if (e.target.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    syncSelectAllCheckbox();
    renderUI();
  }
});

document.body.addEventListener('click', async (e) => {
  if (e.target.dataset.action === 'open-add') openAddDialog();

  const refreshOne = e.target.closest('.btn-refresh-one');
  if (refreshOne) {
    if (refreshOne.disabled) return;
    refreshOne.disabled = true;
    try {
      await refreshOneAccountUsage(refreshOne.dataset.id);
    } finally {
      const btn = document.querySelector(`.btn-refresh-one[data-id="${refreshOne.dataset.id}"]`);
      if (btn) btn.disabled = false;
    }
    return;
  }

  const refreshTokenBtn = e.target.closest('.btn-refresh-token');
  if (refreshTokenBtn) {
    refreshTokenBtn.disabled = true;
    refreshTokenBtn.textContent = t('common.refreshing');
    try {
      const result = await unwrap(api.refreshAccountToken(refreshTokenBtn.dataset.id));
      showToast(
        result.stillExpiringSoon
          ? t('toast.tokenRefreshedStillExpiring')
          : t('toast.tokenRefreshed'),
        !!result.stillExpiringSoon
      );
      await refreshAccounts();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      refreshTokenBtn.disabled = false;
      refreshTokenBtn.textContent = t('accounts.refreshToken');
    }
    return;
  }

  const refreshTokenAlertBtn = e.target.closest('.btn-refresh-token-alert');
  if (refreshTokenAlertBtn) {
    const btn = refreshTokenAlertBtn;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('common.refreshing');
    try {
      const result = await unwrap(api.refreshAccountToken(btn.dataset.id));
      showToast(
        result.stillExpiringSoon
          ? t('toast.tokenRefreshedStillExpiring')
          : t('toast.tokenRefreshed'),
        !!result.stillExpiringSoon
      );
      await refreshAccounts();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    return;
  }

  const reloginBtn = e.target.closest('.btn-relogin, .btn-relogin-alert');
  if (reloginBtn) {
    const account = allAccounts.find((a) => a.id === reloginBtn.dataset.id);
    const advance = !!(account?.tokenExpiringSoon && !account?.tokenExpired);
    await startRelogin(reloginBtn.dataset.id, { advance });
    return;
  }

  // Cookie 到期/临期标签：点击直接续登该账号（cookie 还没过期时算提前续登）
  const cookieTagBtn = e.target.closest('.tag-relogin');
  if (cookieTagBtn) {
    const target = allAccounts.find((a) => a.id === cookieTagBtn.dataset.id);
    const advance = !!(target && typeof target.cookieExpiredAt === 'number' && target.cookieExpiredAt > Date.now());
    await startRelogin(cookieTagBtn.dataset.id, { advance });
    return;
  }

  const detailBtn = e.target.closest('.btn-detail');
  if (detailBtn) { await openDetailDialog(detailBtn.dataset.id); return; }

  const openTraeBtn = e.target.closest('.btn-open-trae');
  if (openTraeBtn) {
    const card = openTraeBtn.closest('.trace-ring');
    openTraeBtn.disabled = true;
    openTraeBtn.textContent = t('accounts.opening');
    traceLaunching = true;
    setTraceState(card, 'running');
    try {
      await unwrap(api.openTrae());
      showToast(t('accounts.openIdeOk'));
      setTraceState(card, 'success');
      traeRunning = true;
      traeRunningChecked = true;
      updateTraeRunningPoll();
      setTimeout(() => { renderUI(); traceLaunching = false; }, 1200);
    } catch (err) {
      showToast(err.message, true);
      setTraceState(card, 'fail');
      traceLaunching = false;
      setTimeout(() => setTraceState(card, null), 1600);
      openTraeBtn.disabled = false;
      openTraeBtn.textContent = t('accounts.openIde');
    }
    return;
  }

  const switchBtn = e.target.closest('.btn-switch-account');
  if (switchBtn) {
    switchBtn.disabled = true;
    switchBtn.textContent = '…';
    try { await handleSwitch(switchBtn.dataset.id); }
    catch (err) { showToast(err.message, true); switchBtn.disabled = false; switchBtn.textContent = t('common.switch'); }
    return;
  }

  const cleanSwitchBtn = e.target.closest('.btn-clean-switch');
  if (cleanSwitchBtn) {
    cleanSwitchBtn.disabled = true;
    try { await handleCleanSwitch(cleanSwitchBtn.dataset.id); }
    catch (err) { showToast(err.message, true); }
    finally { cleanSwitchBtn.disabled = false; }
    return;
  }

  const removeBtn = e.target.closest('.btn-remove');
  if (removeBtn) {
    if (!confirm(t('confirm.deleteAccount'))) return;
    try {
      delete usageMap[removeBtn.dataset.id];
      selectedIds.delete(removeBtn.dataset.id);
      await unwrap(api.removeAccount(removeBtn.dataset.id));
      showToast(t('toast.deleted'));
      await refreshAccounts();
    } catch (err) { showToast(err.message, true); }
  }
});

async function handleRefresh(btn) {
  const label = t('common.refreshUsage');
  btn.disabled = true;
  btn.textContent = t('common.refreshing');
  try { await loadAllUsage(); showToast(t('toast.usageRefreshed')); }
  catch (err) { showToast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = label; }
}

const disclaimerDialog = $('#disclaimer-dialog');
let disclaimerRequired = false;

function setDisclaimerMode(required) {
  disclaimerRequired = required;
  $('#btn-disclaimer-decline').classList.toggle('hidden', !required);
  $('#btn-disclaimer-accept').textContent = required ? t('disclaimer.accept') : t('common.close');
}

function showDisclaimer({ required = false } = {}) {
  if (!disclaimerDialog) return;
  setDisclaimerMode(required);
  disclaimerDialog.showModal();
}

async function ensureDisclaimerAccepted() {
  if (appSettings.disclaimerAccepted) return true;
  showDisclaimer({ required: true });
  return new Promise((resolve) => {
    disclaimerDialog._resolveDisclaimer = resolve;
  });
}

function handleDisclaimerAccept() {
  if (disclaimerRequired) {
    saveSettings({
      disclaimerAccepted: true,
      disclaimerAcceptedAt: Date.now(),
    }).then(() => {
      disclaimerDialog.close();
      if (disclaimerDialog._resolveDisclaimer) {
        disclaimerDialog._resolveDisclaimer(true);
        disclaimerDialog._resolveDisclaimer = null;
      }
    });
  } else {
    disclaimerDialog.close();
  }
}

function handleDisclaimerDecline() {
  api.quitApp();
}

$('#btn-refresh-usage').addEventListener('click', (e) => handleRefresh(e.target));
$('#btn-refresh-overview').addEventListener('click', (e) => handleRefresh(e.target));
$('#btn-switch-best').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    await handleSwitchBest();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
function initAccountsSwitchTip() {
  const tip = $('#accounts-switch-tip');
  if (!tip) return;
  const body = $('#accounts-tip-body');
  const head = $('#btn-toggle-switch-tip');
  const chevron = tip.querySelector('.accounts-tip-chevron');

  // 默认收起；展开状态记忆在 localStorage，下次启动保持用户选择
  let open = false;
  try { open = localStorage.getItem('traehop-switch-tip-open') === '1'; } catch { /* */ }

  function apply() {
    tip.classList.toggle('expanded', open);
    tip.classList.toggle('collapsed', !open);
    if (body) body.hidden = !open;
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (chevron) chevron.textContent = open ? '▾' : '▸';
  }

  function toggle() {
    open = !open;
    try { localStorage.setItem('traehop-switch-tip-open', open ? '1' : '0'); } catch { /* */ }
    apply();
  }

  head?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-dismiss-switch-tip')) return;
    toggle();
  });
  head?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  try {
    if (localStorage.getItem('traehop-switch-tip-dismissed') === '1') {
      tip.classList.add('hidden');
    }
  } catch { /* */ }

  apply();
}

$('#btn-dismiss-switch-tip')?.addEventListener('click', () => {
  $('#accounts-switch-tip')?.classList.add('hidden');
  try { localStorage.setItem('traehop-switch-tip-dismissed', '1'); } catch { /* */ }
});

$('#btn-add').addEventListener('click', openAddDialog);
$('#btn-theme-toggle').addEventListener('click', toggleTheme);

$$('.theme-segment-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.theme);
    saveSettings({ theme: btn.dataset.theme });
  });
});

$('#btn-export-accounts').addEventListener('click', openExportDialog);
$('#btn-import-file').addEventListener('click', openImportDialog);

$('#export-encrypt').addEventListener('change', (e) => {
  $('#export-password-wrap').classList.toggle('hidden', !e.target.checked);
});

$('#btn-export-cancel').addEventListener('click', () => exportDialog.close());
$('#btn-export-close').addEventListener('click', () => exportDialog.close());
$('#btn-export-confirm').addEventListener('click', async () => {
  const ids = JSON.parse(exportDialog.dataset.ids || '[]');
  const encrypt = $('#export-encrypt').checked;
  const password = $('#export-password').value;
  if (encrypt && password.length < 6) { showToast(t('toast.passwordMin6'), true); return; }
  try {
    const result = await unwrap(api.exportAccounts({ ids, password: encrypt ? password : '' }));
    if (result) showToast(t('toast.exported', { n: result.count }) + (result.encrypted ? t('toast.exportedEncrypted') : ''));
    exportDialog.close();
  } catch (err) { showToast(err.message, true); }
});

$('#btn-import-cancel').addEventListener('click', () => {
  importDialog.close();
  resetImportDialog();
});
$('#btn-import-close').addEventListener('click', () => {
  importDialog.close();
  resetImportDialog();
});
$('#btn-import-confirm').addEventListener('click', async () => {
  const btn = $('#btn-import-confirm');
  const mode = $('#import-mode').value;
  const password = $('#import-password').value;

  try {
    btn.disabled = true;

    if (!importPending) {
      const picked = await unwrap(api.pickImportFile());
      if (!picked) return;

      importPending = picked;
      const fileHint = $('#import-file-hint');
      fileHint.textContent = t('importDialog.picked', {
        name: picked.fileName,
        encrypted: picked.encrypted ? t('importDialog.encryptedSuffix') : '',
      });
      fileHint.classList.remove('hidden');

      if (picked.encrypted) {
        $('#import-password-wrap').classList.remove('hidden');
        btn.textContent = t('common.import');
        $('#import-password').focus();
        return;
      }
    }

    if (importPending.encrypted && !password.trim()) {
      showToast(t('toast.enterDecryptPassword'), true);
      $('#import-password').focus();
      return;
    }

    await finishImport(importPending.content, mode, password);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-detail-cancel').addEventListener('click', () => detailDialog.close());
$('#btn-detail-close').addEventListener('click', () => detailDialog.close());
$('#btn-detail-save').addEventListener('click', async () => {
  const id = $('#detail-account-id').value;
  try {
    await unwrap(api.updateAccountMeta(id, {
      group: $('#detail-group').value,
      note: $('#detail-note').value,
    }));
    detailDialog.close();
    showToast(t('toast.saved'));
    await refreshAccounts();
  } catch (err) { showToast(err.message, true); }
});

$('#btn-bind-machine').addEventListener('click', async () => {
  const id = $('#detail-account-id').value;
  try {
    const r = await unwrap(api.bindMachineId(id));
    $('#detail-machine-id').textContent = r.machineId;
    showToast(t('toast.bound'));
    await refreshAccounts();
  } catch (err) { showToast(err.message, true); }
});

$('#btn-regen-machine').addEventListener('click', async () => {
  const id = $('#detail-account-id').value;
  if (!confirm(t('detailDialog.regenConfirm'))) return;
  try {
    const r = await unwrap(api.regenerateMachineId(id));
    $('#detail-machine-id').textContent = r.machineId;
    showToast(t('toast.regenerated'));
    await refreshAccounts();
  } catch (err) { showToast(err.message, true); }
});

$('#btn-import-trae').addEventListener('click', async () => {
  const btn = $('#btn-import-trae');
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = t('importDialog.importing');
  try {
    const result = await unwrap(api.importFromTrae());
    showToast(t('toast.imported', { email: result.account.email || result.account.name }));
    await refreshAccounts({ syncMessage: t('sync.importing') });
  } catch (err) { showToast(err.message, true); }
  finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

$$('.add-tab').forEach((tab) => tab.addEventListener('click', () => setAddMode(tab.dataset.mode)));
$('#btn-dialog-close').addEventListener('click', closeAddDialog);
$('#btn-cancel-add').addEventListener('click', closeAddDialog);
addDialog.addEventListener('click', (e) => { if (e.target === addDialog) closeAddDialog(); });
addDialog.addEventListener('cancel', (e) => { e.preventDefault(); closeAddDialog(); });

$('#btn-submit-add').addEventListener('click', async () => {
  const btn = $('#btn-submit-add');
  const payload = extractTokenPayload($('#token-input').value);
  if (!payload?.token) { showToast(t('toast.invalidToken'), true); return; }
  btn.disabled = true;
  btn.textContent = t('addDialog.adding');
  try {
    await unwrap(api.addAccount(payload.token, payload.tokenExpiredAt || undefined));
    await closeAddDialog();
    switchPage('accounts');
    showToast(t('toast.added'));
    await refreshAccounts({ syncMessage: t('sync.adding') });
  } catch (err) { showToast(err.message, true); }
  finally {
    btn.disabled = false;
    btn.textContent = t('addDialog.submit');
  }
});

$('#btn-import-in-dialog').addEventListener('click', async () => {
  const btn = $('#btn-import-in-dialog');
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = t('importDialog.importing');
  try {
    const result = await unwrap(api.importFromTrae());
    await closeAddDialog();
    switchPage('accounts');
    showToast(t('toast.imported', { email: result.account.email || result.account.name }));
    await refreshAccounts({ syncMessage: t('sync.importing') });
  } catch (err) { showToast(err.message, true); }
  finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
});

$('#btn-browser-login').addEventListener('click', async () => {
  $('#btn-browser-login').disabled = true;
  browserLoginActive = true;
  updateAddDialogFooter();
  const status = $('#browser-login-status');
  status.classList.remove('hidden');
  status.textContent = t('addDialog.loginWaiting');
  try { await unwrap(api.startBrowserLogin()); }
  catch (err) { status.textContent = err.message; resetBrowserLoginState(); }
});

$('#btn-cancel-browser').addEventListener('click', async () => {
  await api.cancelBrowserLogin().catch(() => {});
  resetBrowserLoginState();
});

api.onLoginSuccess(async (data) => {
  const wasRelogin = !!reloginAccountId;
  resetBrowserLoginState();
  if (addDialog.open) addDialog.close();
  showToast(wasRelogin ? t('toast.tokenUpdated') : t('toast.loginSuccess', { email: data.email || t('toast.newAccount') }));
  reloginAccountId = null;
  if (!wasRelogin) switchPage('accounts');
  try {
    await refreshAccounts({
      syncMessage: wasRelogin ? t('sync.updating') : t('sync.adding'),
    });
  } catch (err) {
    showToast(err.message, true);
  }
});
api.onLoginFailed((msg) => {
  resetBrowserLoginState();
  $('#browser-login-status').classList.remove('hidden');
  $('#browser-login-status').textContent = msg;
});
api.onLoginCancelled(resetBrowserLoginState);
api.onTraeAccountChanged(scheduleRefreshAccounts);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleRefreshAccounts();
});

$('#btn-scan-path').addEventListener('click', async () => {
  try { cachedTraePath = await unwrap(api.scanTraePath()); traePathEl.textContent = cachedTraePath; showToast(t('toast.traeFound')); }
  catch (err) { showToast(err.message, true); }
});

$('#btn-pick-path').addEventListener('click', async () => {
  try {
    const p = await unwrap(api.pickTraePath());
    if (p) { cachedTraePath = p; traePathEl.textContent = p; showToast(t('toast.pathSaved')); }
  } catch (err) { showToast(err.message, true); }
});

$('#setting-language').addEventListener('change', async (e) => {
  const lang = e.target.value;
  window.TraeHopI18n.setLocale(lang);
  await saveSettings({ language: lang });
  applyTheme(appSettings.theme);
  updateAutoRefreshStatus();
  refreshSettingsLabels();
  setDisclaimerMode(disclaimerRequired);
  setCleanRunning(cleanCleaning);
  syncSettingDependencies();
  renderUI();
  loadUsageHistory();
});

$('#setting-auto-refresh').addEventListener('change', async (e) => {
  await saveSettings({ autoRefreshEnabled: e.target.checked });
  syncSettingDependencies();
});
$('#setting-interval').addEventListener('change', (e) => saveSettings({ autoRefreshIntervalMinutes: Math.max(5, Number(e.target.value)) }));
$('#setting-notify-quota').addEventListener('change', async (e) => {
  await saveSettings({ notifyLowQuota: e.target.checked });
  syncSettingDependencies();
});
$('#setting-notify-expiry').addEventListener('change', async (e) => {
  await saveSettings({ notifyTokenExpiry: e.target.checked });
  renderExpiryAlerts();
});
$('#setting-quota-threshold').addEventListener('change', (e) => saveSettings({ lowQuotaThreshold: Number(e.target.value) }));
$('#setting-auto-backup').addEventListener('change', async (e) => {
  await saveSettings({ autoBackupEnabled: e.target.checked });
  syncSettingDependencies();
});
$('#setting-backup-interval').addEventListener('change', (e) => saveSettings({ autoBackupIntervalHours: Number(e.target.value) }));

$('#btn-pick-backup-dir').addEventListener('click', async () => {
  try {
    const dir = await unwrap(api.pickBackupDir());
    if (dir) {
      await saveSettings({ autoBackupDir: dir });
      $('#backup-dir').textContent = dir;
      showToast(t('toast.backupDirSaved'));
    }
  } catch (err) { showToast(err.message, true); }
});

$('#btn-backup-now').addEventListener('click', async () => {
  try {
    const r = await unwrap(api.runBackupNow());
    if (r.skipped) { showToast(r.reason, true); return; }
    showToast(t('toast.backupDone', { n: r.count }));
    lastBackupTs = Date.now();
    refreshSettingsLabels();
  } catch (err) { showToast(err.message, true); }
});

$('#btn-rescan-clean').addEventListener('click', () => { cleanScanned = false; scanCleanSize(); });
$('#btn-start-clean').addEventListener('click', handleClean);
$('#btn-cancel-clean').addEventListener('click', () => api.cancelClean());

$('#btn-show-disclaimer').addEventListener('click', () => showDisclaimer({ required: false }));
$('#btn-disclaimer-accept').addEventListener('click', handleDisclaimerAccept);
$('#btn-disclaimer-decline').addEventListener('click', handleDisclaimerDecline);
disclaimerDialog?.addEventListener('cancel', (e) => {
  if (disclaimerRequired) e.preventDefault();
});
disclaimerDialog?.addEventListener('click', (e) => {
  if (disclaimerRequired && e.target === disclaimerDialog) e.preventDefault();
});

window.addEventListener('traehop:localechange', () => {
  applyTheme(appSettings.theme);
  updateAutoRefreshStatus();
  refreshSettingsLabels();
  setDisclaimerMode(disclaimerRequired);
  setCleanRunning(cleanCleaning);
  renderUI();
  if (currentPage === 'overview') loadUsageHistory();
});

(async () => {
  try {
    await window.TraeHopI18n.ready;
    initAccountsSwitchTip();
    await loadSettings();
    if (!appSettings.language) await saveSettings({ language: window.TraeHopI18n.getLocale() });
    await ensureDisclaimerAccepted();
    await loadTraePath();
    await refreshAccounts();
    // 从 Trae 切回本窗口时重新探测：用户关掉 Trae 后「打开 IDE」按钮应重新出现
    window.addEventListener('focus', () => syncTraeRunning(true));
    // 窗口失焦即停光条并回到初始；启动中除外（Trae 抢焦点会把动画误停）
    window.addEventListener('blur', () => { if (!traceLaunching) clearTraceRing(); });
    const p = await unwrap(api.getTraePath());
    if (!p) {
      try {
        cachedTraePath = await unwrap(api.scanTraePath());
        traePathEl.textContent = cachedTraePath;
      } catch { /* */ }
    }
  } catch (err) {
    initialLoading = false;
    renderUI();
    showToast(err.message, true);
  }
})();
