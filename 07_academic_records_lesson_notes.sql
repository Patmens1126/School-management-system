-- Academic records export needs no schema changes. Lesson notes use a private
-- Storage bucket, role-scoped records, and database-owned notifications.
-- Run after 02_security.sql and the existing schema migrations.

create table if not exists public.lesson_notes (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references public.teachers(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  semester_id uuid not null references public.semesters(id) on delete restrict,
  lesson_date date not null,
  topic text not null check (char_length(btrim(topic)) between 1 and 160),
  file_path text not null unique check (file_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  file_mime_type text not null check (file_mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  file_size integer not null check (file_size between 1 and 15728640),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text check (rejection_reason is null or char_length(btrim(rejection_reason)) between 5 and 500),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lesson_notes_teacher_created_idx on public.lesson_notes(submitted_by, created_at desc);
create index if not exists lesson_notes_pending_idx on public.lesson_notes(created_at desc) where status = 'pending';
alter table public.lesson_notes enable row level security;
revoke all on table public.lesson_notes from anon, public, authenticated;
grant select on public.lesson_notes to authenticated;
grant insert (id, submitted_by, class_id, subject_id, semester_id, lesson_date, topic, file_path, file_mime_type, file_size)
  on public.lesson_notes to authenticated;
grant update (class_id, subject_id, semester_id, lesson_date, topic, file_path, file_mime_type, file_size, status, rejection_reason, reviewed_by, reviewed_at)
  on public.lesson_notes to authenticated;
grant delete on public.lesson_notes to authenticated;

drop policy if exists lesson_notes_select_admin on public.lesson_notes;
create policy lesson_notes_select_admin on public.lesson_notes for select to authenticated
  using (private.is_admin());
drop policy if exists lesson_notes_select_owner on public.lesson_notes;
create policy lesson_notes_select_owner on public.lesson_notes for select to authenticated
  using (private.is_teacher() and submitted_by = (select auth.uid()));
drop policy if exists lesson_notes_select_approved_assignment on public.lesson_notes;
create policy lesson_notes_select_approved_assignment on public.lesson_notes for select to authenticated
  using (private.is_teacher() and status = 'approved'
    and private.teaches_subject_in_semester(class_id, subject_id, semester_id));
drop policy if exists lesson_notes_insert_owner on public.lesson_notes;
create policy lesson_notes_insert_owner on public.lesson_notes for insert to authenticated
  with check (
    private.is_teacher()
    and submitted_by = (select auth.uid())
    and status = 'pending'
    and private.teaches_subject_in_semester(class_id, subject_id, semester_id)
    and split_part(file_path, '/', 1) = (select auth.uid())::text
    and split_part(file_path, '/', 2) = id::text
  );
drop policy if exists lesson_notes_update_rejected_owner on public.lesson_notes;
create policy lesson_notes_update_rejected_owner on public.lesson_notes for update to authenticated
  using (private.is_teacher() and submitted_by = (select auth.uid()) and status = 'rejected')
  with check (
    private.is_teacher()
    and submitted_by = (select auth.uid())
    and status in ('rejected', 'pending')
    and private.teaches_subject_in_semester(class_id, subject_id, semester_id)
    and split_part(file_path, '/', 1) = (select auth.uid())::text
    and split_part(file_path, '/', 2) = id::text
  );
drop policy if exists lesson_notes_delete_owner on public.lesson_notes;
create policy lesson_notes_delete_owner on public.lesson_notes for delete to authenticated
  using (private.is_teacher() and submitted_by = (select auth.uid()) and status in ('pending', 'rejected'));

create table if not exists public.lesson_note_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  lesson_note_id uuid not null references public.lesson_notes(id) on delete cascade,
  event_type text not null check (event_type in ('pending', 'approved', 'rejected')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  message text not null check (char_length(btrim(message)) between 1 and 500),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (recipient_id, lesson_note_id, event_type)
);
create index if not exists lesson_note_notifications_recipient_idx
  on public.lesson_note_notifications(recipient_id, created_at desc);
alter table public.lesson_note_notifications enable row level security;
revoke all on table public.lesson_note_notifications from anon, public, authenticated;
grant select on public.lesson_note_notifications to authenticated;
grant update (read_at) on public.lesson_note_notifications to authenticated;
drop policy if exists lesson_note_notifications_select_recipient on public.lesson_note_notifications;
create policy lesson_note_notifications_select_recipient on public.lesson_note_notifications for select to authenticated
  using (recipient_id = (select auth.uid()) and private.user_role() is not null);
drop policy if exists lesson_note_notifications_read_recipient on public.lesson_note_notifications;
create policy lesson_note_notifications_read_recipient on public.lesson_note_notifications for update to authenticated
  using (recipient_id = (select auth.uid()) and private.user_role() is not null)
  with check (recipient_id = (select auth.uid()) and private.user_role() is not null);

create or replace function private.guard_lesson_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not private.is_teacher() or new.submitted_by <> auth.uid() or new.status <> 'pending'
       or new.reviewed_by is not null or new.reviewed_at is not null
       or not private.teaches_subject_in_semester(new.class_id, new.subject_id, new.semester_id)
       or split_part(new.file_path, '/', 1) <> auth.uid()::text
       or split_part(new.file_path, '/', 2) <> new.id::text then
      raise exception 'You can only submit lesson notes for a class and subject assigned to you.';
    end if;
  elsif private.is_admin() then
    if old.status <> 'pending' or new.status not in ('approved', 'rejected')
       or new.reviewed_by <> auth.uid() or new.reviewed_at is null then
      raise exception 'Only pending lesson notes can be reviewed.';
    end if;
  elsif private.is_teacher() then
     if old.status <> 'rejected'
       or new.status not in ('rejected', 'pending')
       or old.submitted_by <> auth.uid() or new.submitted_by <> old.submitted_by
       or (new.status = 'pending' and (new.reviewed_by is not null or new.reviewed_at is not null or new.rejection_reason is not null))
       or (new.status = 'rejected' and (new.reviewed_by is distinct from old.reviewed_by
         or new.reviewed_at is distinct from old.reviewed_at or new.rejection_reason is distinct from old.rejection_reason))
       or not private.teaches_subject_in_semester(new.class_id, new.subject_id, new.semester_id)
       or split_part(new.file_path, '/', 1) <> auth.uid()::text
       or split_part(new.file_path, '/', 2) <> new.id::text then
      raise exception 'Only your rejected lesson notes can be edited and resubmitted.';
    end if;
  else
    raise exception 'You do not have permission to change this lesson note.';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.guard_lesson_note() from public, anon, authenticated;
drop trigger if exists lesson_notes_guard on public.lesson_notes;
create trigger lesson_notes_guard before insert or update on public.lesson_notes
  for each row execute function private.guard_lesson_note();

create or replace function private.notify_lesson_note() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_class text; v_subject text;
begin
  select p.full_name into v_name from public.profiles p where p.id = new.submitted_by;
  select c.name, s.name into v_class, v_subject
    from public.classes c cross join public.subjects s
    where c.id = new.class_id and s.id = new.subject_id;

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'pending') then
    insert into public.lesson_note_notifications(recipient_id, lesson_note_id, event_type, title, message)
      select p.id, new.id, 'pending', 'Lesson note awaiting review',
        coalesce(v_name, 'A teacher') || ' submitted "' || new.topic || '" for ' || coalesce(v_class, 'a class') || ' / ' || coalesce(v_subject, 'a subject') || '.'
      from public.profiles p where p.role = 'admin' and p.is_active
    on conflict (recipient_id, lesson_note_id, event_type) do update
      set title = excluded.title, message = excluded.message, created_at = now(), read_at = null;
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'rejected') then
    insert into public.lesson_note_notifications(recipient_id, lesson_note_id, event_type, title, message)
    values (
      new.submitted_by, new.id, new.status,
      case when new.status = 'approved' then 'Lesson note approved' else 'Lesson note needs changes' end,
      case when new.status = 'approved'
        then 'Your lesson note "' || new.topic || '" is approved and available for teaching.'
        else 'Your lesson note "' || new.topic || '" was rejected. Reason: ' || coalesce(new.rejection_reason, 'No reason provided.') end
    )
    on conflict (recipient_id, lesson_note_id, event_type) do update
      set title = excluded.title, message = excluded.message, created_at = now(), read_at = null;
  end if;
  return new;
end $$;
revoke all on function private.notify_lesson_note() from public, anon, authenticated;
drop trigger if exists lesson_notes_notify on public.lesson_notes;
create trigger lesson_notes_notify after insert or update of status on public.lesson_notes
  for each row execute function private.notify_lesson_note();

drop trigger if exists audit_lesson_notes on public.lesson_notes;
create trigger audit_lesson_notes after insert or update on public.lesson_notes
  for each row execute function private.audit_row();

create or replace function public.decide_lesson_note(p_id uuid, p_decision text, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'Only an administrator can review lesson notes.'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Choose approve or reject.'; end if;
  if p_decision = 'rejected' and (p_reason is null or char_length(btrim(p_reason)) not between 5 and 500) then
    raise exception 'A rejection reason between 5 and 500 characters is required.';
  end if;
  update public.lesson_notes
    set status = p_decision,
        rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) else null end,
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where id = p_id and status = 'pending';
  if not found then raise exception 'This lesson note is no longer waiting for review.'; end if;
end $$;
revoke all on function public.decide_lesson_note(uuid, text, text) from public, anon;
grant execute on function public.decide_lesson_note(uuid, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lesson-notes', 'lesson-notes', false, 15728640,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 15728640,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists lesson_note_objects_read on storage.objects;
create policy lesson_note_objects_read on storage.objects for select to authenticated
  using (
    bucket_id = 'lesson-notes'
    and (private.is_admin() or exists (
      select 1 from public.lesson_notes n
      where n.file_path = name
        and (n.submitted_by = (select auth.uid())
          or (n.status = 'approved' and private.teaches_subject_in_semester(n.class_id, n.subject_id, n.semester_id)))
    ))
  );
drop policy if exists lesson_note_objects_insert on storage.objects;
create policy lesson_note_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'lesson-notes'
    and private.is_teacher()
    and split_part(name, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.lesson_notes n
      where n.file_path = name and n.submitted_by = (select auth.uid()) and n.status in ('pending', 'rejected'))
  );
drop policy if exists lesson_note_objects_update on storage.objects;
create policy lesson_note_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = 'lesson-notes'
    and private.is_teacher()
    and split_part(name, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.lesson_notes n
      where n.file_path = name and n.submitted_by = (select auth.uid()) and n.status = 'rejected')
  )
  with check (
    bucket_id = 'lesson-notes'
    and private.is_teacher()
    and split_part(name, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.lesson_notes n
      where n.file_path = name and n.submitted_by = (select auth.uid()) and n.status = 'rejected')
  );
drop policy if exists lesson_note_objects_delete on storage.objects;
create policy lesson_note_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'lesson-notes'
    and private.is_teacher()
    and split_part(name, '/', 1) = (select auth.uid())::text
    and exists (select 1 from public.lesson_notes n
      where n.file_path = name and n.submitted_by = (select auth.uid()) and n.status in ('pending', 'rejected'))
  );