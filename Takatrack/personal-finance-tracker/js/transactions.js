/**
 * transactions.js — Unified Transaction History Controller
 * --------------------------------------------------------
 * Supports all 6 transaction types (expense, income, borrow, lend,
 * repay_debt, collect_loan), date grouping, multi-facet filtering,
 * search, editing, deletion with confirmation, and Undo.
 */

import { bootstrapPage } from './app.js';
import {
  getUnifiedTransactions,
  getCategories,
  getPeopleList,
  updateTransaction,
  deleteTransaction,
  createTransaction,
  updateLoanTransaction,
  deleteLoanTransaction,
} from './database.js';
import { filterUnifiedTransactions, parseIntegerBDT } from './accounting.js';
import {
  formatBDT,
  formatTimeBD,
  formatGroupDateHeading,
  escapeHtml,
  showToast,
  showConfirmDialog,
  TX_TYPE_LABELS,
} from './utils.js';

let allRecords = [];
let allCategories = [];
let editingRecord = null;

function getFilters() {
  return {
    query: document.getElementById('filter-search').value,
    type: document.getElementById('filter-type').value,
    category: document.getElementById('filter-category').value,
    personId: document.getElementById('filter-person').value,
    dateFrom: document.getElementById('filter-from').value,
    dateTo: document.getElementById('filter-to').value,
    minAmount: document.getElementById('filter-min').value,
    maxAmount: document.getElementById('filter-max').value,
    sort: document.getElementById('filter-sort').value,
  };
}

function renderList() {
  const root = document.getElementById('activity-list-root');
  const filters = getFilters();
  const filtered = filterUnifiedTransactions(allRecords, filters);

  filtered.sort((a, b) => {
    if (filters.sort === 'date_asc') {
      return (a.transaction_date + a.occurred_at).localeCompare(b.transaction_date + b.occurred_at);
    }
    if (filters.sort === 'amount_desc') return Number(b.amount) - Number(a.amount);
    if (filters.sort === 'amount_asc') return Number(a.amount) - Number(b.amount);
    return (b.transaction_date + b.occurred_at).localeCompare(a.transaction_date + a.occurred_at);
  });

  document.getElementById('activity-count-sub').textContent =
    `${filtered.length} ${filtered.length === 1 ? 'transaction' : 'transactions'} shown`;

  if (filtered.length === 0) {
    root.innerHTML = `
      <div class="card empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>No matching transactions</h3>
        <p>Try clearing filters or record a new expense, income, or loan.</p>
      </div>
    `;
    return;
  }

  // Group by transaction_date
  const groups = new Map();
  for (const row of filtered) {
    const key = row.transaction_date || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const parts = [];
  for (const [dateStr, items] of groups.entries()) {
    parts.push(`
      <div class="tx-date-group">
        <h2 class="tx-date-heading">${escapeHtml(formatGroupDateHeading(dateStr))}</h2>
        <div class="tx-list">
          ${items.map(renderRow).join('')}
        </div>
      </div>
    `);
  }

  root.innerHTML = parts.join('');

  root.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rec = allRecords.find((r) => r.id === btn.dataset.editId);
      if (rec) openEditModal(rec);
    });
  });

  root.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const rec = allRecords.find((r) => r.id === btn.dataset.deleteId);
      if (rec) await handleDelete(rec);
    });
  });
}

function renderRow(row) {
  const typeLabel = TX_TYPE_LABELS[row.transaction_type] || row.transaction_type;
  const title = row.description
    || (row.person_name ? `${typeLabel} — ${row.person_name}` : row.category_name || typeLabel);

  let amountClass = 'text-muted';
  let sign = '';
  let icon = '•';
  if (row.transaction_type === 'expense') {
    amountClass = 'text-expense';
    sign = '−';
    icon = '−';
  } else if (row.transaction_type === 'income') {
    amountClass = 'text-income';
    sign = '+';
    icon = '+';
  } else if (row.transaction_type === 'borrow') {
    amountClass = 'text-payable';
    icon = '↙';
  } else if (row.transaction_type === 'lend') {
    amountClass = 'text-receivable';
    icon = '↗';
  } else {
    amountClass = 'text-income';
    icon = '✓';
  }

  return `
    <div class="tx-item">
      <div class="tx-left">
        <div class="tx-avatar badge-${escapeHtml(row.transaction_type)}">${icon}</div>
        <div class="tx-meta">
          <div class="tx-title">${escapeHtml(title)}</div>
          <div class="tx-sub">
            <span class="badge badge-${escapeHtml(row.transaction_type)}">${escapeHtml(typeLabel)}</span>
            ${row.source_table === 'transactions' ? `<span>${escapeHtml(row.category_name || 'Uncategorized')}</span>` : ''}
            ${row.person_name ? `<span>· ${escapeHtml(row.person_name)}</span>` : ''}
            <span>· ${escapeHtml(formatTimeBD(row.occurred_at))}</span>
          </div>
        </div>
      </div>
      <div class="tx-right">
        <div class="tx-amount tabular-nums ${amountClass}">${sign}${formatBDT(row.amount)}</div>
        <button type="button" class="btn btn-ghost btn-icon" data-edit-id="${escapeHtml(row.id)}" aria-label="Edit" title="Edit">✎</button>
        <button type="button" class="btn btn-ghost btn-icon" data-delete-id="${escapeHtml(row.id)}" aria-label="Delete" title="Delete">🗑</button>
      </div>
    </div>
  `;
}

async function handleDelete(rec) {
  const ok = await showConfirmDialog({
    title: `Delete ${TX_TYPE_LABELS[rec.transaction_type] || 'Transaction'}?`,
    message: `This will remove ${formatBDT(rec.amount)} and immediately recalculate all affected balances and reports.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;

  try {
    if (rec.source_table === 'transactions') {
      await deleteTransaction(rec.id);
      await loadData();
      showToast('Transaction deleted.', 'success', {
        onUndo: async () => {
          await createTransaction({
            type: rec.transaction_type,
            amount: rec.amount,
            categoryId: rec.category_id,
            categoryName: rec.category_name,
            description: rec.description || '',
            transactionDate: rec.transaction_date,
          });
          await loadData();
          showToast('Transaction restored.', 'success');
        },
      });
    } else {
      await deleteLoanTransaction(rec.id);
      await loadData();
      showToast('Loan entry deleted and person balance recalculated.', 'success');
    }
  } catch (err) {
    showToast(err.message || 'Could not delete transaction.', 'error');
  }
}

function openEditModal(rec) {
  editingRecord = rec;
  const modal = document.getElementById('edit-tx-modal');
  const catGroup = document.getElementById('edit-category-group');
  const catSelect = document.getElementById('edit-category');

  document.getElementById('edit-tx-title').textContent = `Edit ${TX_TYPE_LABELS[rec.transaction_type] || 'Transaction'}`;
  document.getElementById('edit-amount').value = rec.amount;
  document.getElementById('edit-date').value = rec.transaction_date;
  document.getElementById('edit-description').value = rec.description || '';
  document.getElementById('edit-error').classList.add('hidden');

  if (rec.source_table === 'transactions') {
    catGroup.classList.remove('hidden');
    const matchingCats = allCategories.filter((c) => c.type === rec.transaction_type);
    catSelect.innerHTML = `<option value="">Uncategorized</option>` + matchingCats
      .map((c) => `<option value="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" ${c.name === rec.category_name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
  } else {
    catGroup.classList.add('hidden');
  }

  modal.classList.remove('hidden');
}

function bindEditModal() {
  const modal = document.getElementById('edit-tx-modal');
  const form = document.getElementById('edit-tx-form');
  const errEl = document.getElementById('edit-error');
  const submitBtn = document.getElementById('edit-submit-btn');

  const closeModal = () => {
    editingRecord = null;
    modal.classList.add('hidden');
  };

  document.getElementById('close-edit-tx').addEventListener('click', closeModal);
  document.getElementById('cancel-edit-tx').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editingRecord) return;
    errEl.classList.add('hidden');

    const parsed = parseIntegerBDT(document.getElementById('edit-amount').value);
    if (!parsed.ok) {
      errEl.textContent = parsed.error;
      errEl.classList.remove('hidden');
      return;
    }

    const transactionDate = document.getElementById('edit-date').value;
    const description = document.getElementById('edit-description').value.trim();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      if (editingRecord.source_table === 'transactions') {
        const catSelect = document.getElementById('edit-category');
        const opt = catSelect.options[catSelect.selectedIndex];
        const categoryId = catSelect.value || null;
        const categoryName = categoryId ? opt.dataset.name : 'Uncategorized';

        await updateTransaction(editingRecord.id, {
          amount: parsed.value,
          categoryId,
          categoryName,
          description,
          transactionDate,
        });
      } else {
        await updateLoanTransaction(editingRecord.id, {
          amount: parsed.value,
          description,
          transactionDate,
        });
      }

      closeModal();
      await loadData();
      showToast('Transaction updated and balances recalculated.', 'success');
    } catch (err) {
      errEl.textContent = err.message || 'Could not update transaction.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Changes';
    }
  });
}

async function loadData() {
  try {
    const [records, cats, people] = await Promise.all([
      getUnifiedTransactions({ limit: 1000 }),
      getCategories(),
      getPeopleList(),
    ]);
    allRecords = records;
    allCategories = cats;

    const catSelect = document.getElementById('filter-category');
    const prevCat = catSelect.value;
    const uniqueCatNames = Array.from(new Set(records.map((r) => r.category_name).filter(Boolean))).sort();
    catSelect.innerHTML = `<option value="all">All Categories</option>` + uniqueCatNames
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join('');
    catSelect.value = prevCat || 'all';

    const personSelect = document.getElementById('filter-person');
    const prevPerson = personSelect.value;
    personSelect.innerHTML = `<option value="all">All People</option>` + people
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
    personSelect.value = prevPerson || 'all';

    renderList();
  } catch (err) {
    showToast(err.message || 'Could not load activity history.', 'error');
  }
}

bootstrapPage({
  activeNav: 'activity',
  onReady: async () => {
    const filterIds = [
      'filter-search', 'filter-type', 'filter-category', 'filter-person',
      'filter-sort', 'filter-from', 'filter-to', 'filter-min', 'filter-max',
    ];
    filterIds.forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', renderList);
    });

    document.getElementById('reset-filters-btn').addEventListener('click', () => {
      document.getElementById('filter-search').value = '';
      document.getElementById('filter-type').value = 'all';
      document.getElementById('filter-category').value = 'all';
      document.getElementById('filter-person').value = 'all';
      document.getElementById('filter-sort').value = 'date_desc';
      document.getElementById('filter-from').value = '';
      document.getElementById('filter-to').value = '';
      document.getElementById('filter-min').value = '';
      document.getElementById('filter-max').value = '';
      renderList();
    });

    bindEditModal();
    await loadData();
  },
});
