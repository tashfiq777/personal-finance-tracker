/**
 * utils.js — Bangladesh Currency/Date Formatting, XSS-safe DOM Helpers, Toasts, & Modals
 */

const BD_TIMEZONE = 'Asia/Dhaka';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const TX_TYPE_LABELS = {
  expense: 'Expense',
  income: 'Income',
  borrow: 'Borrowed',
  lend: 'Lent',
  repay_debt: 'Debt Repayment',
  collect_loan: 'Loan Collection',
};

/**
 * Formats an integer BDT amount with Bangladeshi/South Asian digit grouping (৳1,25,000).
 * @param {number} amount
 * @param {{ signed?: boolean }} [opts]
 */
export function formatBDT(amount, opts = {}) {
  const num = Math.round(Number(amount) || 0);
  const absFormatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(Math.abs(num));

  if (num < 0) return `-৳${absFormatted}`;
  if (opts.signed && num > 0) return `+৳${absFormatted}`;
  return `৳${absFormatted}`;
}

/**
 * Returns today's YYYY-MM-DD in Asia/Dhaka timezone.
 */
export function getTodayBD() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

export function getCurrentYearMonthBD() {
  const today = getTodayBD();
  return {
    year: Number.parseInt(today.slice(0, 4), 10),
    month: Number.parseInt(today.slice(5, 7), 10),
  };
}

export function getMonthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function getShortMonthName(month) {
  return SHORT_MONTHS[month - 1] || '';
}

export function formatDateBD(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d, 6, 0, 0));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BD_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dt);
}

export function formatTimeBD(isoStr) {
  if (!isoStr) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BD_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(isoStr));
}

export function formatGroupDateHeading(dateStr) {
  const today = getTodayBD();
  if (dateStr === today) return `Today — ${formatDateBD(dateStr)}`;
  const [y, m, d] = today.split('-').map(Number);
  const yesterdayDt = new Date(Date.UTC(y, m - 1, d - 1));
  const yStr = yesterdayDt.toISOString().slice(0, 10);
  if (dateStr === yStr) return `Yesterday — ${formatDateBD(dateStr)}`;
  return formatDateBD(dateStr);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Displays a toast notification with optional Undo action.
 */
export function showToast(message, type = 'success', opts = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
  };

  if (typeof opts.onUndo === 'function') {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'toast-undo';
    undoBtn.textContent = opts.undoLabel || 'Undo';
    undoBtn.addEventListener('click', async () => {
      dismiss();
      try {
        await opts.onUndo();
      } catch (err) {
        showToast(err.message || 'Could not undo action.', 'error');
      }
    });
    toast.appendChild(undoBtn);
  }

  container.appendChild(toast);
  timer = setTimeout(dismiss, opts.duration || (opts.onUndo ? 6000 : 3500));
}

/**
 * Accessible confirmation modal dialog returning a Promise<boolean>.
 */
export function showConfirmDialog({
  title = 'Confirm Action',
  message = 'Are you sure?',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-header">
          <h2 class="modal-title" id="confirm-title">${escapeHtml(title)}</h2>
        </div>
        <p style="margin:0;color:var(--text-secondary);font-size:0.94rem;">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    const cleanup = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => cleanup(false));
    backdrop.querySelector('[data-action="confirm"]').addEventListener('click', () => cleanup(true));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
  });
}

/**
 * Triggers a browser file download.
 */
export function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
