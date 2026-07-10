-- Attendance app schema (D1 / SQLite)
-- Multi-tenant: every table (except sessions) is scoped by company_id.

CREATE TABLE IF NOT EXISTS companies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  office_lat         REAL,
  office_lng         REAL,
  geofence_radius_m  INTEGER DEFAULT 200,
  work_start_time    TEXT DEFAULT '09:00',
  work_end_time      TEXT DEFAULT '17:00',
  late_grace_minutes INTEGER DEFAULT 10,
  created_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id),
  name               TEXT NOT NULL,          -- e.g. "Pagi", "Sore", "Malam"
  start_time         TEXT NOT NULL,          -- "07:00"
  end_time           TEXT NOT NULL,          -- "15:00"
  late_grace_minutes INTEGER DEFAULT 10,
  created_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id),
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  department    TEXT,
  position      TEXT,
  shift_id      INTEGER REFERENCES shifts(id),
  status        TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  employee_id    INTEGER REFERENCES employees(id),
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  salt           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK(role IN ('admin','employee')),
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  used        INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id),
  employee_id        INTEGER NOT NULL REFERENCES employees(id),
  work_date          TEXT NOT NULL,          -- YYYY-MM-DD
  check_in_time      TEXT,                   -- ISO timestamp
  check_in_lat       REAL,
  check_in_lng       REAL,
  check_in_ip        TEXT,
  check_in_verified  INTEGER DEFAULT 0,      -- inside geofence?
  check_out_time     TEXT,
  check_out_lat      REAL,
  check_out_lng      REAL,
  check_out_ip       TEXT,
  check_out_verified INTEGER DEFAULT 0,
  status             TEXT DEFAULT 'present' CHECK(status IN ('present','late','absent','half_day','on_leave')),
  notes              TEXT,
  created_at         TEXT DEFAULT (datetime('now')),
  UNIQUE(employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  employee_id  INTEGER REFERENCES employees(id),
  type         TEXT NOT NULL,   -- 'late' | 'absent' | 'reminder' | 'system'
  message      TEXT NOT NULL,
  is_read      INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_company_date  ON attendance(company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_employees_company         ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company             ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company     ON notifications(company_id, is_read);
CREATE INDEX IF NOT EXISTS idx_shifts_company             ON shifts(company_id);
