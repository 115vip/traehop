try {
  const t = localStorage.getItem('traehop-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* ignore */
}

// 主题分段按钮的高亮必须和实际主题同步，否则首帧会出现「浅色选中 + 深色界面」，
// 要等异步的设置 IPC 回来才纠正（肉眼可见的闪动）。
document.addEventListener('DOMContentLoaded', () => {
  const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  document.querySelectorAll('.theme-segment-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === mode);
  });
});
