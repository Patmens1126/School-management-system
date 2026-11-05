// Small UI toolkit.
//
// SECURITY: nothing here ever uses innerHTML. Text is always inserted with
// textContent / text nodes, so teacher comments or names containing
// "<script>" are displayed as harmless text (XSS protection).
import { db } from './supabase.js';
import { SCHOOL_TIMEZONE } from './config.js';
import { isUuid } from './validation.js';

// ---------- DOM builder ----------
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    const lower = key.toLowerCase();
    if (lower === 'style' || lower === 'innerhtml' || lower === 'outerhtml' || lower === 'srcdoc') {
      throw new Error(`Attribute "${key}" is not allowed.`);
    }
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(lower.slice(2), value);
    else if (key === 'href' && /^\s*(javascript|data|vbscript):/i.test(String(value))) throw new Error('Unsafe link.');
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);

// Like replaceChildren/append, but silently skips null/false so optional pieces never print "null".
const compact = (items) => items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
export const show = (root, ...items) => root.replaceChildren(...compact(items));
export const push = (root, ...items) => root.append(...compact(items));

// ---------- Query helpers ----------
export async function must(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function countOf(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export function paramId(name) {
  const value = new URLSearchParams(location.search).get(name);
  return isUuid(value) ? value : null;
}

// ---------- Dates ----------
export function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIMEZONE }).format(new Date());   // YYYY-MM-DD
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(ts) {
  return new Date(ts).toLocaleString('en-GB', { timeZone: SCHOOL_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function pct(value) {
  return value === null || value === undefined ? '-' : `${Number(value).toFixed(1)}%`;
}

export function rating(value) {
  return value === null || value === undefined ? '-' : `${Number(value).toFixed(1)}/5`;
}

export async function getActiveSemester() {
  return must(db.from('semesters')
    .select('id, term, status, academic_year_id, academic_years(name)')
    .eq('status', 'active').maybeSingle());
}

export function semesterLabel(sem) {
  return `${sem.academic_years?.name ?? ''} - Semester ${sem.term}`;
}

// ---------- Errors: friendly, never technical ----------
export function isOffline(err) {
  if (!navigator.onLine) return true;
  if (err && (err.name === 'FunctionsFetchError' || err.message === 'Failed to fetch')) return false;
  return !!err && !err.code && !err.status && /network|load failed/i.test(String(err.message || err));
}

export function errorMessage(err, fallback = "We couldn't save this information. Please try again.") {
  if (isOffline(err)) return 'Connection lost. Your changes have not been submitted.';
  const text = String(err && (err.message || err));
  if (/timeout|timed out|time out/i.test(text)) {
    return 'The request timed out. Please try again in a moment, or check that the Supabase function is deployed and reachable.';
  }
  switch (err && err.code) {
    case '23505': return 'That record already exists.';
    case '23503': return 'This item is linked to other records, so it cannot be changed or removed.';
    case '23514': return 'Some of the values are not valid. Please check them and try again.';
    case '42501': return 'You do not have permission to do that.';
    case 'P0001': return err.message;          // messages raised by our own database rules are written for users
    default: return fallback;
  }
}

export const loadError = (err) => errorMessage(err, "We couldn't load this information. Please try again.");

// ---------- Feedback ----------
export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const node = el('div', { class: type === 'error' ? 'toast toast-error' : 'toast', role: type === 'error' ? 'alert' : 'status', text: message });
  box.append(node);
  setTimeout(() => node.remove(), type === 'error' ? 8000 : 4500);
}

export function alertBox(message, type = 'error') {
  return el('p', { class: `alert alert-${type}`, role: type === 'error' ? 'alert' : 'status', text: message });
}

// Disables the button while work is running - prevents duplicate submissions.
export async function busy(button, work, label = 'Saving...') {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ---------- Building blocks ----------
export function card(title, ...content) {
  return el('section', { class: 'card' }, title ? el('h2', { text: title }) : null, ...content);
}

export function badge(text, kind = '') {
  return el('span', { class: `badge ${kind}`.trim(), text });
}

export function statusBadge(status) {
  const map = {
    present: ['Present', 'badge-solid'], absent: ['Absent', 'badge-navy'], late: ['Late', 'badge-tint'],
    active: ['Active', 'badge-solid'], inactive: ['Inactive', 'badge-muted'],
    graduated: ['Graduated', 'badge-tint'], transferred: ['Transferred', 'badge-tint'],
    planned: ['Planned', 'badge-muted'], closed: ['Closed', 'badge-navy'],
    pending: ['Pending', 'badge-tint'], approved: ['Approved', 'badge-solid'], rejected: ['Rejected', 'badge-muted'],
  };
  const [text, kind] = map[status] || [String(status), ''];
  return badge(text, kind);
}

export function field(label, control, hint) {
  return el('label', { class: 'field' }, el('span', { text: label }), control, hint ? el('small', { text: hint }) : null);
}

export function textInput(name, { value = '', type = 'text', maxlength = 100, required = false, autocomplete = 'off', readonly = false, placeholder } = {}) {
  return el('input', { name, type, value, maxlength, required, autocomplete, readonly, placeholder });
}

export function selectInput(name, options, { value = '', placeholder = null, required = false } = {}) {
  const node = el('select', { name, required });
  if (placeholder !== null) node.append(el('option', { value: '', text: placeholder }));
  for (const o of options) node.append(el('option', { value: o.value, text: o.label }));
  node.value = value;
  return node;
}

// columns: [{ label, render(row) }]. Layout switches between stacked cards (phone) and a table (wide screens).
export function dataTable(columns, rows, emptyText = 'Nothing to show yet.') {
  if (!rows.length) return el('p', { class: 'muted', text: emptyText });
  const head = el('thead', {}, el('tr', {}, columns.map((c) => el('th', { scope: 'col', text: c.label }))));
  const body = el('tbody', {}, rows.map((row) => el('tr', {}, columns.map((c) =>
    el('td', { 'data-label': c.label, class: c.actions ? 'cell-actions' : null }, c.render(row))))));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, head, body));
}

export function pageHead(title, ...actions) {
  return el('div', { class: 'page-head' }, el('h1', { text: title }), actions.length ? el('div', { class: 'btn-row' }, actions) : null);
}

// ---------- Dialogs ----------
export function modal(title, body, { onClose } = {}) {
  const dlg = el('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' },
    el('div', { class: 'modal-head' },
      el('h2', { id: 'modal-title', text: title }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Close', text: 'Close', onclick: () => dlg.close() })),
    el('div', { class: 'modal-body' }, body));
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// Resolves true only when the person explicitly confirms. `phrase` forces them to type it first.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, phrase = null }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const input = phrase ? el('input', { type: 'text', class: 'input', autocomplete: 'off', 'aria-label': 'Type the confirmation text' }) : null;
    const ok = el('button', {
      type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary', text: confirmLabel, disabled: !!phrase,
      onclick: () => { confirmed = true; dlg.close(); },
    });
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== phrase; });
    const dlg = modal(title, el('div', {},
      el('p', { text: message }),
      phrase ? el('p', {}, 'Type ', el('strong', { text: phrase }), ' to continue.') : null,
      input,
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Cancel', onclick: () => dlg.close() }), ok),
    ), { onClose: () => resolve(confirmed) });
  });
}
