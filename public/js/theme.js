// Applies the saved theme before first paint so the page never flashes the wrong colors.
try {
  var savedTheme = localStorage.getItem('simple-jev:theme');
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
} catch (e) {
  // Storage unavailable (private mode, blocked site data): follow the system theme.
}
