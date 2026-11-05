import { db, isConfigured } from './supabase.js';
import { requireRole, renderShell } from './auth.js';
import { el, field, must, pageHead, selectInput, textInput, toast, errorMessage, loadError, confirmDialog, alertBox } from './ui.js';

const NAV = [
  ['Dashboard', '/admin/dashboard.html'], ['Students', '/admin/students.html'],
  ['Teachers', '/admin/teachers.html'], ['Parents', '/admin/parents.html'],
  ['Classes', '/admin/classes.html'], ['Subjects', '/admin/subjects.html'],
  ['Academic Years', '/admin/academic-years.html'], ['Semester', '/admin/semester.html'],
  ['Corrections', '/admin/corrections.html'], ['News & programmes', '/admin/news.html'],
];
const BUCKET = 'news-flyers';
const MAX_FLYER_SIZE = 5 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'],
]);
const columns = 'id, post_type, headline, summary, body, flyer_path, event_date, event_time, venue, created_at';

function eventDate(date) {
  if (!date) return '';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

async function newsAdmin(main) {
  const message = el('div', { 'aria-live': 'assertive' });
  const listing = el('div', { class: 'news-admin-list' });
  const form = el('form', { class: 'card news-admin-form', novalidate: true });
  const kind = selectInput('post_type', [
    { value: 'news', label: 'School news' },
    { value: 'programme', label: 'Upcoming programme' },
  ], { required: true });
  const headline = textInput('headline', { maxlength: 160, required: true });
  const summary = el('textarea', { name: 'summary', maxlength: 320, required: true, rows: 3 });
  const body = el('textarea', { name: 'body', maxlength: 10000, required: true, rows: 8 });
  const eventDateInput = el('input', { name: 'event_date', type: 'date' });
  const eventTimeInput = el('input', { name: 'event_time', type: 'time' });
  const venue = textInput('venue', { maxlength: 160 });
  const flyer = el('input', { name: 'flyer', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const removeFlyer = el('input', { name: 'remove_flyer', type: 'checkbox' });
  const flyerField = field('Flyer image (optional)', flyer, 'JPEG, PNG, or WebP; maximum 5 MB.');
  const removeField = field('Remove current flyer', removeFlyer);
  const dateField = field('Event date', eventDateInput);
  const timeField = field('Event time', eventTimeInput);
  const venueField = field('Venue', venue);
  const formTitle = el('h2', { text: 'Create a post' });
  const saveButton = el('button', { type: 'submit', class: 'btn', text: 'Publish post' });
  let editing = null;
  let records = [];

  function setKindFields() {
    const programme = kind.value === 'programme';
    dateField.hidden = !programme;
    timeField.hidden = !programme;
    venueField.hidden = !programme;
    eventDateInput.required = programme;
    eventTimeInput.required = programme;
    venue.required = programme;
  }

  function resetEditor() {
    editing = null;
    form.reset();
    formTitle.textContent = 'Create a post';
    saveButton.textContent = 'Publish post';
    removeField.hidden = true;
    message.replaceChildren();
    setKindFields();
  }

  function editRecord(record) {
    editing = record;
    form.elements.post_type.value = record.post_type;
    form.elements.headline.value = record.headline;
    form.elements.summary.value = record.summary;
    form.elements.body.value = record.body;
    form.elements.event_date.value = record.event_date || '';
    form.elements.event_time.value = record.event_time?.slice(0, 5) || '';
    form.elements.venue.value = record.venue || '';
    form.elements.flyer.value = '';
    form.elements.remove_flyer.checked = false;
    formTitle.textContent = 'Edit post';
    saveButton.textContent = 'Save changes';
    removeField.hidden = !record.flyer_path;
    message.replaceChildren();
    setKindFields();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadRecords() {
    listing.replaceChildren(el('p', { class: 'muted', text: 'Loading posts…' }));
    const rows = await must(db.from('news_posts').select(columns).order('created_at', { ascending: false }).limit(200));
    records = rows || [];
    listing.replaceChildren(...records.map((record) => {
      const info = el('div', { class: 'news-admin-copy' },
        el('span', { class: record.post_type === 'programme' ? 'news-kind news-kind-programme' : 'news-kind', text: record.post_type === 'programme' ? 'Programme' : 'School news' }),
        el('h3', { text: record.headline }),
        el('p', { class: 'muted', text: record.summary }));
      if (record.post_type === 'programme') {
        info.append(el('p', { class: 'news-event', text: `${eventDate(record.event_date)} · ${record.event_time?.slice(0, 5) || ''} · ${record.venue}` }));
      }
      if (record.flyer_path) {
        const { data } = db.storage.from(BUCKET).getPublicUrl(record.flyer_path);
        info.prepend(el('img', { class: 'news-admin-image', src: data.publicUrl, alt: `Flyer for ${record.headline}`, loading: 'lazy' }));
      }
      return el('article', { class: 'news-admin-card' }, info,
        el('div', { class: 'news-admin-actions' },
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'Edit', onclick: () => editRecord(record) }),
          el('button', { type: 'button', class: 'btn btn-danger btn-sm', text: 'Delete', onclick: () => deleteRecord(record) })));
    }));
    if (!records.length) listing.replaceChildren(el('p', { class: 'muted', text: 'No posts yet. Create your first school update above.' }));
  }

  async function refreshRecords() {
    try {
      await loadRecords();
    } catch (error) {
      console.error('Could not refresh school news posts.', error);
      listing.replaceChildren(el('div', { class: 'alert alert-error' },
        loadError(error),
        ' Confirm supabase/06_news_and_programmes.sql has been run in the Supabase SQL Editor.'));
    }
  }

  async function deleteRecord(record) {
    const confirmed = await confirmDialog({
      title: 'Delete this post?',
      message: `“${record.headline}” will be removed from the public news page.`,
      confirmLabel: 'Delete post',
      danger: true,
    });
    if (!confirmed) return;

    try {
      await must(db.from('news_posts').delete().eq('id', record.id));
    } catch (error) {
      toast(errorMessage(error), 'error');
      return;
    }

    if (record.flyer_path) {
      const { error } = await db.storage.from(BUCKET).remove([record.flyer_path]);
      if (error) {
        console.error('The post was deleted, but its flyer could not be removed.', error);
        toast('The post was deleted, but its flyer could not be removed.', 'error');
      } else {
        toast('Post deleted.');
      }
    } else {
      toast('Post deleted.');
    }
    if (editing?.id === record.id) resetEditor();
    await refreshRecords();
  }

  kind.addEventListener('change', setKindFields);
  form.append(
    formTitle,
    message,
    field('Post type', kind),
    field('Headline', headline),
    field('Summary', summary),
    field('Full article', body),
    dateField,
    timeField,
    venueField,
    flyerField,
    removeField,
    el('div', { class: 'btn-row' }, saveButton,
      el('button', { type: 'button', class: 'btn btn-secondary', text: 'Clear form', onclick: resetEditor })),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.replaceChildren();
    if (!form.reportValidity()) return;
    if (!isConfigured) {
      message.replaceChildren(alertBox('The database is not configured. Posts cannot be saved.'));
      return;
    }

    const file = flyer.files[0];
    if (file && (!MIME_EXTENSIONS.has(file.type) || file.size > MAX_FLYER_SIZE)) {
      message.replaceChildren(alertBox('Choose a JPEG, PNG, or WebP image no larger than 5 MB.'));
      return;
    }

    const isProgramme = kind.value === 'programme';
    const payload = {
      post_type: kind.value,
      headline: headline.value.trim(),
      summary: summary.value.trim(),
      body: body.value.trim(),
      event_date: isProgramme ? eventDateInput.value : null,
      event_time: isProgramme ? eventTimeInput.value : null,
      venue: isProgramme ? venue.value.trim() : null,
      is_published: true,
    };
    let uploadedPath = null;
    const previousPath = editing?.flyer_path || null;

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      if (file) {
        const path = `${crypto.randomUUID()}.${MIME_EXTENSIONS.get(file.type)}`;
        const { error } = await db.storage.from(BUCKET).upload(path, file, {
          cacheControl: '3600',
          contentType: file.type,
          upsert: false,
        });
        if (error) throw error;
        uploadedPath = path;
        payload.flyer_path = uploadedPath;
      } else if (removeFlyer.checked) {
        payload.flyer_path = null;
      } else if (previousPath) {
        payload.flyer_path = previousPath;
      }

      if (editing) {
        await must(db.from('news_posts').update(payload).eq('id', editing.id));
      } else {
        await must(db.from('news_posts').insert(payload));
      }
    } catch (error) {
      let cleanupFailed = false;
      if (uploadedPath) {
        const { error: cleanupError } = await db.storage.from(BUCKET).remove([uploadedPath]);
        if (cleanupError) {
          cleanupFailed = true;
          console.error('Could not clean up an uploaded flyer after a failed save.', cleanupError);
        }
      }
      message.replaceChildren(alertBox(`${errorMessage(error)}${cleanupFailed ? ' The uploaded flyer also could not be cleaned up.' : ''}`));
      return;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = editing ? 'Save changes' : 'Publish post';
    }

    const shouldRemovePrevious = previousPath && (uploadedPath || removeFlyer.checked);
    resetEditor();
    if (shouldRemovePrevious) {
      const { error } = await db.storage.from(BUCKET).remove([previousPath]);
      if (error) {
        console.error('The post was saved, but its previous flyer could not be removed.', error);
        toast('Post saved, but the previous flyer could not be removed.', 'error');
      } else {
        toast('Post saved.');
      }
    } else {
      toast('Post saved.');
    }
    await refreshRecords();
  });

  main.replaceChildren(
    pageHead('News & programmes', el('a', { class: 'btn btn-secondary', href: '/news.html', text: 'View public page' })),
    el('p', { class: 'muted', text: 'Create and manage school announcements, full articles, event details, and flyer images.' }),
    form,
    el('section', { class: 'card' }, el('h2', { text: 'Published posts' }), listing),
  );

  setKindFields();
  await refreshRecords();
}

(async function main() {
  const profile = await requireRole('admin');
  if (!profile) return;
  const root = renderShell(profile, NAV);
  try {
    await newsAdmin(root);
  } catch (error) {
    console.error(error);
    root.replaceChildren(alertBox(loadError(error)));
  }
})();
