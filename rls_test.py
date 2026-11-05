# RLS / security test-suite for the school database. See README, section "Testing".
import subprocess, uuid, sys, json

# Runs against a THROWAWAY local PostgreSQL database (never your real Supabase project).
# Set PSQL to your connection command, e.g.  PSQL="psql -U postgres"  (default below).
import os, shlex
DB = os.environ.get("TEST_DB", "schooltest")
PSQL = shlex.split(os.environ.get("PSQL", "psql"))
def psql(sql):
    p = subprocess.run(PSQL + ["-X", "-A", "-t", "-q", "-d", DB, "-v", "ON_ERROR_STOP=0", "-f", "-"],
                       input=sql, capture_output=True, text=True)
    return (p.stdout.strip(), p.stderr.strip())

def run(uid, sql, commit=False, role="authenticated"):
    pre = f"begin; set local role {role}; select set_config('request.jwt.claim.sub', '{uid or ''}', true);"
    post = "commit;" if commit else "rollback;"
    out, err = psql(pre + "\n" + sql + "\n" + post)
    # drop the set_config echo line
    lines = [l for l in out.splitlines() if l and l != (uid or '')]
    return "\n".join(lines), err

def admin_sql(sql):
    out, err = psql(sql)
    if err: print("SETUP ERROR:", err); sys.exit(1)
    return out

fails = 0
def check(name, cond, detail=""):
    global fails
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"   -> {detail}"))
    if not cond: fails += 1

U = {k: str(uuid.uuid4()) for k in ["admin","t1","t2","t3","p1","p2","x","admin2"]}
ids = {k: str(uuid.uuid4()) for k in ["y","sem","c2a","c2b","math","eng","s1","s2","s3"]}

# ---------------- setup (as superuser, bypasses RLS) ----------------
admin_sql(f"""
insert into auth.users(id,email) values
 ('{U['admin']}','admin@x.test'),('{U['admin2']}','admin2@x.test'),('{U['t1']}','t1@x.test'),('{U['t2']}','t2@x.test'),('{U['t3']}','t3@x.test'),
 ('{U['p1']}','p1@x.test'),('{U['p2']}','p2@x.test'),('{U['x']}','x@x.test');
insert into profiles(id,role,full_name,email,is_active) values
 ('{U['admin']}','admin','Admin One','admin@x.test',true),
 ('{U['admin2']}','admin','Admin Two','admin2@x.test',true),
 ('{U['t1']}','teacher','Teacher One','t1@x.test',true),
 ('{U['t2']}','teacher','Teacher Two','t2@x.test',true),
 ('{U['t3']}','teacher','Teacher Three','t3@x.test',false),
 ('{U['p1']}','parent','Parent One','p1@x.test',true),
 ('{U['p2']}','parent','Parent Two','p2@x.test',true);
insert into teachers(id) values ('{U['t1']}'),('{U['t2']}'),('{U['t3']}');
insert into parents(id) values ('{U['p1']}'),('{U['p2']}');
insert into academic_years(id,name) values ('{ids['y']}','2026/2027');
insert into semesters(id,academic_year_id,term,status) values ('{ids['sem']}','{ids['y']}',1,'active');
insert into classes(id,name) values ('{ids['c2a']}','JHS 2A'),('{ids['c2b']}','JHS 2B');
insert into subjects(id,name) values ('{ids['math']}','Mathematics'),('{ids['eng']}','English');
insert into students(id,student_code,first_name,last_name,parent_id) values
 ('{ids['s1']}','ST001','John','Mensah','{U['p1']}'),
 ('{ids['s2']}','ST002','Ama','Boateng','{U['p2']}'),
 ('{ids['s3']}','ST003','Kwame','Owusu','{U['p2']}');
insert into enrollments(student_id,class_id,academic_year_id) values
 ('{ids['s1']}','{ids['c2a']}','{ids['y']}'),('{ids['s2']}','{ids['c2a']}','{ids['y']}'),('{ids['s3']}','{ids['c2b']}','{ids['y']}');
insert into teacher_assignments(teacher_id,class_id,subject_id,academic_year_id) values
 ('{U['t1']}','{ids['c2a']}','{ids['math']}','{ids['y']}'),
 ('{U['t2']}','{ids['c2b']}','{ids['eng']}','{ids['y']}'),
 ('{U['t3']}','{ids['c2a']}','{ids['math']}','{ids['y']}');
""")

# ---------------- lesson notes / private storage / notifications ----------------
note_id = str(uuid.uuid4())
note_path = f"{U['t1']}/{note_id}"
o,e = run(U['t1'], f"""insert into lesson_notes(id,submitted_by,class_id,subject_id,semester_id,lesson_date,topic,file_path,file_mime_type,file_size)
 values ('{note_id}','{U['t1']}','{ids['c2a']}','{ids['math']}','{ids['sem']}',private.today(),'Fractions','{note_path}','application/pdf',2048);""", commit=True)
check("assigned teacher submits a pending lesson note", e=="", e)
o,e = run(U['t2'], f"select count(*) from lesson_notes where id='{note_id}';")
check("another teacher cannot read the submission", o=="0", (o,e))
o,e = run(U['p1'], f"select count(*) from lesson_notes where id='{note_id}';")
check("parent cannot read lesson notes", o=="0", (o,e))
o,e = run(U['t1'], f"insert into storage.objects(bucket_id,name,owner) values ('lesson-notes','{note_path}','{U['t1']}');", commit=True)
check("teacher uploads only their own pending note object", e=="", e)
o,e = run(U['t2'], f"select count(*) from storage.objects where bucket_id='lesson-notes' and name='{note_path}';")
check("another teacher cannot access the private note object", o=="0", (o,e))
o,e = run(U['t1'], f"update lesson_notes set status='approved' where id='{note_id}' returning status;")
check("teacher cannot approve a lesson note directly", o=="", (o,e))
o,e = run(U['t1'], f"insert into lesson_notes(id,submitted_by,class_id,subject_id,semester_id,lesson_date,topic,file_path,file_mime_type,file_size) values (gen_random_uuid(),'{U['t1']}','{ids['c2b']}','{ids['eng']}','{ids['sem']}',private.today(),'Unauthorised class','{U['t1']}/{uuid.uuid4()}','application/pdf',2000);")
check("teacher cannot submit outside assigned class and subject", "assigned to you" in e, e)
o,e = run(U['admin'], f"select public.decide_lesson_note('{note_id}','rejected',null);")
check("admin rejection requires a reason", "rejection reason" in e, e)
o,e = run(U['admin'], f"select public.decide_lesson_note('{note_id}','rejected','Please add worked examples.');", commit=True)
check("admin can reject with a reason", e=="", e)
o,e = run(U['t1'], f"select status || '|' || rejection_reason from lesson_notes where id='{note_id}';")
check("submitting teacher sees rejection reason", o=="rejected|Please add worked examples.", (o,e))
o,e = run(U['t1'], f"select message from lesson_note_notifications where lesson_note_id='{note_id}' and recipient_id='{U['t1']}' and event_type='rejected';")
check("rejection creates teacher notification with reason", "Please add worked examples." in o, (o,e))
o,e = run(U['t1'], f"update lesson_notes set topic='Fractions with examples' where id='{note_id}' returning status;", commit=True)
check("teacher can edit rejected note before resubmission", o=="rejected", (o,e))
o,e = run(U['t1'], f"update storage.objects set metadata='{{\"replaced\":true}}' where bucket_id='lesson-notes' and name='{note_path}';", commit=True)
check("teacher can replace rejected note file", o=="1", (o,e))
o,e = run(U['t1'], f"update lesson_notes set status='pending', rejection_reason=null, reviewed_by=null, reviewed_at=null where id='{note_id}' returning status;", commit=True)
check("teacher can resubmit the corrected note", o=="pending", (o,e))
o,e = run(U['t2'], f"select public.decide_lesson_note('{note_id}','approved',null);")
check("non-admin cannot approve a lesson note", "Only an administrator" in e, e)
o,e = run(U['admin'], f"select public.decide_lesson_note('{note_id}','approved',null);", commit=True)
check("admin can approve a resubmitted note", e=="", e)
o,e = run(U['t1'], f"select status from lesson_notes where id='{note_id}';")
check("teacher sees approved note status", o=="approved", (o,e))
o,e = run(U['t1'], f"select title || '|' || message from lesson_note_notifications where lesson_note_id='{note_id}' and recipient_id='{U['t1']}' and event_type='approved';")
check("approval creates teacher notification", "Lesson note approved" in o and "available for teaching" in o, (o,e))
o,e = run(U['t1'], f"delete from lesson_notes where id='{note_id}' returning 1;")
check("teacher cannot remove an approved note", o=="", (o,e))

today = "private.today()"
def att_insert(teacher, student, cls, date=today, status="present"):
    return f"insert into attendance(student_id,class_id,semester_id,teacher_id,date,status) values ('{student}','{cls}','{ids['sem']}','{teacher}',{date},'{status}');"

# ---------------- anonymous / no-profile / inactive ----------------
o,e = run(None, "select count(*) from students;", role="anon")
check("anon cannot read students", "permission denied" in e, e)
o,e = run(U['x'], "select count(*) from students;")
check("signed-in user with NO profile sees 0 students", o=="0", (o,e))
o,e = run(U['x'], "select count(*) from classes;")
check("signed-in user with NO profile sees 0 classes", o=="0", (o,e))
o,e = run(U['x'], "insert into students(student_code,first_name,last_name) values ('ST999','A','B');")
check("no-profile user cannot insert student", "row-level security" in e, e)
o,e = run(U['t3'], "select count(*) from students;")
check("deactivated teacher sees 0 students", o=="0", (o,e))
o,e = run(U['t3'], att_insert(U['t3'], ids['s1'], ids['c2a']))
check("deactivated teacher cannot mark attendance", "row-level security" in e, e)

# ---------------- profiles ----------------
o,e = run(U['t1'], "select count(*) from profiles;")
check("teacher sees only own profile", o=="1", (o,e))
o,e = run(U['t1'], f"update profiles set role='admin' where id='{U['t1']}';")
check("teacher cannot change own role (column privilege)", "permission denied" in e, e)
o,e = run(U['t1'], f"update profiles set full_name='Hacker' where id='{U['t1']}' returning 1;")
check("teacher cannot edit own profile row (RLS)", o=="", (o,e))
o,e = run(U['p1'], f"update profiles set is_active=true where id='{U['p2']}' returning 1;")
check("parent cannot edit other profile", o=="", (o,e))
o,e = run(U['admin'], f"update profiles set role='admin' where id='{U['t1']}';")
check("even admin cannot change roles", "permission denied" in e, e)
o,e = run(U['admin'], f"update profiles set is_active=false where id='{U['admin']}' returning 1;")
check("admin cannot deactivate own account", o=="", (o,e))
o,e = run(U['admin'], f"update profiles set is_active=false where id='{U['t2']}' returning 1;")
check("admin can deactivate another account", o=="1", (o,e))
o,e = run(U['admin'], "insert into profiles(id,role,full_name,email) values (gen_random_uuid(),'admin','Evil','e@x.test');")
check("admin cannot create profiles from the site (server function only)", "permission denied" in e, e)

# ---------------- students visibility ----------------
o,e = run(U['p1'], "select student_code from students order by 1;")
check("parent 1 sees only own child", o=="ST001", (o,e))
o,e = run(U['p2'], "select student_code from students order by 1;")
check("parent 2 sees only own children", o=="ST002\nST003", (o,e))
o,e = run(U['t1'], "select student_code from students order by 1;")
check("teacher 1 sees only students of assigned class", o=="ST001\nST002", (o,e))
o,e = run(U['t2'], "select student_code from students order by 1;")
check("teacher 2 sees only students of assigned class", o=="ST003", (o,e))
o,e = run(U['admin'], "select count(*) from students;")
check("admin sees all students", o=="3", (o,e))
o,e = run(U['p1'], f"select count(*) from students where id='{ids['s2']}';")
check("parent cannot fetch another child by guessing the ID", o=="0", (o,e))
o,e = run(U['t1'], f"update students set first_name='X' where id='{ids['s1']}' returning 1;")
check("teacher cannot edit students", o=="" or "permission denied" in e, (o,e))
o,e = run(U['admin'], f"update students set student_code='ST777' where id='{ids['s1']}';")
check("student code is immutable from the site", "permission denied" in e, e)
o,e = run(U['admin'], "insert into students(student_code,first_name,last_name) values ('BAD','A','B');")
check("student code format enforced", "violates check constraint" in e, e)
o,e = run(U['admin'], "delete from students;")
check("nobody can delete students", "permission denied" in e, e)

# ---------------- attendance ----------------
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a']))
check("teacher marks attendance for own class today", e=="" , e)
o,e = run(U['t1'], att_insert(U['t1'], ids['s3'], ids['c2b']))
check("teacher cannot mark another class", "row-level security" in e, e)
o,e = run(U['t2'], att_insert(U['t2'], ids['s1'], ids['c2a']))
check("teacher 2 cannot mark class 2A", "row-level security" in e, e)
o,e = run(U['t1'], att_insert(U['t2'], ids['s1'], ids['c2a']))
check("teacher cannot record attendance as another teacher", "row-level security" in e, e)
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a'], date=f"{today}-1"))
check("teacher cannot create attendance for a past date", "row-level security" in e, e)
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a']) + att_insert(U['t1'], ids['s1'], ids['c2a'], status="absent"))
check("duplicate attendance blocked by database", "attendance_one_record_per_day" in e, e)
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a'], status="excused"))
check("invalid attendance status rejected", "invalid input value for enum" in e, e)
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a']) + f"update attendance set status='absent' where student_id='{ids['s1']}' returning status;")
check("teacher can correct own record same day", "absent" in o and "violates" not in e, (o,e))
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a']) + f"update attendance set student_id='{ids['s2']}';")
check("teacher cannot re-point a record to another student", "permission denied" in e, e)
o,e = run(U['t1'], "delete from attendance;")
check("teacher cannot delete attendance", "permission denied" in e, e)
# persist a record for parent/other tests
run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a']) + att_insert(U['t1'], ids['s2'], ids['c2a'], status="absent"), commit=True)
o,e = run(U['p1'], "select status from attendance;")
check("parent sees own child's attendance only", o=="present", (o,e))
o,e = run(U['p2'], "select status from attendance;")
check("other parent sees only their child's record", o=="absent", (o,e))
o,e = run(U['p1'], f"update attendance set status='present' returning 1;")
check("parent cannot change attendance", "permission denied" in e or o=="", (o,e))
o,e = run(U['t2'], "select count(*) from attendance;")
check("teacher 2 cannot see class 2A attendance", o=="0", (o,e))
o,e = run(U['t1'], "select count(*) from attendance;")
check("teacher 1 sees class 2A attendance", o=="2", (o,e))
o,e = run(U['x'], "select count(*) from attendance;")
check("no-profile user sees no attendance", o=="0", (o,e))

# ---------------- performance ----------------
def perf(teacher, student, cls, subj, u=4, p=4, a=5, b=4, comment="'Good'", date=today):
    return f"insert into performance(student_id,class_id,subject_id,semester_id,teacher_id,date,understanding,participation,assignment,behaviour,comment) values ('{student}','{cls}','{subj}','{ids['sem']}','{teacher}',{date},{u},{p},{a},{b},{comment});"
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math']))
check("teacher records performance for assigned class+subject", e=="", e)
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['eng']))
check("teacher cannot record a subject they are not assigned", "row-level security" in e, e)
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math'], u=6))
check("rating 6 rejected", "violates check constraint" in e, e)
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math'], u=0))
check("rating 0 rejected", "violates check constraint" in e, e)
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math'], comment="'" + "x"*501 + "'"))
check("comment over 500 chars rejected", "violates check constraint" in e, e)
o,e = run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math']) + perf(U['t1'], ids['s1'], ids['c2a'], ids['math']))
check("duplicate performance entry blocked", "duplicate key" in e, e)
o,e = run(U['t1'], perf(U['t1'], ids['s3'], ids['c2b'], ids['math']))
check("teacher cannot record performance for another class's student", "row-level security" in e, e)
run(U['t1'], perf(U['t1'], ids['s1'], ids['c2a'], ids['math']) + perf(U['t1'], ids['s2'], ids['c2a'], ids['math'], u=2,p=3,a=3,b=2), commit=True)
o,e = run(U['p1'], "select understanding from performance;")
check("parent sees own child's performance only", o=="4", (o,e))
o,e = run(U['p2'], "select count(*) from performance where student_id='"+ids['s1']+"';")
check("other parent cannot see it", o=="0", (o,e))
o,e = run(U['t1'], "select count(*) from performance;")
check("teacher sees own class/subject performance", o=="2", (o,e))
o,e = run(U['t1'], f"update performance set understanding=5, comment='<script>alert(1)</script>' returning understanding;")
check("teacher edits own same-day entry (XSS text is stored inert; escaped by site)", "5" in o, (o,e))
o,e = run(U['t1'], f"update performance set behaviour=6;")
check("update also range-checked", "violates check constraint" in e, e)

# ---------------- reference data ----------------
o,e = run(U['t1'], "insert into classes(name) values ('Hack');")
check("teacher cannot create classes", "permission denied" in e or "row-level security" in e, e)
o,e = run(U['admin'], "insert into classes(name) values ('JHS 3A') returning name;", commit=True)
check("admin can create classes", "JHS 3A" in o, (o,e))
o,e = run(U['admin'], "insert into academic_years(name) values ('2026/2028');")
check("academic year must be consecutive years", "violates check constraint" in e, e)
o,e = run(U['admin'], "insert into academic_years(name) values ('2027/2028') returning name;", commit=True)
check("valid academic year accepted", "2027/2028" in o, (o,e))
o,e = run(U['admin'], f"update semesters set status='closed' where id='{ids['sem']}';")
check("admin cannot set semester status directly", "permission denied" in e, e)
o,e = run(U['admin'], f"insert into semesters(academic_year_id,term) values ('{ids['y']}',3);")
check("only semester 1 or 2 accepted", "violates check constraint" in e, e)

# ---------------- audit ----------------
o,e = run(U['t1'], "select count(*) from audit_logs;")
check("teacher cannot read audit logs", "permission denied" in e or o=="0", (o,e))
o,e = run(U['admin'], "select count(*) > 0 from audit_logs;")
check("admin can read audit logs (attendance/profile changes recorded)", o=="t", (o,e))
o,e = run(U['admin'], "update audit_logs set action='x';")
check("audit logs cannot be edited by admin", "permission denied" in e, e)
o,e = psql("update audit_logs set action='x';")
check("audit logs immutable even for the database owner", "cannot be changed" in e, e)

# ---------------- corrections ----------------
admin_sql(f"""insert into attendance(student_id,class_id,semester_id,teacher_id,date,status)
  values ('{ids['s1']}','{ids['c2a']}','{ids['sem']}','{U['t1']}',private.today()-1,'present');""")
o,e = run(U['t1'], f"select id from attendance where date < private.today() and student_id='{ids['s1']}';")
old_att = o
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,new_status,reason) values ('{old_att}','absent','Marked wrongly');")
check("correction insert needs requested_by (own id)", e!="" , (o,e))
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','absent','Marked wrongly');")
check("teacher requests correction for an earlier day", e=="", e)
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','absent','Marked wrongly'); insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','late','Second request');")
check("only one pending request per record", "one_pending_correction" in e, e)
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','present','Same status');")
check("request must change the status", "same as the current" in e, e)
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) select id,'{U['t1']}','late','Wrong today' from attendance where date = private.today() and student_id='{ids['s1']}';")
check("no correction requests for today (edit directly)", "directly" in e, e)
o,e = run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','absent','no');")
check("reason must be at least 5 characters", "violates check constraint" in e, e)
o,e = run(U['t2'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t2']}','absent','Not my class');")
check("other teacher cannot request corrections on this record", "row-level security" in e, e)
run(U['t1'], f"insert into attendance_corrections(attendance_id,requested_by,new_status,reason) values ('{old_att}','{U['t1']}','absent','Marked wrongly');", commit=True)
o,e = run(U['t1'], "update attendance_corrections set status='approved';")
check("teacher cannot approve own request", "permission denied" in e, e)
o,e = run(U['t1'], f"select public.decide_attendance_correction((select id from attendance_corrections limit 1), true);")
check("teacher cannot call admin approval function", "Only an administrator" in e, e)
o,e = run(U['p1'], f"select public.decide_attendance_correction(gen_random_uuid(), true);")
check("parent cannot call admin approval function", "Only an administrator" in e, e)
o,e = run(None, f"select public.decide_attendance_correction(gen_random_uuid(), true);", role="anon")
check("anonymous cannot call admin functions", "permission denied" in e, e)
o,e = run(U['admin'], "select id from attendance_corrections limit 1;")
cid = o
o,e = run(U['admin'], f"select public.decide_attendance_correction('{cid}', true); select status from attendance where id='{old_att}';")
check("admin approves -> attendance updated", "absent" in o, (o,e))
o,e = run(U['admin'], f"select public.decide_attendance_correction('{cid}', true); select public.decide_attendance_correction('{cid}', true);")
check("a request cannot be decided twice", "already been decided" in e, e)

# ---------------- semester lifecycle ----------------
o,e = run(U['t1'], f"select public.prepare_semester_closure('{ids['sem']}');")
check("teacher cannot prepare closure", "Only an administrator" in e, e)
o,e = run(U['admin'], f"select public.close_semester('{ids['sem']}', 'CLOSE 2026/2027 S1');")
check("cannot close without preparing/reviewing", "Prepare the closure" in e, e)
o,e = run(U['admin'], f"select public.prepare_semester_closure('{ids['sem']}');", commit=True)
print("      prepare ->", o)
d = json.loads(o) if o.startswith("{") else {}
check("prepare returns counts for review", d.get("summaries")==3 and d.get("attendance_records")==3 and d.get("performance_records")==2, d)
o,e = run(U['p1'], "select count(*) from semester_summaries;")
check("parent cannot see DRAFT summaries", o=="0", (o,e))
o,e = run(U['t1'], "select count(*) from semester_summaries;")
check("teacher cannot see summaries", "permission denied" in e or o=="0", (o,e))
o,e = run(U['admin'], "select s.student_code, ss.attendance_percentage, ss.overall_percentage, ss.performance_rating from semester_summaries ss join students s on s.id=ss.student_id order by 1;")
print("      draft summaries:\n      " + o.replace("\n","\n      "))
# ST001: attendance present today + present yesterday = 2/2 -> 100 ; perf u4,p4,a5,b4 => avg 4.25 -> 85%
check("summary maths: ST001", o.splitlines()[0]=="ST001|100.00|85.00|4.25", o)
check("summary maths: ST002", o.splitlines()[1]=="ST002|0.00|50.00|2.50", o)
check("summary for student with no records has NULLs", o.splitlines()[2]=="ST003|||", o)
o,e = run(U['admin'], f"update semester_summaries set teacher_remark='Good progress.', promotion_status='promoted' where student_id='{ids['s1']}' returning 1;", commit=True)
check("admin can enter remark/promotion on review", o=="1", (o,e))
o,e = run(U['admin'], f"update semester_summaries set overall_percentage=100 where student_id='{ids['s1']}';")
check("admin cannot edit calculated figures", "permission denied" in e, e)
o,e = run(U['admin'], f"select public.close_semester('{ids['sem']}', 'close 2026/2027 s1');")
check("wrong confirmation text rejected", "does not match" in e, e)
# pending correction blocks closure
admin_sql(f"""insert into attendance(student_id,class_id,semester_id,teacher_id,date,status) values ('{ids['s3']}','{ids['c2b']}','{ids['sem']}','{U['t2']}',private.today()-2,'present');
 insert into attendance_corrections(attendance_id,requested_by,new_status,reason) select id,'{U['t2']}','absent','Marked wrongly' from attendance where student_id='{ids['s3']}';""")
o,e = run(U['admin'], f"select public.close_semester('{ids['sem']}', 'CLOSE 2026/2027 S1');")
check("pending corrections block closure", "pending attendance corrections" in e, e)
admin_sql("update attendance_corrections set status='rejected' where status='pending';")
# retention not set: closure keeps every detail record
o,e = run(U['admin'], f"select public.close_semester('{ids['sem']}', 'CLOSE 2026/2027 S1');", commit=True)
print("      close (retention unset) ->", o)
d = json.loads(o) if o.startswith("{") else {}
check("closure with NO retention policy deletes nothing", d.get("attendance_deleted")==0 and d.get("performance_deleted")==0, (o,e))
o,e = run(U['admin'], "select (select count(*) from attendance), (select count(*) from performance), (select status from semesters);")
check("detail records kept, semester closed", o=="4|2|closed", (o,e))
o,e = run(U['t1'], att_insert(U['t1'], ids['s1'], ids['c2a'], date=f"{today}+0", status="late"))
check("no writes to a closed semester", e!="", (o,e))
o,e = run(U['admin'], f"update semester_summaries set teacher_remark='changed' where student_id='{ids['s1']}';")
check("closed summaries are final", "final" in e, e)
o,e = run(U['admin'], f"select public.close_semester('{ids['sem']}', 'CLOSE 2026/2027 S1');")
check("cannot close twice", "Only the active semester" in e, e)
o,e = run(U['p1'], "select ss.overall_percentage, ss.teacher_remark, ss.promotion_status from semester_summaries ss;")
check("parent now sees FINAL summary of own child", o=="85.00|Good progress.|promoted", (o,e))
o,e = run(U['p2'], "select count(*) from semester_summaries where student_id='"+ids['s1']+"';")
check("other parent still cannot", o=="0", (o,e))
o,e = run(U['p1'], "select count(*) from subject_summaries;")
check("parent sees own subject summaries", o=="1", (o,e))
o,e = run(U['admin'], "select public.purge_semester_details((select id from semesters));")
check("purge refused while no retention policy approved", "No retention period" in e, e)
o,e = run(U['admin'], "update school_settings set detail_retention_days = 0 returning detail_retention_days;", commit=True)
check("admin sets retention period", o=="0", (o,e))
o,e = run(U['admin'], "select public.purge_semester_details((select id from semesters));", commit=True)
print("      purge ->", o)
o,e = run(U['admin'], "select (select count(*) from attendance), (select count(*) from performance), (select count(*) from semester_summaries), (select count(*) from subject_summaries);")
check("after purge: details gone, summaries preserved", o=="0|0|3|2", (o,e))
o,e = run(U['admin'], "select count(*) from audit_logs where action in ('CLOSE semester','PURGE semester details');")
check("closure and purge are audit-logged", o=="2", (o,e))

# ---------------- second semester + promotion ----------------
admin_sql(f"""insert into academic_years(id,name) values ('{ids['y']}'::uuid, '2030/2031') on conflict do nothing;""") if False else None
o,e = run(U['admin'], f"select id from academic_years where name='2027/2028';")
y2 = o
o,e = run(U['admin'], f"select public.promote_class('{ids['y']}','{ids['c2a']}','{y2}', (select id from classes where name='JHS 3A'));", commit=True)
check("promote class creates new enrolments (active students only)", o=="2", (o,e))
o,e = run(U['admin'], f"select count(*) from enrollments where student_id='{ids['s1']}';")
check("old enrolment preserved (history)", o=="2", (o,e))
o,e = run(U['admin'], f"select public.promote_class('{ids['y']}','{ids['c2a']}','{y2}', (select id from classes where name='JHS 3A'));")
check("promotion is idempotent (no duplicates)", o=="0", (o,e))
o,e = run(U['p1'], "select ay.name, c.name from enrollments e join academic_years ay on ay.id=e.academic_year_id join classes c on c.id=e.class_id order by 1;")
check("parent sees child's class history", o=="2026/2027|JHS 2A\n2027/2028|JHS 3A", (o,e))
o,e = run(U['t1'], "select public.promote_class(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid());")
check("teacher cannot promote", "Only an administrator" in e, e)

# activation rules
admin_sql(f"insert into semesters(academic_year_id,term) values ('{y2}',1),('{y2}',2);")
o,e = run(U['admin'], f"select public.activate_semester((select id from semesters where academic_year_id='{y2}' and term=1));", commit=True)
check("admin activates next semester", e=="", e)
o,e = run(U['admin'], f"select public.activate_semester((select id from semesters where academic_year_id='{y2}' and term=2));")
check("only one active semester", "already active" in e, e)
o,e = psql(f"update semesters set status='active' where academic_year_id='{y2}' and term=2;")
check("DB-level: two active semesters impossible even for owner", "one_active_semester" in e, e)
o,e = psql(f"update semesters set status='planned' where status='closed';")
check("closed semester cannot be reopened (even by owner)", "closed semester cannot be changed" in e, e)

# grants sanity
o,e = psql("select has_function_privilege('authenticated','private.audit_write(text,text,text,jsonb,jsonb)','execute'), has_function_privilege('authenticated','private.purge_details(uuid)','execute'), has_function_privilege('anon','public.close_semester(uuid,text)','execute'), has_function_privilege('authenticated','public.close_semester(uuid,text)','execute');")
check("private functions not callable by users; public RPCs only by signed-in", o=="f|f|f|t", o)
o,e = psql("select count(*) from pg_tables where schemaname='public' and not rowsecurity;")
check("RLS enabled on every table", o=="0", o)
o,e = psql("select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public';")
check("anon role has no table grants", o=="0", o)

print("\nFAILS:", fails); sys.exit(1 if fails else 0)
