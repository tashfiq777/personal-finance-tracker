/**
 * app.js — Shared App Shell, Theme Manager, Navigation, Sync Wiring, & PWA Registration
 */

import { initDatabase, createTransaction, recordLoanEvent, ensureDefaultCategories } from './database.js';
import { getSession, renderAuthScreen, renderConfigMissingScreen, renderOfflineBootScreen } from './auth.js';
import { syncManager } from './sync.js';
import { showToast } from './utils.js';

const THEME_KEY = 'takatrack_theme';

export function getSavedTheme() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

export function applyTheme(theme = getSavedTheme()) {
  localStorage.setItem(THEME_KEY, theme);
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function getNavItems() {
  const inPagesDir = window.location.pathname.includes('/pages/');
  const prefix = inPagesDir ? '../' : './';
  return [
    {
      id: 'dashboard',
      label: 'Home',
      href: `${prefix}index.html`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>`,
    },
    {
      id: 'activity',
      label: 'Activity',
      href: `${prefix}pages/activity.html`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
    },
    {
      id: 'people',
      label: 'People',
      href: `${prefix}pages/people.html`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    },
    {
      id: 'reports',
      label: 'Reports',
      href: `${prefix}pages/reports.html`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>`,
    },
    {
      id: 'settings',
      label: 'Settings',
      href: `${prefix}pages/settings.html`,
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    },
  ];
}

function mountNavigation(activeNav) {
  const items = getNavItems();

  const sidebar = document.getElementById('desktop-sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="sidebar-brand">
        <div class="brand-mark" style="width:34px;height:34px;font-size:1.1rem;">৳</div>
        <span>TakaTrack</span>
      </div>
      <nav class="sidebar-nav" aria-label="Main navigation">
        ${items.map((item) => `
          <a class="sidebar-link ${item.id === activeNav ? 'active' : ''}" href="${item.href}">
            ${item.icon}
            <span>${item.label}</span>
          </a>
        `).join('')}
      </nav>
      <div class="sidebar-footer">
        <div id="sidebar-sync-pill" class="sync-pill"><span class="sync-dot"></span><span>Online</span></div>
      </div>
    `;
  }

  const bottomNav = document.getElementById('bottom-nav');
  if (bottomNav) {
    bottomNav.innerHTML = items.map((item) => `
      <a class="bottom-nav-item ${item.id === activeNav ? 'active' : ''}" href="${item.href}" aria-current="${item.id === activeNav ? 'page' : 'false'}">
        ${item.icon}
        <span>${item.label}</span>
      </a>
    `).join('');
  }
}

export async function flushOfflineQueue() {
  const result = await syncManager.flush(async (item) => {
    if (item.action_type === 'create_transaction') {
      await createTransaction({
        ...item.payload,
        clientMutationId: item.client_mutation_id,
      });
    } else if (item.action_type === 'record_loan_event') {
      await recordLoanEvent({
        ...item.payload,
        clientMutationId: item.client_mutation_id,
      });
    }
  });

  if (result.synced > 0) {
    showToast(`Synced ${result.synced} queued ${result.synced === 1 ? 'entry' : 'entries'} to cloud.`, 'success');
    window.dispatchEvent(new CustomEvent('takatrack:synced', { detail: result }));
  }
  return result;
}

function wireSyncIndicators() {
  const updatePills = (status) => {
    const pills = document.querySelectorAll('.sync-pill');
    pills.forEach((pill) => {
      pill.classList.remove('offline', 'syncing');
      if (status.state === 'offline') {
        pill.classList.add('offline');
        pill.innerHTML = `<span class="sync-dot"></span><span>Offline${status.pending ? ` (${status.pending} queued)` : ''}</span>`;
      } else if (status.state === 'syncing') {
        pill.classList.add('syncing');
        pill.innerHTML = `<span class="sync-dot"></span><span>Syncing (${status.pending})...</span>`;
      } else if (status.pending > 0) {
        pill.classList.add('syncing');
        pill.innerHTML = `<span class="sync-dot"></span><span>Pending (${status.pending})</span>`;
      } else {
        pill.innerHTML = `<span class="sync-dot"></span><span>Online</span>`;
      }
    });
  };

  syncManager.subscribe(updatePills);
  window.addEventListener('online', () => {
    syncManager.notify();
    flushOfflineQueue();
  });
  window.addEventListener('offline', () => syncManager.notify());
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    const inPagesDir = window.location.pathname.includes('/pages/');
    const swPath = inPagesDir ? '../service-worker.js' : './service-worker.js';
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swPath).catch(() => {});
    });
  }
}

/**
 * Bootstraps every page: applies theme, initializes Supabase, enforces auth,
 * mounts navigation, syncs offline queue, and invokes page-specific `onReady`.
 */
export async function bootstrapPage({ activeNav, onReady }) {
  window.__TAKATRACK_BOOTED__ = true;
  applyTheme();
  registerServiceWorker();

  const shell = document.getElementById('app-shell');
  const authRoot = document.getElementById('auth-root');

  try {
    await initDatabase();
  } catch (err) {
    shell?.classList.add('hidden');
    authRoot?.classList.remove('hidden');
    if (err.message === 'SUPABASE_NOT_CONFIGURED') {
      renderConfigMissingScreen(authRoot || document.body);
      return;
    }
    if (err.message === 'SUPABASE_SDK_OFFLINE') {
      renderOfflineBootScreen(authRoot || document.body);
      return;
    }
    throw err;
  }

  const startApp = async (session) => {
    authRoot?.classList.add('hidden');
    shell?.classList.remove('hidden');
    mountNavigation(activeNav);
    wireSyncIndicators();
    if (navigator.onLine) {
      await ensureDefaultCategories();
      flushOfflineQueue().catch(() => {});
    }
    await onReady(session);
  };

  const session = await getSession();
  if (!session) {
    shell?.classList.add('hidden');
    authRoot?.classList.remove('hidden');
    renderAuthScreen(authRoot, startApp);
    return;
  }

  await startApp(session);
}
