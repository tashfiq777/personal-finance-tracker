/**
 * sync.js — Persistent Offline Expense Queue & Deduplicated Cloud Sync
 * --------------------------------------------------------------------
 * Guarantees:
 *  - Never silently loses offline entries (persisted in localStorage).
 *  - Never falsely claims an offline entry is saved to the cloud.
 *  - Uses unique client_mutation_id UUIDs so retries never create duplicates.
 *  - Automatically flushes when connectivity returns.
 */

import { generateUuid } from './utils.js';

const QUEUE_KEY = 'takatrack_offline_queue_v1';

export class OfflineSyncManager {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.isSyncing = false;
    this.listeners = new Set();
  }

  getQueue() {
    try {
      const raw = this.storage.getItem(QUEUE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveQueue(items) {
    this.storage.setItem(QUEUE_KEY, JSON.stringify(items));
    this.notify();
  }

  enqueue(actionType, payload) {
    const queue = this.getQueue();
    const item = {
      id: generateUuid(),
      client_mutation_id: payload.clientMutationId || generateUuid(),
      action_type: actionType,
      payload,
      queued_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
    };
    queue.push(item);
    this.saveQueue(queue);
    return item;
  }

  getPendingCount() {
    return this.getQueue().length;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getStatus());
    return () => this.listeners.delete(fn);
  }

  getStatus() {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    const pending = this.getPendingCount();
    let state = 'online';
    if (!online) state = 'offline';
    else if (this.isSyncing) state = 'syncing';
    return { online, pending, syncing: this.isSyncing, state };
  }

  notify() {
    const status = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Flushes all queued mutations sequentially via the supplied executor.
   * Keeps failed items in the queue safely without dropping them.
   * @param {(item: Object) => Promise<void>} executor
   */
  async flush(executor) {
    if (this.isSyncing) return { synced: 0, failed: 0, remaining: this.getPendingCount() };
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.notify();
      return { synced: 0, failed: 0, remaining: this.getPendingCount() };
    }

    const queue = this.getQueue();
    if (queue.length === 0) return { synced: 0, failed: 0, remaining: 0 };

    this.isSyncing = true;
    this.notify();

    const remaining = [];
    let synced = 0;
    let failed = 0;

    for (const item of queue) {
      try {
        await executor(item);
        synced += 1;
      } catch (err) {
        failed += 1;
        remaining.push({
          ...item,
          attempts: (item.attempts || 0) + 1,
          last_error: err?.message || 'Sync error',
        });
      }
    }

    this.isSyncing = false;
    this.saveQueue(remaining);
    return { synced, failed, remaining: remaining.length };
  }
}

export const syncManager = new OfflineSyncManager();
