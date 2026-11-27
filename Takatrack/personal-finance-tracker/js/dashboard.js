/**
 * dashboard.js — Home / Dashboard Controller
 * ------------------------------------------
 * Handles:
 *  - Month navigation persisted in URL (?month=YYYY-MM)
 *  - Live monthly summary (income, expenses, net cash flow, I owe, owed to me)
 *  - Ultra-fast one-tap Quick Expense Entry (with offline queue fallback + Undo)
 *  - Quick Income Entry modal
 *  - Recent monthly transactions preview
 */

import { bootstrapPage } from './app.js';
import {
  getCategories,
  getDashboardSummary,
  getMonthlyTransactions,
  createTransaction,
  deleteTransaction,
} from './database.js';
import { parseIntegerBDT } from './accounting.js';
import { syncManager } from './sync.js';
import {
  formatBDT,
  formatDateBD,
  formatTimeBD,
  getCurrentYearMonthBD,
  getMonthLabel,
  getTodayBD,
  escapeHtml,
  showToast,
  generateUuid,
} from './utils.js';

let selectedYear;
let selectedMonth;
let expenseCategories = [];
let incomeCategories = [];

function readInitialMonthFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const ym = params.get('month');
  if (ym && /^\d{4}-\d{2}$/.test(ym)) {
    const [y, m] = ym.split('-').map(Number);
    if (m >= 1 && m <= 12) return { year: y, month: m };
  }
  return getCurrentYearMonthBD();
}

function writeMonthToUrl(year, month) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const url = new URL(window.location.href);
  url.searchParams.set('month', ym);
  window.history.replaceState({}, '', url);
}

function renderCategories() {
  const expSelect = document.getElementById('qe-category');
  const chipsRoot = document.getElementById('qe-category-chips');
  const incSelect = document.getElementById('qi-category');

  expSelect.innerHTML = `<option value="">Uncategorized</option>` + expenseCategories
    .map((c) => `<option value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join('');

  chipsRoot.innerHTML = expenseCategories.slice(0, 8)
    .map((c) => `<button type="button" class="chip" data-cat-id="${escapeHtml(c.id)}" data-cat-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`)
    .join('');

  chipsRoot.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const alreadyActive = chip.classList.contains('active');
      chipsRoot.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
      if (alreadyActive) {
        expSelect.value = '';
      } else {
        chip.classList.add('active');
        expSelect.value = chip.dataset.catId;
      }
    });
  });

  expSelect.addEventListener('change', () => {
    chipsRoot.querySelectorAll('.chip').forEach((b) => {
      b.classList.toggle('active', b.dataset.catId === expSelect.value);
    });
  });

  incSelect.innerHTML = `<option value="">Uncategorized</option>` + incomeCategories
    .map((c) => `<option value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
    .join('');
}

async function refreshDashboard() {
  document.getElementById('current-month-label').textContent = getMonthLabel(selectedYear, selectedMonth);
  writeMonthToUrl(selectedYear, selectedMonth);

  try {
    const [summary, monthlyTxs] = await Promise.all([
      getDashboardSummary(selectedYear, selectedMonth),
      getMonthlyTransactions(selectedYear, selectedMonth),
    ]);

    document.getElementById('kpi-expenses').textContent = formatBDT(summary.total_expenses);
    document.getElementById('kpi-income').textContent = formatBDT(summary.total_income);
    document.getElementById('kpi-net-flow').textContent = formatBDT(summary.net_cash_flow, { signed: true });
    document.getElementById('kpi-i-owe').textContent = formatBDT(summary.total_i_owe);
    document.getElementById('kpi-owed-to-me').textContent = formatBDT(summary.total_owed_to_me);

    renderRecentList(monthlyTxs.slice(0, 8));
  } catch (err) {
    if (!navigator.onLine) {
      showToast('You are offline. New expenses will be queued locally until connection returns.', 'warning');
    } else {
      showToast(err.message || 'Could not load dashboard summary.', 'error');
    }
  }
}

function renderRecentList(items) {
  const root = document.getElementById('recent-transactions-root');
  if (!items || items.length === 0) {
    root.innerHTML = `
      <div class="card empty-state">
        <div class="empty-state-icon">৳</div>
        <h3>No transactions in ${escapeHtml(getMonthLabel(selectedYear, selectedMonth))}</h3>
        <p>Add an expense above or record income to see your monthly cash flow update live.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <div class="tx-list">
      ${items.map((tx) => {
        const isExpense = tx.type === 'expense';
        const title = tx.description || tx.category_name || (isExpense ? 'Expense' : 'Income');
        return `
          <div class="tx-item">
            <div class="tx-left">
              <div class="tx-avatar ${isExpense ? 'badge-expense' : 'badge-income'}">
                ${isExpense ? '−' : '+'}
              </div>
              <div class="tx-meta">
                <div class="tx-title">${escapeHtml(title)}</div>
                <div class="tx-sub">
                  <span class="badge ${isExpense ? 'badge-expense' : 'badge-income'}">${escapeHtml(tx.category_name || 'Uncategorized')}</span>
                  <span>${escapeHtml(formatDateBD(tx.transaction_date))} · ${escapeHtml(formatTimeBD(tx.occurred_at))}</span>
                </div>
              </div>
            </div>
            <div class="tx-right">
              <div class="tx-amount tabular-nums ${isExpense ? 'text-expense' : 'text-income'}">
                ${isExpense ? '−' : '+'}${formatBDT(tx.amount)}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function bindQuickExpenseForm() {
  const form = document.getElementById('quick-expense-form');
  const amountInput = document.getElementById('qe-amount');
  const descInput = document.getElementById('qe-description');
  const catSelect = document.getElementById('qe-category');
  const errEl = document.getElementById('qe-error');
  const submitBtn = document.getElementById('qe-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');

    const parsed = parseIntegerBDT(amountInput.value);
    if (!parsed.ok) {
      errEl.textContent = parsed.error;
      errEl.classList.remove('hidden');
      amountInput.focus();
      return;
    }

    const selectedOpt = catSelect.options[catSelect.selectedIndex];
    const categoryId = catSelect.value || null;
    const categoryName = categoryId ? selectedOpt.dataset.name : 'Uncategorized';
    const description = descInput.value.trim();
    const transactionDate = getTodayBD();
    const clientMutationId = generateUuid();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const payload = {
      type: 'expense',
      amount: parsed.value,
      categoryId,
      categoryName,
      description,
      transactionDate,
      clientMutationId,
    };

    try {
      if (!navigator.onLine) {
        syncManager.enqueue('create_transaction', payload);
        form.reset();
        document.querySelectorAll('#qe-category-chips .chip').forEach((c) => c.classList.remove('active'));
        showToast(`Queued ${formatBDT(parsed.value)} locally (offline). Will sync when online.`, 'warning');
        return;
      }

      const created = await createTransaction(payload);
      form.reset();
      document.querySelectorAll('#qe-category-chips .chip').forEach((c) => c.classList.remove('active'));
      await refreshDashboard();

      showToast(`Expense ${formatBDT(created.amount)} saved.`, 'success', {
        onUndo: async () => {
          await deleteTransaction(created.id);
          await refreshDashboard();
          showToast('Expense undone.', 'success');
        },
      });
    } catch (err) {
      if (!navigator.onLine) {
        syncManager.enqueue('create_transaction', payload);
        form.reset();
        showToast(`Connection lost. Queued ${formatBDT(parsed.value)} locally for sync.`, 'warning');
      } else {
        errEl.textContent = err.message || 'Could not save expense.';
        errEl.classList.remove('hidden');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Expense';
      amountInput.focus();
    }
  });
}

function bindQuickIncomeModal() {
  const modal = document.getElementById('income-modal');
  const openBtn = document.getElementById('open-income-modal-btn');
  const closeBtn = document.getElementById('close-income-modal');
  const cancelBtn = document.getElementById('cancel-income-modal');
  const form = document.getElementById('quick-income-form');
  const amountInput = document.getElementById('qi-amount');
  const catSelect = document.getElementById('qi-category');
  const descInput = document.getElementById('qi-description');
  const dateInput = document.getElementById('qi-date');
  const errEl = document.getElementById('qi-error');
  const submitBtn = document.getElementById('qi-submit-btn');

  const openModal = () => {
    errEl.classList.add('hidden');
    dateInput.value = getTodayBD();
    modal.classList.remove('hidden');
    setTimeout(() => amountInput.focus(), 50);
  };

  const closeModal = () => modal.classList.add('hidden');

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');

    const parsed = parseIntegerBDT(amountInput.value);
    if (!parsed.ok) {
      errEl.textContent = parsed.error;
      errEl.classList.remove('hidden');
      return;
    }

    const selectedOpt = catSelect.options[catSelect.selectedIndex];
    const categoryId = catSelect.value || null;
    const categoryName = categoryId ? selectedOpt.dataset.name : 'Uncategorized';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const payload = {
      type: 'income',
      amount: parsed.value,
      categoryId,
      categoryName,
      description: descInput.value.trim(),
      transactionDate: dateInput.value || getTodayBD(),
      clientMutationId: generateUuid(),
    };

    try {
      if (!navigator.onLine) {
        syncManager.enqueue('create_transaction', payload);
        form.reset();
        closeModal();
        showToast(`Queued income ${formatBDT(parsed.value)} locally (offline).`, 'warning');
        return;
      }

      const created = await createTransaction(payload);
      form.reset();
      closeModal();
      await refreshDashboard();
      showToast(`Income ${formatBDT(created.amount)} saved.`, 'success', {
        onUndo: async () => {
          await deleteTransaction(created.id);
          await refreshDashboard();
          showToast('Income undone.', 'success');
        },
      });
    } catch (err) {
      errEl.textContent = err.message || 'Could not save income.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Income';
    }
  });
}

function bindMonthNavigation() {
  document.getElementById('prev-month-btn').addEventListener('click', () => {
    selectedMonth -= 1;
    if (selectedMonth < 1) {
      selectedMonth = 12;
      selectedYear -= 1;
    }
    refreshDashboard();
  });

  document.getElementById('next-month-btn').addEventListener('click', () => {
    selectedMonth += 1;
    if (selectedMonth > 12) {
      selectedMonth = 1;
      selectedYear += 1;
    }
    refreshDashboard();
  });
}

bootstrapPage({
  activeNav: 'dashboard',
  onReady: async () => {
    const initial = readInitialMonthFromUrl();
    selectedYear = initial.year;
    selectedMonth = initial.month;

    document.getElementById('quick-date-badge').textContent = formatDateBD(getTodayBD());

    const [expCats, incCats] = await Promise.all([
      getCategories('expense'),
      getCategories('income'),
    ]);
    expenseCategories = expCats;
    incomeCategories = incCats;
    renderCategories();

    bindMonthNavigation();
    bindQuickExpenseForm();
    bindQuickIncomeModal();

    window.addEventListener('takatrack:synced', refreshDashboard);
    await refreshDashboard();
  },
});
