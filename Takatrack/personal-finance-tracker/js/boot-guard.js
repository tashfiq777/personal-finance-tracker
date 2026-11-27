/**
 * boot-guard.js — Non-module classic script guard
 * -----------------------------------------------
 * Runs even when opened via file:/// (where browsers block ES modules).
 * Prevents a blank screen by displaying a clear local-server instruction
 * card if opened via file:// or if ES modules fail to load.
 */
(function () {
  function showBanner(title, subtitle, bodyHtml) {
    var root = document.getElementById('auth-root');
    var shell = document.getElementById('app-shell');
    if (shell) shell.classList.add('hidden');
    if (!root) return;
    root.classList.remove('hidden');
    root.innerHTML =
      '<div class="auth-screen"><div class="auth-card">' +
      '<div class="auth-brand"><div class="brand-mark">৳</div><div>' +
      '<h1 style="margin:0;font-size:1.2rem;font-weight:800;">' + title + '</h1>' +
      '<p style="margin:0;font-size:0.82rem;color:var(--text-muted);">' + subtitle + '</p>' +
      '</div></div>' + bodyHtml + '</div></div>';
  }

  if (window.location.protocol === 'file:') {
    showBanner(
      'Open via a Local Server',
      'Browsers block JavaScript modules on file:// URLs',
      '<p style="font-size:0.9rem;color:var(--text-secondary);margin-top:0;">' +
      'Opening <code>index.html</code> directly from File Explorer uses <code>file://</code>, which disables ES Modules and PWA features in Edge/Chrome.' +
      '</p>' +
      '<p style="font-size:0.88rem;color:var(--text-secondary);margin-bottom:8px;"><strong>Run one of these commands inside the <code>personal-finance-tracker</code> folder:</strong></p>' +
      '<pre style="background:var(--bg-subtle);padding:12px;border-radius:10px;font-size:0.82rem;overflow-x:auto;margin:0 0 12px;">npx serve .\n# or with Python:\npython -m http.server 8000</pre>' +
      '<p style="font-size:0.84rem;color:var(--text-muted);margin:0;">Then open <strong>http://localhost:3000</strong> (or <strong>http://localhost:8000</strong>) in your browser, or deploy to Vercel.</p>'
    );
    return;
  }

  setTimeout(function () {
    if (!window.__TAKATRACK_BOOTED__) {
      showBanner(
        'App Could Not Start',
        'Offline or blocked script resources',
        '<p style="font-size:0.9rem;color:var(--text-secondary);margin-top:0;">' +
        'Make sure you are running over <code>http://localhost</code> or <code>https://</code> and have an internet connection on first load.' +
        '</p>' +
        '<button type="button" class="btn btn-primary btn-block" onclick="window.location.reload()">Retry</button>'
      );
    }
  }, 2500);
})();
