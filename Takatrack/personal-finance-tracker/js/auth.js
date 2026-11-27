/**
 * auth.js — Supabase Authentication & Private-by-Default Session Gate
 */

import { getSupabase, ensureDefaultCategories } from './database.js';
import { saveLocalConfig, isConfigValid } from './config.js';
import { escapeHtml } from './utils.js';

export async function getSession() {
  const { data, error } = await getSupabase().auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await getSupabase().auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  await ensureDefaultCategories();
  return data;
}

export async function signUp(email, password, fullName = '') {
  const { data, error } = await getSupabase().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { full_name: fullName.trim() },
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

/**
 * Renders the private-by-default Sign In / Sign Up screen when unauthenticated.
 */
export function renderAuthScreen(container, onAuthenticated) {
  let mode = 'signin';

  const draw = () => {
    container.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="brand-mark">৳</div>
            <div>
              <h1 style="margin:0;font-size:1.25rem;font-weight:800;">TakaTrack</h1>
              <p style="margin:0;font-size:0.82rem;color:var(--text-muted);">Private Personal Finance Tracker (BDT)</p>
            </div>
          </div>

          <div class="segmented-tabs" style="margin-bottom:18px;">
            <button type="button" class="segmented-tab ${mode === 'signin' ? 'active' : ''}" data-mode="signin">Sign In</button>
            <button type="button" class="segmented-tab ${mode === 'signup' ? 'active' : ''}" data-mode="signup">Create Account</button>
          </div>

          <form id="auth-form" class="stack-sm" novalidate>
            ${mode === 'signup' ? `
              <div class="form-group">
                <label class="form-label" for="auth-name">Full Name (optional)</label>
                <input id="auth-name" class="form-input" type="text" autocomplete="name" placeholder="e.g. Tashfiqur Rahman" />
              </div>
            ` : ''}

            <div class="form-group">
              <label class="form-label" for="auth-email">Email Address</label>
              <input id="auth-email" class="form-input" type="email" required autocomplete="email" placeholder="you@example.com" />
            </div>

            <div class="form-group">
              <label class="form-label" for="auth-password">Password</label>
              <input id="auth-password" class="form-input" type="password" required minlength="6" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" placeholder="Minimum 6 characters" />
            </div>

            <p id="auth-message" class="form-error hidden"></p>

            <button type="submit" id="auth-submit" class="btn btn-primary btn-block" style="margin-top:6px;">
              ${mode === 'signin' ? 'Sign In' : 'Create Private Account'}
            </button>
          </form>

          <p style="margin:16px 0 0;font-size:0.78rem;color:var(--text-muted);text-align:center;">
            Protected by Supabase Authentication &amp; Row Level Security.
          </p>
        </div>
      </div>
    `;

    container.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        draw();
      });
    });

    const form = container.querySelector('#auth-form');
    const msgEl = container.querySelector('#auth-message');
    const submitBtn = container.querySelector('#auth-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msgEl.classList.add('hidden');
      const email = container.querySelector('#auth-email').value.trim();
      const password = container.querySelector('#auth-password').value;
      const fullName = container.querySelector('#auth-name')?.value || '';

      if (!email || !password) {
        msgEl.textContent = 'Please enter both email and password.';
        msgEl.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = mode === 'signin' ? 'Signing in...' : 'Creating account...';

      try {
        if (mode === 'signin') {
          const { session } = await signIn(email, password);
          if (session) onAuthenticated(session);
        } else {
          const res = await signUp(email, password, fullName);
          if (res.session) {
            await ensureDefaultCategories();
            onAuthenticated(res.session);
          } else {
            msgEl.style.color = 'var(--income)';
            msgEl.textContent = 'Account created! Check your email to confirm your address, then sign in.';
            msgEl.classList.remove('hidden');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Private Account';
          }
        }
      } catch (err) {
        msgEl.style.color = 'var(--expense)';
        msgEl.textContent = escapeHtml(err.message || 'Authentication failed.');
        msgEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'signin' ? 'Sign In' : 'Create Private Account';
      }
    });
  };

  draw();
}

export function renderConfigMissingScreen(container) {
  container.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="brand-mark">৳</div>
          <div>
            <h1 style="margin:0;font-size:1.25rem;font-weight:800;">Connect Supabase</h1>
            <p style="margin:0;font-size:0.82rem;color:var(--text-muted);">One-time setup for local testing or Vercel</p>
          </div>
        </div>
        <p style="font-size:0.88rem;color:var(--text-secondary);margin-top:0;">
          Enter your public Supabase Project URL and Anon Key below (saved only in this browser), or set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in Vercel Environment Variables.
        </p>
        <form id="local-setup-form" class="stack-sm" novalidate>
          <div class="form-group">
            <label class="form-label" for="setup-url">Supabase Project URL</label>
            <input id="setup-url" class="form-input" type="url" required placeholder="https://your-project-ref.supabase.co" />
          </div>
          <div class="form-group">
            <label class="form-label" for="setup-key">Supabase Public Anon Key</label>
            <input id="setup-key" class="form-input" type="text" required placeholder="eyJhbGciOi..." />
          </div>
          <p id="setup-err" class="form-error hidden"></p>
          <button type="submit" class="btn btn-primary btn-block">Save &amp; Continue</button>
        </form>
        <p style="font-size:0.78rem;color:var(--text-muted);margin:14px 0 0;">
          Never use your <code>service_role</code> key here. See <strong>README.md</strong> to run <code>supabase/schema.sql</code> first.
        </p>
      </div>
    </div>
  `;

  const form = container.querySelector('#local-setup-form');
  const errEl = container.querySelector('#setup-err');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    const url = container.querySelector('#setup-url').value.trim();
    const key = container.querySelector('#setup-key').value.trim();
    if (!isConfigValid({ supabaseUrl: url, supabaseAnonKey: key })) {
      errEl.textContent = 'Enter a valid https:// Supabase URL and public Anon Key.';
      errEl.classList.remove('hidden');
      return;
    }
    saveLocalConfig(url, key);
    window.location.reload();
  });
}

export function renderOfflineBootScreen(container) {
  container.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="brand-mark">৳</div>
          <div>
            <h1 style="margin:0;font-size:1.25rem;font-weight:800;">You're Offline</h1>
            <p style="margin:0;font-size:0.82rem;color:var(--text-muted);">Internet required for first-time sign-in</p>
          </div>
        </div>
        <p style="font-size:0.9rem;color:var(--text-secondary);margin-top:0;">
          Connect to the internet once to load the Supabase client and sign in. After that, the PWA caches the app shell and queues offline expenses automatically.
        </p>
        <button type="button" class="btn btn-primary btn-block" onclick="window.location.reload()">Retry Connection</button>
      </div>
    </div>
  `;
}
