// =====================================================================
// config.js - the ONLY file you need to edit before deploying.
//
// SUPABASE_ANON_KEY is the *public* "anon" key (Project Settings -> API).
// It is designed to be visible in the browser; the database's Row Level
// Security is what protects the data.
//
// NEVER put the "service_role" key in this file or anywhere in the website.
// =====================================================================

export const SUPABASE_URL = 'https://npqnpmjwnkbgybkrlkqj.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_XjXqnp33-hQm_Urxq4_4QQ_rr-uogGy';

export const SCHOOL_NAME = 'Staronic';
export const SCHOOL_EMAIL = 'staronicschool09@gmail.com';   // where the contact form opens an email to

// Must match the time zone used inside the database (private.today() in 02_security.sql).
export const SCHOOL_TIMEZONE = 'Africa/Accra';

// Signed-in users are logged out after this many minutes without activity.
export const IDLE_TIMEOUT_MINUTES = 30;
