/**
 * people.js — People & Debt Management Overview Controller
 */

import { bootstrapPage } from './app.js';
import { getPeopleList, getPersonBalances, recordLoanEvent } from './database.js';
import { parseIntegerBDT } from './accounting.js';
import { formatBDT, formatDateBD, getTodayBD, escapeHtml, showToast, generateUuid } from './utils.js';

let activeTab = 'payable';
let allBalances = [];
let allPeople = [];

function readInitialTab() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return tab === 'receivable' ? 'receivable' : 'payable';
}

function setActiveTab(tab) {
  activeTab = tab;
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', url);

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  renderList();
}

function renderList() {
  const root = document.getElementById('people-list-root');
  const query = document.getElementById('people-search').value.trim().toLowerCase();

  let payableTotal = 0;
  let receivableTotal = 0;
  for (const b of allBalances) {
    if (b.direction === 'payable' && b.outstanding_balance > 0) payableTotal += Number(b.outstanding_balance);
    if (b.direction === 'receivable' && b.outstanding_balance > 0) receivableTotal += Number(b.outstanding_balance);
  }
  document.getElementById('summary-payable').textContent = formatBDT(payableTotal);
  document.getElementById('summary-receivable').textContent = formatBDT(receivableTotal);

  const filtered = allBalances
    .filter((b) => b.direction === activeTab)
    .filter((b) => !query || b.person_name.toLowerCase().includes(query));

  if (filtered.length === 0) {
    root.innerHTML = `
      <div class="card empty-state">
        <div class="empty-state-icon">${activeTab === 'payable' ? '🤝' : '💳'}</div>
        <h3>${activeTab === 'payable' ? 'No debts you owe' : 'No money owed to you'}</h3>
        <p>${query ? 'No matching person found.' : 'Tap "+ Record" above to log borrowing or lending.'}</p>
      </div>
    `;
    return;
  }

  root.innerHTML = filtered.map((item) => {
    const isSettled = Number(item.outstanding_balance) <= 0;
    const pct = item.total_principal > 0
      ? Math.min(100, Math.round((Number(item.total_settled) / Number(item.total_principal)) * 100))
      : 100;
    const href = `./person-details.html?id=${encodeURIComponent(item.person_id)}&direction=${encodeURIComponent(item.direction)}`;
    const colorClass = isSettled ? 'text-muted' : (activeTab === 'payable' ? 'text-payable' : 'text-receivable');

    return `
      <a class="person-card card-interactive" href="${href}">
        <div style="flex:1;min-width:0;">
          <div class="row" style="gap:8px;">
            <strong style="font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.person_name)}</strong>
            ${isSettled ? '<span class="badge badge-income">Settled</span>' : ''}
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">
            ${activeTab === 'payable' ? 'Borrowed' : 'Lent'} ${formatBDT(item.total_principal)} ·
            ${activeTab === 'payable' ? 'Repaid' : 'Collected'} ${formatBDT(item.total_settled)} ·
            ${item.transaction_count} ${item.transaction_count === 1 ? 'entry' : 'entries'}
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%;"></div>
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="person-balance tabular-nums ${colorClass}">${formatBDT(item.outstanding_balance)}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);">${formatDateBD(item.last_activity_at)}</div>
        </div>
      </a>
    `;
  }).join('');
}

async function loadData() {
  try {
    const [balances, people] = await Promise.all([
      getPersonBalances(),
      getPeopleList(),
    ]);
    allBalances = balances;
    allPeople = people;

    const datalist = document.getElementById('existing-people-datalist');
    datalist.innerHTML = allPeople
      .map((p) => `<option value="${escapeHtml(p.name)}"></option>`)
      .join('');

    renderList();
  } catch (err) {
    showToast(err.message || 'Could not load people balances.', 'error');
  }
}

function bindModal() {
  const modal = document.getElementById('loan-modal');
  const openBtn = document.getElementById('add-loan-btn');
  const closeBtn = document.getElementById('close-loan-modal');
  const cancelBtn = document.getElementById('cancel-loan-modal');
  const form = document.getElementById('loan-form');
  const dirSelect = document.getElementById('loan-direction');
  const nameInput = document.getElementById('loan-person-name');
  const amountInput = document.getElementById('loan-amount');
  const dateInput = document.getElementById('loan-date');
  const descInput = document.getElementById('loan-description');
  const errEl = document.getElementById('loan-error');
  const submitBtn = document.getElementById('loan-submit-btn');

  const openModal = () => {
    errEl.classList.add('hidden');
    dirSelect.value = activeTab;
    dateInput.value = getTodayBD();
    modal.classList.remove('hidden');
    setTimeout(() => nameInput.focus(), 50);
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

    const personName = nameInput.value.trim();
    if (!personName) {
      errEl.textContent = 'Person name is required.';
      errEl.classList.remove('hidden');
      return;
    }

    const parsed = parseIntegerBDT(amountInput.value);
    if (!parsed.ok) {
      errEl.textContent = parsed.error;
      errEl.classList.remove('hidden');
      return;
    }

    const direction = dirSelect.value;
    const eventType = direction === 'payable' ? 'borrow' : 'lend';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      await recordLoanEvent({
        personName,
        direction,
        eventType,
        amount: parsed.value,
        description: descInput.value.trim(),
        transactionDate: dateInput.value || getTodayBD(),
        clientMutationId: generateUuid(),
      });

      form.reset();
      closeModal();
      setActiveTab(direction);
      await loadData();
      showToast(
        direction === 'payable'
          ? `Recorded ${formatBDT(parsed.value)} borrowed from ${personName}.`
          : `Recorded ${formatBDT(parsed.value)} lent to ${personName}.`,
        'success'
      );
    } catch (err) {
      errEl.textContent = err.message || 'Could not save loan record.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Record';
    }
  });
}

bootstrapPage({
  activeNav: 'people',
  onReady: async () => {
    activeTab = readInitialTab();
    document.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });
    document.getElementById('people-search').addEventListener('input', renderList);
    bindModal();
    setActiveTab(activeTab);
    await loadData();
  },
});
