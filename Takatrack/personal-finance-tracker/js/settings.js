/**
 * settings.js — Theme, Custom Categories, CSV Export, JSON Backup/Restore, Sync, & Logout
 */

import { bootstrapPage, applyTheme, getSavedTheme, flushOfflineQueue } from './app.js';
import {
  getCategories,
  createCategory,
  deleteCategory,
  getUnifiedTransactions,
  exportAllUserData,
  importUserBackup,
} from './database.js';
import { signOut } from './auth.js';
import { buildCsvExport } from './accounting.js';
import { syncManager } from './sync.js';
import {
  escapeHtml,
  showToast,
  showConfirmDialog,
  downloadTextFile,
  getTodayBD,
} from './utils.js';

function initThemeControls() {
  const current = getSavedTheme();
  const buttons = document.querySelectorAll('[data-theme-choice]');
  const syncActive = (theme) => {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === theme));
  };
  syncActive(current);

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice;
      applyTheme(choice);
      syncActive(choice);
      showToast(`Theme set to ${choice}.`, 'success');
    });
  });
}

async function renderCategories() {
  const root = document.getElementById('categories-list');
  const cats = await getCategories();

  if (!cats.length) {
    root.innerHTML = `<p class="text-muted" style="margin:0;">No categories yet.</p>`;
    return;
  }

  root.innerHTML = cats.map((c) => `
    <div class="row-between" style="padding:8px 12px;border:1px solid var(--border);border-radius:10px;">
      <div class="row">
        <span class="badge ${c.type === 'expense' ? 'badge-expense' : 'badge-income'}">${escapeHtml(c.type)}</span>
        <strong style="font-size:0.92rem;">${escapeHtml(c.name)}</strong>
        ${c.is_default ? '<span class="text-muted" style="font-size:0.76rem;">Default</span>' : ''}
      </div>
      ${!c.is_default
        ? `<button type="button" class="btn btn-ghost btn-sm" data-del-cat="${escapeHtml(c.id)}">Remove</button>`
        : ''}
    </div>
  `).join('');

  root.querySelectorAll('[data-del-cat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirmDialog({
        title: 'Remove Custom Category?',
        message: 'Existing transactions will keep their saved category label.',
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteCategory(btn.dataset.delCat);
        await renderCategories();
        showToast('Category removed.', 'success');
      } catch (err) {
        showToast(err.message || 'Could not remove category.', 'error');
      }
    });
  });
}

function bindCategoryForm() {
  const form = document.getElementById('add-category-form');
  const nameInput = document.getElementById('cat-name-input');
  const typeSelect = document.getElementById('cat-type-select');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      await createCategory({ name, type: typeSelect.value });
      nameInput.value = '';
      await renderCategories();
      showToast(`Category "${name}" added.`, 'success');
    } catch (err) {
      showToast(err.message || 'Could not add category.', 'error');
    }
  });
}

function bindExportsAndRestore() {
  document.getElementById('export-csv-btn').addEventListener('click', async () => {
    try {
      const rows = await getUnifiedTransactions({ limit: 5000 });
      const csv = buildCsvExport(rows);
      downloadTextFile(`takatrack-export-${getTodayBD()}.csv`, csv, 'text/csv;charset=utf-8');
      showToast(`Exported ${rows.length} transactions to CSV.`, 'success');
    } catch (err) {
      showToast(err.message || 'CSV export failed.', 'error');
    }
  });

  document.getElementById('export-json-btn').addEventListener('click', async () => {
    try {
      const data = await exportAllUserData();
      downloadTextFile(
        `takatrack-backup-${getTodayBD()}.json`,
        JSON.stringify(data, null, 2),
        'application/json;charset=utf-8'
      );
      showToast('JSON backup downloaded.', 'success');
    } catch (err) {
      showToast(err.message || 'Backup export failed.', 'error');
    }
  });

  document.getElementById('import-json-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const ok = await showConfirmDialog({
        title: 'Restore JSON Backup?',
        message: `This will merge ${parsed.transactions?.length || 0} transactions and ${parsed.loan_transactions?.length || 0} loan entries into your account without creating duplicates.`,
        confirmText: 'Restore',
      });
      if (!ok) return;

      const result = await importUserBackup(parsed);
      await renderCategories();
      showToast(`Restored ${result.importedTx} transactions and ${result.importedLoans} loan entries.`, 'success');
    } catch (err) {
      showToast(err.message || 'Invalid backup file.', 'error');
    }
  });
}

function bindSyncAndAccount(session) {
  document.getElementById('settings-account-email').textContent = session.user?.email || 'Signed in';

  const summaryEl = document.getElementById('sync-queue-summary');
  syncManager.subscribe((status) => {
    if (!status.online) {
      summaryEl.textContent = `Offline · ${status.pending} ${status.pending === 1 ? 'entry' : 'entries'} waiting locally.`;
    } else if (status.pending > 0) {
      summaryEl.textContent = `${status.pending} pending ${status.pending === 1 ? 'entry' : 'entries'} ready to sync.`;
    } else {
      summaryEl.textContent = 'All entries are synced with Supabase.';
    }
  });

  document.getElementById('manual-sync-btn').addEventListener('click', async () => {
    const res = await flushOfflineQueue();
    if (res.synced === 0 && res.remaining === 0) {
      showToast('Everything is already up to date.', 'success');
    } else if (res.failed > 0) {
      showToast(`Synced ${res.synced}, ${res.remaining} still pending.`, 'warning');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    const ok = await showConfirmDialog({
      title: 'Sign Out?',
      message: 'You will need to sign in again to access your private financial records.',
      confirmText: 'Sign Out',
      danger: true,
    });
    if (!ok) return;
    await signOut();
    window.location.href = '../index.html';
  });
}

bootstrapPage({
  activeNav: 'settings',
  onReady: async (session) => {
    initThemeControls();
    bindCategoryForm();
    bindExportsAndRestore();
    bindSyncAndAccount(session);
    await renderCategories();
  },
});
