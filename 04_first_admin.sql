-- =====================================================================
-- 04_first_admin.sql  -  create the FIRST administrator (run once)
--
-- Nobody can register as an admin from the website. The first admin is
-- created by you, here, in two steps:
--
-- Step 1. Supabase dashboard -> Authentication -> Users -> "Add user"
--         -> "Create new user". Enter the admin's email and a strong
--         password and tick "Auto Confirm User".
--
-- Step 2. Replace the two values below, then run this script in the SQL Editor.
--         (Email must match Step 1 exactly. Keep it lower-case.)
--
-- Further teacher and parent accounts are then created from the Admin
-- pages of the website. Additional ADMINS are created the same way as this one.
-- =====================================================================
with new_admin as (
  select id, lower(email) as email
  from auth.users
  where lower(email) = lower('admin@staronic.edu.gh')
)
insert into public.profiles (id, role, full_name, email, is_active)
select id, 'admin', 'STARONIC School Administrator', email, true
from new_admin
on conflict (id) do update
set role = 'admin',
    full_name = 'STARONIC School Administrator',
    email = excluded.email,
    is_active = true;

-- Check: this should return exactly one active admin row.
select id, role, full_name, email, is_active
from public.profiles
where role = 'admin' and is_active = true;
