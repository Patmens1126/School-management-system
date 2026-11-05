import { db, isConfigured } from './supabase.js';
import { SCHOOL_NAME, IDLE_TIMEOUT_MINUTES } from './config.js';
import { el, alertBox, busy, isOffline } from './ui.js';
import { isEmail, passwordProblem } from './validation.js';

const HOME = { admin: '/admin/dashboard.html', teacher: '/teacher/dashboard.html', parent: '/parent/dashboard.html' };
export const roleHome = (role) => HOME[role] || '/login.html';

const NOT_CONFIGURED = 'This site has not been connected to its database yet. Edit js/config.js (see README).';

const REASONS = {
  idle: 'You were signed out after a period of inactivity. Please sign in again.',
  inactive: 'This account is not active. Please contact the school administrator.',
  'password-updated': 'Your password has been updated. Please sign in.',
};

// ---------- Signing out & inactivity ----------
export async function signOut(reason) {
  try { await db.auth.signOut(); } catch { /* the local session is cleared regardless */ }
  location.replace(reason ? `/login.html?reason=${encodeURIComponent(reason)}` : '/login.html');
}

let idleTimer;
export function startIdleTimer() {
  const limit = IDLE_TIMEOUT_MINUTES * 60 * 1000;
  const reset = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => signOut('idle'), limit);
  };
  for (const evt of ['click', 'keydown', 'touchstart', 'pointerdown']) {
    document.addEventListener(evt, reset, { passive: true });
  }
  reset();
}

// ---------- Page guard for the portal ----------
function fatal(message) {
  const app = document.getElementById('app') || document.body;
  app.replaceChildren(alertBox(message));
}

export async function requireRole(role) {
  if (!isConfigured) { fatal(NOT_CONFIGURED); return null; }

  // getUser() asks the server to verify the session (a stolen/revoked token fails here).
  const { data, error } = await db.auth.getUser();
  if (error || !data || !data.user) {
    if (isOffline(error)) { fatal('Connection lost. Please check your internet connection and reload the page.'); return null; }
    location.replace('/login.html');
    return null;
  }

  const { data: profile, error: profileError } = await db.from('profiles')
    .select('id, role, full_name, is_active').eq('id', data.user.id).maybeSingle();
  if (profileError) {
    fatal(isOffline(profileError) ? 'Connection lost. Please check your internet connection and reload the page.'
      : "We couldn't load your account. Please try again.");
    return null;
  }
  if (!profile || !profile.is_active) { await signOut('inactive'); return null; }
  if (profile.role !== role) { location.replace(roleHome(profile.role)); return null; }

  db.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') location.replace('/login.html'); });
  startIdleTimer();
  return profile;
}

export function renderShell(profile, links) {
  const path = location.pathname;
  const roleLabel = profile.role.charAt(0).toUpperCase() + profile.role.slice(1);
  const welcomeName = profile.full_name.split(/\s+/).filter(Boolean)[0] || 'User';
  const initials = profile.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'U';

  document.body.dataset.role = profile.role;
  document.body.classList.remove('role-admin', 'role-teacher', 'role-parent');
  document.body.classList.add(`role-${profile.role}`);

  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' }, links.map(([label, href]) =>
    el('a', { href, class: path === href ? 'nav-link active' : 'nav-link', 'aria-current': path === href ? 'page' : null, text: label })));
  const top = document.getElementById('topbar');
  top.replaceChildren(
    el('div', { class: 'topbar-inner' },
      el('div', { class: 'topbar-brand-wrap' },
        el('a', { class: 'brand', href: roleHome(profile.role) },
          el('img', { src: '/images/logo.jpeg', alt: 'STARONIC logo', class: 'brand-logo' }),
          el('span', { text: SCHOOL_NAME })),
        el('span', { class: `role-pill role-${profile.role}`, text: roleLabel })),
      el('div', { class: 'topbar-user' },
        el('button', {
          type: 'button',
          class: 'btn btn-secondary btn-sm menu-toggle',
          text: 'Menu',
          'aria-expanded': 'false',
          'aria-controls': 'portal-nav',
          onclick: togglePortalNav,
        }),
        el('div', { class: 'user-profile-chip' },
          el('div', { class: 'user-avatar', text: initials }),
          el('div', { class: 'user-meta' },
            el('span', { class: 'user-greet', text: `Welcome, ${welcomeName}` }),
            el('span', { class: 'user-role', text: roleLabel }))),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Log out', onclick: () => signOut() }))),
    el('button', {
      type: 'button',
      class: 'nav-backdrop',
      tabindex: '-1',
      'aria-label': 'Close navigation',
      onclick: closePortalNav,
    }),
    nav);
  nav.id = 'portal-nav';
  if (window.innerWidth <= 640) {
    nav.setAttribute('inert', '');
    nav.setAttribute('aria-hidden', 'true');
  } else {
    nav.setAttribute('aria-hidden', 'false');
  }
  const menuButton = top.querySelector('.menu-toggle');
  const closeAfterNavigation = () => {
    if (window.innerWidth <= 640) closePortalNav();
  };
  nav.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) closeAfterNavigation();
  });
  top.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePortalNav();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 640) closePortalNav();
  });
  return document.getElementById('app');
}

function togglePortalNav() {
  const top = document.getElementById('topbar');
  if (top?.classList.contains('menu-open')) closePortalNav();
  else openPortalNav();
}

function openPortalNav() {
  const top = document.getElementById('topbar');
  const nav = top?.querySelector('.nav');
  const menuButton = top?.querySelector('.menu-toggle');
  if (!top || !nav || !menuButton || window.innerWidth > 640) return;
  top.classList.add('menu-open');
  nav.removeAttribute('inert');
  nav.setAttribute('aria-hidden', 'false');
  menuButton.setAttribute('aria-expanded', 'true');
  menuButton.textContent = 'Close';
  document.body.classList.add('portal-menu-open');
  nav.querySelector('a[aria-current="page"]')?.focus();
}

function closePortalNav() {
  const top = document.getElementById('topbar');
  const nav = top?.querySelector('.nav');
  const menuButton = top?.querySelector('.menu-toggle');
  if (!top || !nav || !menuButton) return;
  const wasOpen = top.classList.contains('menu-open');
  top.classList.remove('menu-open');
  if (window.innerWidth <= 640) {
    nav.setAttribute('inert', '');
    nav.setAttribute('aria-hidden', 'true');
  } else {
    nav.removeAttribute('inert');
    nav.setAttribute('aria-hidden', 'false');
  }
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.textContent = 'Menu';
  document.body.classList.remove('portal-menu-open');
  if (wasOpen && window.innerWidth <= 640) menuButton.focus();
}

// ---------- Login page ----------
function message(type, text) {
  const box = document.getElementById('msg');
  box.replaceChildren(text ? alertBox(text, type) : '');
}

function initLoginPage() {
  const form = document.getElementById('login-form');
  const forgotForm = document.getElementById('forgot-form');
  const reason = new URLSearchParams(location.search).get('reason');
  if (reason && REASONS[reason]) message(reason === 'password-updated' ? 'success' : 'info', REASONS[reason]);
  if (!isConfigured) { message('error', NOT_CONFIGURED); return; }

  let failures = 0;
  let lockedUntil = 0;

  document.getElementById('forgot-toggle').addEventListener('click', () => {
    forgotForm.hidden = !forgotForm.hidden;
    if (!forgotForm.hidden) forgotForm.elements.email.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const email = form.elements.email.value.trim().toLowerCase();
    const password = form.elements.password.value;
    if (Date.now() < lockedUntil) { message('error', 'Too many attempts. Please wait a minute and try again.'); return; }
    if (!isEmail(email) || !password) { message('error', 'Enter your email and password.'); return; }

    await busy(submit, async () => {
      message('', '');
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      if (error || !data || !data.user) {
        if (isOffline(error)) { message('error', 'Connection lost. Please check your internet connection and try again.'); return; }
        failures += 1;
        if (failures >= 5) { lockedUntil = Date.now() + 60_000; failures = 0; }
        message('error', 'Invalid email or password.');       // same message for every failure: no account enumeration
        form.elements.password.value = '';
        return;
      }
      const { data: profile } = await db.from('profiles').select('role, is_active').eq('id', data.user.id).maybeSingle();
      if (!profile || !profile.is_active) {
        await db.auth.signOut();
        message('error', REASONS.inactive);
        return;
      }
      location.replace(roleHome(profile.role));
    }, 'Signing in...');
  });

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = forgotForm.querySelector('button[type="submit"]');
    const email = forgotForm.elements.email.value.trim().toLowerCase();
    if (!isEmail(email)) { message('error', 'Enter a valid email address.'); return; }
    await busy(submit, async () => {
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset-password.html` });
      if (error && isOffline(error)) { message('error', 'Connection lost. Please try again.'); return; }
      // Same answer whether or not the account exists.
      message('success', 'If that email belongs to an account, a password reset link has been sent.');
    }, 'Sending...');
  });
}

// ---------- Set / reset password page (also used for first-time invitations) ----------
async function initResetPage() {
  const form = document.getElementById('reset-form');
  const checking = document.getElementById('checking');
  if (!isConfigured) { checking.hidden = true; message('error', NOT_CONFIGURED); return; }

  const params = new URLSearchParams(location.search);
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  let ok = false;

  if (tokenHash && (type === 'recovery' || type === 'invite')) {
    const { error } = await db.auth.verifyOtp({ token_hash: tokenHash, type });
    ok = !error;
    history.replaceState(null, '', location.pathname);        // remove the one-time token from the address bar
  } else {
    const { data } = await db.auth.getSession();               // link that arrived with a session in the URL hash
    ok = !!(data && data.session);
  }

  checking.hidden = true;
  if (!ok) {
    message('error', 'This link is invalid or has expired. Ask the administrator for a new invitation, or use "Forgot your password?" on the sign-in page.');
    return;
  }
  form.hidden = false;
  form.elements.password.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const pw = form.elements.password.value;
    const again = form.elements.confirm.value;
    const problem = passwordProblem(pw);
    if (problem) { message('error', problem); return; }
    if (pw !== again) { message('error', 'The two passwords do not match.'); return; }
    await busy(submit, async () => {
      const { error } = await db.auth.updateUser({ password: pw });
      if (error) {
        message('error', isOffline(error) ? 'Connection lost. Your password has not been changed.'
          : 'We could not set that password. Try a longer or less common password.');
        return;
      }
      await signOut('password-updated');
    }, 'Saving...');
  });
}

const page = document.body.dataset.page;
if (page === 'login') initLoginPage();
if (page === 'reset') initResetPage();
