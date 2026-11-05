-- =====================================================================
-- School Progress Management System
-- 01_schema.sql  -  tables, types and data-integrity constraints
-- Run order: 01_schema.sql -> 02_security.sql -> 03_functions.sql
-- Security (RLS, grants, triggers, audit) is in 02_security.sql.
-- =====================================================================

-- ---------- Enumerated types ----------
create type public.app_role          as enum ('admin', 'teacher', 'parent');
create type public.student_status    as enum ('active', 'inactive', 'graduated', 'transferred');
create type public.semester_status   as enum ('planned', 'active', 'closed');
create type public.attendance_status as enum ('present', 'absent', 'late');
create type public.correction_status as enum ('pending', 'approved', 'rejected');
create type public.promotion_status  as enum ('pending', 'promoted', 'repeated', 'graduated');

-- ---------- Accounts ----------
-- One profile per Supabase Auth identity. The role lives here (NOT in
-- user-editable metadata) and can only be set by the server-side function.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.app_role not null,
  full_name  text not null check (char_length(btrim(full_name)) between 1 and 100),
  email      text not null check (email = lower(email) and char_length(email) <= 254),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, role)
);
create unique index profiles_email_key on public.profiles (email);

-- Role tables. The composite foreign key guarantees that only a profile with
-- role 'teacher' can be a teacher, and only 'parent' can be a parent.
create table public.teachers (
  id         uuid primary key,
  role       public.app_role not null default 'teacher' check (role = 'teacher'),
  created_at timestamptz not null default now(),
  foreign key (id, role) references public.profiles (id, role) on delete cascade
);

create table public.parents (
  id         uuid primary key,
  role       public.app_role not null default 'parent' check (role = 'parent'),
  created_at timestamptz not null default now(),
  foreign key (id, role) references public.profiles (id, role) on delete cascade
);

-- ---------- Students (minimal data only) ----------
create sequence public.student_code_seq minvalue 1 maxvalue 999999;

create table public.students (
  id           uuid primary key default gen_random_uuid(),
  student_code text not null unique default ('ST' || lpad(nextval('public.student_code_seq')::text, 3, '0'))
               check (student_code ~ '^ST[0-9]{3,6}$'),
  first_name   text not null check (char_length(btrim(first_name)) between 1 and 60),
  last_name    text not null check (char_length(btrim(last_name)) between 1 and 60),
  parent_id    uuid references public.parents (id) on delete restrict,
  status       public.student_status not null default 'active',
  created_at   timestamptz not null default now()
);
create index students_parent_idx on public.students (parent_id);

-- ---------- Academic structure ----------
create table public.academic_years (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (case when name ~ '^[0-9]{4}/[0-9]{4}$'
                    then substr(name, 6, 4)::int = substr(name, 1, 4)::int + 1
                    else false end),
  created_at timestamptz not null default now()
);

create table public.semesters (
  id                   uuid primary key default gen_random_uuid(),
  academic_year_id     uuid not null references public.academic_years (id) on delete restrict,
  term                 smallint not null check (term in (1, 2)),
  status               public.semester_status not null default 'planned',
  closure_prepared_at  timestamptz,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  unique (academic_year_id, term)
);
-- Only one semester may be active at any time.
create unique index one_active_semester on public.semesters ((true)) where status = 'active';

create table public.classes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(btrim(name)) between 1 and 30),
  created_at timestamptz not null default now()
);

create table public.subjects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);

-- A student's class is NOT stored on the student. Each academic year gets its
-- own enrolment row, so JHS 1 -> JHS 2 -> JHS 3 history is preserved.
create table public.enrollments (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.students (id) on delete restrict,
  class_id         uuid not null references public.classes (id) on delete restrict,
  academic_year_id uuid not null references public.academic_years (id) on delete restrict,
  created_at       timestamptz not null default now(),
  unique (student_id, academic_year_id)
);
create index enrollments_class_year_idx on public.enrollments (class_id, academic_year_id);

create table public.teacher_assignments (
  id               uuid primary key default gen_random_uuid(),
  teacher_id       uuid not null references public.teachers (id) on delete restrict,
  class_id         uuid not null references public.classes (id) on delete restrict,
  subject_id       uuid not null references public.subjects (id) on delete restrict,
  academic_year_id uuid not null references public.academic_years (id) on delete restrict,
  created_at       timestamptz not null default now(),
  unique (teacher_id, class_id, subject_id, academic_year_id)
);
create index teacher_assignments_teacher_idx on public.teacher_assignments (teacher_id, academic_year_id);

-- ---------- Daily records ----------
create table public.attendance (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students (id) on delete restrict,
  class_id    uuid not null references public.classes (id) on delete restrict,
  semester_id uuid not null references public.semesters (id) on delete restrict,
  teacher_id  uuid not null references public.teachers (id) on delete restrict,
  date        date not null,
  status      public.attendance_status not null,
  marked_at   timestamptz not null default now(),
  -- Duplicate protection enforced by the database, not by JavaScript.
  constraint attendance_one_record_per_day unique (student_id, class_id, semester_id, date)
);
create index attendance_class_date_idx on public.attendance (class_id, date);
create index attendance_semester_idx   on public.attendance (semester_id);

create table public.attendance_corrections (
  id            uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance (id) on delete cascade,
  requested_by  uuid not null references public.teachers (id) on delete restrict,
  new_status    public.attendance_status not null,
  reason        text not null check (char_length(btrim(reason)) between 5 and 300),
  status        public.correction_status not null default 'pending',
  decided_by    uuid references public.profiles (id) on delete restrict,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create unique index one_pending_correction_per_record
  on public.attendance_corrections (attendance_id) where status = 'pending';

create table public.performance (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.students (id) on delete restrict,
  class_id      uuid not null references public.classes (id) on delete restrict,
  subject_id    uuid not null references public.subjects (id) on delete restrict,
  semester_id   uuid not null references public.semesters (id) on delete restrict,
  teacher_id    uuid not null references public.teachers (id) on delete restrict,
  date          date not null,
  understanding smallint not null check (understanding between 1 and 5),
  participation smallint not null check (participation between 1 and 5),
  assignment    smallint not null check (assignment between 1 and 5),
  behaviour     smallint not null check (behaviour between 1 and 5),
  comment       text check (comment is null or char_length(comment) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (student_id, subject_id, semester_id, date)
);
create index performance_class_date_idx on public.performance (class_id, subject_id, date);
create index performance_semester_idx   on public.performance (semester_id);
create index performance_student_idx    on public.performance (student_id, date);

-- ---------- Long-term history (kept after detailed records are cleaned) ----------
create table public.semester_summaries (
  id                    uuid primary key default gen_random_uuid(),
  student_id            uuid not null references public.students (id) on delete restrict,
  academic_year_id      uuid not null references public.academic_years (id) on delete restrict,
  semester_id           uuid not null references public.semesters (id) on delete restrict,
  class_id              uuid not null references public.classes (id) on delete restrict,
  attendance_percentage numeric(5,2) check (attendance_percentage between 0 and 100),
  overall_percentage    numeric(5,2) check (overall_percentage between 0 and 100),
  performance_rating    numeric(3,2) check (performance_rating between 0 and 5),
  teacher_remark        text check (teacher_remark is null or char_length(teacher_remark) <= 500),
  promotion_status      public.promotion_status not null default 'pending',
  created_at            timestamptz not null default now(),
  unique (student_id, semester_id)
);
create index semester_summaries_student_idx on public.semester_summaries (student_id);

create table public.subject_summaries (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students (id) on delete restrict,
  semester_id uuid not null references public.semesters (id) on delete restrict,
  subject_id  uuid not null references public.subjects (id) on delete restrict,
  percentage  numeric(5,2) check (percentage between 0 and 100),
  rating      numeric(3,2) check (rating between 0 and 5),
  created_at  timestamptz not null default now(),
  unique (student_id, semester_id, subject_id)
);

-- ---------- Accountability ----------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid,
  action      text not null,
  target_type text not null,
  target_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- ---------- School settings (single row) ----------
-- detail_retention_days is deliberately NULL until the school approves a
-- retention period. While it is NULL, nothing is ever deleted.
create table public.school_settings (
  id                    boolean primary key default true check (id),
  detail_retention_days integer check (detail_retention_days is null or detail_retention_days >= 0),
  updated_at            timestamptz not null default now()
);
insert into public.school_settings (id) values (true);
