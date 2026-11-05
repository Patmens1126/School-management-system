-- School Progress Management System: MVP improvements
-- Existing data is preserved. Safe to run on the existing schema.
-- Adds parent event notifications and hardens trigger-function permissions.

create table if not exists public.parent_notifications (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.parents(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  event_type text not null check (event_type in ('attendance_alert','performance_update','semester_summary','promotion','graduation')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  message text not null check (char_length(btrim(message)) between 1 and 500),
  metadata jsonb not null default '{}'::jsonb,
  related_record_id uuid not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint parent_notifications_deduplicate unique (parent_id, student_id, event_type, related_record_id)
);
create index if not exists parent_notifications_parent_created_idx on public.parent_notifications(parent_id, created_at desc);
create index if not exists parent_notifications_unread_idx on public.parent_notifications(parent_id, created_at desc) where read_at is null;
alter table public.parent_notifications enable row level security;
revoke all on table public.parent_notifications from anon, public;
grant select, update (read_at) on table public.parent_notifications to authenticated;
drop policy if exists parent_notifications_select_own on public.parent_notifications;
create policy parent_notifications_select_own on public.parent_notifications for select to authenticated
  using (parent_id = (select auth.uid()) or private.is_admin());
drop policy if exists parent_notifications_mark_own_read on public.parent_notifications;
create policy parent_notifications_mark_own_read on public.parent_notifications for update to authenticated
  using (parent_id = (select auth.uid()) and private.is_parent())
  with check (parent_id = (select auth.uid()) and private.is_parent());

-- Absent/late attendance alerts. The trigger is the only notification writer.
create or replace function private.notify_parent_attendance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_parent_id uuid; v_name text;
begin
  if new.status not in ('absent'::public.attendance_status, 'late'::public.attendance_status) then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  select s.parent_id, trim(s.first_name || ' ' || s.last_name) into v_parent_id, v_name from public.students s where s.id = new.student_id;
  if v_parent_id is not null then
    insert into public.parent_notifications(parent_id, student_id, event_type, title, message, related_record_id, metadata)
    values (v_parent_id, new.student_id, 'attendance_alert',
      case when new.status = 'absent'::public.attendance_status then 'Attendance alert' else 'Late arrival recorded' end,
      coalesce(v_name, 'Your child') || case when new.status = 'absent'::public.attendance_status then ' was marked absent on ' else ' was marked late on ' end || to_char(new.date, 'FMDD Mon YYYY') || '.',
      new.id, jsonb_build_object('attendance_id', new.id, 'date', new.date, 'status', new.status))
    on conflict (parent_id, student_id, event_type, related_record_id) do update set title=excluded.title, message=excluded.message, metadata=excluded.metadata, created_at=now(), read_at=null;
  end if;
  return new;
end; $$;
revoke all on function private.notify_parent_attendance() from public, anon, authenticated;
drop trigger if exists parent_notification_attendance on public.attendance;
create trigger parent_notification_attendance after insert or update of status on public.attendance for each row execute function private.notify_parent_attendance();

-- New or updated daily ratings.
create or replace function private.notify_parent_performance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_parent_id uuid; v_student_name text; v_subject_name text; v_average numeric(3,2);
begin
  select st.parent_id, trim(st.first_name || ' ' || st.last_name) into v_parent_id, v_student_name from public.students st where st.id=new.student_id;
  if v_parent_id is null then return new; end if;
  select sb.name into v_subject_name from public.subjects sb where sb.id=new.subject_id;
  v_average := round((new.understanding + new.participation + new.assignment + new.behaviour)::numeric / 4, 2);
  insert into public.parent_notifications(parent_id, student_id, event_type, title, message, related_record_id, metadata)
  values (v_parent_id, new.student_id, 'performance_update', 'New student performance update',
    coalesce(v_student_name, 'Your child') || ' received a ' || v_average::text || '/5 performance rating in ' || coalesce(v_subject_name, 'a subject') || ' on ' || to_char(new.date, 'FMDD Mon YYYY') || '.',
    new.id, jsonb_build_object('performance_id',new.id,'subject_id',new.subject_id,'subject',v_subject_name,'date',new.date,'average_rating',v_average))
  on conflict (parent_id, student_id, event_type, related_record_id) do update set title=excluded.title, message=excluded.message, metadata=excluded.metadata, created_at=now(), read_at=null;
  return new;
end; $$;
revoke all on function private.notify_parent_performance() from public, anon, authenticated;
drop trigger if exists parent_notification_performance on public.performance;
create trigger parent_notification_performance after insert or update of understanding, participation, assignment, behaviour, comment on public.performance for each row execute function private.notify_parent_performance();

-- Semester notifications are issued only once the administrator closes the semester.
create or replace function private.notify_parent_semester_closed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_summary record; v_parent_id uuid; v_student_name text;
begin
  if new.status <> 'closed'::public.semester_status or old.status = 'closed'::public.semester_status then return new; end if;
  for v_summary in select ss.id, ss.student_id, ss.semester_id, ss.academic_year_id from public.semester_summaries ss where ss.semester_id=new.id loop
    select st.parent_id, trim(st.first_name || ' ' || st.last_name) into v_parent_id, v_student_name from public.students st where st.id=v_summary.student_id;
    if v_parent_id is not null then
      insert into public.parent_notifications(parent_id, student_id, event_type, title, message, related_record_id, metadata)
      select v_parent_id, v_summary.student_id, 'semester_summary', 'Semester progress summary available',
        coalesce(v_student_name,'Your child') || '''s Semester ' || new.term::text || ' summary for ' || ay.name || ' is now available.',
        v_summary.id, jsonb_build_object('summary_id',v_summary.id,'semester_id',v_summary.semester_id,'academic_year_id',v_summary.academic_year_id)
      from public.academic_years ay where ay.id=new.academic_year_id
      on conflict (parent_id, student_id, event_type, related_record_id) do update set title=excluded.title, message=excluded.message, metadata=excluded.metadata, created_at=now(), read_at=null;
    end if;
  end loop;
  return new;
end; $$;
revoke all on function private.notify_parent_semester_closed() from public, anon, authenticated;
drop trigger if exists parent_notification_semester_summary on public.semester_summaries;
drop function if exists private.notify_parent_semester_summary();
drop trigger if exists parent_notification_semester_closed on public.semesters;
create trigger parent_notification_semester_closed after update of status on public.semesters for each row execute function private.notify_parent_semester_closed();

-- Parent updates when a student gets a new academic-year enrollment (promotion/repetition).
create or replace function private.notify_parent_enrollment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_parent_id uuid; v_student_name text; v_class_name text; v_year_name text;
begin
  if not exists (select 1 from public.enrollments e where e.student_id=new.student_id and e.id<>new.id) then return new; end if;
  select st.parent_id, trim(st.first_name || ' ' || st.last_name), c.name, ay.name into v_parent_id, v_student_name, v_class_name, v_year_name
  from public.students st join public.classes c on c.id=new.class_id join public.academic_years ay on ay.id=new.academic_year_id where st.id=new.student_id;
  if v_parent_id is not null then
    insert into public.parent_notifications(parent_id, student_id, event_type, title, message, related_record_id, metadata)
    values (v_parent_id,new.student_id,'promotion','Student progression update',coalesce(v_student_name,'Your child') || ' has been enrolled in ' || coalesce(v_class_name,'a class') || ' for ' || coalesce(v_year_name,'the new academic year') || '.',new.id,
      jsonb_build_object('enrollment_id',new.id,'class_id',new.class_id,'class_name',v_class_name,'academic_year_id',new.academic_year_id,'academic_year',v_year_name))
    on conflict (parent_id, student_id, event_type, related_record_id) do update set title=excluded.title, message=excluded.message, metadata=excluded.metadata, created_at=now(), read_at=null;
  end if;
  return new;
end; $$;
revoke all on function private.notify_parent_enrollment() from public, anon, authenticated;
drop trigger if exists parent_notification_enrollment on public.enrollments;
create trigger parent_notification_enrollment after insert on public.enrollments for each row execute function private.notify_parent_enrollment();

-- Graduation update when an administrator graduates a final-year student.
create or replace function private.notify_parent_graduation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'graduated'::public.student_status or old.status = 'graduated'::public.student_status then return new; end if;
  if new.parent_id is not null then
    insert into public.parent_notifications(parent_id, student_id, event_type, title, message, related_record_id, metadata)
    values (new.parent_id,new.id,'graduation','Graduation update',trim(new.first_name || ' ' || new.last_name) || ' has been marked as graduated. Congratulations on completing the school programme!',new.id,jsonb_build_object('student_id',new.id,'status',new.status))
    on conflict (parent_id, student_id, event_type, related_record_id) do update set title=excluded.title, message=excluded.message, metadata=excluded.metadata, created_at=now(), read_at=null;
  end if;
  return new;
end; $$;
revoke all on function private.notify_parent_graduation() from public, anon, authenticated;
drop trigger if exists parent_notification_graduation on public.students;
create trigger parent_notification_graduation after update of status on public.students for each row execute function private.notify_parent_graduation();

-- Harden existing trigger functions flagged by the security advisor.
alter function public.create_role_record() set search_path = '';
revoke all on function public.create_role_record() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at = pg_catalog.now(); return new; end; $$;
revoke all on function public.set_updated_at() from public, anon, authenticated;
