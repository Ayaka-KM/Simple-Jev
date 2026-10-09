// The model comparison page: theme button, bar widths, scrollable tables and the
// table of contents that follows the reader. Everything on the page is readable
// without this script; it only adds the bars' lengths and the conveniences.

import { initThemeToggle } from './theme-toggle.js';

initThemeToggle(document.getElementById('theme-toggle'), document.getElementById('theme-label'));

// ---- bars: length from data-value, against the largest value in the same chart ----

for (const chart of document.querySelectorAll('[data-bars]')) {
  const bars = [...chart.querySelectorAll('.cmp-bar[data-value]')];
  const values = bars.map((bar) => Number(bar.dataset.value));
  const max = Number(chart.dataset.max) || Math.max(0, ...values.filter(Number.isFinite));
  bars.forEach((bar, i) => {
    const v = values[i];
    const pct = max > 0 && Number.isFinite(v) ? Math.min(100, Math.max(0, (v / max) * 100)) : 0;
    bar.style.setProperty('--w', `${pct.toFixed(2)}%`);
  });
}

// ---- comparison tables: give every cell its column name, for the stacked phone layout ----

for (const table of document.querySelectorAll('.cmp-table.is-stack')) {
  const heads = [...table.querySelectorAll('thead th')];
  for (const row of table.querySelectorAll('tbody tr')) {
    let column = 0;
    for (const cell of row.children) {
      const head = heads[column];
      column += cell.colSpan;
      if (cell.tagName !== 'TD' || cell.colSpan > 1 || !head) continue;
      const dot = head.querySelector('.cmp-dot');
      if (dot?.classList.contains('is-luna')) {
        cell.dataset.col = 'Luna';
        cell.classList.add('is-luna');
      } else if (dot?.classList.contains('is-jev')) {
        cell.dataset.col = 'Jev';
        cell.classList.add('is-jev');
      } else {
        cell.dataset.col = head.dataset.short || head.textContent.trim();
      }
    }
  }
  table.dataset.labeled = '';
}

// ---- tables: keyboard-scrollable when wider than the card, with edge fades ----

const SCROLL_HINT = '左右滑动查看完整表格';

function syncScroller(scroller) {
  const wrap = scroller.parentElement;
  const overflow = scroller.scrollWidth - scroller.clientWidth > 1;
  if (overflow) {
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', scroller.dataset.label || '表格');
  } else {
    scroller.removeAttribute('tabindex');
    scroller.removeAttribute('role');
    scroller.removeAttribute('aria-label');
  }
  const left = scroller.scrollLeft;
  wrap.toggleAttribute('data-more-left', overflow && left > 1);
  wrap.toggleAttribute('data-more-right', overflow && left + scroller.clientWidth < scroller.scrollWidth - 1);
  const hint = wrap.nextElementSibling;
  if (hint && hint.classList.contains('cmp-scroll-hint')) hint.hidden = !overflow;
}

const scrollers = [...document.querySelectorAll('.cmp-scroll')];
for (const scroller of scrollers) {
  const hint = document.createElement('p');
  hint.className = 'cmp-scroll-hint';
  hint.textContent = SCROLL_HINT;
  hint.hidden = true;
  scroller.parentElement.after(hint);
  scroller.addEventListener('scroll', () => syncScroller(scroller), { passive: true });
}
const syncAll = () => scrollers.forEach(syncScroller);
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(syncAll);
  scrollers.forEach((scroller) => observer.observe(scroller));
} else {
  window.addEventListener('resize', syncAll);
}
syncAll();

// ---- table of contents: mark the section being read ----

const tocLinks = [...document.querySelectorAll('.cmp-toc-list a[href^="#"]')];
const sections = tocLinks
  .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
  .filter(Boolean);

let current = null;
function markCurrent() {
  // The last section whose top has passed a line a little below the top of the window.
  const line = Math.min(160, window.innerHeight * 0.3);
  let index = 0;
  sections.forEach((section, i) => {
    if (section.getBoundingClientRect().top <= line) index = i;
  });
  // At the very bottom, the last section counts even if it is too short to reach the line.
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
    index = sections.length - 1;
  }
  const link = tocLinks[index];
  if (link === current) return;
  if (current) current.removeAttribute('aria-current');
  link.setAttribute('aria-current', 'true');
  current = link;
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    markCurrent();
  });
}
if (sections.length === tocLinks.length && sections.length > 0) {
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  markCurrent();
}
