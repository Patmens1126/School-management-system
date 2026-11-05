import { db } from './supabase.js';
import { requireRole, renderShell } from './auth.js';
import {
  el, must, countOf, card, push, badge, statusBadge, field, textInput, selectInput, dataTable, pageHead,
  modal, confirmDialog, toast, alertBox, busy, errorMessage, loadError, todayStr, formatDate,
  formatDateTime, pct, rating, getActiveSemester, semesterLabel,
} from './ui.js';
import { checkText, isAcademicYear, isEmail, passwordProblem, LIMITS } from './validation.js';

const NAV = [
  ['Dashboard', '/admin/dashboard.html'], ['Students', '/admin/students.html'],
  ['Teachers', '/admin/teachers.html'], ['Parents', '/admin/parents.html'],
  ['Classes', '/admin/classes.html'], ['Subjects', '/admin/subjects.html'],
  ['Academic Years', '/admin/academic-years.html'], ['Semester', '/admin/semester.html'],
  ['Corrections', '/admin/corrections.html'], ['Academic Records', '/admin/academic-records.html'],
  ['Lesson Notes', '/admin/lesson-notes.html'], ['News & programmes', '/admin/news.html'],
];

const fullName = (s) => `${s.first_name} ${s.last_name}`;
const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });
async function fetchAll(queryForRange, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await must(queryForRange().range(offset, offset + pageSize - 1));
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

function searchField(onChange) {
  const input = el('input', { type: 'search', maxlength: 100, autocomplete: 'off', placeholder: 'Name, ID or class' });
  input.addEventListener('input', () => onChange(input.value.trim().toLowerCase()));   // filtered in the browser: no query text is sent to the database
  return field('Search', input);
}

function formError() {
  const box = el('div', { 'aria-live': 'assertive' });

  return {
    box,

    show(msg) {
      box.replaceChildren(
        msg ? alertBox(msg) : ''
      );
    }
  };

}

// ======================================================================
// Dashboard
// ======================================================================
function describeAction(action) {
  const [verb, ...rest] = String(action).split(' ');
  const verbs = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Removed' };
  const what = rest.join(' ').replace(/_/g, ' ');
  return verbs[verb] ? `${verbs[verb]} ${what}` : action;
}

async function dashboard(main) {
  const today = todayStr();
  const head = (table, filter) => countOf(filter(db.from(table).select('id', { count: 'exact', head: true })));
  const safeHead = async (table, filter, fallback = 0) => {
    try { return await head(table, filter); } catch { return fallback; }
  };
  const safeList = async (queryBuilder, fallback = []) => {
    try { return await queryBuilder(); } catch { return fallback; }
  };

  const [students, teachers, parents, present, absent, late, sem, audits, issues, pending, pendingNotes, allUsers] = await Promise.all([
    safeHead('students', (q) => q.eq('status', 'active')),
    safeHead('profiles', (q) => q.eq('role', 'teacher').eq('is_active', true)),
    safeHead('profiles', (q) => q.eq('role', 'parent').eq('is_active', true)),
    safeHead('attendance', (q) => q.eq('date', today).eq('status', 'present')),
    safeHead('attendance', (q) => q.eq('date', today).eq('status', 'absent')),
    safeHead('attendance', (q) => q.eq('date', today).eq('status', 'late')),
    safeList(async () => await getActiveSemester(), null),
    safeList(async () => await must(db.from('audit_logs').select('id, action, created_at, user_id').order('created_at', { ascending: false }).limit(8)), []),
    safeList(async () => await must(db.from('attendance').select('id, status, students(first_name, last_name), classes(name)').eq('date', today).in('status', ['absent', 'late']).limit(10)), []),
    safeHead('attendance_corrections', (q) => q.eq('status', 'pending')),
    safeHead('lesson_notes', (q) => q.eq('status', 'pending')),
    safeList(async () => await must(db.from('profiles').select('id, role, full_name, email, is_active').order('role').order('full_name')), []),
  ]);

  const actorIds = [...new Set((audits || []).map((a) => a.user_id).filter(Boolean))];
  const actors = actorIds.length ? await safeList(async () => await must(db.from('profiles').select('id, full_name').in('id', actorIds)), []) : [];
  const actorName = new Map(actors.map((p) => [p.id, p.full_name]));

  const stat = (value, label) => el('div', { class: 'stat' }, el('span', { class: 'stat-value', text: String(value) }), el('span', { class: 'stat-label', text: label }));
  const notices = [];
  if (!sem) notices.push(el('div', { class: 'notice' }, 'No semester is active, so teachers cannot record attendance or performance. ', el('a', { href: '/admin/semester.html', text: 'Activate a semester' })));
  if (pending > 0) notices.push(el('div', { class: 'notice' }, `${pending} attendance correction request${pending === 1 ? '' : 's'} waiting. `, el('a', { href: '/admin/corrections.html', text: 'Review' })));
  if (pendingNotes > 0) notices.push(el('div', { class: 'notice' }, `${pendingNotes} lesson note${pendingNotes === 1 ? '' : 's'} waiting for approval. `, el('a', { href: '/admin/lesson-notes.html', text: 'Review lesson notes' })));
  if (!audits.length && !issues.length && !allUsers.length) notices.push(el('div', { class: 'notice notice-info' }, 'The database is connected, but there is no school data yet. Add classes, students, teachers, or parents to populate the dashboard.'));

 const adminActions = [
  ['Create teacher', () => openCreate('teacher')],
  ['Create parent', () => openCreate('parent')],
  ['Assign teacher', () => location.href = '/admin/teachers.html'],
  ['Link parent to student', () => location.href = '/admin/students.html'],
  ['Semester', () => location.href = '/admin/semester.html'],
  ['Corrections', () => location.href = '/admin/corrections.html'],
  ['Academic Records', () => location.href = '/admin/academic-records.html'],
  ['Lesson Note Approvals', () => location.href = '/admin/lesson-notes.html'],
];

  main.replaceChildren(
    pageHead('Executive dashboard',
      el('button', { type: 'button', class: 'btn btn-secondary', text: 'Open students', onclick: () => location.href = '/admin/students.html' }),
      el('button', { type: 'button', class: 'btn btn-secondary', text: 'Manage semester', onclick: () => location.href = '/admin/semester.html' })),
    ...notices,
    el('div', { class: 'executive-shell' },
      el('div', { class: 'kpi-strip' },
        el('div', { class: 'kpi-card' }, el('strong', { text: String(students) }), el('span', { text: 'Active students' })),
        el('div', { class: 'kpi-card' }, el('strong', { text: String(teachers) }), el('span', { text: 'Teachers' })),
        el('div', { class: 'kpi-card' }, el('strong', { text: String(parents) }), el('span', { text: 'Parents' })),
        el('div', { class: 'kpi-card' }, el('strong', { text: String(present) }), el('span', { text: 'Present today' }))),
      el('div', { class: 'grid grid-2' },
        el('div', { class: 'insight-panel' },
          el('p', { class: 'tag tag-light', text: 'Today' }),
          el('h3', { text: `School snapshot • ${formatDate(today)}` }),
          el('p', { text: `${present} present, ${absent} absent, ${late} late.` }),
          el('div', { class: 'quick-actions' },
            el('a', { class: 'btn btn-light', href: '/admin/students.html', text: 'View students' }),
            el('a', { class: 'btn btn-secondary btn-plain', href: '/admin/corrections.html', text: 'Review corrections' }))),
        el('div', { class: 'card card-tint' },
          el('h2', { text: 'School operations' }),
          sem
            ? el('div', { class: 'grid grid-3' },
                el('div', { class: 'stat' },
                  el('span', { class: 'stat-label', text: 'Academic year' }),
                  el('span', { class: 'stat-value', text: sem.academic_years?.name || 'Not assigned' })),
                el('div', { class: 'stat' },
                  el('span', { class: 'stat-label', text: 'Semester' }),
                  el('span', { class: 'stat-value', text: sem.term ? `Term ${sem.term}` : 'Not set' })),
                el('div', { class: 'stat' },
                  el('span', { class: 'stat-label', text: 'Status' }),
                  el('span', { class: 'stat-value', text: sem.status || 'inactive' })))
            : el('p', { class: 'muted', text: 'No semester is active. Set one up to begin classroom records.' }))),
      el('div', { class: 'grid grid-2' },
        card('Admin actions',
          el('div', { class: 'quick-actions' },
            ...adminActions.map(([label, action]) =>
               el('button', {
    type: 'button',
    class: 'btn btn-secondary',
    text: label,
    onclick: action
  }))),
          el('div', { class: 'muted dashboard-note', text: 'The system routes key operational tasks through role-based security and database checks.' })),
        card('Recent attendance issues today',
          issues.length
            ? el('ul', { class: 'list-plain' }, issues.map((i) => el('li', {}, `${fullName(i.students)} (${i.classes.name}) `, statusBadge(i.status))))
            : el('p', { class: 'muted', text: 'No absences or late arrivals recorded today.' }))),
      card('All school accounts',
        el('div', { class: 'muted dashboard-note' }, 'Role changes are protected by the database. Only the database/admin setup can create or change admin roles for safety.'),
        dataTable([
          { label: 'Role', render: (u) => u.role },
          { label: 'Name', render: (u) => u.full_name },
          { label: 'Email', render: (u) => u.email },
          { label: 'Status', render: (u) => statusBadge(u.is_active ? 'active' : 'inactive') },
          { label: 'Actions', actions: true, render: (u) => el('button', {
            type: 'button', class: 'btn btn-secondary btn-sm', text: u.is_active ? 'Deactivate' : 'Activate', onclick: async () => {
              const next = !u.is_active;
              try {
                await must(db.from('profiles').update({ is_active: next }).eq('id', u.id));
                toast(next ? 'Account activated.' : 'Account deactivated.');
                location.reload();
              } catch (err) { toast(errorMessage(err), 'error'); }
            },
          }) },
        ], allUsers, 'No accounts found.')),
      card('Recent activity',
        audits.length
          ? el('ul', { class: 'list-plain' }, audits.map((a) => el('li', {},
              el('strong', { text: describeAction(a.action) }), ` by ${actorName.get(a.user_id) || 'the system'} `,
              el('span', { class: 'muted', text: formatDateTime(a.created_at) }))))
          : el('p', { class: 'muted', text: 'No activity recorded yet.' }))
    )
  );
}

// ======================================================================
// Students
// ======================================================================
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' },
  { value: 'graduated', label: 'Graduated' }, { value: 'transferred', label: 'Transferred' },
];

const classOrderValue = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

const sortClassesByOrder = (a, b) => {
  const aHasOrder = Object.prototype.hasOwnProperty.call(a || {}, 'class_order');
  const bHasOrder = Object.prototype.hasOwnProperty.call(b || {}, 'class_order');
  if (aHasOrder && bHasOrder) {
    const diff = classOrderValue(a?.class_order) - classOrderValue(b?.class_order);
    if (diff !== 0) return diff;
  }
  return byName(a?.name || '', b?.name || '');
};

const classOptions = (rows) => [...rows].sort(sortClassesByOrder).map((c) => ({ value: c.id, label: c.name }));

async function students(main) {
  const [parents, classes, years, sem] = await Promise.all([
    must(db.from('profiles').select('id, full_name').eq('role', 'parent').order('full_name')),
    must(db.from('classes').select('id, name')),
    must(db.from('academic_years').select('id, name').order('name', { ascending: false })),
    getActiveSemester(),
  ]);
  const orderedClasses = [...classes].sort(sortClassesByOrder);
  let list = [];
  let enrolls = [];
  let yearId = (sem && sem.academic_year_id) || (years[0] && years[0].id) || '';
  let term = '';

  const parentName = new Map(parents.map((p) => [p.id, p.full_name]));
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const holder = el('div');
  const yearSelect = selectInput('year', years.map((y) => ({ value: y.id, label: y.name })), { value: yearId });
  yearSelect.addEventListener('change', () => { yearId = yearSelect.value; renderList(); });

  main.replaceChildren(
    pageHead('Students', el('button', { type: 'button', class: 'btn', text: 'Add student', onclick: () => openEditor(null) })),
    el('div', { class: 'toolbar' }, searchField((v) => { term = v; renderList(); }), field('Class shown for year', yearSelect)),
    holder);

  const enrolIn = (studentId, year) => enrolls.find((e) => e.student_id === studentId && e.academic_year_id === year);

  async function refresh() {
    [list, enrolls] = await Promise.all([
      must(db.from('students').select('id, student_code, first_name, last_name, status, parent_id').order('last_name').order('first_name')),
      must(db.from('enrollments').select('id, student_id, class_id, academic_year_id')),
    ]);
    renderList();
  }

  function renderList() {
    const rows = list.filter((s) => {
      if (!term) return true;
      const e = enrolIn(s.id, yearId);
      const hay = [s.student_code, fullName(s), parentName.get(s.parent_id) || '', e ? className.get(e.class_id) : ''].join(' ').toLowerCase();
      return hay.includes(term);
    });
    holder.replaceChildren(dataTable([
      { label: 'Student ID', render: (s) => s.student_code },
      { label: 'Name', render: (s) => fullName(s) },
      { label: 'Parent', render: (s) => parentName.get(s.parent_id) || '-' },
      { label: 'Class', render: (s) => { const e = enrolIn(s.id, yearId); return e ? className.get(e.class_id) : '-'; } },
      { label: 'Status', render: (s) => statusBadge(s.status) },
      { label: 'Actions', actions: true, render: (s) => [
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Edit', onclick: () => openEditor(s) }),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'History', onclick: () => openHistory(s) }),
      ] },
    ], rows, 'No students found.'));
  }

  function enrolSection(s) {
    const classSelect = selectInput('class', classOptions(orderedClasses), { placeholder: 'Choose a class' });
    const yearSel = selectInput('enrol_year', years.map((y) => ({ value: y.id, label: y.name })), { value: yearId });
    const sync = () => { const e = enrolIn(s.id, yearSel.value); classSelect.value = e ? e.class_id : ''; };
    yearSel.addEventListener('change', sync);
    sync();
    const btn = el('button', {
      type: 'button', class: 'btn btn-secondary', text: 'Save class for this year',
      onclick: async () => {
        if (!yearSel.value || !classSelect.value) { toast('Choose an academic year and a class.', 'error'); return; }
        await busy(btn, async () => {
          try {
            const existing = enrolIn(s.id, yearSel.value);
            if (existing) await must(db.from('enrollments').update({ class_id: classSelect.value }).eq('id', existing.id));
            else await must(db.from('enrollments').insert({ student_id: s.id, class_id: classSelect.value, academic_year_id: yearSel.value }));
            toast('Class saved.');
            await refresh();
          } catch (err) { toast(errorMessage(err), 'error'); }
        });
      },
    });
    return el('div', { class: 'card card-tint' }, el('h3', { text: 'Class enrolment' }),
      field('Academic year', yearSel), field('Class', classSelect), btn);
  }

  function openEditor(s) {
    const isNew = !s;
    const first = textInput('first_name', { value: s ? s.first_name : '', maxlength: LIMITS.personName, required: true });
    const last = textInput('last_name', { value: s ? s.last_name : '', maxlength: LIMITS.personName, required: true });
    const parent = selectInput('parent_id', parents.map((p) => ({ value: p.id, label: p.full_name })), { value: s && s.parent_id ? s.parent_id : '', placeholder: 'No parent linked' });
    const status = isNew ? null : selectInput('status', STATUS_OPTIONS, { value: s.status });
    const err = formError();
    const save = el('button', { type: 'submit', class: 'btn', text: isNew ? 'Add student' : 'Save changes' });
    const form = el('form', { novalidate: true },
      field('First name', first), field('Last name', last), field('Parent', parent),
      status ? field('Status', status) : null, err.box, el('div', { class: 'btn-row' }, save));
    const dlg = modal(isNew ? 'Add student' : 'Edit student', el('div', {}, form, isNew ? null : enrolSection(s)));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = checkText(first.value, 'First name', { max: LIMITS.personName })
        || checkText(last.value, 'Last name', { max: LIMITS.personName });
      if (problem) { err.show(problem); return; }
      if (!isNew && status.value !== 'active' && s.status === 'active') {
        const ok = await confirmDialog({
          title: 'Deactivate Student?', message: 'This will prevent the student from accessing active school services.',
          confirmLabel: 'Confirm', danger: true,
        });
        if (!ok) return;
      }
      await busy(save, async () => {
        try {
          const values = { first_name: first.value.trim(), last_name: last.value.trim(), parent_id: parent.value || null };
          if (isNew) {
            const created = await must(db.from('students').insert(values).select('student_code').single());
            toast(`Student added. Generated ID: ${created.student_code}`);
          } else {
            await must(db.from('students').update({ ...values, status: status.value }).eq('id', s.id));
            toast('Saved.');
          }
          dlg.close();
          await refresh();
        } catch (error) { err.show(errorMessage(error)); }
      });
    });
  }

  async function openHistory(s) {
    try {
      const [enr, sums] = await Promise.all([
        must(db.from('enrollments').select('id, academic_years(name), classes(name)').eq('student_id', s.id)),
        must(db.from('semester_summaries').select('id, attendance_percentage, overall_percentage, performance_rating, promotion_status, teacher_remark, semesters(term, status), academic_years(name), classes(name)').eq('student_id', s.id)),
      ]);
      enr.sort((a, b) => byName(a.academic_years.name, b.academic_years.name));
      sums.sort((a, b) => byName(a.academic_years.name, b.academic_years.name) || a.semesters.term - b.semesters.term);
      modal(`${fullName(s)} (${s.student_code})`, el('div', {},
        el('h3', { text: 'Class history' }),
        enr.length ? el('ul', { class: 'list-plain' }, enr.map((e) => el('li', { text: `${e.academic_years.name}: ${e.classes.name}` })))
          : el('p', { class: 'muted', text: 'Not enrolled in any class yet.' }),
        el('h3', { text: 'Semester summaries' }),
        sums.length ? el('ul', { class: 'list-plain' }, sums.map((r) => el('li', {},
            el('strong', { text: `${r.academic_years.name}, ${r.classes.name}, Semester ${r.semesters.term}` }), ' ',
            statusBadge(r.semesters.status === 'closed' ? 'closed' : 'pending'),
            el('div', { class: 'meter' },
              el('span', {}, 'Overall ', el('strong', { text: pct(r.overall_percentage) })),
              el('span', {}, 'Attendance ', el('strong', { text: pct(r.attendance_percentage) })),
              el('span', {}, 'Rating ', el('strong', { text: rating(r.performance_rating) })),
              el('span', {}, 'Promotion ', el('strong', { text: r.promotion_status }))))))
          : el('p', { class: 'muted', text: 'No summaries yet. They are created when a semester is closed.' })));
    } catch (error) { toast(loadError(error), 'error'); }
  }

  await refresh();
}

// ======================================================================
// Teachers and parents (accounts are created by the server-side function)
// ======================================================================
async function createAccount(role, name, email, password) {
  if (!db?.auth || !db?.functions?.invoke) {
    throw new Error('Account creation is unavailable because the Supabase client is not configured correctly.');
  }

  const normalizedRole = role === 'teacher' || role === 'parent' ? role : null;
  if (!normalizedRole) {
    throw new Error('Invalid account role. Use teacher or parent.');
  }

  const {
    data: { session },
    error: sessionError,
  } = await db.auth.getSession();

  if (sessionError || !session?.access_token) {
    throw new Error('Your administrator session has expired. Please log in again.');
  }

  let data;
  let error;

  try {
    ({ data, error } = await db.functions.invoke('admin-create-account', {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: {
        role: normalizedRole,
        full_name: name,
        email,
        password,
      },
    }));
  } catch (invokeError) {
    const text = String(invokeError?.message || '');
    if (/not found|function.*missing|404|FunctionsFetchError|Failed to fetch/i.test(text)) {
      throw new Error('The account-creation function is not deployed in Supabase yet. Deploy supabase/functions/admin-create-account and try again.');
    }
    throw invokeError;
  }

  if (error) {
    let message = 'Account creation failed. Please try again.';

    try {
      const responseBody = error?.context ? await error.context.json() : null;
      if (responseBody?.error) {
        message = responseBody.error;
      }
    } catch (_) {
      // Keep the fallback message
    }

    if (/not found|function.*missing|404|FunctionsFetchError|Failed to fetch/i.test(String(error?.message || ''))) {
      message = 'The account-creation function is not deployed in Supabase yet. Deploy supabase/functions/admin-create-account and try again.';
    }

    throw new Error(message);
  }

  if (!data || data.ok !== true) {
    throw new Error(data?.error || 'Account creation failed. Please try again.');
  }

  return data;
}

async function accountsPage(main, role) {
  const singular = role === 'teacher' ? 'teacher' : 'parent';
  const heading = role === 'teacher' ? 'Teachers' : 'Parents';
  const holder = el('div');
  let term = '';
  let profiles = [];
  let kids = [];

  main.replaceChildren(
    pageHead(
  heading,
  el('button', {
    type: 'button',
    class: 'btn',
    text: `Add ${singular}`,
    onclick: () => {
  const dialog = openCreate(role);
  if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal();
  }}
  })
),
    el('div', { class: 'toolbar' }, searchField((v) => { term = v; render(); })),
    holder);

  async function load() {
    [profiles, kids] = await Promise.all([
      must(db.from('profiles').select('id, full_name, email, is_active').eq('role', role).order('full_name')),
      role === 'parent' ? must(db.from('students').select('id, first_name, last_name, parent_id')) : Promise.resolve([]),
    ]);
    render();
  }

  function render() {
    const rows = profiles.filter((p) => !term || `${p.full_name} ${p.email}`.toLowerCase().includes(term));
    const cols = [
      { label: 'Name', render: (p) => p.full_name },
      { label: 'Email', render: (p) => p.email },
      { label: 'Status', render: (p) => statusBadge(p.is_active ? 'active' : 'inactive') },
    ];
    if (role === 'parent') {
      cols.push({ label: 'Children', render: (p) => {
        const c = kids.filter((k) => k.parent_id === p.id);
        return c.length ? c.map(fullName).join(', ') : '-';
      } });
    }
    cols.push({ label: 'Actions', actions: true, render: (p) => el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm', text: p.is_active ? 'Deactivate' : 'Activate', onclick: () => toggle(p),
    }) });
    holder.replaceChildren(dataTable(cols, rows, `No ${singular}s found.`));
  }

  async function toggle(p) {
    if (p.is_active) {
      const ok = await confirmDialog({
        title: 'Deactivate account?', message: `${p.full_name} will no longer be able to use the portal. Their records are kept.`,
        confirmLabel: 'Deactivate', danger: true,
      });
      if (!ok) return;
    }
    try {
      await must(db.from('profiles').update({ is_active: !p.is_active }).eq('id', p.id));
      toast(p.is_active ? 'Account deactivated.' : 'Account activated.');
      await load();
    } catch (err) { toast(errorMessage(err), 'error'); }
  }

function openCreate(role) {
  const title =
    role === 'teacher'
      ? 'Create Teacher Account'
      : 'Create Parent Account';

  const name = textInput('full-name', {
    type: 'text',
    autocomplete: 'name',
    required: true,
    placeholder: 'Enter full name'
  });

  const email = textInput('email', {
    type: 'email',
    autocomplete: 'email',
    required: true,
    placeholder: 'Enter email address'
  });

  const password = textInput('password', {
    type: 'password',
    minlength: 12,
    maxlength: 72,
    autocomplete: 'new-password',
    required: true,
    placeholder: 'Enter password'
  });

  const confirmPassword = textInput('confirm-password', {
    type: 'password',
    minlength: 12,
    maxlength: 72,
    autocomplete: 'new-password',
    required: true,
    placeholder: 'Confirm password'
  });

  const form = el('form', {
    class: 'create-account-form',
    novalidate: true
  });

  const description = el('p', {
    class: 'muted',
    text: 'Create the account immediately. Use a unique temporary password and share it securely; the user should change it after signing in.'
  });

 const error = formError();

  const submit = el('button', {
    type: 'submit',
    class: 'btn',
    text: 'Create account'
  });

  form.append(
    description,
    field('Full name', name),
    field('Email address', email),
    field('Password', password),
    field('Confirm password', confirmPassword),
    error.box,
    submit
  );

  const dialog = modal(title, form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    error.show('');

    const fullNameValue = name.value.trim();
    const emailValue = email.value.trim().toLowerCase();
    const passwordValue = password.value;
    const confirmPasswordValue = confirmPassword.value;

    const nameProblem = checkText(fullNameValue, 'Full name', { min: 2, max: 100 });
    if (nameProblem) {
      error.show(nameProblem);
      return;
    }

    if (!isEmail(emailValue)) {
      error.show('Please enter a valid email address.');
      return;
    }

    const passwordIssue = passwordProblem(passwordValue);
    if (passwordIssue) {
      error.show(passwordIssue);
      return;
    }

    if (passwordValue !== confirmPasswordValue) {
      error.show('Passwords do not match.');
      return;
    }

    const originalButtonText = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Creating account...';

    try {
      await createAccount(
        role,
        fullNameValue,
        emailValue,
        passwordValue
      );

      form.reset();
      dialog.close();

      toast(
        `${role === 'teacher' ? 'Teacher' : 'Parent'} account created successfully.`
      );

      await load();
    } catch (err) {
      console.error('Create account error:', err);
      error.show(err?.message || 'Account creation failed. Please try again.');
    } finally {
      submit.disabled = false;
      submit.textContent = originalButtonText;
    }
  });

  return dialog;
}

  await load();
}

async function teachers(main) {
  await accountsPage(main, 'teacher');
  const box = el('div');
  main.append(box);
  await assignments(box);
}

async function parentsPage(main) { await accountsPage(main, 'parent'); }

async function assignments(box) {
  const [years, classes, subjects, teacherList, sem] = await Promise.all([
    must(db.from('academic_years').select('id, name').order('name', { ascending: false })),
    must(db.from('classes').select('id, name')),
    must(db.from('subjects').select('id, name').order('name')),
    must(db.from('profiles').select('id, full_name, is_active').eq('role', 'teacher').order('full_name')),
    getActiveSemester(),
  ]);
  if (!years.length || !classes.length || !subjects.length) {
    box.replaceChildren(card('Teacher assignments', el('p', { class: 'muted', text: 'Create an academic year, at least one class and at least one subject before assigning teachers.' })));
    return;
  }
  let yearId = (sem && sem.academic_year_id) || years[0].id;
  const teacherName = new Map(teacherList.map((t) => [t.id, t.full_name]));
  const holder = el('div');
  const yearSel = selectInput('year', years.map((y) => ({ value: y.id, label: y.name })), { value: yearId });
  yearSel.addEventListener('change', () => { yearId = yearSel.value; load(); });

  const tSel = selectInput('teacher', teacherList.filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.full_name })), { placeholder: 'Choose a teacher' });
  const cSel = selectInput('class', classes.map((c) => ({ value: c.id, label: c.name })), { placeholder: 'Choose a class' });
  const sSel = selectInput('subject', subjects.map((s) => ({ value: s.id, label: s.name })), { placeholder: 'Choose a subject' });
  const add = el('button', { type: 'button', class: 'btn', text: 'Assign' });
  add.addEventListener('click', async () => {
    if (!tSel.value || !cSel.value || !sSel.value) { toast('Choose a teacher, a class and a subject.', 'error'); return; }
    await busy(add, async () => {
      try {
        const { data: existing } = await db.from('teacher_assignments')
          .select('id')
          .eq('teacher_id', tSel.value)
          .eq('class_id', cSel.value)
          .eq('subject_id', sSel.value)
          .eq('academic_year_id', yearId)
          .maybeSingle();
        if (existing) {
          toast('This teacher is already assigned to that class and subject for the selected academic year.', 'error');
          return;
        }
        await must(db.from('teacher_assignments').insert({ teacher_id: tSel.value, class_id: cSel.value, subject_id: sSel.value, academic_year_id: yearId }));
        toast('Teacher assigned.');
        await load();
      } catch (err) {
        if (err && err.code === '23503') {
          toast('The selected teacher, class, subject, or academic year is invalid. Please refresh the page and choose a valid combination.', 'error');
          return;
        }
        toast(errorMessage(err), 'error');
      }
    });
  });

  box.replaceChildren(card('Teacher assignments',
    el('p', { class: 'muted', text: 'Teachers only ever see the classes and subjects assigned to them here.' }),
    field('Academic year', yearSel), holder,
    el('h3', { text: 'Add an assignment' }),
    el('div', { class: 'grid grid-3' }, field('Teacher', tSel), field('Class', cSel), field('Subject', sSel)), add));

  async function load() {
    try {
      const rows = await must(db.from('teacher_assignments').select('id, teacher_id, classes(name), subjects(name)').eq('academic_year_id', yearId));
      rows.sort((a, b) => byName(teacherName.get(a.teacher_id) || '', teacherName.get(b.teacher_id) || '') || byName(a.classes.name, b.classes.name));
      holder.replaceChildren(dataTable([
        { label: 'Teacher', render: (r) => teacherName.get(r.teacher_id) || '-' },
        { label: 'Class', render: (r) => r.classes.name },
        { label: 'Subject', render: (r) => r.subjects.name },
        { label: 'Actions', actions: true, render: (r) => el('button', {
          type: 'button', class: 'btn btn-secondary btn-sm', text: 'Keep history',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Keep this assignment in history?',
              message: 'This assignment is still linked to school records, so it stays in place. You can create a new assignment for the next term or year instead.',
              confirmLabel: 'Keep',
              danger: false,
            });
            if (!ok) return;
            toast('Assignment kept for school history. Create a new assignment instead of deleting this one.');
          },
        }) },
      ], rows, 'No assignments for this year yet.'));
    } catch (err) { holder.replaceChildren(alertBox(loadError(err))); }
  }
  await load();
}

// ======================================================================
// Classes and subjects
// ======================================================================
async function namesPage(main, { table, singular, plural, limit }) {
  const holder = el('div');
  const input = textInput('name', { maxlength: limit, required: true, placeholder: singular === 'class' ? 'JHS 1A' : 'Mathematics' });
  const add = el('button', { type: 'submit', class: 'btn', text: `Add ${singular}` });
  const err = formError();
  const form = el('form', { novalidate: true }, field(`New ${singular} name`, input), err.box, add);
  main.replaceChildren(pageHead(plural), card(null, form), card(`All ${plural.toLowerCase()}`, holder));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = checkText(input.value, 'Name', { max: limit });
    if (problem) { err.show(problem); return; }
    await busy(add, async () => {
      try { await must(db.from(table).insert({ name: input.value.trim() })); input.value = ''; err.show(''); toast('Added.'); await load(); }
      catch (error) { err.show(errorMessage(error)); }
    });
  });

  async function load() {
    const rows = await must(db.from(table).select('id, name'));
    if (table === 'classes') rows.sort(sortClassesByOrder);
    else rows.sort((a, b) => byName(a.name, b.name));
    holder.replaceChildren(dataTable([
      { label: 'Name', render: (r) => r.name },
      { label: 'Actions', actions: true, render: (r) => [
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Rename', onclick: () => rename(r) }),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Keep history', onclick: () => keepHistory(r) }),
      ] },
    ], rows, `No ${plural.toLowerCase()} yet.`));
  }

  function rename(r) {
    const name = textInput('name', { value: r.name, maxlength: limit, required: true });
    const e2 = formError();
    const save = el('button', { type: 'submit', class: 'btn', text: 'Save' });
    const f = el('form', { novalidate: true }, field('Name', name), e2.box, save);
    const dlg = modal(`Rename ${singular}`, f);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const problem = checkText(name.value, 'Name', { max: limit });
      if (problem) { e2.show(problem); return; }
      await busy(save, async () => {
        try { await must(db.from(table).update({ name: name.value.trim() }).eq('id', r.id)); toast('Saved.'); dlg.close(); await load(); }
        catch (error) { e2.show(errorMessage(error)); }
      });
    });
  }

  async function keepHistory(r) {
    const ok = await confirmDialog({
      title: `Keep ${singular} in history?`,
      message: `"${r.name}" is still connected to school records. It is kept for history so the system remains accurate. Create a fresh ${singular} instead if you need a new one.`,
      confirmLabel: 'Keep',
      danger: false,
    });
    if (!ok) return;
    toast('The item was kept in history. New records can be created without touching linked data.');
  }

  await load();
}

async function classes(main) {
  await namesPage(main, { table: 'classes', singular: 'class', plural: 'Classes', limit: LIMITS.className });
  const box = el('div');
  main.append(box);
  await promoteSection(box);
}

const subjects = (main) => namesPage(main, { table: 'subjects', singular: 'subject', plural: 'Subjects', limit: LIMITS.subjectName });

async function promoteSection(box) {
  const [years, cls] = await Promise.all([
    must(db.from('academic_years').select('id, name').order('name', { ascending: false })),
    must(db.from('classes').select('id, name')),
  ]);
  const orderedClasses = [...cls].sort(sortClassesByOrder);
  if (years.length < 2 || !orderedClasses.length) {
    box.replaceChildren(card('Student Progression', el('p', { class: 'muted', text: 'Create at least two academic years and one class to use promotion.' })));
    return;
  }
  const yOpts = years.map((y) => ({ value: y.id, label: y.name }));
  const cOpts = classOptions(orderedClasses);
  const yearMap = new Map(years.map((y) => [y.id, y.name]));
  const classMap = new Map(orderedClasses.map((c) => [c.id, c]));
  const fromYear = selectInput('from_year', yOpts, { value: years[Math.min(1, years.length - 1)].id });
  const sourceClass = selectInput('source_class', cOpts, { placeholder: 'Choose a class' });
  const targetYear = selectInput('target_year', yOpts, { value: years[0].id });
  const decision = selectInput('promotion_action', [
    { value: 'promoted', label: 'Promote to next class' },
    { value: 'repeated', label: 'Repeat current class' },
    { value: 'graduated', label: 'Graduate' },
  ], { value: 'promoted' });
  const studentTable = el('div');
  const selectedStudents = new Set();

  function currentClassTarget() {
    const current = classMap.get(sourceClass.value);
    if (!current) return { nextClass: null, decision: 'promoted', text: 'Choose a source class.' };
    const index = orderedClasses.findIndex((c) => c.id === sourceClass.value);
    const nextClass = index >= 0 ? orderedClasses[index + 1] : null;
    if (current.name === 'JHS 3') return { nextClass: null, decision: 'graduated', text: 'Graduate' };
    if (!nextClass) return { nextClass: null, decision: 'promoted', text: 'No next class is configured.' };
    return { nextClass, decision: 'promoted', text: `Promotion: ${current.name} → ${nextClass.name}` };
  }

  function updateActionOptions() {
    const current = classMap.get(sourceClass.value);
    const opts = current && current.name === 'JHS 3'
      ? [{ value: 'graduated', label: 'Graduate' }]
      : [
          { value: 'promoted', label: 'Promote to next class' },
          { value: 'repeated', label: 'Repeat current class' },
        ];
    const currentValue = decision.value;
    decision.replaceChildren(...opts.map((opt) => el('option', { value: opt.value, text: opt.label })));
    decision.value = opts.some((opt) => opt.value === currentValue) ? currentValue : opts[0].value;
  }

  async function refreshStudents() {
    selectedStudents.clear();
    const currentYearId = fromYear.value;
    const currentClassId = sourceClass.value;
    if (!currentYearId || !currentClassId) {
      studentTable.replaceChildren(el('p', { class: 'muted', text: 'Select a source academic year and class to view students.' }));
      return;
    }

    const [rows, duplicateMap] = await Promise.all([
      must(db.from('enrollments')
        .select('id, student_id, class_id, academic_year_id, students(id, student_code, first_name, last_name, status), classes(name)')
        .eq('academic_year_id', currentYearId)
        .eq('class_id', currentClassId)),
      must(db.from('enrollments').select('student_id, academic_year_id').eq('academic_year_id', targetYear.value)),
    ]);

    const ids = rows.map((row) => row.student_id).filter(Boolean);
    const duplicateSet = new Set(duplicateMap.filter((row) => ids.includes(row.student_id)).map((row) => row.student_id));
    const students = rows.filter((row) => row.students && row.students.status === 'active').map((row) => ({
      ...row.students,
      class_name: row.classes?.name || row.students?.class_name || '',
      alreadyEnrolled: duplicateSet.has(row.student_id),
    }));

    const targetInfo = currentClassTarget();
    const studentRows = students.map((student) => {
      const isDisabled = student.alreadyEnrolled;
      const statusText = student.alreadyEnrolled ? `Already enrolled in ${yearMap.get(targetYear.value) || 'target year'}` : targetInfo.text;
      const rowCheck = el('input', {
        type: 'checkbox',
        checked: selectedStudents.has(student.id),
        disabled: isDisabled,
        onchange: () => {
          if (rowCheck.checked) selectedStudents.add(student.id);
          else selectedStudents.delete(student.id);
        },
      });
      return {
        id: student.id,
        rowCheck,
        name: `${student.first_name} ${student.last_name}`,
        student_code: student.student_code,
        class_name: student.class_name,
        academic_year: yearMap.get(fromYear.value) || 'Selected year',
        status: statusText,
      };
    });

    studentTable.replaceChildren(dataTable([
      { label: 'Checkbox', render: (row) => row.rowCheck },
      { label: 'Student name', render: (row) => row.name },
      { label: 'Student ID', render: (row) => row.student_code },
      { label: 'Class', render: (row) => row.class_name },
      { label: 'Academic year', render: (row) => row.academic_year },
      { label: 'Status', render: (row) => row.status },
    ], studentRows, 'No students found for the selected source year and class.'));
  }

  const rowAction = el('button', { type: 'button', class: 'btn', text: 'Promote Students' });
  rowAction.addEventListener('click', async () => {
    const selected = [...selectedStudents];
    if (!selected.length) { toast('Select at least one student to promote.', 'error'); return; }
    if (fromYear.value === targetYear.value) { toast('Choose two different academic years.', 'error'); return; }
    const targetLabel = yearMap.get(targetYear.value) || 'selected year';
    const nextClass = currentClassTarget().nextClass;
    const currentClassName = classMap.get(sourceClass.value)?.name || 'current class';
    const actionLabel = decision.value === 'graduated' ? 'Graduate' : decision.value === 'repeated' ? 'Repeat' : 'Promote';
    const prompt = decision.value === 'graduated'
      ? `Graduate ${selected.length} student${selected.length === 1 ? '' : 's'} from ${currentClassName} for ${targetLabel}?`
      : decision.value === 'repeated'
        ? `Repeat ${selected.length} student${selected.length === 1 ? '' : 's'} in ${currentClassName} for ${targetLabel}?`
        : `Promote ${selected.length} student${selected.length === 1 ? '' : 's'} from ${currentClassName} to ${nextClass ? nextClass.name : 'the next class'} for ${targetLabel}?`;
    const ok = await confirmDialog({
      title: 'Confirm progression',
      message: prompt,
      confirmLabel: actionLabel,
    });
    if (!ok) return;

    await busy(rowAction, async () => {
      try {
        for (const studentId of selected) {
          const targetClassId = decision.value === 'repeated'
            ? sourceClass.value
            : decision.value === 'graduated'
              ? null
              : (currentClassTarget().nextClass ? currentClassTarget().nextClass.id : null);
          const payload = {
            p_student_id: studentId,
            p_from_year: fromYear.value,
            p_to_year: targetYear.value,
            p_decision: decision.value,
            p_target_class: targetClassId,
          };
          const { error } = await db.rpc('promote_student', payload);
          if (error) throw error;
        }
        selectedStudents.clear();
        toast(`${selected.length} student${selected.length === 1 ? '' : 's'} updated.`);
        await refreshStudents();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    }, 'Updating...');
  });

  const wholeClassYear = selectInput('class_from_year', yOpts, { value: years[1]?.id || years[0].id });
  const wholeClass = selectInput('class_from_class', cOpts, { placeholder: 'Choose a class' });
  const wholeClassTargetYear = selectInput('class_to_year', yOpts, { value: years[0].id });
  const wholeClassTarget = selectInput('class_to_class', cOpts, { placeholder: 'Choose a class' });
  const wholeClassButton = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Promote Entire Class' });
  wholeClassButton.addEventListener('click', async () => {
    if (!wholeClass.value || !wholeClassTarget.value) { toast('Choose both classes for the whole-class promotion.', 'error'); return; }
    if (wholeClassYear.value === wholeClassTargetYear.value) { toast('Choose two different academic years.', 'error'); return; }
    const labelFrom = classMap.get(wholeClass.value)?.name || 'selected class';
    const labelTo = classMap.get(wholeClassTarget.value)?.name || 'selected class';
    const ok = await confirmDialog({
      title: 'Promote entire class?',
      message: `Every active student in ${labelFrom} (${yearMap.get(wholeClassYear.value) || 'selected year'}) will be enrolled in ${labelTo} for ${yearMap.get(wholeClassTargetYear.value) || 'selected year'}. Their earlier enrolment stays in their history.`,
      confirmLabel: 'Promote class',
    });
    if (!ok) return;
    await busy(wholeClassButton, async () => {
      try {
        const count = await must(db.rpc('promote_class', {
          p_from_year: wholeClassYear.value,
          p_from_class: wholeClass.value,
          p_to_year: wholeClassTargetYear.value,
          p_to_class: wholeClassTarget.value,
        }));
        toast(`${count} student${count === 1 ? '' : 's'} promoted.`);
      } catch (err) { toast(errorMessage(err), 'error'); }
    }, 'Promoting class...');
  });

  fromYear.addEventListener('change', async () => {
    updateActionOptions();
    await refreshStudents();
  });
  sourceClass.addEventListener('change', async () => {
    updateActionOptions();
    await refreshStudents();
  });
  targetYear.addEventListener('change', () => refreshStudents());
  decision.addEventListener('change', () => refreshStudents());

  updateActionOptions();
  refreshStudents();

  box.replaceChildren(card('Student Progression',
    el('p', { class: 'muted', text: 'Use the existing class progression rules and keep every enrolment in history.' }),
    el('div', { class: 'grid grid-3' }, field('Source Academic Year', fromYear), field('Source Class', sourceClass), field('Target Academic Year', targetYear)),
    el('div', { class: 'btn-row' }, field('Progression action', decision), rowAction),
    studentTable,
    el('div', { class: 'card card-tint' },
      el('h3', { text: 'Promote Entire Class' }),
      el('div', { class: 'grid grid-2' }, field('From year', wholeClassYear), field('From class', wholeClass), field('To year', wholeClassTargetYear), field('To class', wholeClassTarget)),
      wholeClassButton)));
}

// ======================================================================
// Academic years
// ======================================================================
async function academicYears(main) {
  const holder = el('div');
  const yearInput = textInput('name', { maxlength: 9, required: true, placeholder: '2026/2027' });
  const addYear = el('button', { type: 'submit', class: 'btn', text: 'Add academic year' });
  const yErr = formError();
  const yearForm = el('form', { novalidate: true }, field('Academic year', yearInput, 'Two consecutive years, for example 2026/2027.'), yErr.box, addYear);
  const semHolder = el('div');
  main.replaceChildren(pageHead('Academic years'), card(null, yearForm), card('Add a semester', semHolder), card('Academic years and semesters', holder));

  yearForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = yearInput.value.trim();
    if (!isAcademicYear(name)) { yErr.show('Use the format 2026/2027 (two consecutive years).'); return; }
    await busy(addYear, async () => {
      try { await must(db.from('academic_years').insert({ name })); yearInput.value = ''; yErr.show(''); toast('Academic year added.'); await load(); }
      catch (error) { yErr.show(errorMessage(error)); }
    });
  });

  async function load() {
    const [years, sems] = await Promise.all([
      must(db.from('academic_years').select('id, name').order('name', { ascending: false })),
      must(db.from('semesters').select('id, academic_year_id, term, status')),
    ]);
    const cell = (y, t) => { const s = sems.find((x) => x.academic_year_id === y.id && x.term === t); return s ? statusBadge(s.status) : el('span', { class: 'muted', text: 'Not created' }); };
    holder.replaceChildren(dataTable([
      { label: 'Academic year', render: (y) => y.name },
      { label: 'Semester 1', render: (y) => cell(y, 1) },
      { label: 'Semester 2', render: (y) => cell(y, 2) },
    ], years, 'No academic years yet.'));

    const ySel = selectInput('year', years.map((y) => ({ value: y.id, label: y.name })), { placeholder: 'Choose a year' });
    const tSel = selectInput('term', [{ value: '1', label: 'Semester 1' }, { value: '2', label: 'Semester 2' }], { value: '1' });
    const add = el('button', { type: 'button', class: 'btn', text: 'Add semester' });
    add.addEventListener('click', async () => {
      if (!ySel.value) { toast('Choose an academic year.', 'error'); return; }
      await busy(add, async () => {
        try { await must(db.from('semesters').insert({ academic_year_id: ySel.value, term: Number(tSel.value) })); toast('Semester added. Activate it on the Semester page.'); await load(); }
        catch (error) { toast(errorMessage(error), 'error'); }
      });
    });
    semHolder.replaceChildren(el('div', { class: 'grid grid-2' }, field('Academic year', ySel), field('Semester', tSel)), add);
  }
  await load();
}

// ======================================================================
// Semester: activate, retention policy, closure
// ======================================================================
const PROMOTION_OPTIONS = [
  { value: 'pending', label: 'Pending' }, { value: 'promoted', label: 'Promoted' },
  { value: 'repeated', label: 'Repeated' }, { value: 'graduated', label: 'Graduated' },
];

async function semester(main) {
  const holder = el('div');
  main.replaceChildren(pageHead('Semester'), holder);
  let report = null;                     // result of "Prepare closure" for this visit

  async function load() {
    const [sems, settings] = await Promise.all([
      must(db.from('semesters').select('id, term, status, closed_at, academic_years(name)')),
      must(db.from('school_settings').select('detail_retention_days').maybeSingle()),
    ]);
    sems.sort((a, b) => byName(b.academic_years.name, a.academic_years.name) || b.term - a.term);
    const days = settings ? settings.detail_retention_days : null;
    const active = sems.find((s) => s.status === 'active');
    holder.replaceChildren(
      active ? await activeCard(active, days) : alertBox('No semester is active. Activate a planned semester below to let teachers record attendance and performance.', 'info'),
      plannedCard(sems.filter((s) => s.status === 'planned'), !!active),
      retentionCard(days),
      closedCard(sems.filter((s) => s.status === 'closed'), days),
    );
  }

  function plannedCard(planned, hasActive) {
    return card('Planned semesters', planned.length
      ? dataTable([
        { label: 'Semester', render: (s) => semesterLabel(s) },
        { label: 'Actions', actions: true, render: (s) => el('button', {
          type: 'button', class: 'btn btn-secondary btn-sm', text: 'Activate', disabled: hasActive,
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Activate semester?', message: `${semesterLabel(s)} becomes the semester teachers record into.`, confirmLabel: 'Activate' });
            if (!ok) return;
            try { await must(db.rpc('activate_semester', { p_semester: s.id })); toast('Semester activated.'); report = null; await load(); }
            catch (err) { toast(errorMessage(err), 'error'); }
          },
        }) },
      ], planned)
      : el('p', { class: 'muted', text: 'No planned semesters. Add one on the Academic Years page.' }),
    hasActive ? el('p', { class: 'muted', text: 'Close the active semester before activating another.' }) : null);
  }

  function retentionCard(days) {
    const input = el('input', { type: 'number', min: '0', max: '3650', step: '1', inputmode: 'numeric', value: days === null || days === undefined ? '' : String(days) });
    const save = el('button', { type: 'button', class: 'btn', text: 'Save retention period' });
    save.addEventListener('click', async () => {
      const raw = input.value.trim();
      const value = raw === '' ? null : Number(raw);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 3650)) { toast('Enter a whole number of days from 0 to 3650, or leave it empty.', 'error'); return; }
      await busy(save, async () => {
        try { await must(db.from('school_settings').update({ detail_retention_days: value, updated_at: new Date().toISOString() }).eq('id', true)); toast('Saved.'); await load(); }
        catch (err) { toast(errorMessage(err), 'error'); }
      });
    });
    return card('Data retention policy',
      el('p', { text: 'How many days the school keeps individual daily attendance and performance records after they are entered. Enter this only once the school has approved its retention policy.' }),
      el('p', { class: 'alert', text: days === null || days === undefined ? 'No retention period is set, so no detailed records are ever deleted.' : `Detailed records older than ${days} day${days === 1 ? '' : 's'} may be cleaned up after a semester is closed.` }),
      field('Retention period (days)', input, 'Leave empty to keep everything.'), save);
  }

  function closedCard(closed, days) {
    return card('Closed semesters', closed.length
      ? dataTable([
        { label: 'Semester', render: (s) => semesterLabel(s) },
        { label: 'Closed on', render: (s) => (s.closed_at ? formatDateTime(s.closed_at) : '-') },
        { label: 'Actions', actions: true, render: (s) => days === null || days === undefined ? el('span', { class: 'muted', text: 'No retention period set' })
          : el('button', {
            type: 'button', class: 'btn btn-secondary btn-sm', text: 'Clean up eligible details',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Remove eligible detailed records?', message: `Daily records for ${semesterLabel(s)} that are older than the retention period will be permanently removed. Semester summaries are kept.`, confirmLabel: 'Remove records', danger: true });
              if (!ok) return;
              try {
                const r = await must(db.rpc('purge_semester_details', { p_semester: s.id }));
                toast(`Removed ${r.attendance_deleted} attendance and ${r.performance_deleted} performance records.`);
              } catch (err) { toast(errorMessage(err), 'error'); }
            },
          }) },
      ], closed)
      : el('p', { class: 'muted', text: 'No semesters have been closed yet.' }));
  }

  async function activeCard(sem, days) {
    const label = semesterLabel(sem);
    const body = el('div');
    const wrap = card(`Active semester: ${label}`, body);

    const prepare = el('button', { type: 'button', class: 'btn', text: report ? 'Recalculate summaries' : 'Prepare closure' });
    prepare.addEventListener('click', () => busy(prepare, async () => {
      try {
        report = await must(db.rpc('prepare_semester_closure', { p_semester: sem.id }));
        await renderReview();
      } catch (err) { toast(errorMessage(err), 'error'); }
    }, 'Calculating...'));

    body.append(
      el('p', { text: 'Closing a semester calculates each student\'s final figures and stores them permanently. It never deletes anything unless a retention period has been approved above.' }),
      prepare);
    const review = el('div');
    body.append(review);

    async function renderReview() {
      review.replaceChildren();
      prepare.textContent = 'Recalculate summaries';
      const rows = await must(db.from('semester_summaries')
        .select('id, attendance_percentage, overall_percentage, performance_rating, teacher_remark, promotion_status, students(student_code, first_name, last_name), classes(name)')
        .eq('semester_id', sem.id));
      rows.sort((a, b) => byName(a.classes.name, b.classes.name) || byName(a.students.last_name, b.students.last_name));

      const affected = el('ul', { class: 'list-plain' },
        el('li', { text: `Students with a summary: ${report.summaries}` }),
        el('li', { text: `Daily attendance records in this semester: ${report.attendance_records}` }),
        el('li', { text: `Daily performance records in this semester: ${report.performance_records}` }),
        el('li', { text: report.retention_days === null
          ? 'Retention period: not set, so no detailed records will be removed.'
          : `Retention period: ${report.retention_days} days. Eligible for removal now: ${report.attendance_eligible_for_cleanup} attendance and ${report.performance_eligible_for_cleanup} performance records.` }));

      const table = dataTable([
        { label: 'Student', render: (r) => `${fullName(r.students)} (${r.students.student_code})` },
        { label: 'Class', render: (r) => r.classes.name },
        { label: 'Attendance', render: (r) => pct(r.attendance_percentage) },
        { label: 'Overall', render: (r) => pct(r.overall_percentage) },
        { label: 'Rating', render: (r) => rating(r.performance_rating) },
        { label: 'Final remark', render: (r) => { r.remarkInput = el('input', { type: 'text', maxlength: LIMITS.comment, value: r.teacher_remark || '', 'aria-label': `Final remark for ${fullName(r.students)}` }); return r.remarkInput; } },
        { label: 'Promotion', render: (r) => { r.promoInput = selectInput('promotion', PROMOTION_OPTIONS, { value: r.promotion_status }); r.promoInput.setAttribute('aria-label', `Promotion status for ${fullName(r.students)}`); return r.promoInput; } },
        { label: 'Actions', actions: true, render: (r) => {
          const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Save' });
          b.addEventListener('click', () => busy(b, async () => {
            try {
              await must(db.from('semester_summaries').update({ teacher_remark: r.remarkInput.value.trim() || null, promotion_status: r.promoInput.value }).eq('id', r.id));
              toast('Saved.');
            } catch (err) { toast(errorMessage(err), 'error'); }
          }));
          return b;
        } },
      ], rows, 'No students are enrolled for this academic year yet.');

      const backup = el('input', { type: 'checkbox', id: 'backup-ok' });
      const close = el('button', { type: 'button', class: 'btn btn-danger', text: 'Close semester', disabled: true });
      const blocked = report.pending_corrections > 0;
      backup.addEventListener('change', () => { close.disabled = blocked || !backup.checked; });
      close.addEventListener('click', async () => {
        const phrase = `CLOSE ${sem.academic_years.name} S${sem.term}`;
        const ok = await confirmDialog({
          title: 'Close Semester?',
          message: 'This action will finalize the semester summaries and begin the approved data-retention process. A closed semester cannot be reopened.',
          confirmLabel: 'Close semester', danger: true, phrase,
        });
        if (!ok) return;
        await busy(close, async () => {
          try {
            const r = await must(db.rpc('close_semester', { p_semester: sem.id, p_confirmation: phrase }));
            toast(`Semester closed. ${r.summaries} summaries stored; ${r.attendance_deleted} attendance and ${r.performance_deleted} performance records removed.`);
            report = null;
            await load();
          } catch (err) { toast(errorMessage(err), 'error'); }
        }, 'Closing...');
      });

      push(review,
        el('h3', { text: 'Review before closing' }), affected,
        blocked ? alertBox(`${report.pending_corrections} attendance correction request(s) must be decided first (Corrections page), then recalculate.`) : null,
        el('h3', { text: 'Summaries' }),
        el('p', { class: 'muted', text: 'Percentages are calculated from the daily ratings (rating out of 5). Enter each student\'s final remark and promotion status, then save each row.' }),
        table,
        el('label', { class: 'field-check', for: 'backup-ok' }, backup, el('span', { text: 'I confirm a database backup or recovery point exists (Supabase dashboard, Database, Backups).' })),
        close);
    }
    if (report) await renderReview();
    return wrap;
  }

  await load();
}

// ======================================================================
// Academic records export
// ======================================================================
async function academicRecords(main) {
  main.replaceChildren(pageHead('Academic Records'), el('p', { class: 'muted', text: 'Export semester summaries using the figures already calculated by the school system.' }));
  const holder = el('div');
  main.append(holder);
  holder.replaceChildren(el('p', { class: 'muted', text: 'Loading academic records...' }));

  const [summaries, subjectRows, classes, students, semesters, years] = await Promise.all([
    fetchAll(() => db.from('semester_summaries').select('id, student_id, academic_year_id, semester_id, attendance_percentage, overall_percentage, performance_rating, teacher_remark, students(student_code, first_name, last_name), classes(id, name), semesters(term), academic_years(name)').order('id')),
    fetchAll(() => db.from('subject_summaries').select('id, student_id, semester_id, percentage, rating, subjects(name)').order('id')),
    must(db.from('classes').select('id, name').order('name')),
    fetchAll(() => db.from('students').select('id, student_code, first_name, last_name').order('last_name').order('first_name').order('id')),
    must(db.from('semesters').select('id, term, academic_year_id, academic_years(name)').order('academic_year_id').order('term')),
    must(db.from('academic_years').select('id, name').order('name')),
  ]);
  const makeOptions = (items, label) => [{ value: '', label: `All ${label}` }, ...items.map((item) => ({ value: item.id, label: item.name }))];
  const classFilter = selectInput('class', makeOptions(classes, 'classes'));
  const studentFilter = selectInput('student', [{ value: '', label: 'All students' }, ...students.map((s) => ({ value: s.id, label: `${fullName(s)} (${s.student_code})` }))]);
  const yearFilter = selectInput('year', makeOptions(years, 'academic years'));
  const semesterFilter = selectInput('semester', [{ value: '', label: 'All semesters' }, ...semesters.map((s) => ({ value: s.id, label: `${s.academic_years?.name || ''} - Semester ${s.term}` }))]);
  const status = el('div', { 'aria-live': 'polite' });
  const download = el('button', { type: 'button', class: 'btn', text: 'Download Excel workbook' });
  const subjectMap = new Map();
  for (const row of subjectRows) {
    const key = `${row.student_id}:${row.semester_id}`;
    const list = subjectMap.get(key) || [];
    list.push(row);
    subjectMap.set(key, list);
  }
  const filters = () => summaries.filter((row) =>
    (!classFilter.value || row.classes?.id === classFilter.value)
    && (!studentFilter.value || row.student_id === studentFilter.value)
    && (!yearFilter.value || row.academic_year_id === yearFilter.value)
    && (!semesterFilter.value || row.semester_id === semesterFilter.value));

  function render() {
    const rows = filters();
    download.disabled = rows.length === 0;
    status.replaceChildren(el('p', { class: 'muted', text: `${rows.length} academic record${rows.length === 1 ? '' : 's'} match these filters.` }));
  }
  for (const input of [classFilter, studentFilter, yearFilter, semesterFilter]) input.addEventListener('change', render);
  download.addEventListener('click', () => busy(download, async () => {
    try {
      const rows = filters();
      if (!rows.length) { status.replaceChildren(alertBox('No academic records match these filters.', 'info')); return; }
      if (!window.ExcelJS) throw new Error('The local Excel workbook library did not load.');
      const workbook = new window.ExcelJS.Workbook();
      workbook.creator = 'Staronic Educational Complex';
      workbook.subject = 'Academic records';
      workbook.title = 'Academic Records';
      const sheet = workbook.addWorksheet('Academic Records', { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.columns = [
        { header: 'Academic year', key: 'year', width: 18 },
        { header: 'Semester', key: 'semester', width: 12 },
        { header: 'Student name', key: 'student', width: 28 },
        { header: 'Student ID', key: 'studentId', width: 14 },
        { header: 'Class', key: 'className', width: 18 },
        { header: 'Attendance', key: 'attendance', width: 14 },
        { header: 'Subject performance', key: 'subjects', width: 48 },
        { header: 'Performance rating', key: 'rating', width: 18 },
        { header: 'Overall performance', key: 'overall', width: 19 },
        { header: 'Teacher remarks', key: 'remark', width: 42 },
      ];
      const ordered = [...rows].sort((a, b) => byName(a.classes?.name || '', b.classes?.name || '') || byName(fullName(a.students), fullName(b.students)));
      for (const row of ordered) {
        const subjectsForStudent = (subjectMap.get(`${row.student_id}:${row.semester_id}`) || []).sort((a, b) => byName(a.subjects?.name || '', b.subjects?.name || ''));
        sheet.addRow({
          year: row.academic_years?.name || '',
          semester: row.semesters?.term ? `Semester ${row.semesters.term}` : '',
          student: fullName(row.students),
          studentId: row.students?.student_code || '',
          className: row.classes?.name || '',
          attendance: row.attendance_percentage === null ? null : Number(row.attendance_percentage) / 100,
          subjects: subjectsForStudent.map((s) => `${s.subjects?.name || 'Subject'}: ${s.percentage === null ? '-' : `${Number(s.percentage).toFixed(1)}%`} (${s.rating === null ? '-' : `${Number(s.rating).toFixed(2)}/5`})`).join('\n'),
          rating: row.performance_rating === null ? null : Number(row.performance_rating),
          overall: row.overall_percentage === null ? null : Number(row.overall_percentage) / 100,
          remark: row.teacher_remark || '',
        });
      }
      sheet.autoFilter = { from: 'A1', to: `J${ordered.length + 1}` };
      sheet.getRow(1).height = 30;
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173A67' } };
      sheet.getColumn('attendance').numFmt = '0.0%';
      sheet.getColumn('overall').numFmt = '0.0%';
      sheet.getColumn('rating').numFmt = '0.00"/5"';
      sheet.eachRow((row, rowNumber) => {
        row.alignment = { vertical: 'top', wrapText: true };
        if (rowNumber > 1 && rowNumber % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
      });
      sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
      sheet.pageSetup.printTitlesRow = '1:1';
      sheet.headerFooter.oddHeader = '&C&"Arial,Bold"Staronic Educational Complex - Academic Records';
      sheet.headerFooter.oddFooter = '&L&F&CPage &P of &N&RPrinted &D';
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = el('a', { href: url, download: `staronic-academic-records-${new Date().toISOString().slice(0, 10)}.xlsx` });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Exported ${rows.length} academic record${rows.length === 1 ? '' : 's'}.`);
    } catch (err) { status.replaceChildren(alertBox(errorMessage(err, 'The workbook could not be generated. Please try again.'))); }
  }, 'Preparing workbook...'));

  holder.replaceChildren(card('Filter records',
    el('div', { class: 'grid grid-2' },
      field('Class', classFilter), field('Student', studentFilter),
      field('Semester', semesterFilter), field('Academic year', yearFilter)),
    status, download));
  render();
}

// ======================================================================
// Lesson note approvals
// ======================================================================
async function lessonNotes(main) {
  const holder = el('div');
  main.replaceChildren(pageHead('Lesson Note Approvals'), holder);

  async function load() {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Loading lesson notes...' }));
    const [notes, notifications] = await Promise.all([
      fetchAll(() => db.from('lesson_notes').select('id, submitted_by, class_id, subject_id, semester_id, lesson_date, topic, file_path, file_mime_type, status, rejection_reason, created_at, classes(name), subjects(name), semesters(term, academic_years(name))').order('created_at', { ascending: false }).order('id')),
      must(db.from('lesson_note_notifications').select('id, lesson_note_id, title, message, created_at, read_at').eq('recipient_id', (await db.auth.getUser()).data.user.id).eq('event_type', 'pending').order('created_at', { ascending: false }).limit(30)),
    ]);
    const teacherIds = [...new Set(notes.map((note) => note.submitted_by))];
    const profiles = teacherIds.length ? await must(db.from('profiles').select('id, full_name').in('id', teacherIds)) : [];
    const teacherNames = new Map(profiles.map((profile) => [profile.id, profile.full_name]));
    const pending = notes.filter((note) => note.status === 'pending');
    const history = notes.filter((note) => note.status !== 'pending').slice(0, 30);

    async function documentLink(note, download = false) {
      const { data, error } = await db.storage.from('lesson-notes').createSignedUrl(note.file_path, 300, download ? { download: true } : undefined);
      if (error) throw error;
      return data.signedUrl;
    }
    async function preview(note) {
      try {
        const url = await documentLink(note);
        const content = note.file_mime_type === 'application/pdf'
          ? el('iframe', { class: 'lesson-note-preview-frame', src: url, title: `Lesson note: ${note.topic}` })
          : el('img', { class: 'lesson-note-preview-image', src: url, alt: `Lesson note: ${note.topic}` });
        const download = el('a', { class: 'btn btn-secondary', href: await documentLink(note, true), target: '_blank', rel: 'noopener noreferrer', text: 'Download document' });
        modal(`Preview: ${note.topic}`, el('div', {}, content, el('p', {}, download)));
      } catch (err) { toast(errorMessage(err, 'The private document could not be opened.'), 'error'); }
    }
    async function decide(note, decision, reason = null) {
      try {
        await must(db.rpc('decide_lesson_note', { p_id: note.id, p_decision: decision, p_reason: reason }));
        await must(db.from('lesson_note_notifications').update({ read_at: new Date().toISOString() }).eq('lesson_note_id', note.id).eq('event_type', 'pending'));
        toast(decision === 'approved' ? 'Lesson note approved.' : 'Lesson note rejected.');
        await load();
        return true;
      } catch (err) { toast(errorMessage(err), 'error'); return false; }
    }
    function reject(note) {
      const reason = el('textarea', { rows: 4, maxlength: 500, required: true });
      const feedback = el('div', { 'aria-live': 'assertive' });
      const submit = el('button', { type: 'submit', class: 'btn btn-danger', text: 'Reject lesson note' });
      const form = el('form', { novalidate: true }, field('Reason for rejection', reason, 'The teacher will see this reason and can resubmit an updated note.'), feedback, submit);
      const dialog = modal('Reject lesson note', form);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = reason.value.trim();
        if (value.length < 5 || value.length > 500) { feedback.replaceChildren(alertBox('Enter a reason between 5 and 500 characters.')); return; }
        await busy(submit, async () => { if (await decide(note, 'rejected', value)) dialog.close(); }, 'Rejecting...');
      });
    }
    const noteCard = (note, showActions) => card(note.topic,
      el('p', { text: `${note.classes?.name || 'Class'} / ${note.subjects?.name || 'Subject'} / ${formatDate(note.lesson_date)}` }),
      el('p', { class: 'muted', text: `${teacherNames.get(note.submitted_by) || 'Teacher'} · ${note.semesters?.academic_years?.name || ''} Semester ${note.semesters?.term || ''}` }),
      el('p', {}, statusBadge(note.status), note.rejection_reason ? el('span', { text: ` Reason: ${note.rejection_reason}` }) : null),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Preview / download', onclick: () => preview(note) }),
        showActions ? el('button', { type: 'button', class: 'btn', text: 'Approve', onclick: () => decide(note, 'approved') }) : null,
        showActions ? el('button', { type: 'button', class: 'btn btn-secondary', text: 'Reject', onclick: () => reject(note) }) : null));

    const unread = notifications.filter((notification) => !notification.read_at);
    holder.replaceChildren(
      card('In-app notifications',
        unread.length ? el('ul', { class: 'list-plain' }, unread.map((notification) => el('li', { text: `${notification.message} ` },
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Mark read', onclick: async () => {
            try { await must(db.from('lesson_note_notifications').update({ read_at: new Date().toISOString() }).eq('id', notification.id)); await load(); }
            catch (err) { toast(errorMessage(err), 'error'); }
          } })))) : el('p', { class: 'muted', text: 'No unread lesson-note notifications.' })),
      card(`Pending review (${pending.length})`, pending.length ? pending.map((note) => noteCard(note, true)) : el('p', { class: 'muted', text: 'No lesson notes are waiting for approval.' })),
      card('Recent decisions', history.length ? history.map((note) => noteCard(note, false)) : el('p', { class: 'muted', text: 'No decisions have been recorded yet.' })));
  }
  await load();
}

// ======================================================================
// Attendance corrections
// ======================================================================
async function corrections(main) {
  const holder = el('div');
  main.replaceChildren(pageHead('Attendance corrections'), holder);

  async function load() {
    const rows = await must(db.from('attendance_corrections')
      .select('id, new_status, reason, status, created_at, decided_at, requested_by, attendance(date, status, students(first_name, last_name, student_code), classes(name))')
      .order('created_at', { ascending: false }).limit(100));
    const ids = [...new Set(rows.map((r) => r.requested_by))];
    const people = ids.length ? await must(db.from('profiles').select('id, full_name').in('id', ids)) : [];
    const who = new Map(people.map((p) => [p.id, p.full_name]));
    const pending = rows.filter((r) => r.status === 'pending');
    const decided = rows.filter((r) => r.status !== 'pending').slice(0, 20);

    const common = [
      { label: 'Student', render: (r) => `${fullName(r.attendance.students)} (${r.attendance.classes.name})` },
      { label: 'Date', render: (r) => formatDate(r.attendance.date) },
      { label: 'Change', render: (r) => [statusBadge(r.attendance.status), ' to ', statusBadge(r.new_status)] },
      { label: 'Teacher', render: (r) => who.get(r.requested_by) || '-' },
      { label: 'Reason', render: (r) => r.reason },
    ];
    const decide = async (r, approve) => {
      const ok = await confirmDialog({
        title: approve ? 'Approve correction?' : 'Reject correction?',
        message: approve ? 'The attendance record will be changed and the change will be logged.' : 'The attendance record will stay as it is.',
        confirmLabel: approve ? 'Approve' : 'Reject', danger: !approve,
      });
      if (!ok) return;
      try { await must(db.rpc('decide_attendance_correction', { p_id: r.id, p_approve: approve })); toast(approve ? 'Approved.' : 'Rejected.'); await load(); }
      catch (err) { toast(errorMessage(err), 'error'); }
    };
    holder.replaceChildren(
      card('Waiting for a decision', dataTable([...common, { label: 'Actions', actions: true, render: (r) => [
        el('button', { type: 'button', class: 'btn btn-sm', text: 'Approve', onclick: () => decide(r, true) }),
        el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Reject', onclick: () => decide(r, false) }),
      ] }], pending, 'No requests are waiting.')),
      card('Recent decisions', dataTable([...common, { label: 'Decision', render: (r) => statusBadge(r.status) }], decided, 'No decisions yet.')));
  }
  await load();
}

// ======================================================================
const pages = {
  dashboard, students, teachers, parents: parentsPage, classes, subjects,
  'academic-years': academicYears, semester, corrections, 'academic-records': academicRecords, 'lesson-notes': lessonNotes,
};

(async function main() {
  const profile = await requireRole('admin');
  if (!profile) return;
  const root = renderShell(profile, NAV);
  const page = pages[document.body.dataset.page];
  try {
    await page(root, profile);
  } catch (err) {
    console.error(err);
    root.replaceChildren(alertBox(loadError(err)));
  }
})();
