// The theme button shared by every page: cycles 跟随系统 → 浅色 → 深色 and remembers
// the choice (theme.js applies it before first paint on the next load).

const THEME_STORE = 'simple-jev:theme';
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
const THEME_COLOR = { light: '#f6f5f1', dark: '#0d0d0d' };
const ORDER = ['auto', 'light', 'dark'];

function readSaved() {
  try {
    const mode = localStorage.getItem(THEME_STORE);
    return mode === 'light' || mode === 'dark' ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

function save(mode) {
  try {
    if (mode === 'auto') localStorage.removeItem(THEME_STORE);
    else localStorage.setItem(THEME_STORE, mode);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

// `button` holds the three icons (shown by data-mode); `label` is the text next to them.
export function initThemeToggle(button, label) {
  function apply(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    // Keep the browser chrome in step with a manual override.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const own = meta.media.includes('dark') ? 'dark' : 'light';
      meta.content = THEME_COLOR[mode === 'auto' ? own : mode];
    }
    button.dataset.mode = mode;
    if (label) label.textContent = THEME_LABEL[mode];
    button.setAttribute('aria-label', `切换主题：当前为${THEME_LABEL[mode]}`);
  }

  button.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(button.dataset.mode) + 1) % ORDER.length];
    save(next);
    apply(next);
  });
  apply(readSaved());
}
