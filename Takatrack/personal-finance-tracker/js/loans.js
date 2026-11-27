/**
 * loans.js — Person Details, Partial Repayments, Over-Repayment Guard, & Loan History
 */

import { bootstrapPage } from './app.js';
import {
  getPersonDetails,
  recordLoanEvent,
  deleteLoanTransaction,
} from './database.js';
import { parseIntegerBDT } from './accounting.js';
import {
  formatBDT,
  formatDateBD,
  formatTimeBD,
  getTodayBD,
  escapeHtml,
  showToast,
  showConfirmDialog,
  TX_TYPE_LABELS,
  generateUuid,
} from './utils.js';

let personId = null;
let direction = 'payable';
let currentDetails = null;
let modalEventType = null;

async function refreshDetails() {
  try {
    currentDetails = await getPersonDetails(personId, direction);
    const { person, total_principal, total_settled, outstanding_balance, transactions } = currentDetails;
    const isPayable = direction === 'payable';

    document.getElementById('person-name-heading').textContent = person.name;
    document.getElementById('person-direction-label').textContent = isPayable
      ? 'I owe them (Payable — excluded from expenses)'
      : 'They owe me (Receivable — excluded from income)';

    const statusBadge = document.getElementById('person-status-badge');
    if (outstanding_balance <= 0) {
      statusBadge.className = 'badge badge-income';
      statusBadge.textContent = 'Settled';
    } else {
      statusBadge.className = `badge ${isPayable ? 'badge-payable' : 'badge-receivable'}`;
      statusBadge.textContent = isPayable ? 'I Owe' : 'Owes Me';
    }

    const outEl = document.getElementById('detail-outstanding');
    outEl.textContent = formatBDT(outstanding_balance);
    outEl.className = `net-flow-value tabular-nums ${outstanding_balance <= 0 ? 'text-income' : (isPayable ? 'text-payable' : 'text-receivable')}`;

    document.getElementById('label-principal').textContent = isPayable ? 'Total Borrowed' : 'Total Lent';
    document.getElementById('label-settled').textContent = isPayable ? 'Total Repaid' : 'Total Collected';
    document.getElementById('detail-principal').textContent = formatBDT(total_principal);
    document.getElementById('detail-settled').textContent = formatBDT(total_settled);

    const pct = total_principal > 0 ? Math.min(100, Math.round((total_settled / total_principal) * 100)) : 100;
    document.getElementById('detail-progress-fill').style.width = `${pct}%`;

    document.getElementById('btn-add-principal').textContent = isPayable ? '+ Borrow More' : '+ Lend More';
    document.getElementById('btn-record-settlement').textContent = isPayable ? 'Record Repayment' : 'Record Collection';
    document.getElementById('detail-count').textContent = `${transactions.length} ${transactions.length === 1 ? 'entry' : 'entries'}`;

    renderHistory(transactions);
  } catch (err) {
    showToast(err.message || 'Could not load person details.', 'error');
  }
}

function renderHistory(transactions) {
  const root = document.getElementById('person-history-root');
  if (!transactions.length) {
    root.innerHTML = `
      <div class="card empty-state">
        <h3>No history yet</h3>
        <p>Use the buttons above to record borrowing, lending, or repayments.</p>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <div class="tx-list">
      ${transactions.map((tx) => {
        const isPrincipal = tx.event_type === 'borrow' || tx.event_type === 'lend';
        const label = TX_TYPE_LABELS[tx.event_type] || tx.event_type;
        return `
          <div class="tx-item">
            <div class="tx-left">
              <div class="tx-avatar ${isPrincipal ? (direction === 'payable' ? 'badge-payable' : 'badge-receivable') : 'badge-income'}">
                ${isPrincipal ? '↗' : '✓'}
              </div>
              <div class="tx-meta">
                <div class="tx-title">${escapeHtml(tx.description || label)}</div>
                <div class="tx-sub">
                  <span class="badge badge-${escapeHtml(tx.event_type)}">${escapeHtml(label)}</span>
                  ${tx.is_overpayment_override ? '<span class="badge badge-payable">Overpayment Override</span>' : ''}
                  <span>${escapeHtml(formatDateBD(tx.transaction_date))} · ${escapeHtml(formatTimeBD(tx.occurred_at))}</span>
                </div>
              </div>
            </div>
            <div class="tx-right">
              <div class="tx-amount tabular-nums ${isPrincipal ? (direction === 'payable' ? 'text-payable' : 'text-receivable') : 'text-income'}">
                ${formatBDT(tx.amount)}
              </div>
              <button type="button" class="btn btn-ghost btn-icon" data-delete-loan="${escapeHtml(tx.id)}" aria-label="Delete entry" title="Delete">🗑</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  root.querySelectorAll('[data-delete-loan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirmDialog({
        title: 'Delete Loan Entry?',
        message: 'Deleting this entry will immediately recalculate the outstanding balance for this person.',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteLoanTransaction(btn.dataset.deleteLoan);
        await refreshDetails();
        showToast('Entry deleted and balance recalculated.', 'success');
      } catch (err) {
        showToast(err.message || 'Could not delete entry.', 'error');
      }
    });
  });
}

function bindActionModal() {
  const modal = document.getElementById('person-action-modal');
  const titleEl = document.getElementById('pam-title');
  const form = document.getElementById('pam-form');
  const amountInput = document.getElementById('pam-amount');
  const dateInput = document.getElementById('pam-date');
  const descInput = document.getElementById('pam-description');
  const errEl = document.getElementById('pam-error');
  const submitBtn = document.getElementById('pam-submit');

  const openModal = (eventType) => {
    modalEventType = eventType;
    errEl.classList.add('hidden');
    form.reset();
    dateInput.value = getTodayBD();

    const titles = {
      borrow: `Borrow More from ${currentDetails?.person?.name || ''}`,
      lend: `Lend More to ${currentDetails?.person?.name || ''}`,
      repay_debt: `Record Repayment to ${currentDetails?.person?.name || ''}`,
      collect_loan: `Record Collection from ${currentDetails?.person?.name || ''}`,
    };
    titleEl.textContent = titles[eventType] || 'Record Entry';
    modal.classList.remove('hidden');
    setTimeout(() => amountInput.focus(), 50);
  };

  const closeModal = () => modal.classList.add('hidden');

  document.getElementById('btn-add-principal').addEventListener('click', () => {
    openModal(direction === 'payable' ? 'borrow' : 'lend');
  });
  document.getElementById('btn-record-settlement').addEventListener('click', () => {
    openModal(direction === 'payable' ? 'repay_debt' : 'collect_loan');
  });
  document.getElementById('close-pam').addEventListener('click', closeModal);
  document.getElementById('cancel-pam').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  const submitLoan = async (allowOverpayment = false) => {
    const parsed = parseIntegerBDT(amountInput.value);
    if (!parsed.ok) {
      errEl.textContent = parsed.error;
      errEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      await recordLoanEvent({
        personId,
        direction,
        eventType: modalEventType,
        amount: parsed.value,
        description: descInput.value.trim(),
        transactionDate: dateInput.value || getTodayBD(),
        allowOverpayment,
        clientMutationId: generateUuid(),
      });
      closeModal();
      await refreshDetails();
      showToast(`${TX_TYPE_LABELS[modalEventType]} of ${formatBDT(parsed.value)} recorded.`, 'success');
    } catch (err) {
      if (err.code === 'OVERPAYMENT_EXCEEDS_BALANCE') {
        const confirmOverride = await showConfirmDialog({
          title: 'Exceeds Outstanding Balance',
          message: `The entered amount (${formatBDT(parsed.value)}) exceeds the current outstanding balance (${formatBDT(err.outstandingBalance)}). Do you want to record this as an intentional correction?`,
          confirmText: 'Confirm Correction',
          danger: true,
        });
        if (confirmOverride) {
          await submitLoan(true);
          return;
        }
      } else {
        errEl.textContent = err.message || 'Could not save entry.';
        errEl.classList.remove('hidden');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    await submitLoan(false);
  });
}

bootstrapPage({
  activeNav: 'people',
  onReady: async () => {
    const params = new URLSearchParams(window.location.search);
    personId = params.get('id');
    direction = params.get('direction') === 'receivable' ? 'receivable' : 'payable';
    document.getElementById('back-to-people').href = `./people.html?tab=${direction}`;

    if (!personId) {
      window.location.replace('./people.html');
      return;
    }

    bindActionModal();
    await refreshDetails();
  },
});
