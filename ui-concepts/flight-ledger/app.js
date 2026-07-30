const root = document.documentElement;
const themeButton = document.querySelector('#themeToggle');
const toast = document.querySelector('#toast');
let toastTimer;

function setTheme(theme) {
  root.dataset.theme = theme;
  const dark = theme === 'dark';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
  themeButton.textContent = dark ? '浅色' : '深色';
  localStorage.setItem('tk-concept-theme', theme);
}

setTheme(localStorage.getItem('tk-concept-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.querySelector('#ledgerDate').textContent = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
themeButton.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

document.querySelectorAll('.account-chip').forEach((button) => {
  button.addEventListener('click', () => {
    const active = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  });
});

document.querySelector('[data-select-all]').addEventListener('click', () => {
  document.querySelectorAll('.account-chip:not(.warning)').forEach((button) => {
    button.setAttribute('aria-pressed', 'true');
    button.classList.add('active');
  });
});

document.querySelectorAll('[data-toast]').forEach((button) => button.addEventListener('click', () => {
  toast.textContent = button.dataset.toast;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}));
