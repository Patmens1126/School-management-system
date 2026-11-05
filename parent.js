// Parent pages. The database only returns rows for children linked to the signed-in
// parent (Row Level Security), so guessing another child's ID returns nothing.
import { db } from './supabase.js';
import { requireRole, renderShell } from './auth.js';
import {
  el, must, card, show, push, dataTable, pageHead, alertBox, loadError, paramId, todayStr, formatDate,
  getActiveSemester, statusBadge, pct, rating, selectInput, field, toast,
} from './ui.js';

const NAV = [['My children', '/parent/dashboard.html']];
const fullName = (s) => `${s.first_name} ${s.last_name}`;
const CATEGORIES = [['understanding', 'Understanding'], ['participation', 'Participation'], ['assignment', 'Assignment'], ['behaviour', 'Behaviour']];
const nameOf = (rel, fallback = '-') => (rel && typeof rel === 'object' && rel.name ? rel.name : fallback);

async function loadChildren() {
  return must(db.from('students').select('id, student_code, first_name, last_name, status').order('first_name'));
}

// Current class of each child: the class for the active semester's year, otherwise the latest enrolment.
async function currentClasses(children) {
  const [sem, enrols] = await Promise.all([
    getActiveSemester(),
    must(db.from('enrollments').select('student_id, academic_year_id, academic_years(name), classes(name)')),
  ]);
  const map = new Map();
  for (const c of children) {
    const mine = (enrols || [])
      .filter((e) => e.student_id === c.id)
      .sort((a, b) => String(nameOf(b?.academic_years, '')).localeCompare(String(nameOf(a?.academic_years, ''))));
    const inActive = sem ? mine.find((e) => e.academic_year_id === sem.academic_year_id) : null;
    const pick = inActive || mine[0];
    map.set(c.id, pick ? nameOf(pick.classes, null) : null);
  }
  return map;
}

function ratingList(entry) {
  return el('dl', { class: 'rating-list' }, CATEGORIES.flatMap(([key, label]) => [el('dt', { text: label }), el('dd', { text: `${entry[key]}/5` })]));
}

function switcher(children, currentId, page) {
  if (children.length < 2) return null;
  const sel = selectInput('child', children.map((c) => ({ value: c.id, label: fullName(c) })), { value: currentId });
  sel.addEventListener('change', () => location.assign(`/parent/${page}.html?student=${sel.value}`));
  return field('Child', sel);
}

function weeklyPerformanceSummary(rows) {
  if (!rows.length) {
    return {
      average: 0,
      total: 0,
      distribution: [
        { label: 'Excellent', count: 0, color: '#2d6df6' },
        { label: 'Good', count: 0, color: '#63b3ff' },
        { label: 'Satisfactory', count: 0, color: '#22b3a5' },
        { label: 'Needs support', count: 0, color: '#f7b267' },
        { label: 'At risk', count: 0, color: '#f76c6c' },
      ],
    };
  }

  const values = rows.flatMap((row) => [row.understanding, row.participation, row.assignment, row.behaviour]);
  const total = values.length;
  const average = values.reduce((sum, value) => sum + value, 0) / total;
  const bucket = [
    { label: 'Excellent', color: '#2d6df6', test: (value) => value >= 4.5 },
    { label: 'Good', color: '#63b3ff', test: (value) => value >= 4 && value < 4.5 },
    { label: 'Satisfactory', color: '#22b3a5', test: (value) => value >= 3 && value < 4 },
    { label: 'Needs support', color: '#f7b267', test: (value) => value >= 2 && value < 3 },
    { label: 'At risk', color: '#f76c6c', test: (value) => value < 2 },
  ].map((item) => ({ ...item, count: values.filter((value) => item.test(value)).length }));

  return { average, total, distribution: bucket };
}

function weeklyDonut(distribution) {
  const total = distribution.reduce((sum, item) => sum + item.count, 0) || 1;
  const circumference = 2 * Math.PI * 42;
  let offset = 0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'weekly-donut-chart');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', '50');
  track.setAttribute('cy', '50');
  track.setAttribute('r', '42');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', '#eaf0f7');
  track.setAttribute('stroke-width', '12');
  svg.append(track);

  distribution.forEach((item) => {
    if (!item.count) return;
    const length = (item.count / total) * circumference;
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    segment.setAttribute('cx', '50');
    segment.setAttribute('cy', '50');
    segment.setAttribute('r', '42');
    segment.setAttribute('fill', 'none');
    segment.setAttribute('stroke', item.color);
    segment.setAttribute('stroke-width', '12');
    segment.setAttribute('stroke-dasharray', `${length} ${circumference - length}`);
    segment.setAttribute('stroke-dashoffset', String(-offset));
    segment.setAttribute('transform', 'rotate(-90 50 50)');
    svg.append(segment);
    offset += length;
  });
  return svg;
}

// Works out which child the page is about, or shows a chooser.
function pickChild(main, children, page) {
  const id = paramId('student');
  const chosen = children.find((c) => c.id === id) || (children.length === 1 ? children[0] : null);
  if (chosen) return chosen;
  main.replaceChildren(pageHead('Choose a child'),
    children.length
      ? el('ul', { class: 'list-plain' }, children.map((c) => el('li', {}, el('a', { href: `/parent/${page}.html?student=${c.id}`, text: fullName(c) }))))
      : el('p', { class: 'muted', text: 'No children are linked to your account yet. Please contact the school.' }));
  return null;
}

const childLinks = (c) => el('div', { class: 'btn-row' },
  el('a', { class: 'btn btn-secondary btn-sm', href: `/parent/child.html?student=${c.id}`, text: 'Overview and history' }),
  el('a', { class: 'btn btn-secondary btn-sm', href: `/parent/attendance.html?student=${c.id}`, text: 'Attendance' }),
  el('a', { class: 'btn btn-secondary btn-sm', href: `/parent/performance.html?student=${c.id}`, text: 'Performance' }));

// ======================================================================
async function dashboard(main, profile) {
  const today = todayStr();
  const children = await loadChildren();
  main.replaceChildren(pageHead(`Welcome, ${profile.full_name}`));
  if (!children.length) { main.append(alertBox('No children are linked to your account yet. Please contact the school.', 'info')); return; }

  const [classMap, att, perf, sums, weeklyPerf, notifications] = await Promise.all([
    currentClasses(children),
    must(db.from('attendance').select('student_id, status').eq('date', today)),
    must(db.from('performance').select('student_id, understanding, participation, assignment, behaviour, comment, subjects(name)').eq('date', today)),
    must(db.from('semester_summaries').select('student_id, created_at, semesters(term), academic_years(name)').order('created_at', { ascending: false })),
    must(db.from('performance').select('student_id, understanding, participation, assignment, behaviour').gte('date', (() => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    })()).order('date', { ascending: false })),
    must(db.from('parent_notifications').select('id, student_id, event_type, title, message, created_at, read_at').order('created_at', { ascending: false }).limit(30)),
  ]);

  const weeklyMap = new Map();
  for (const row of weeklyPerf) {
    const list = weeklyMap.get(row.student_id) || [];
    list.push(row);
    weeklyMap.set(row.student_id, list);
  }

  // Simple notifications, worked out from the records themselves.
  const notes = [];
  for (const c of children) {
    const a = att.find((x) => x.student_id === c.id);
    if (a && a.status === 'absent') notes.push(`${c.first_name} was marked absent today.`);
    if (a && a.status === 'late') notes.push(`${c.first_name} was marked late today.`);
    if (perf.some((p) => p.student_id === c.id)) notes.push(`New performance record available for ${c.first_name}.`);
    const s = sums.find((x) => x.student_id === c.id);
    if (s) notes.push(`${c.first_name}: Semester ${s.semesters.term} results (${s.academic_years.name}) are now available.`);
  }
  const eventNotifications = notifications.map((n) => {
    const markRead = !n.read_at ? el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm', text: 'Mark as read',
      onclick: async () => {
        const { error } = await db.from('parent_notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
        if (error) { toast('Could not update this notification. Please try again.'); return; }
        n.read_at = new Date().toISOString();
        markRead.replaceWith(el('span', { class: 'notification-state muted', text: 'Read' }));
        item.classList.add('is-read');
      },
    }) : el('span', { class: 'notification-state muted', text: 'Read' });
    const item = el('article', { class: `notice notification-item${n.read_at ? ' is-read' : ''}` },
      el('div', { class: 'notification-copy' },
        el('strong', { text: n.title }),
        el('p', { text: n.message }),
        el('small', { class: 'muted', text: new Date(n.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) })),
      markRead);
    return item;
  });

  push(main,
    eventNotifications.length || notes.length ? card('Notifications',
      eventNotifications.length ? el('div', { class: 'notification-list' }, eventNotifications) : null,
      notes.map((n) => el('div', { class: 'notice notice-legacy', text: n }))) : null,
    el('h2', { text: 'My children' }),
    ...children.map((c) => {
      const a = att.find((x) => x.student_id === c.id);
      const p = perf.filter((x) => x.student_id === c.id);
      const weekly = weeklyPerformanceSummary(weeklyMap.get(c.id) || []);
      const donut = el('div', {
        class: 'weekly-donut',
      }, weeklyDonut(weekly.distribution), el('div', { class: 'weekly-donut-inner' },
        el('strong', { text: `${weekly.total ? (weekly.average / 5 * 100).toFixed(0) : 0}%` }),
        el('small', { text: 'This week' })));

      const summaryBreakdown = el('div', { class: 'weekly-summary-breakdown' },
        weekly.total
          ? weekly.distribution.map((item, index) => el('div', { class: 'weekly-breakdown-row' },
              el('span', { class: `weekly-breakdown-color weekly-color-${index}` }),
              el('span', { text: item.label }),
              el('strong', { text: String(item.count) })))
          : el('p', { class: 'muted', text: 'No performance records in the last 7 days.' }));

      return el('article', { class: 'child-card' },
        el('h3', { text: fullName(c) }),
        el('p', { class: 'muted', text: classMap.get(c.id) || 'No class assigned yet' }),
        el('div', { class: 'weekly-summary' }, donut, summaryBreakdown),
        el('h4', { text: "Today's attendance" }),
        a ? statusBadge(a.status) : el('span', { class: 'muted', text: 'Not recorded yet today' }),
        el('h4', { text: "Today's performance" }),
        p.length ? p.map((x) => el('div', {},
          el('strong', { text: nameOf(x?.subjects, 'Subject') }), ratingList(x),
          x.comment ? el('p', { class: 'quote', text: `Teacher comment: "${x.comment}"` }) : null))
          : el('p', { class: 'muted', text: 'No performance record today.' }),
        childLinks(c));
    }));
}

// ======================================================================
async function childPage(main) {
  const children = await loadChildren();
  const child = pickChild(main, children, 'child');
  if (!child) return;
  const today = todayStr();
  const [classMap, att, perf, enrols, sums, subs] = await Promise.all([
    currentClasses([child]),
    must(db.from('attendance').select('status').eq('student_id', child.id).eq('date', today)),
    must(db.from('performance').select('understanding, participation, assignment, behaviour, comment, subjects(name)').eq('student_id', child.id).eq('date', today)),
    must(db.from('enrollments').select('academic_years(name), classes(name)').eq('student_id', child.id)),
    must(db.from('semester_summaries').select('id, semester_id, attendance_percentage, overall_percentage, performance_rating, teacher_remark, promotion_status, classes(name), semesters(term), academic_years(name)').eq('student_id', child.id)),
    must(db.from('subject_summaries').select('semester_id, percentage, rating, subjects(name)').eq('student_id', child.id)),
  ]);

  // Academic history, grouped by year: 2025/26 -> class -> semesters -> subjects.
  const years = new Map();
  for (const e of enrols) {
    const yearName = nameOf(e?.academic_years, 'Unknown year');
    const className = nameOf(e?.classes, 'Unknown class');
    years.set(yearName, { classes: new Set([className]), semesters: [] });
  }
  for (const s of sums) {
    const yearName = nameOf(s?.academic_years, 'Unknown year');
    const y = years.get(yearName) || { classes: new Set(), semesters: [] };
    y.classes.add(nameOf(s?.classes, 'Unknown class'));
    y.semesters.push(s);
    years.set(yearName, y);
  }
  const yearNames = [...years.keys()].sort((a, b) => a.localeCompare(b));

  show(main,
    el('p', { class: 'crumbs' }, el('a', { href: '/parent/dashboard.html', text: 'My children' })),
    pageHead(fullName(child)),
    switcher(children, child.id, 'child'),
    el('p', { class: 'muted', text: classMap.get(child.id) || 'No class assigned yet' }),
    childLinks(child),
    card("Today's attendance", att.length ? statusBadge(att[0].status) : el('span', { class: 'muted', text: 'Not recorded yet today.' })),
    card("Today's performance", perf.length
      ? perf.map((x) => el('div', {}, el('strong', { text: nameOf(x?.subjects, 'Subject') }), ratingList(x), x.comment ? el('p', { class: 'quote', text: `Teacher comment: "${x.comment}"` }) : null))
      : el('p', { class: 'muted', text: 'No performance record today.' })),
    card('Academic history', yearNames.length
      ? yearNames.map((name) => {
        const y = years.get(name);
        y.semesters.sort((a, b) => a.semesters.term - b.semesters.term);
        return el('section', { class: 'history-year' },
          el('h3', { text: `${name}: ${[...y.classes].join(', ')}` }),
          y.semesters.length
            ? y.semesters.map((s) => {
              const subjectRows = subs.filter((x) => x.semester_id === s.semester_id).sort((a, b) => a.subjects.name.localeCompare(b.subjects.name));
              return el('div', { class: 'history-sem' },
                el('strong', { text: `Semester ${s.semesters.term}` }),
                el('div', { class: 'meter' },
                  el('span', {}, 'Overall ', el('strong', { text: pct(s.overall_percentage) })),
                  el('span', {}, 'Attendance ', el('strong', { text: pct(s.attendance_percentage) })),
                  el('span', {}, 'Rating ', el('strong', { text: rating(s.performance_rating) })),
                  el('span', {}, 'Promotion ', el('strong', { text: s.promotion_status }))),
                s.teacher_remark ? el('p', { class: 'quote', text: s.teacher_remark }) : null,
                subjectRows.length ? dataTable([
                  { label: 'Subject', render: (r) => r.subjects.name },
                  { label: 'Percentage', render: (r) => pct(r.percentage) },
                  { label: 'Rating', render: (r) => rating(r.rating) },
                ], subjectRows) : null);
            })
            : el('p', { class: 'muted', text: 'Semester results appear here once a semester is closed.' }));
      })
      : el('p', { class: 'muted', text: 'No academic history yet.' })));
}

// ======================================================================
async function attendancePage(main) {
  const children = await loadChildren();
  const child = pickChild(main, children, 'attendance');
  if (!child) return;
  const rows = await must(db.from('attendance').select('id, date, status, classes(name)').eq('student_id', child.id).order('date', { ascending: false }).limit(90));
  const count = (s) => rows.filter((r) => r.status === s).length;
  show(main,
    el('p', { class: 'crumbs' }, el('a', { href: `/parent/child.html?student=${child.id}`, text: fullName(child) })),
    pageHead(`Attendance: ${fullName(child)}`),
    switcher(children, child.id, 'attendance'),
    card('Summary of the records shown', el('div', { class: 'meter' },
      el('span', {}, 'Present ', el('strong', { text: String(count('present')) })),
      el('span', {}, 'Absent ', el('strong', { text: String(count('absent')) })),
      el('span', {}, 'Late ', el('strong', { text: String(count('late')) })))),
    card('Daily attendance', dataTable([
      { label: 'Date', render: (r) => formatDate(r.date) },
      { label: 'Class', render: (r) => nameOf(r?.classes, 'Unknown class') },
      { label: 'Status', render: (r) => statusBadge(r.status) },
    ], rows, 'No attendance has been recorded yet.'),
    el('p', { class: 'muted', text: 'Shows the most recent 90 days on record. Older daily records may be replaced by the semester summaries in the academic history.' })));
}

async function performancePage(main) {
  const children = await loadChildren();
  const child = pickChild(main, children, 'performance');
  if (!child) return;
  const rows = await must(db.from('performance')
    .select('id, date, understanding, participation, assignment, behaviour, comment, subjects(name)')
    .eq('student_id', child.id).order('date', { ascending: false }).limit(90));
  show(main,
    el('p', { class: 'crumbs' }, el('a', { href: `/parent/child.html?student=${child.id}`, text: fullName(child) })),
    pageHead(`Performance: ${fullName(child)}`),
    switcher(children, child.id, 'performance'),
    card('Daily performance (ratings out of 5)', dataTable([
      { label: 'Date', render: (r) => formatDate(r.date) },
      { label: 'Subject', render: (r) => nameOf(r?.subjects, 'Unknown subject') },
      { label: 'Understanding', render: (r) => String(r.understanding) },
      { label: 'Participation', render: (r) => String(r.participation) },
      { label: 'Assignment', render: (r) => String(r.assignment) },
      { label: 'Behaviour', render: (r) => String(r.behaviour) },
      { label: 'Teacher comment', render: (r) => r.comment || '-' },
    ], rows, 'No performance records yet.')));
}

// ======================================================================
const pages = { dashboard, child: childPage, attendance: attendancePage, performance: performancePage };

(async function start() {
  const app = document.getElementById('app');
  try {
    const profile = await requireRole('parent');
    if (!profile) return;
    const root = renderShell(profile, NAV);
    await pages[document.body.dataset.page](root, profile);
  } catch (err) {
    console.error(err);
    (app || document.body).replaceChildren(alertBox(loadError(err)));
  }
})();
