-- =====================================================================
-- 03_functions.sql  -  server-side operations (each one is a single
-- PostgreSQL transaction: either everything succeeds or nothing changes).
-- Every function re-checks that the caller is an active administrator.
-- =====================================================================

-- ---------------------------------------------------------------------
-- How the semester summary figures are calculated (change here if the
-- school decides on a different rule):
--   * Subject rating      = average of the four ratings (understanding,
--                           participation, assignment, behaviour) across all
--                           daily entries for that subject, out of 5.
--   * Subject percentage  = subject rating / 5 x 100.
--   * Overall percentage  = average of the subject percentages (equal weight).
--   * Performance rating  = average of the subject ratings.
--   * Attendance %        = (present + late) / all recorded days x 100.
-- The MVP has no exam or test scores, so percentages come from the ratings.
-- ---------------------------------------------------------------------
create or replace function private.compute_semester_summaries(p_semester uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_year uuid;
begin
  select s.academic_year_id into v_year from public.semesters s where s.id = p_semester;

  insert into public.subject_summaries (student_id, semester_id, subject_id, percentage, rating)
  select p.student_id, p_semester, p.subject_id,
         round(avg((p.understanding + p.participation + p.assignment + p.behaviour) / 4.0) / 5 * 100, 2),
         round(avg((p.understanding + p.participation + p.assignment + p.behaviour) / 4.0), 2)
  from public.performance p
  where p.semester_id = p_semester
  group by p.student_id, p.subject_id
  on conflict (student_id, semester_id, subject_id)
  do update set percentage = excluded.percentage, rating = excluded.rating;

  insert into public.semester_summaries
         (student_id, academic_year_id, semester_id, class_id,
          attendance_percentage, overall_percentage, performance_rating)
  select e.student_id, v_year, p_semester, e.class_id,
         (select round(100.0 * count(*) filter (where a.status in ('present', 'late')) / nullif(count(*), 0), 2)
            from public.attendance a
           where a.student_id = e.student_id and a.semester_id = p_semester),
         (select round(avg(ss.percentage), 2)
            from public.subject_summaries ss
           where ss.student_id = e.student_id and ss.semester_id = p_semester),
         (select round(avg(ss.rating), 2)
            from public.subject_summaries ss
           where ss.student_id = e.student_id and ss.semester_id = p_semester)
  from public.enrollments e
  where e.academic_year_id = v_year
  on conflict (student_id, semester_id)
  do update set class_id = excluded.class_id,
                attendance_percentage = excluded.attendance_percentage,
                overall_percentage = excluded.overall_percentage,
                performance_rating = excluded.performance_rating;
end $$;

-- Removes detailed daily records that the school's retention policy allows.
-- With no retention period set, nothing is removed.
create or replace function private.purge_details(p_semester uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_days integer; v_att bigint := 0; v_perf bigint := 0;
begin
  select detail_retention_days into v_days from public.school_settings;
  if v_days is not null then
    with d as (
      delete from public.attendance
       where semester_id = p_semester and date <= private.today() - v_days
      returning 1)
    select count(*) into v_att from d;
    with d as (
      delete from public.performance
       where semester_id = p_semester and date <= private.today() - v_days
      returning 1)
    select count(*) into v_perf from d;
  end if;
  return jsonb_build_object('retention_days', v_days,
                            'attendance_deleted', v_att,
                            'performance_deleted', v_perf);
end $$;

-- ---------- Activate a planned semester ----------
create or replace function public.activate_semester(p_semester uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  perform 1 from public.semesters where id = p_semester and status = 'planned' for update;
  if not found then
    raise exception 'Only a planned semester can be activated.';
  end if;
  if exists (select 1 from public.semesters where status = 'active') then
    raise exception 'Another semester is already active. Close it first.';
  end if;
  update public.semesters set status = 'active' where id = p_semester;
end $$;

-- ---------- Step 1 of closure: calculate summaries and show what will be affected ----------
create or replace function public.prepare_semester_closure(p_semester uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.semester_status;
  v_days integer;
  v_students bigint; v_att bigint; v_perf bigint; v_pending bigint;
  v_att_eligible bigint := 0; v_perf_eligible bigint := 0;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  select status into v_status from public.semesters where id = p_semester for update;
  if not found then raise exception 'Semester not found.'; end if;
  if v_status <> 'active' then raise exception 'Only the active semester can be closed.'; end if;

  perform private.compute_semester_summaries(p_semester);
  update public.semesters set closure_prepared_at = now() where id = p_semester;

  select detail_retention_days into v_days from public.school_settings;
  select count(*) into v_students from public.semester_summaries where semester_id = p_semester;
  select count(*) into v_att  from public.attendance  where semester_id = p_semester;
  select count(*) into v_perf from public.performance where semester_id = p_semester;
  select count(*) into v_pending
    from public.attendance_corrections c join public.attendance a on a.id = c.attendance_id
   where a.semester_id = p_semester and c.status = 'pending';
  if v_days is not null then
    select count(*) into v_att_eligible  from public.attendance
     where semester_id = p_semester and date <= private.today() - v_days;
    select count(*) into v_perf_eligible from public.performance
     where semester_id = p_semester and date <= private.today() - v_days;
  end if;

  return jsonb_build_object(
    'summaries', v_students,
    'attendance_records', v_att,
    'performance_records', v_perf,
    'pending_corrections', v_pending,
    'retention_days', v_days,
    'attendance_eligible_for_cleanup', v_att_eligible,
    'performance_eligible_for_cleanup', v_perf_eligible);
end $$;

-- ---------- Step 2 of closure: one atomic transaction ----------
create or replace function public.close_semester(p_semester uuid, p_confirmation text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.semester_status; v_prepared timestamptz; v_year_name text; v_term smallint;
  v_expected text; v_pending bigint; v_purged jsonb; v_summaries bigint;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  select s.status, s.closure_prepared_at, y.name, s.term
    into v_status, v_prepared, v_year_name, v_term
    from public.semesters s join public.academic_years y on y.id = s.academic_year_id
   where s.id = p_semester for update of s;
  if not found then raise exception 'Semester not found.'; end if;
  if v_status <> 'active' then raise exception 'Only the active semester can be closed.'; end if;
  if v_prepared is null then raise exception 'Prepare the closure and review the summaries first.'; end if;

  v_expected := 'CLOSE ' || v_year_name || ' S' || v_term;
  if p_confirmation is distinct from v_expected then
    raise exception 'The confirmation text does not match.';
  end if;

  select count(*) into v_pending
    from public.attendance_corrections c join public.attendance a on a.id = c.attendance_id
   where a.semester_id = p_semester and c.status = 'pending';
  if v_pending > 0 then
    raise exception 'Decide all pending attendance corrections before closing the semester.';
  end if;

  perform private.compute_semester_summaries(p_semester);           -- final figures
  update public.semesters set status = 'closed', closed_at = now() where id = p_semester;
  v_purged := private.purge_details(p_semester);                     -- only what retention allows
  select count(*) into v_summaries from public.semester_summaries where semester_id = p_semester;

  perform private.audit_write('CLOSE semester', 'semesters', p_semester::text, null,
                              v_purged || jsonb_build_object('summaries', v_summaries));
  return v_purged || jsonb_build_object('summaries', v_summaries);
end $$;

-- ---------- Later clean-up of a closed semester (after the retention period passes) ----------
create or replace function public.purge_semester_details(p_semester uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_status public.semester_status; v_result jsonb;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  select status into v_status from public.semesters where id = p_semester;
  if not found then raise exception 'Semester not found.'; end if;
  if v_status <> 'closed' then raise exception 'Only a closed semester can be cleaned up.'; end if;
  if (select detail_retention_days from public.school_settings) is null then
    raise exception 'No retention period has been approved yet, so nothing can be removed.';
  end if;
  v_result := private.purge_details(p_semester);
  perform private.audit_write('PURGE semester details', 'semesters', p_semester::text, null, v_result);
  return v_result;
end $$;

-- ---------- Promote a class into the next academic year ----------
-- Creates NEW enrolments; the old ones stay in the student's history.
create or replace function public.promote_class(p_from_year uuid, p_from_class uuid, p_to_year uuid, p_to_class uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  if p_from_year = p_to_year then
    raise exception 'Choose a different academic year to promote into.';
  end if;
  with promoted as (
    insert into public.enrollments (student_id, class_id, academic_year_id)
    select e.student_id, p_to_class, p_to_year
      from public.enrollments e
      join public.students s on s.id = e.student_id
     where e.class_id = p_from_class and e.academic_year_id = p_from_year
       and s.status = 'active'
       and not exists (select 1 from public.enrollments x
                       where x.student_id = e.student_id and x.academic_year_id = p_to_year)
    returning 1)
  select count(*) into v_count from promoted;
  perform private.audit_write('PROMOTE class', 'enrollments', null,
                              jsonb_build_object('year', p_from_year, 'class', p_from_class),
                              jsonb_build_object('year', p_to_year, 'class', p_to_class, 'students', v_count));
  return v_count;
end $$;

-- ---------- Approve / reject an attendance correction ----------
create or replace function public.decide_attendance_correction(p_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_att uuid; v_new public.attendance_status; v_status public.correction_status;
begin
  if not private.is_admin() then
    raise exception 'Only an administrator can do this.' using errcode = '42501';
  end if;
  select attendance_id, new_status, status into v_att, v_new, v_status
    from public.attendance_corrections where id = p_id for update;
  if not found then raise exception 'Correction request not found.'; end if;
  if v_status <> 'pending' then raise exception 'This request has already been decided.'; end if;
  if p_approve then
    update public.attendance set status = v_new where id = v_att;
  end if;
  update public.attendance_corrections
     set status = case when p_approve then 'approved'::public.correction_status
                       else 'rejected'::public.correction_status end,
         decided_by = auth.uid(), decided_at = now()
   where id = p_id;
end $$;

-- ---------- Who may call these functions ----------
revoke execute on function public.activate_semester(uuid)                       from public, anon;
revoke execute on function public.prepare_semester_closure(uuid)                from public, anon;
revoke execute on function public.close_semester(uuid, text)                    from public, anon;
revoke execute on function public.purge_semester_details(uuid)                  from public, anon;
revoke execute on function public.promote_class(uuid, uuid, uuid, uuid)         from public, anon;
revoke execute on function public.decide_attendance_correction(uuid, boolean)   from public, anon;
grant  execute on function public.activate_semester(uuid)                       to authenticated;
grant  execute on function public.prepare_semester_closure(uuid)                to authenticated;
grant  execute on function public.close_semester(uuid, text)                    to authenticated;
grant  execute on function public.purge_semester_details(uuid)                  to authenticated;
grant  execute on function public.promote_class(uuid, uuid, uuid, uuid)         to authenticated;
grant  execute on function public.decide_attendance_correction(uuid, boolean)   to authenticated;
