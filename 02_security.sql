
-- ---------- Private schema (not exposed through the Supabase API) ----------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------- Role helpers ----------
-- SECURITY DEFINER + empty search_path: safe to call inside RLS policies.
-- An account that is deactivated (is_active = false) or has no profile
-- gets NULL here and therefore no access to anything.
create or replace function private.user_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.user_role() = 'admin', false) $$;

create or replace function private.is_teacher() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.user_role() = 'teacher', false) $$;

create or replace function private.is_parent() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.user_role() = 'parent', false) $$;

-- "Today" in the school's time zone (Ghana = Africa/Accra).
create or replace function private.today() returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'Africa/Accra')::date $$;

create or replace function private.semester_closed(p_semester uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.semesters s where s.id = p_semester and s.status = 'closed') $$;

-- Parent -> only their own children.
create or replace function private.owns_student(p_student uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_parent()
     and exists (select 1 from public.students s
                 where s.id = p_student and s.parent_id = auth.uid())
$$;

-- Teacher -> only classes/subjects they are assigned to.
create or replace function private.teaches_class_in_year(p_class uuid, p_year uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher()
     and exists (select 1 from public.teacher_assignments ta
                 where ta.teacher_id = auth.uid()
                   and ta.class_id = p_class and ta.academic_year_id = p_year)
$$;

create or replace function private.teaches_class_in_semester(p_class uuid, p_semester uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher()
     and exists (select 1
                 from public.semesters s
                 join public.teacher_assignments ta on ta.academic_year_id = s.academic_year_id
                 where s.id = p_semester
                   and ta.teacher_id = auth.uid()
                   and ta.class_id = p_class)
$$;

create or replace function private.teaches_subject_in_semester(p_class uuid, p_subject uuid, p_semester uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher()
     and exists (select 1
                 from public.semesters s
                 join public.teacher_assignments ta on ta.academic_year_id = s.academic_year_id
                 where s.id = p_semester
                   and ta.teacher_id = auth.uid()
                   and ta.class_id = p_class
                   and ta.subject_id = p_subject)
$$;

create or replace function private.teacher_sees_student(p_student uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_teacher()
     and exists (select 1
                 from public.enrollments e
                 join public.teacher_assignments ta
                   on ta.class_id = e.class_id and ta.academic_year_id = e.academic_year_id
                 where e.student_id = p_student and ta.teacher_id = auth.uid())
$$;

-- ---------- Business-rule triggers ----------
-- Messages raised here are written for end users (the site shows them as-is).

create or replace function private.guard_attendance() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_year uuid;
begin
  select s.academic_year_id into v_year
  from public.semesters s where s.id = new.semester_id and s.status = 'active';
  if v_year is null then
    raise exception 'This semester is not active, so its records cannot be changed.';
  end if;
  if tg_op = 'INSERT' then
    if new.date > private.today() then
      raise exception 'Attendance cannot be recorded for a future date.';
    end if;
    if not exists (select 1
                   from public.enrollments e
                   join public.students st on st.id = e.student_id
                   where e.student_id = new.student_id and e.class_id = new.class_id
                     and e.academic_year_id = v_year and st.status = 'active') then
      raise exception 'This student is not actively enrolled in this class for the semester.';
    end if;
  end if;
  return new;
end $$;

create trigger attendance_guard before insert or update on public.attendance
  for each row execute function private.guard_attendance();

create or replace function private.guard_performance() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_year uuid;
begin
  select s.academic_year_id into v_year
  from public.semesters s where s.id = new.semester_id and s.status = 'active';
  if v_year is null then
    raise exception 'This semester is not active, so its records cannot be changed.';
  end if;
  if tg_op = 'INSERT' then
    if new.date > private.today() then
      raise exception 'Performance cannot be recorded for a future date.';
    end if;
    if not exists (select 1
                   from public.enrollments e
                   join public.students st on st.id = e.student_id
                   where e.student_id = new.student_id and e.class_id = new.class_id
                     and e.academic_year_id = v_year and st.status = 'active') then
      raise exception 'This student is not actively enrolled in this class for the semester.';
    end if;
  else
    new.updated_at := now();
  end if;
  return new;
end $$;

create trigger performance_guard before insert or update on public.performance
  for each row execute function private.guard_performance();

create or replace function private.guard_correction() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_date date; v_status public.attendance_status;
begin
  select a.date, a.status into v_date, v_status
  from public.attendance a where a.id = new.attendance_id;
  if v_date is null then
    raise exception 'Attendance record not found.';
  end if;
  if v_date >= private.today() then
    raise exception 'Today''s register can be edited directly. Requests are only for earlier days.';
  end if;
  if new.new_status = v_status then
    raise exception 'The requested status is the same as the current status.';
  end if;
  return new;
end $$;

create trigger correction_guard before insert on public.attendance_corrections
  for each row execute function private.guard_correction();

create or replace function private.guard_semester() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'closed' then
    raise exception 'A closed semester cannot be changed.';
  end if;
  if new.academic_year_id <> old.academic_year_id or new.term <> old.term then
    raise exception 'A semester cannot be moved to another year or term.';
  end if;
  if new.status <> old.status
     and not ((old.status = 'planned' and new.status = 'active')
           or (old.status = 'active'  and new.status = 'closed')) then
    raise exception 'That semester status change is not allowed.';
  end if;
  return new;
end $$;

create trigger semester_guard before update on public.semesters
  for each row execute function private.guard_semester();

create or replace function private.guard_summary() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.semesters s where s.id = old.semester_id and s.status = 'closed') then
    raise exception 'Summaries of a closed semester are final and cannot be changed.';
  end if;
  return new;
end $$;

create trigger summary_guard before update on public.semester_summaries
  for each row execute function private.guard_summary();

-- ---------- Auto-create a profile row for every new Auth user ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, role, full_name, email, is_active)
  values (
    new.id,
    'parent',
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), 'User'),
    lower(new.email),
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Audit log (written by the database, cannot be skipped by the site) ----------
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_old jsonb; v_new jsonb;
begin
  v_old := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  insert into public.audit_logs (user_id, action, target_type, target_id, old_value, new_value)
  values (auth.uid(), tg_op || ' ' || tg_table_name, tg_table_name,
          coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new);
  return null;
end $$;

create or replace function private.audit_write(p_action text, p_type text, p_target text, p_old jsonb, p_new jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_logs (user_id, action, target_type, target_id, old_value, new_value)
  values (auth.uid(), p_action, p_type, p_target, p_old, p_new)
$$;

create or replace function private.audit_immutable() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'Audit logs cannot be changed or deleted.';
end $$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function private.audit_immutable();

-- Full audit (create / change / remove) for administration tables.
create trigger audit_profiles            after insert or update or delete on public.profiles            for each row execute function private.audit_row();
create trigger audit_students            after insert or update or delete on public.students            for each row execute function private.audit_row();
create trigger audit_academic_years      after insert or update or delete on public.academic_years      for each row execute function private.audit_row();
create trigger audit_semesters           after insert or update or delete on public.semesters           for each row execute function private.audit_row();
create trigger audit_classes             after insert or update or delete on public.classes             for each row execute function private.audit_row();
create trigger audit_subjects            after insert or update or delete on public.subjects            for each row execute function private.audit_row();
create trigger audit_enrollments         after insert or update or delete on public.enrollments         for each row execute function private.audit_row();
create trigger audit_teacher_assignments after insert or update or delete on public.teacher_assignments for each row execute function private.audit_row();
create trigger audit_corrections         after insert or update or delete on public.attendance_corrections for each row execute function private.audit_row();
create trigger audit_school_settings     after update on public.school_settings for each row execute function private.audit_row();
-- Daily records: changes are audited. (First-time entries carry their own teacher_id and time;
-- bulk clean-up after retention is audited once by the closing function.)
create trigger audit_attendance          after update on public.attendance  for each row execute function private.audit_row();
create trigger audit_performance         after update on public.performance for each row execute function private.audit_row();
-- Summaries: only manual review edits (remark / promotion) are audited.
create trigger audit_summaries after update on public.semester_summaries
  for each row when (old.teacher_remark is distinct from new.teacher_remark
                  or old.promotion_status is distinct from new.promotion_status)
  execute function private.audit_row();

-- ---------- Row Level Security: enable everywhere ----------
alter table public.profiles                enable row level security;
alter table public.teachers                enable row level security;
alter table public.parents                 enable row level security;
alter table public.students                enable row level security;
alter table public.academic_years          enable row level security;
alter table public.semesters               enable row level security;
alter table public.classes                 enable row level security;
alter table public.subjects                enable row level security;
alter table public.enrollments             enable row level security;
alter table public.teacher_assignments     enable row level security;
alter table public.attendance              enable row level security;
alter table public.attendance_corrections  enable row level security;
alter table public.performance             enable row level security;
alter table public.semester_summaries      enable row level security;
alter table public.subject_summaries       enable row level security;
alter table public.audit_logs              enable row level security;
alter table public.school_settings         enable row level security;

-- ---------- Policies ----------
-- profiles: everyone reads only their own row; admin reads all and may manage
-- teacher/parent roles and active flags from the dashboard. Self-escalation is blocked.
create policy profiles_select_own   on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_select_admin on public.profiles for select to authenticated
  using (private.is_admin());
create policy profiles_insert_admin on public.profiles for insert to authenticated
  with check (private.is_admin() and id <> (select auth.uid()) and role in ('teacher', 'parent'));
create policy profiles_update_admin on public.profiles for update to authenticated
  using (private.is_admin() and id <> (select auth.uid()))
  with check (private.is_admin() and id <> (select auth.uid()) and role in ('teacher', 'parent'));

-- teachers / parents role tables: admin only
create policy teachers_select_admin on public.teachers for select to authenticated using (private.is_admin());
create policy teachers_insert_admin on public.teachers for insert to authenticated
  with check (private.is_admin() and id <> (select auth.uid()) and role = 'teacher');
create policy parents_select_admin  on public.parents  for select to authenticated using (private.is_admin());
create policy parents_insert_admin on public.parents for insert to authenticated
  with check (private.is_admin() and id <> (select auth.uid()) and role = 'parent');

-- students
create policy students_select_admin   on public.students for select to authenticated using (private.is_admin());
create policy students_select_teacher on public.students for select to authenticated using (private.teacher_sees_student(id));
create policy students_select_parent  on public.students for select to authenticated using (private.owns_student(id));
create policy students_insert_admin   on public.students for insert to authenticated with check (private.is_admin());
create policy students_update_admin   on public.students for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- reference data: any active signed-in user may read; only admin writes
create policy academic_years_select on public.academic_years for select to authenticated using (private.user_role() is not null);
create policy academic_years_insert on public.academic_years for insert to authenticated with check (private.is_admin());
create policy semesters_select      on public.semesters      for select to authenticated using (private.user_role() is not null);
create policy semesters_insert      on public.semesters      for insert to authenticated with check (private.is_admin());
create policy classes_select        on public.classes        for select to authenticated using (private.user_role() is not null);
create policy classes_insert        on public.classes        for insert to authenticated with check (private.is_admin());
create policy classes_update        on public.classes        for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy classes_delete        on public.classes        for delete to authenticated using (private.is_admin());
create policy subjects_select       on public.subjects       for select to authenticated using (private.user_role() is not null);
create policy subjects_insert       on public.subjects       for insert to authenticated with check (private.is_admin());
create policy subjects_update       on public.subjects       for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy subjects_delete       on public.subjects       for delete to authenticated using (private.is_admin());

-- enrolments
create policy enrollments_select_admin   on public.enrollments for select to authenticated using (private.is_admin());
create policy enrollments_select_teacher on public.enrollments for select to authenticated using (private.teaches_class_in_year(class_id, academic_year_id));
create policy enrollments_select_parent  on public.enrollments for select to authenticated using (private.owns_student(student_id));
create policy enrollments_insert_admin   on public.enrollments for insert to authenticated with check (private.is_admin());
create policy enrollments_update_admin   on public.enrollments for update to authenticated using (private.is_admin()) with check (private.is_admin());

-- teacher assignments
create policy assignments_select_admin   on public.teacher_assignments for select to authenticated using (private.is_admin());
create policy assignments_select_teacher on public.teacher_assignments for select to authenticated
  using (private.is_teacher() and teacher_id = (select auth.uid()));
create policy assignments_insert_admin   on public.teacher_assignments for insert to authenticated with check (private.is_admin());
create policy assignments_delete_admin   on public.teacher_assignments for delete to authenticated using (private.is_admin());

-- attendance
create policy attendance_select_admin   on public.attendance for select to authenticated using (private.is_admin());
create policy attendance_select_teacher on public.attendance for select to authenticated using (private.teaches_class_in_semester(class_id, semester_id));
create policy attendance_select_parent  on public.attendance for select to authenticated using (private.owns_student(student_id));
create policy attendance_insert_teacher on public.attendance for insert to authenticated
  with check (private.is_teacher()
              and teacher_id = (select auth.uid())
              and private.teaches_class_in_semester(class_id, semester_id)
              and date = private.today());
create policy attendance_update_teacher on public.attendance for update to authenticated
  using (private.is_teacher() and teacher_id = (select auth.uid()) and date = private.today())
  with check (private.is_teacher() and teacher_id = (select auth.uid()) and date = private.today()
              and private.teaches_class_in_semester(class_id, semester_id));
create policy attendance_update_admin   on public.attendance for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- attendance correction requests (approval only through the admin function)
create policy corrections_select_admin   on public.attendance_corrections for select to authenticated using (private.is_admin());
create policy corrections_select_teacher on public.attendance_corrections for select to authenticated
  using (private.is_teacher() and requested_by = (select auth.uid()));
create policy corrections_insert_teacher on public.attendance_corrections for insert to authenticated
  with check (private.is_teacher()
              and requested_by = (select auth.uid())
              and exists (select 1 from public.attendance a
                          where a.id = attendance_id and a.teacher_id = (select auth.uid())));

-- performance
create policy performance_select_admin   on public.performance for select to authenticated using (private.is_admin());
create policy performance_select_teacher on public.performance for select to authenticated using (private.teaches_subject_in_semester(class_id, subject_id, semester_id));
create policy performance_select_parent  on public.performance for select to authenticated using (private.owns_student(student_id));
create policy performance_insert_teacher on public.performance for insert to authenticated
  with check (private.is_teacher()
              and teacher_id = (select auth.uid())
              and private.teaches_subject_in_semester(class_id, subject_id, semester_id)
              and date = private.today());
create policy performance_update_teacher on public.performance for update to authenticated
  using (private.is_teacher() and teacher_id = (select auth.uid()) and date = private.today())
  with check (private.is_teacher() and teacher_id = (select auth.uid()) and date = private.today()
              and private.teaches_subject_in_semester(class_id, subject_id, semester_id));
create policy performance_update_admin   on public.performance for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- summaries: parents only see FINAL (closed-semester) results of their own children
create policy summaries_select_admin  on public.semester_summaries for select to authenticated using (private.is_admin());
create policy summaries_select_parent on public.semester_summaries for select to authenticated
  using (private.owns_student(student_id) and private.semester_closed(semester_id));
create policy summaries_update_admin  on public.semester_summaries for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy subject_summaries_select_admin  on public.subject_summaries for select to authenticated using (private.is_admin());
create policy subject_summaries_select_parent on public.subject_summaries for select to authenticated
  using (private.owns_student(student_id) and private.semester_closed(semester_id));

-- audit + settings: admin only
create policy audit_select_admin on public.audit_logs for select to authenticated using (private.is_admin());
create policy settings_select_admin on public.school_settings for select to authenticated using (private.is_admin());
create policy settings_update_admin on public.school_settings for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- ---------- Function privileges ----------
-- Nothing in the private schema is callable by default; only the read-only
-- helpers that RLS policies need are granted to signed-in users.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.user_role(), private.is_admin(), private.is_teacher(), private.is_parent(),
  private.today(), private.semester_closed(uuid), private.owns_student(uuid),
  private.teaches_class_in_year(uuid, uuid), private.teaches_class_in_semester(uuid, uuid),
  private.teaches_subject_in_semester(uuid, uuid, uuid), private.teacher_sees_student(uuid)
  to authenticated;

-- ---------- Table privileges (least privilege) ----------
-- Start from nothing: the anonymous (not-logged-in) role gets NO table access.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges revoke execute on functions from public;

grant select on public.profiles, public.teachers, public.parents,
                public.students, public.academic_years, public.semesters,
                public.classes, public.subjects, public.enrollments,
                public.teacher_assignments, public.attendance,
                public.attendance_corrections, public.performance,
                public.semester_summaries, public.subject_summaries,
                public.audit_logs, public.school_settings
  to authenticated;

-- Column-level write access: admin can manage teacher/parent accounts and assignments from the dashboard.
grant insert (id, role, full_name, email, is_active), update (role, full_name, is_active) on public.profiles to authenticated;
grant insert (id, role) on public.teachers to authenticated;
grant insert (id, role) on public.parents to authenticated;
grant insert (student_code, first_name, last_name, parent_id, status) on public.students  to authenticated;
grant update (first_name, last_name, parent_id, status)               on public.students  to authenticated;
grant insert (name)                                                   on public.academic_years to authenticated;
grant insert (academic_year_id, term)                                 on public.semesters to authenticated;  -- status changes only via functions
grant insert (name), update (name), delete                            on public.classes   to authenticated;
grant insert (name), update (name), delete                            on public.subjects  to authenticated;
grant insert (student_id, class_id, academic_year_id)                 on public.enrollments to authenticated;
grant update (class_id)                                               on public.enrollments to authenticated;
grant insert (teacher_id, class_id, subject_id, academic_year_id), delete on public.teacher_assignments to authenticated;
grant insert (student_id, class_id, semester_id, teacher_id, date, status) on public.attendance to authenticated;
grant update (status)                                                 on public.attendance to authenticated;
grant insert (attendance_id, requested_by, new_status, reason)        on public.attendance_corrections to authenticated;
grant insert (student_id, class_id, subject_id, semester_id, teacher_id, date,
              understanding, participation, assignment, behaviour, comment) on public.performance to authenticated;
grant update (understanding, participation, assignment, behaviour, comment)  on public.performance to authenticated;
grant update (teacher_remark, promotion_status)                       on public.semester_summaries to authenticated;
grant update (detail_retention_days)                                  on public.school_settings to authenticated;
