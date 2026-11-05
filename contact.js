// Contact form: builds an email in the visitor's own mail app. Nothing is sent to or stored by this website.
import { SCHOOL_EMAIL } from './config.js';
import { isEmail, checkText } from './validation.js';
import { alertBox } from './ui.js';

const form = document.getElementById('contact-form');
const box = document.getElementById('contact-msg');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const clean = (v) => v.replace(/[\r\n]+/g, ' ').trim();          // no line breaks in header-like fields
  const name = clean(form.elements.name.value);
  const email = clean(form.elements.email.value);
  const message = form.elements.message.value.trim();
  const problem = checkText(name, 'Your name', { max: 100 }) || (!isEmail(email) && 'Enter a valid email address.')
    || checkText(message, 'Message', { max: 1500 });
  if (problem) { box.replaceChildren(alertBox(problem)); return; }
  box.replaceChildren();
  const subject = `Website message from ${name}`;
  const body = `${message}\n\nFrom: ${name} <${email}>`;
  location.href = `mailto:${SCHOOL_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
