// Teacher pages. The database only lets a teacher read/write records for the
// classes and subjects assigned to them; the checks here just give friendly feedback.
import { db } from './supabase.js';
import { requireRole, renderShell } from './auth.js';
import {
  el, must, countOf, card, show, field, selectInput, dataTable, pageHead, modal, toast, alertBox,
  busy, errorMessage, loadError, paramId, todayStr, formatDate, getActiveSemester, semesterLabel,
  statusBadge,
} from './ui.js';
import { checkText, isIsoDate, isRating, LIMITS } from './validation.js';

const NAV = [['My classes', '/teacher/dashboard.html'], ['Lesson Notes', '/teacher/lesson-notes.html']];
const fullName = (s) => `${s.first_name} ${s.last_name}`;
async function fetchAll(queryForRange, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await must(queryForRange().range(offset, offset + pageSize - 1));
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

// ---------- Shared: which class/subject is this page about? ----------
async function loadContext(main) {
  const classId = paramId('class');
  const subjectId = paramId('subject');
  if (!classId || !subjectId) {
    main.replaceChildren(alertBox('Open this page from one of your classes on the dashboard.', 'info'));
    return null;
  }
  const sem = await getActiveSemester();
  if (!sem) { main.replaceChildren(alertBox('No semester is active. Please contact the school administrator.', 'info')); return null; }
  const a = await must(db.from('teacher_assignments').select('id, classes(name), subjects(name)')
    .eq('class_id', classId).eq('subject_id', subjectId).eq('academic_year_id', sem.academic_year_id).maybeSingle());
  if (!a) { main.replaceChildren(alertBox('You are not assigned to this class and subject.')); return null; }
  return { sem, classId, subjectId, className: a.classes.name, subjectName: a.subjects.name };
}

async function classStudents(ctx) {
  const rows = await must(db.from('enrollments')
    .select('student_id, students(id, student_code, first_name, last_name, status)')
    .eq('class_id', ctx.classId).eq('academic_year_id', ctx.sem.academic_year_id));
  return rows.map((r) => r.students).filter((s) => s && s.status === 'active')
    .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

const classUrl = (ctx, page) => `/teacher/${page}.html?class=${ctx.classId}&subject=${ctx.subjectId}`;
const crumbs = (ctx) => el('p', { class: 'crumbs' }, el('a', { href: '/teacher/dashboard.html', text: 'My classes' }), ' / ',
  el('a', { href: classUrl(ctx, 'class'), text: `${ctx.className} - ${ctx.subjectName}` }));

function pastDateParam(today) {
  const requested = new URLSearchParams(location.search).get('date');
  return isIsoDate(requested) && requested <= today ? requested : today;
}

// ======================================================================
async function dashboard(main, profile) {
  main.replaceChildren(pageHead(`Welcome, ${profile.full_name}`));
  const sem = await getActiveSemester();
  if (!sem) {
    main.append(alertBox('No semester is active. Please contact the school administrator.', 'info'),
      card('Lesson notes', el('p', { class: 'muted', text: 'Review your submitted notes and their approval status.' }),
        el('a', { class: 'btn', href: '/teacher/lesson-notes.html', text: 'Open Lesson Notes' })));
    return;
  }
  const rows = await must(db.from('teacher_assignments').select('id, class_id, subject_id, classes(name), subjects(name)')
    .eq('academic_year_id', sem.academic_year_id));
  rows.sort((a, b) => {
    const aHasOrder = Object.prototype.hasOwnProperty.call(a.classes || {}, 'class_order');
    const bHasOrder = Object.prototype.hasOwnProperty.call(b.classes || {}, 'class_order');
    if (aHasOrder && bHasOrder) {
      const aOrder = Number(a.classes?.class_order ?? Number.MAX_SAFE_INTEGER);
      const bOrder = Number(b.classes?.class_order ?? Number.MAX_SAFE_INTEGER);
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    return a.classes.name.localeCompare(b.classes.name) || a.subjects.name.localeCompare(b.subjects.name);
  });
  const counts = await Promise.all(rows.map((r) => countOf(db.from('enrollments').select('id', { count: 'exact', head: true })
    .eq('class_id', r.class_id).eq('academic_year_id', sem.academic_year_id))));

  main.append(el('p', { class: 'muted', text: semesterLabel(sem) }),
    el('h2', { text: 'My classes' }),
    rows.length
      ? el('div', { class: 'grid grid-3' }, rows.map((r, i) => el('div', { class: 'class-card' },
          el('h3', { text: r.classes.name }), el('div', { text: r.subjects.name }),
          el('div', { class: 'muted', text: `${counts[i]} student${counts[i] === 1 ? '' : 's'}` }),
          el('a', { class: 'btn', href: `/teacher/class.html?class=${r.class_id}&subject=${r.subject_id}`, text: 'Open class' }))))
      : el('p', { class: 'muted', text: 'No classes have been assigned to you for this academic year yet.' }),
    card('Lesson notes', el('p', { class: 'muted', text: 'Submit notes for approval and check their status or feedback.' }),
      el('a', { class: 'btn', href: '/teacher/lesson-notes.html', text: 'Open Lesson Notes' })));
}

// ======================================================================
async function classPage(main) {
  const ctx = await loadContext(main);
  if (!ctx) return;
  const students = await classStudents(ctx);
  const holder = el('div');
  let term = '';
  const search = el('input', { type: 'search', maxlength: 100, placeholder: 'Name or ID', autocomplete: 'off' });
  search.addEventListener('input', () => { term = search.value.trim().toLowerCase(); render(); });

  main.replaceChildren(crumbs(ctx),
    pageHead(`${ctx.className} - ${ctx.subjectName}`),
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn', href: classUrl(ctx, 'attendance'), text: 'Attendance' }),
      el('a', { class: 'btn', href: classUrl(ctx, 'performance'), text: 'Performance' }),
    ),
    card('Students', field('Search students in this class', search), holder));

  function render() {
    const rows = students.filter((s) => !term || `${fullName(s)} ${s.student_code}`.toLowerCase().includes(term));
    holder.replaceChildren(dataTable([
      { label: 'Student ID', render: (s) => s.student_code },
      { label: 'Name', render: (s) => fullName(s) },
    ], rows, 'No students found.'));
  }
  render();
}

// ======================================================================
async function attendance(main, profile) {
  const ctx = await loadContext(main);
  if (!ctx) return;
  const today = todayStr();
  let date = pastDateParam(today);
  const students = await classStudents(ctx);
  const holder = el('div');

  const dateInput = el('input', { type: 'date', value: date, max: today, required: true });
  dateInput.addEventListener('change', () => {
    if (isIsoDate(dateInput.value) && dateInput.value <= today) { date = dateInput.value; load(); }
    else dateInput.value = date;
  });
  main.replaceChildren(crumbs(ctx), pageHead(`Attendance: ${ctx.className}`),
    card(null, field('Date', dateInput, 'You can record today\'s register. Earlier days are view-only; ask the administrator to approve a correction if needed.')),
    holder);

  async function load() {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Loading...' }));
    try {
      const [records, requests] = await Promise.all([
        must(db.from('attendance').select('id, student_id, status, teacher_id')
          .eq('class_id', ctx.classId).eq('semester_id', ctx.sem.id).eq('date', date)),
        must(db.from('attendance_corrections').select('attendance_id, new_status').eq('status', 'pending')),
      ]);
      const byStudent = new Map(records.map((r) => [r.student_id, r]));
      const pending = new Set(requests.map((r) => r.attendance_id));
      if (date === today) renderRegister(byStudent);
      else renderHistory(byStudent, pending);
    } catch (err) { holder.replaceChildren(alertBox(loadError(err))); }
  }

  function renderRegister(byStudent) {
    const choice = new Map();
    for (const s of students) { const r = byStudent.get(s.id); if (r) choice.set(s.id, r.status); }
    const status = el('div', { 'aria-live': 'polite' });

    const rows = students.map((s) => {
      const rec = byStudent.get(s.id);
      const locked = !!rec && rec.teacher_id !== profile.id;
      const group = el('div', { class: 'att-group', role: 'group', 'aria-label': `Attendance for ${fullName(s)}` });
      const defs = [['present', 'Present', '\u2713 Present'], ['absent', 'Absent', '\u2715 Absent'], ['late', 'Late', 'L Late']];
      for (const [value, name, text] of defs) {
        const btn = el('button', { type: 'button', class: 'att-btn', 'data-value': value, 'aria-pressed': String(choice.get(s.id) === value), 'aria-label': `${name}: ${fullName(s)}`, text, disabled: locked });
        btn.addEventListener('click', () => {
          choice.set(s.id, value);
          for (const b of group.children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
        });
        group.append(btn);
      }
      return el('div', { class: 'register-row' },
        el('div', { class: 'register-name', text: fullName(s) }),
        el('div', { class: 'register-code', text: locked ? `${s.student_code} - marked by another teacher` : s.student_code }),
        group);
    });

    const save = el('button', { type: 'button', class: 'btn btn-block', text: 'Save attendance' });
    save.addEventListener('click', async () => {
      const inserts = [];
      const updates = [];
      for (const s of students) {
        const c = choice.get(s.id);
        const rec = byStudent.get(s.id);
        if (!c) continue;
        if (!rec) inserts.push({ student_id: s.id, class_id: ctx.classId, semester_id: ctx.sem.id, teacher_id: profile.id, date, status: c });
        else if (rec.teacher_id === profile.id && rec.status !== c) updates.push({ id: rec.id, status: c });
      }
      if (!inserts.length && !updates.length) { status.replaceChildren(alertBox('Nothing new to save. Mark students Present, Absent or Late first.', 'info')); return; }
      if (!navigator.onLine) { status.replaceChildren(alertBox('Connection lost. Your changes have not been submitted.')); return; }
      await busy(save, async () => {
        try {
          if (inserts.length) await must(db.from('attendance').insert(inserts));
          for (const u of updates) await must(db.from('attendance').update({ status: u.status }).eq('id', u.id));
          toast('Attendance saved successfully.');
          await load();
          const left = students.filter((s) => !choice.get(s.id)).length;
          holder.prepend(alertBox(`\u2713 Attendance saved successfully.${left ? ` ${left} student${left === 1 ? ' is' : 's are'} not marked yet.` : ''}`, 'success'));
        } catch (err) {
          if (err && err.code === '23505') {
            status.replaceChildren(alertBox('Attendance for some of these students was already recorded. The register has been reloaded.'));
            await load();
          } else status.replaceChildren(alertBox(errorMessage(err)));
        }
      });
    });

    show(holder,
      el('p', { class: 'muted', text: `${formatDate(date)}. ${ctx.sem ? semesterLabel(ctx.sem) : ''}` }),
      students.length ? el('div', { class: 'register' }, rows) : el('p', { class: 'muted', text: 'No active students are enrolled in this class.' }),
      students.length ? el('div', { class: 'register-foot' }, status, save) : null);
  }

  function renderHistory(byStudent, pending) {
    holder.replaceChildren(dataTable([
      { label: 'Student', render: (s) => fullName(s) },
      { label: 'Status', render: (s) => { const r = byStudent.get(s.id); return r ? statusBadge(r.status) : el('span', { class: 'muted', text: 'Not recorded' }); } },
      { label: 'Actions', actions: true, render: (s) => {
        const r = byStudent.get(s.id);
        if (!r || r.teacher_id !== profile.id) return '';
        if (pending.has(r.id)) return statusBadge('pending');
        return el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Request correction', onclick: () => openCorrection(s, r) });
      } },
    ], students, 'No active students are enrolled in this class.'));
  }

  function openCorrection(s, rec) {
    const options = ['present', 'absent', 'late'].filter((v) => v !== rec.status).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
    const sel = selectInput('new_status', options, { value: options[0].value });
    const reason = el('textarea', { maxlength: LIMITS.reason, rows: 3, required: true });
    const err = el('div', { 'aria-live': 'assertive' });
    const send = el('button', { type: 'submit', class: 'btn', text: 'Send request' });
    const form = el('form', { novalidate: true },
      el('p', { text: `${fullName(s)} on ${formatDate(date)} is currently marked ${rec.status}.` }),
      field('Change to', sel), field('Reason', reason, 'The administrator reviews every request.'), err, el('div', { class: 'btn-row' }, send));
    const dlg = modal('Request a correction', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = checkText(reason.value, 'Reason', { min: 5, max: LIMITS.reason });
      if (problem) { err.replaceChildren(alertBox(problem)); return; }
      await busy(send, async () => {
        try {
          await must(db.from('attendance_corrections').insert({ attendance_id: rec.id, requested_by: profile.id, new_status: sel.value, reason: reason.value.trim() }));
          toast('Request sent to the administrator.');
          dlg.close();
          await load();
        } catch (error) { err.replaceChildren(alertBox(errorMessage(error))); }
      }, 'Sending...');
    });
  }

  await load();
}

// ======================================================================
const CATEGORIES = [
  ['understanding', 'Understanding'], ['participation', 'Participation'],
  ['assignment', 'Assignment'], ['behaviour', 'Behaviour'],
];

async function performance(main, profile) {
  const ctx = await loadContext(main);
  if (!ctx) return;
  const today = todayStr();
  let date = pastDateParam(today);
  const students = await classStudents(ctx);
  const holder = el('div');

  const dateInput = el('input', { type: 'date', value: date, max: today, required: true });
  dateInput.addEventListener('change', () => {
    if (isIsoDate(dateInput.value) && dateInput.value <= today) { date = dateInput.value; load(); }
    else dateInput.value = date;
  });

  main.replaceChildren(crumbs(ctx), pageHead(`Performance: ${ctx.className} - ${ctx.subjectName}`),
    card(null, field('Date', dateInput, 'Ratings can be entered for today. Earlier days are view-only.'),
      el('ul', { class: 'legend list-plain' },
        el('li', { text: '1 = Needs significant improvement' }), el('li', { text: '2 = Needs improvement' }),
        el('li', { text: '3 = Satisfactory' }), el('li', { text: '4 = Good' }), el('li', { text: '5 = Excellent' }))),
    holder);

  async function load() {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Loading...' }));
    try {
      const records = await must(db.from('performance')
        .select('id, student_id, understanding, participation, assignment, behaviour, comment, teacher_id')
        .eq('class_id', ctx.classId).eq('subject_id', ctx.subjectId).eq('semester_id', ctx.sem.id).eq('date', date));
      render(new Map(records.map((r) => [r.student_id, r])));
    } catch (err) { holder.replaceChildren(alertBox(loadError(err))); }
  }

  function render(byStudent) {
    const editable = date === today;
    const inputs = new Map();
    const status = el('div', { 'aria-live': 'polite' });

    const cols = [{ label: 'Student', render: (s) => fullName(s) }];
    for (const [key, label] of CATEGORIES) {
      cols.push({ label, render: (s) => {
        const rec = byStudent.get(s.id);
        const locked = !editable || (rec && rec.teacher_id !== profile.id);
        if (locked) return rec ? String(rec[key]) : '-';
        const input = el('input', { type: 'number', min: '1', max: '5', step: '1', inputmode: 'numeric', class: 'rating-input', value: rec ? String(rec[key]) : '', 'aria-label': `${label} for ${fullName(s)}` });
        const entry = inputs.get(s.id) || {};
        entry[key] = input;
        inputs.set(s.id, entry);
        return input;
      } });
    }
    cols.push({ label: 'Comment', render: (s) => {
      const rec = byStudent.get(s.id);
      const locked = !editable || (rec && rec.teacher_id !== profile.id);
      if (locked) return rec && rec.comment ? rec.comment : '-';
      const input = el('input', { type: 'text', class: 'comment-input', maxlength: LIMITS.comment, value: rec && rec.comment ? rec.comment : '', 'aria-label': `Comment for ${fullName(s)}` });
      const entry = inputs.get(s.id) || {};
      entry.comment = input;
      inputs.set(s.id, entry);
      return input;
    } });

    const table = dataTable(cols, students, 'No active students are enrolled in this class.');
    if (!editable) { holder.replaceChildren(table); return; }

    const save = el('button', { type: 'button', class: 'btn btn-block', text: 'Save all' });
    save.addEventListener('click', async () => {
      const inserts = [];
      const updates = [];
      for (const s of students) {
        const entry = inputs.get(s.id);
        if (!entry) continue;                                   // locked row (another teacher's entry)
        const raw = CATEGORIES.map(([key]) => entry[key].value.trim());
        const comment = entry.comment.value.trim();
        if (raw.every((v) => v === '') && comment === '') continue;
        if (raw.some((v) => v === '')) { status.replaceChildren(alertBox(`Enter all four ratings for ${fullName(s)}, or leave the row empty.`)); return; }
        const nums = raw.map(Number);
        if (!nums.every(isRating)) { status.replaceChildren(alertBox(`Ratings for ${fullName(s)} must be whole numbers from 1 to 5.`)); return; }
        const problem = comment ? checkText(comment, 'Comment', { max: LIMITS.comment }) : null;
        if (problem) { status.replaceChildren(alertBox(problem)); return; }
        const values = { understanding: nums[0], participation: nums[1], assignment: nums[2], behaviour: nums[3], comment: comment || null };
        const rec = byStudent.get(s.id);
        if (!rec) inserts.push({ student_id: s.id, class_id: ctx.classId, subject_id: ctx.subjectId, semester_id: ctx.sem.id, teacher_id: profile.id, date, ...values });
        else if (CATEGORIES.some(([key], i) => rec[key] !== nums[i]) || (rec.comment || null) !== values.comment) updates.push({ id: rec.id, values });
      }
      if (!inserts.length && !updates.length) { status.replaceChildren(alertBox('Nothing new to save.', 'info')); return; }
      if (!navigator.onLine) { status.replaceChildren(alertBox('Connection lost. Your changes have not been submitted.')); return; }
      await busy(save, async () => {
        try {
          if (inserts.length) await must(db.from('performance').insert(inserts));
          for (const u of updates) await must(db.from('performance').update(u.values).eq('id', u.id));
          toast('Performance saved successfully.');
          await load();
          holder.prepend(alertBox('\u2713 Performance saved successfully.', 'success'));
        } catch (err) {
          if (err && err.code === '23505') { status.replaceChildren(alertBox('Some of these entries were already recorded. The page has been reloaded.')); await load(); }
          else status.replaceChildren(alertBox(errorMessage(err)));
        }
      });
    });
    show(holder, table, students.length ? el('div', { class: 'register-foot' }, status, save) : null);
  }

  await load();
}

// ======================================================================
// Lesson notes
// ======================================================================
async function lessonNotes(main, profile) {
  const holder = el('div');
  main.replaceChildren(pageHead('Lesson Notes'), holder);
  const maxBytes = 15 * 1024 * 1024;
  const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

  async function load() {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Loading lesson notes...' }));
    const [sem, notes, notifications] = await Promise.all([
      getActiveSemester(),
      fetchAll(() => db.from('lesson_notes').select('id, submitted_by, class_id, subject_id, semester_id, lesson_date, topic, file_path, file_mime_type, file_size, status, rejection_reason, created_at, classes(name), subjects(name), semesters(term, academic_years(name))').eq('submitted_by', profile.id).order('created_at', { ascending: false }).order('id')),
      fetchAll(() => db.from('lesson_note_notifications').select('id, lesson_note_id, title, message, created_at, read_at').eq('recipient_id', profile.id).order('created_at', { ascending: false }).order('id')),
    ]);
    const assignments = sem ? await must(db.from('teacher_assignments').select('class_id, subject_id, classes(name), subjects(name)')
      .eq('academic_year_id', sem.academic_year_id)) : [];
    const sharedApproved = sem ? (await Promise.all(assignments.map((assignment) =>
      fetchAll(() => db.from('lesson_notes').select('id, submitted_by, class_id, subject_id, semester_id, lesson_date, topic, file_path, file_mime_type, file_size, status, rejection_reason, created_at, classes(name), subjects(name), semesters(term, academic_years(name))')
        .eq('class_id', assignment.class_id).eq('subject_id', assignment.subject_id).eq('semester_id', sem.id).eq('status', 'approved').order('id'))))).flat() : [];
    const allNotes = [...new Map([...notes, ...sharedApproved].map((note) => [note.id, note])).values()];

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
        modal(`Lesson note: ${note.topic}`, el('div', {}, content,
          el('p', {}, el('a', { class: 'btn btn-secondary', href: await documentLink(note, true), target: '_blank', rel: 'noopener noreferrer', text: 'Download document' }))));
      } catch (err) { toast(errorMessage(err, 'The private document could not be opened.'), 'error'); }
    }
    async function remove(note) {
      try {
        const { error: fileError } = await db.storage.from('lesson-notes').remove([note.file_path]);
        if (fileError) throw fileError;
        await must(db.from('lesson_notes').delete().eq('id', note.id));
        toast('Lesson note removed.');
        await load();
      } catch (err) { toast(errorMessage(err), 'error'); }
    }
    async function save(form, existing = null) {
      const file = form.elements.document.files[0];
      const topic = form.elements.topic.value.trim();
      const classId = form.elements.class_id.value;
      const subjectId = form.elements.subject_id.value;
      const lessonDate = form.elements.lesson_date.value;
      const message = form.querySelector('[data-form-message]');
      if (!classId || !subjectId || !lessonDate || !topic || topic.length > 160) {
        message.replaceChildren(alertBox('Choose a class, subject, and lesson date, and enter a topic up to 160 characters.'));
        return;
      }
      if (!existing && !file) { message.replaceChildren(alertBox('Choose a PDF or image to upload.')); return; }
      if (file && (!allowedTypes.has(file.type) || file.size < 1 || file.size > maxBytes)) {
        message.replaceChildren(alertBox('Choose a PDF, JPG, PNG, or WebP file no larger than 15 MB.'));
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      await busy(submit, async () => {
        let noteId = existing?.id || crypto.randomUUID();
        const filePath = `${profile.id}/${noteId}`;
        const assignment = assignments.find((row) => row.class_id === classId && row.subject_id === subjectId);
        if (!assignment || !sem) { message.replaceChildren(alertBox('This class and subject are not assigned to you for an active semester.')); return; }
        const values = {
          class_id: classId, subject_id: subjectId, semester_id: sem.id, lesson_date: lessonDate, topic,
          file_path: filePath,
          file_mime_type: file?.type || existing.file_mime_type,
          file_size: file?.size || existing.file_size,
        };
        const previousValues = existing ? {
          class_id: existing.class_id, subject_id: existing.subject_id, semester_id: existing.semester_id,
          lesson_date: existing.lesson_date, topic: existing.topic, file_path: existing.file_path,
          file_mime_type: existing.file_mime_type, file_size: existing.file_size,
        } : null;
        let metadataChanged = false;
        let fileUploaded = false;
        try {
          if (existing) {
            await must(db.from('lesson_notes').update(values).eq('id', existing.id));
            metadataChanged = true;
          } else {
            await must(db.from('lesson_notes').insert({ id: noteId, submitted_by: profile.id, ...values }));
          }
          if (file) {
            const { error: uploadError } = await db.storage.from('lesson-notes').upload(filePath, file, {
              cacheControl: '3600', upsert: Boolean(existing), contentType: file.type,
            });
            if (uploadError) throw uploadError;
            fileUploaded = true;
          }
          if (existing) await must(db.from('lesson_notes').update({ status: 'pending', rejection_reason: null, reviewed_by: null, reviewed_at: null }).eq('id', existing.id));
          toast(existing ? 'Updated lesson note resubmitted for approval.' : 'Lesson note submitted for approval.');
          await load();
        } catch (err) {
          if (!existing) {
            await db.from('lesson_notes').delete().eq('id', noteId);
          } else if (metadataChanged && !fileUploaded) {
            const { error: rollbackError } = await db.from('lesson_notes').update(previousValues).eq('id', existing.id);
            if (rollbackError) console.error('Could not restore lesson-note metadata after a failed upload.', rollbackError);
          }
          message.replaceChildren(alertBox(errorMessage(err, 'The lesson note could not be submitted. Please try again.')));
        }
      }, existing ? 'Resubmitting...' : 'Uploading...');
    }
    function submissionForm(existing = null) {
      const classInput = selectInput('class_id', [{ value: '', label: 'Choose a class' }, ...[...new Map(assignments.map((a) => [a.class_id, { value: a.class_id, label: a.classes.name }])).values()]], { required: true, value: existing?.class_id || '' });
      const subjectInput = selectInput('subject_id', [{ value: '', label: 'Choose a subject' }, ...assignments.filter((a) => !existing || a.class_id === (existing?.class_id || classInput.value)).map((a) => ({ value: a.subject_id, label: a.subjects.name }))], { required: true, value: existing?.subject_id || '' });
      classInput.addEventListener('change', () => {
        subjectInput.replaceChildren(el('option', { value: '', text: 'Choose a subject' }), ...assignments.filter((a) => a.class_id === classInput.value).map((a) => el('option', { value: a.subject_id, text: a.subjects.name })));
      });
      const topic = el('input', { name: 'topic', maxlength: 160, required: true, value: existing?.topic || '' });
      const date = el('input', { name: 'lesson_date', type: 'date', required: true, value: existing?.lesson_date || todayStr() });
      const file = el('input', { name: 'document', type: 'file', accept: '.pdf,image/jpeg,image/png,image/webp', required: !existing });
      const message = el('div', { 'data-form-message': '', 'aria-live': 'assertive' });
      const submit = el('button', { type: 'submit', class: 'btn', text: existing ? 'Replace and resubmit' : 'Submit lesson note' });
      const form = el('form', { class: 'grid grid-2', novalidate: true },
        field('Class', classInput), field('Subject', subjectInput), field('Topic', topic), field('Lesson date', date),
        field(existing ? 'Replacement PDF or image (optional)' : 'PDF or image (max 15 MB)', file, 'Accepted: PDF, JPG, PNG, WebP.'),
        message, el('div', { class: 'btn-row' }, submit));
      form.addEventListener('submit', (event) => { event.preventDefault(); save(form, existing); });
      return form;
    }
    const unread = notifications.filter((notification) => !notification.read_at);
    const noteCard = (note, showOwnerActions) => card(note.topic,
      el('p', { text: `${note.classes?.name || 'Class'} / ${note.subjects?.name || 'Subject'} / ${formatDate(note.lesson_date)}` }),
      el('p', {}, statusBadge(note.status), note.rejection_reason ? el('span', { text: ` Reason: ${note.rejection_reason}` }) : null),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn btn-secondary', text: 'Preview / download', onclick: () => preview(note) }),
        showOwnerActions && (note.status === 'rejected' || note.status === 'pending')
          ? el('button', { type: 'button', class: 'btn btn-secondary', text: 'Remove', onclick: () => remove(note) }) : null,
        showOwnerActions && note.status === 'rejected'
          ? el('button', { type: 'button', class: 'btn', text: 'Edit / replace', onclick: () => modal('Update rejected lesson note', submissionForm(note)) }) : null));
    holder.replaceChildren(
      !sem ? alertBox('No semester is active. You can review previous notes, but new submissions require an active semester.', 'info') : null,
      card('Submit a lesson note', sem ? submissionForm() : el('p', { class: 'muted', text: 'Contact the administrator to activate a semester before submitting notes.' })),
      card(`Notifications (${unread.length} unread)`, unread.length
        ? el('ul', { class: 'list-plain' }, unread.map((notification) => el('li', {},
          el('strong', { text: notification.title }), el('p', { text: notification.message }),
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Mark read', onclick: async () => {
            try { await must(db.from('lesson_note_notifications').update({ read_at: new Date().toISOString() }).eq('id', notification.id)); await load(); }
            catch (err) { toast(errorMessage(err), 'error'); }
          } })))) : el('p', { class: 'muted', text: 'No unread lesson-note notifications.' })),
      card('Approved notes for your classes', sharedApproved.length
        ? sharedApproved.map((note) => noteCard(note, false))
        : el('p', { class: 'muted', text: 'No approved lesson notes are available for your assigned classes yet.' })),
      card('Your submissions', notes.length
        ? notes.map((note) => noteCard(note, true))
        : el('p', { class: 'muted', text: 'You have not submitted any lesson notes yet.' })));
  }
  await load();
}

// ======================================================================
// ======================================================================
const pages = { dashboard, class: classPage, attendance, performance, 'lesson-notes': lessonNotes };

(async function start() {
  const profile = await requireRole('teacher');
  if (!profile) return;
  const root = renderShell(profile, NAV);
  try {
    await pages[document.body.dataset.page](root, profile);
  } catch (err) {
    console.error(err);
    root.replaceChildren(alertBox(loadError(err)));
  }
})();
