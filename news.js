import { db, isConfigured } from './supabase.js';

const list = document.getElementById('news-list');
const status = document.getElementById('news-status');
const filters = [...document.querySelectorAll('[data-news-filter]')];
let posts = [];
let activeFilter = 'all';

function formatEventDate(date) {
  if (!date) return '';
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function renderPost(post, now) {
  const article = document.createElement('article');
  article.className = 'news-card';

  if (post.flyer_path) {
    const { data } = db.storage.from('news-flyers').getPublicUrl(post.flyer_path);
    const image = document.createElement('img');
    image.className = 'news-card-image';
    image.src = data.publicUrl;
    image.alt = `Flyer for ${post.headline}`;
    image.loading = 'lazy';
    article.append(image);
  }

  const content = document.createElement('div');
  content.className = 'news-card-content';
  const label = document.createElement('span');
  label.className = post.post_type === 'programme' ? 'news-kind news-kind-programme' : 'news-kind';
  const upcoming = isUpcomingProgramme(post, now);
  label.textContent = post.post_type === 'programme' ? (upcoming ? 'Upcoming programme' : 'Past programme') : 'School news';
  const heading = document.createElement('h3');
  heading.textContent = post.headline;
  const summary = document.createElement('p');
  summary.className = 'news-summary';
  summary.textContent = post.summary;
  content.append(label, heading, summary);

  if (post.post_type === 'programme') {
    const event = document.createElement('p');
    event.className = 'news-event';
    const dateTime = [formatEventDate(post.event_date), post.event_time?.slice(0, 5)].filter(Boolean).join(' · ');
    event.textContent = `${dateTime}${post.venue ? ` · ${post.venue}` : ''}`;
    content.append(event);
  }

  const details = document.createElement('details');
  details.className = 'news-article';
  const more = document.createElement('summary');
  more.textContent = 'Read full article';
  const body = document.createElement('p');
  body.textContent = post.body;
  details.append(more, body);
  content.append(details);
  article.append(content);
  return article;
}

function schoolDateTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return { date, time };
}

function isUpcomingProgramme(post, now) {
  if (post.post_type !== 'programme') return false;
  const eventTime = (post.event_time || '23:59').slice(0, 5);
  return post.event_date > now.date || (post.event_date === now.date && eventTime >= now.time);
}

function render() {
  const now = schoolDateTime();
  const visible = posts.filter((post) => activeFilter === 'all' || post.post_type === activeFilter);
  visible.sort((a, b) => {
    const aUpcoming = isUpcomingProgramme(a, now);
    const bUpcoming = isUpcomingProgramme(b, now);
    const rank = (post, upcoming) => post.post_type === 'programme' ? (upcoming ? 0 : 2) : 1;
    const rankDiff = rank(a, aUpcoming) - rank(b, bUpcoming);
    if (rankDiff) return rankDiff;
    if (a.post_type === 'programme' && b.post_type === 'programme') {
      const aEvent = `${a.event_date} ${(a.event_time || '').slice(0, 5)}`;
      const bEvent = `${b.event_date} ${(b.event_time || '').slice(0, 5)}`;
      return aUpcoming ? aEvent.localeCompare(bEvent) : bEvent.localeCompare(aEvent);
    }
    return new Date(b.created_at) - new Date(a.created_at);
  });

  list.replaceChildren(...visible.map((post) => renderPost(post, now)));
  status.textContent = visible.length
    ? `${visible.length} update${visible.length === 1 ? '' : 's'}`
    : activeFilter === 'programme'
      ? 'There are no programmes to show right now.'
      : activeFilter === 'news'
        ? 'There are no school news articles to show right now.'
        : 'There are no updates to show right now.';
}

for (const button of filters) {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.newsFilter;
    for (const filter of filters) {
      const selected = filter === button;
      filter.setAttribute('aria-pressed', String(selected));
      filter.classList.toggle('btn-secondary', !selected);
    }
    render();
  });
}

async function loadNews() {
  if (!isConfigured) {
    status.textContent = 'News is temporarily unavailable because the site database is not configured.';
    return;
  }

  try {
    const { data, error } = await db.from('news_posts')
      .select('id, post_type, headline, summary, body, flyer_path, event_date, event_time, venue, created_at')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    posts = data || [];
    render();
  } catch (error) {
    console.error('Could not load school news.', error);
    status.textContent = 'News could not be loaded. Please try again later.';
  }
}

loadNews();
