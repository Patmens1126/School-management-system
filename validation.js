// Client-side validation gives quick feedback. It is NOT the security boundary:
// the same rules are enforced again by CHECK constraints in the database.

export const LIMITS = { name: 100, personName: 60, className: 30, subjectName: 60, comment: 500, reason: 300 };

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(value);
}

export function isStudentCode(value) {
  return /^ST[0-9]{3,6}$/.test(value);           // e.g. ST001
}

export function isAcademicYear(value) {
  const m = /^(\d{4})\/(\d{4})$/.exec(value);
  return !!m && Number(m[2]) === Number(m[1]) + 1;   // e.g. 2026/2027
}

export function isRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Returns an error message, or null when the text is fine.
export function checkText(value, label, { min = 1, max = 100 } = {}) {
  const v = (value || '').trim();
  if (v.length < min) return min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`;
  if (v.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

// The site's Supabase Auth settings should enforce at least this too (see README).
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 72) return 'Use 72 characters or fewer.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Include a lowercase letter, an uppercase letter and a number.';
  }
  return null;
}
