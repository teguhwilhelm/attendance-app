import { Hono } from "hono";
import * as XLSX from "xlsx";
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  getCookie,
  sessionCookie,
  clearCookie,
  distanceMeters,
  generateToken,
} from "./auth.js";

const app = new Hono();

// ---------- middleware ----------

app.use("/api/*", async (c, next) => {
  const token = getCookie(c.req.raw, "session");
  const user = await getSessionUser(c.env.DB, token);
  c.set("user", user);
  await next();
});

function requireAuth(c) {
  const user = c.get("user");
  if (!user) return null;
  return user;
}

function requireAdmin(c) {
  const user = c.get("user");
  if (!user || user.role !== "admin") return null;
  return user;
}

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Blocks access once a company's trial or subscription has lapsed.
// Auth and billing endpoints stay reachable so people can still log in
// and pay even when locked out of everything else.
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/auth/") || path.startsWith("/api/billing/")) return next();
  const user = c.get("user");
  if (!user) return next();

  const company = await c.env.DB.prepare(
    "SELECT plan_status, trial_ends_at, subscription_expires_at FROM companies WHERE id = ?"
  )
    .bind(user.company_id)
    .first();
  const now = new Date();
  const trialActive = company.trial_ends_at && new Date(company.trial_ends_at) > now;
  const subActive =
    company.plan_status === "active" &&
    company.subscription_expires_at &&
    new Date(company.subscription_expires_at) > now;
  if (!trialActive && !subActive) {
    return c.json({ error: "Trial/subscription expired", code: "SUBSCRIPTION_REQUIRED" }, 402);
  }
  await next();
});

// ---------- auth ----------

// Creates a brand new company + its first admin user.
app.post("/api/auth/register", async (c) => {
  const { company_name, email, password } = await c.req.json();
  if (!company_name || !email || !password) {
    return c.json({ error: "company_name, email and password are required" }, 400);
  }
  const db = c.env.DB;
  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ error: "That email is already registered" }, 409);

  const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const company = await db
    .prepare("INSERT INTO companies (name, plan_status, trial_ends_at) VALUES (?, 'trial', ?) RETURNING id")
    .bind(company_name, trialEnds)
    .first();

  const { hash, salt } = await hashPassword(password);
  const user = await db
    .prepare(
      "INSERT INTO users (company_id, email, password_hash, salt, role) VALUES (?, ?, ?, ?, 'admin') RETURNING id"
    )
    .bind(company.id, email, hash, salt)
    .first();

  const { token } = await createSession(db, user.id);
  c.header("Set-Cookie", sessionCookie(token));
  return c.json({ ok: true, role: "admin" });
});

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json();
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!row) return c.json({ error: "Invalid email or password" }, 401);
  const ok = await verifyPassword(password, row.salt, row.password_hash);
  if (!ok) return c.json({ error: "Invalid email or password" }, 401);
  const { token } = await createSession(db, row.id);
  c.header("Set-Cookie", sessionCookie(token));
  return c.json({ ok: true, role: row.role });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c.req.raw, "session");
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  c.header("Set-Cookie", clearCookie());
  return c.json({ ok: true });
});

app.post("/api/auth/forgot-password", async (c) => {
  const { email } = await c.req.json();
  const db = c.env.DB;
  const user = await db.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
  if (user) {
    const token = generateToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.prepare("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(token, user.id, expires)
      .run();
    const resetUrl = `https://${c.req.header("Host")}/?reset=${token}`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Ledger <onboarding@resend.dev>",
        to: [user.email],
        subject: "Reset password akun Ledger kamu",
        html: `<p>Klik link berikut untuk atur ulang password kamu. Link ini berlaku selama 1 jam:</p>
               <p><a href="${resetUrl}">${resetUrl}</a></p>
               <p>Kalau kamu tidak meminta ini, abaikan saja email ini.</p>`,
      }),
    }).catch(() => {});
  }
  return c.json({ ok: true });
});

app.post("/api/auth/reset-password", async (c) => {
  const { token, password } = await c.req.json();
  if (!token || !password || password.length < 6) {
    return c.json({ error: "Token dan password (minimal 6 karakter) wajib diisi" }, 400);
  }
  const db = c.env.DB;
  const reset = await db.prepare("SELECT * FROM password_resets WHERE token = ?").bind(token).first();
  if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
    return c.json({ error: "Link reset tidak valid atau sudah kadaluarsa" }, 400);
  }
  const { hash, salt } = await hashPassword(password);
  await db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, reset.user_id).run();
  await db.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").bind(token).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(reset.user_id).run();
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const company = await c.env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(user.company_id).first();
  let employee = null;
  if (user.employee_id) {
    employee = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(user.employee_id).first();
  }
  return c.json({ user, company, employee });
});

// ---------- company settings (admin) ----------

app.get("/api/company", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const company = await c.env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(user.company_id).first();
  return c.json(company);
});

app.put("/api/company", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const b = await c.req.json();
  await c.env.DB.prepare(
    `UPDATE companies SET office_lat = ?, office_lng = ?, geofence_radius_m = ?,
     work_start_time = ?, work_end_time = ?, late_grace_minutes = ? WHERE id = ?`
  )
    .bind(
      b.office_lat ?? null,
      b.office_lng ?? null,
      b.geofence_radius_m ?? 200,
      b.work_start_time ?? "09:00",
      b.work_end_time ?? "17:00",
      b.late_grace_minutes ?? 10,
      user.company_id
    )
    .run();
  return c.json({ ok: true });
});

// ---------- shifts (admin manages; anyone in the company can list them) ----------

app.get("/api/shifts", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM shifts WHERE company_id = ? ORDER BY start_time"
  )
    .bind(user.company_id)
    .all();
  return c.json(results);
});

app.post("/api/shifts", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const b = await c.req.json();
  if (!b.name || !b.start_time || !b.end_time) {
    return c.json({ error: "name, start_time and end_time are required" }, 400);
  }
  const row = await c.env.DB.prepare(
    "INSERT INTO shifts (company_id, name, start_time, end_time, late_grace_minutes) VALUES (?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(user.company_id, b.name, b.start_time, b.end_time, b.late_grace_minutes ?? 10)
    .first();
  return c.json(row);
});

app.put("/api/shifts/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  const b = await c.req.json();
  await c.env.DB.prepare(
    "UPDATE shifts SET name = ?, start_time = ?, end_time = ?, late_grace_minutes = ? WHERE id = ? AND company_id = ?"
  )
    .bind(b.name, b.start_time, b.end_time, b.late_grace_minutes ?? 10, id, user.company_id)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM shifts WHERE id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .first();
  return c.json(row);
});

app.delete("/api/shifts/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE employees SET shift_id = NULL WHERE shift_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  await c.env.DB.prepare("DELETE FROM shifts WHERE id = ? AND company_id = ?").bind(id, user.company_id).run();
  return c.json({ ok: true });
});

app.get("/api/holidays", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const { results } = await c.env.DB.prepare("SELECT * FROM holidays WHERE company_id = ? ORDER BY date")
    .bind(user.company_id)
    .all();
  return c.json(results);
});

app.post("/api/holidays", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const b = await c.req.json();
  if (!b.date || !b.name) return c.json({ error: "date and name are required" }, 400);
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO holidays (company_id, date, name) VALUES (?, ?, ?) RETURNING *"
    )
      .bind(user.company_id, b.date, b.name)
      .first();
    return c.json(row);
  } catch {
    return c.json({ error: "Tanggal itu sudah terdaftar sebagai hari libur" }, 409);
  }
});

app.delete("/api/holidays/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM holidays WHERE id = ? AND company_id = ?").bind(id, user.company_id).run();
  return c.json({ ok: true });
});

// ---------- employees (admin manages; employees can read their own record) ----------

app.get("/api/employees", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, s.name as shift_name, s.start_time as shift_start, s.end_time as shift_end,
            u.id as user_id, u.role as user_role
     FROM employees e
     LEFT JOIN shifts s ON s.id = e.shift_id
     LEFT JOIN users u ON u.employee_id = e.id
     WHERE e.company_id = ? ORDER BY e.full_name`
  )
    .bind(user.company_id)
    .all();
  return c.json(results);
});

app.post("/api/employees", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const b = await c.req.json();
  if (!b.full_name || !b.email) return c.json({ error: "full_name and email are required" }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO employees (company_id, full_name, email, phone, department, position, shift_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active') RETURNING *`
  )
    .bind(user.company_id, b.full_name, b.email, b.phone ?? null, b.department ?? null, b.position ?? null, b.shift_id || null)
    .first();

  // Optionally create a login for this employee right away.
  
  if (b.create_login && b.password) {
    const { hash, salt } = await hashPassword(b.password);
    await c.env.DB.prepare(
      "INSERT INTO users (company_id, employee_id, email, password_hash, salt, role) VALUES (?, ?, ?, ?, ?, 'employee')"
    )
      .bind(user.company_id, row.id, b.email, hash, salt)
      .run();
  }
  return c.json(row);
});

app.put("/api/employees/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  const b = await c.req.json();
  await c.env.DB.prepare(
    `UPDATE employees SET full_name = ?, email = ?, phone = ?, department = ?, position = ?, shift_id = ?, status = ?
     WHERE id = ? AND company_id = ?`
  )
    .bind(b.full_name, b.email, b.phone ?? null, b.department ?? null, b.position ?? null, b.shift_id || null, b.status ?? "active", id, user.company_id)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .first();
  return c.json(row);
});

app.delete("/api/employees/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM attendance WHERE employee_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  await c.env.DB.prepare("DELETE FROM notifications WHERE employee_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  await c.env.DB.prepare("DELETE FROM users WHERE employee_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  await c.env.DB.prepare("DELETE FROM employees WHERE id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/employees/:id/link-me", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  const emp = await c.env.DB.prepare("SELECT id FROM employees WHERE id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .first();
  if (!emp) return c.json({ error: "Employee not found" }, 404);
  await c.env.DB.prepare("UPDATE users SET employee_id = ? WHERE id = ? AND company_id = ?")
    .bind(id, user.id, user.company_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/employees/:id/set-role", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  const { role } = await c.req.json();
  if (!["admin", "employee"].includes(role)) return c.json({ error: "role must be admin or employee" }, 400);
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE employee_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .first();
  if (!target) return c.json({ error: "This employee doesn't have a login yet" }, 400);
  await c.env.DB.prepare("UPDATE users SET role = ? WHERE employee_id = ? AND company_id = ?")
    .bind(role, id, user.company_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/employees/:id/reset-password", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  const { password } = await c.req.json();
  if (!password || password.length < 6) return c.json({ error: "Password minimal 6 karakter" }, 400);
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE employee_id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .first();
  if (!target) return c.json({ error: "Karyawan ini belum punya login" }, 400);
  const { hash, salt } = await hashPassword(password);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE employee_id = ? AND company_id = ?")
    .bind(hash, salt, id, user.company_id)
    .run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id).run();
  return c.json({ ok: true });
});

// ---------- attendance ----------

app.post("/api/attendance/checkin", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (!user.employee_id) return c.json({ error: "This account is not linked to an employee record" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const db = c.env.DB;
  const company = await db.prepare("SELECT * FROM companies WHERE id = ?").bind(user.company_id).first();
  const employee = await db.prepare("SELECT shift_id FROM employees WHERE id = ?").bind(user.employee_id).first();
  let shift = null;
  if (employee?.shift_id) {
    shift = await db.prepare("SELECT * FROM shifts WHERE id = ? AND company_id = ?").bind(employee.shift_id, user.company_id).first();
  }
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const now = new Date();
  const date = todayStr(now);

  const existing = await db
    .prepare("SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?")
    .bind(user.employee_id, date)
    .first();
  if (existing && existing.check_in_time) {
    return c.json({ error: "Already checked in today" }, 409);
  }

  const dist = distanceMeters(company.office_lat, company.office_lng, b.lat, b.lng);
  const verified = dist !== null ? dist <= (company.geofence_radius_m ?? 200) : 0;

  const startTime = shift ? shift.start_time : (company.work_start_time || "09:00");
  const graceMinutes = shift ? shift.late_grace_minutes : (company.late_grace_minutes || 0);
  const [h, m] = startTime.split(":").map(Number);
  const expectedStart = new Date(now);
  expectedStart.setHours(h, m + graceMinutes, 0, 0);
  const status = now > expectedStart ? "late" : "present";

  if (existing) {
    await db
      .prepare(
        `UPDATE attendance SET check_in_time=?, check_in_lat=?, check_in_lng=?, check_in_ip=?, check_in_verified=?, status=?
         WHERE id = ?`
      )
      .bind(now.toISOString(), b.lat ?? null, b.lng ?? null, ip, verified ? 1 : 0, status, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO attendance (company_id, employee_id, work_date, check_in_time, check_in_lat, check_in_lng, check_in_ip, check_in_verified, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(user.company_id, user.employee_id, date, now.toISOString(), b.lat ?? null, b.lng ?? null, ip, verified ? 1 : 0, status)
      .run();
  }

  if (status === "late") {
    await db
      .prepare("INSERT INTO notifications (company_id, employee_id, type, message) VALUES (?, ?, 'late', ?)")
      .bind(user.company_id, user.employee_id, `Checked in late on ${date}`)
      .run();
  }

  return c.json({ ok: true, status, verified: !!verified });
});

app.post("/api/attendance/checkout", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (!user.employee_id) return c.json({ error: "This account is not linked to an employee record" }, 400);
  const b = await c.req.json().catch(() => ({}));
  const db = c.env.DB;
  const company = await db.prepare("SELECT * FROM companies WHERE id = ?").bind(user.company_id).first();
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const now = new Date();
  const date = todayStr(now);

  const existing = await db
    .prepare("SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?")
    .bind(user.employee_id, date)
    .first();
  if (!existing || !existing.check_in_time) return c.json({ error: "You haven't checked in today" }, 400);
  if (existing.check_out_time) return c.json({ error: "Already checked out today" }, 409);

  const dist = distanceMeters(company.office_lat, company.office_lng, b.lat, b.lng);
  const verified = dist !== null ? dist <= (company.geofence_radius_m ?? 200) : 0;

  await db
    .prepare(
      `UPDATE attendance SET check_out_time=?, check_out_lat=?, check_out_lng=?, check_out_ip=?, check_out_verified=? WHERE id = ?`
    )
    .bind(now.toISOString(), b.lat ?? null, b.lng ?? null, ip, verified ? 1 : 0, existing.id)
    .run();

  return c.json({ ok: true, verified: !!verified });
});

// view=daily|weekly|monthly, date=YYYY-MM-DD (anchor), employee_id optional (admin only, else forced to self)

app.get("/api/attendance", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const view = c.req.query("view") || "daily";
  const anchor = c.req.query("date") || todayStr();
  let employeeId = c.req.query("employee_id");
  if (user.role !== "admin") employeeId = user.employee_id;

  const anchorDate = new Date(anchor + "T00:00:00");
  let start, end;
  if (view === "daily") {
    start = end = anchor;
  } else if (view === "weekly") {
    const day = anchorDate.getDay();
    const monday = new Date(anchorDate);
    monday.setDate(anchorDate.getDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    start = todayStr(monday);
    end = todayStr(sunday);
  } else {
    const first = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const last = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0);
    start = todayStr(first);
    end = todayStr(last);
  }

let query = `SELECT a.*, e.full_name, e.department FROM attendance a
               JOIN employees e ON e.id = a.employee_id
               WHERE a.company_id = ? AND a.work_date BETWEEN ? AND ?`;
  const args = [user.company_id, start, end];
  if (employeeId) {
    query += " AND a.employee_id = ?";
    args.push(employeeId);
  }
  query += " ORDER BY a.work_date DESC, e.full_name";
  const { results } = await c.env.DB.prepare(query).bind(...args).all();
  return c.json({ start, end, records: results });
});

app.delete("/api/attendance/:id", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM attendance WHERE id = ? AND company_id = ?")
    .bind(id, user.company_id)
    .run();
  return c.json({ ok: true });
});

// ---------- reports ----------

app.get("/api/reports/summary", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const start = c.req.query("start") || todayStr(new Date(Date.now() - 30 * 86400000));
  const end = c.req.query("end") || todayStr();
  let employeeId = c.req.query("employee_id");
  if (user.role !== "admin") employeeId = user.employee_id;

  let empFilter = "";
  const args = [user.company_id, start, end];
  if (employeeId) {
    empFilter = " AND a.employee_id = ?";
    args.push(employeeId);
  }

  const { results: byEmployee } = await c.env.DB.prepare(
    `SELECT e.id as employee_id, e.full_name, e.department,
            COUNT(*) as total_days,
            SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) as present_days,
            SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) as late_days,
            SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) as absent_days,
            SUM(CASE WHEN a.status = 'on_leave' THEN 1 ELSE 0 END) as leave_days
     FROM attendance a JOIN employees e ON e.id = a.employee_id
     WHERE a.company_id = ? AND a.work_date BETWEEN ? AND ? ${empFilter}
     GROUP BY e.id ORDER BY e.full_name`
  )
    .bind(...args)
    .all();

  const totals = byEmployee.reduce(
    (acc, r) => {
      acc.total_days += r.total_days;
      acc.present_days += r.present_days;
      acc.late_days += r.late_days;
      acc.absent_days += r.absent_days;
      acc.leave_days += r.leave_days;
      return acc;
    },
    { total_days: 0, present_days: 0, late_days: 0, absent_days: 0, leave_days: 0 }
  );

  return c.json({
    start,
    end,
    totals: {
      ...totals,
      attendance_rate: totals.total_days ? +(((totals.present_days + totals.late_days) / totals.total_days) * 100).toFixed(1) : 0,
      tardiness_rate: totals.total_days ? +((totals.late_days / totals.total_days) * 100).toFixed(1) : 0,
      absence_rate: totals.total_days ? +((totals.absent_days / totals.total_days) * 100).toFixed(1) : 0,
    },
    by_employee: byEmployee,
  });
});

// ---------- export ----------

async function fetchRangeRows(c) {
  const user = requireAuth(c);
  const start = c.req.query("start") || todayStr(new Date(Date.now() - 30 * 86400000));
  const end = c.req.query("end") || todayStr();
  const { results } = await c.env.DB.prepare(
    `SELECT e.full_name, e.department, a.work_date, a.check_in_time, a.check_out_time, a.status,
            a.check_in_verified, a.check_out_verified, a.notes
     FROM attendance a JOIN employees e ON e.id = a.employee_id
     WHERE a.company_id = ? AND a.work_date BETWEEN ? AND ?
     ORDER BY a.work_date, e.full_name`
  )
    .bind(user.company_id, start, end)
    .all();
  return results;
}

app.get("/api/export/csv", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const rows = await fetchRangeRows(c);
  const header = ["Employee", "Department", "Date", "Check In", "Check Out", "Status", "In Verified", "Out Verified", "Notes"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.full_name,
        r.department || "",
        r.work_date,
        r.check_in_time || "",
        r.check_out_time || "",
        r.status,
        r.check_in_verified ? "yes" : "no",
        r.check_out_verified ? "yes" : "no",
        (r.notes || "").replace(/,/g, ";"),
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="attendance.csv"',
    },
  });
});

app.get("/api/export/xlsx", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const rows = await fetchRangeRows(c);
  const data = rows.map((r) => ({
    Employee: r.full_name,
    Department: r.department || "",
    Date: r.work_date,
    "Check In": r.check_in_time || "",
    "Check Out": r.check_out_time || "",
    Status: r.status,
    "In Verified": r.check_in_verified ? "yes" : "no",
    "Out Verified": r.check_out_verified ? "yes" : "no",
    Notes: r.notes || "",
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Attendance");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="attendance.xlsx"',
    },
  });
});

// PDF is generated client-side (printable view -> browser "Save as PDF"),
// so this just returns the same JSON the print view renders from.
app.get("/api/export/report-data", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const rows = await fetchRangeRows(c);
  return c.json(rows);
});

// ---------- notifications ----------

app.get("/api/notifications", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  let query = "SELECT * FROM notifications WHERE company_id = ?";
  const args = [user.company_id];
  if (user.role !== "admin") {
    query += " AND employee_id = ?";
    args.push(user.employee_id);
  }
  query += " ORDER BY created_at DESC LIMIT 50";
  const { results } = await c.env.DB.prepare(query).bind(...args).all();
  return c.json(results);
});

app.post("/api/notifications/:id/read", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  await c.env.DB.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND company_id = ?")
    .bind(c.req.param("id"), user.company_id)
    .run();
  return c.json({ ok: true });
});

// ---------- billing ----------

const MONTHLY_PRICE_IDR = 150000;

app.get("/api/billing/status", async (c) => {
  const user = requireAuth(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const company = await c.env.DB.prepare(
    "SELECT plan_status, trial_ends_at, subscription_expires_at FROM companies WHERE id = ?"
  )
    .bind(user.company_id)
    .first();
  const now = new Date();
  const trialActive = company.trial_ends_at && new Date(company.trial_ends_at) > now;
  const subActive =
    company.plan_status === "active" &&
    company.subscription_expires_at &&
    new Date(company.subscription_expires_at) > now;
  return c.json({
    plan_status: company.plan_status,
    trial_ends_at: company.trial_ends_at,
    subscription_expires_at: company.subscription_expires_at,
    is_active: trialActive || subActive,
    trial_days_left: trialActive ? Math.ceil((new Date(company.trial_ends_at) - now) / 86400000) : 0,
    monthly_price: MONTHLY_PRICE_IDR,
  });
});

app.post("/api/billing/checkout", async (c) => {
  const user = requireAdmin(c);
  if (!user) return c.json({ error: "Admin access required" }, 403);
  const company = await c.env.DB.prepare("SELECT * FROM companies WHERE id = ?").bind(user.company_id).first();
  const orderId = `SUB-${user.company_id}-${Date.now()}`;
  await c.env.DB.prepare("INSERT INTO payments (company_id, order_id, amount, status) VALUES (?, ?, ?, 'pending')")
    .bind(user.company_id, orderId, MONTHLY_PRICE_IDR)
    .run();

  const midtransUrl =
    c.env.MIDTRANS_IS_PRODUCTION === "true"
      ? "https://app.midtrans.com/snap/v1/transactions"
      : "https://app.sandbox.midtrans.com/snap/v1/transactions";
  const auth = btoa(`${c.env.MIDTRANS_SERVER_KEY}:`);

  const res = await fetch(midtransUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      transaction_details: { order_id: orderId, gross_amount: MONTHLY_PRICE_IDR },
      customer_details: { email: user.email, first_name: company.name },
      item_details: [{ id: "subscription-monthly", price: MONTHLY_PRICE_IDR, quantity: 1, name: "Ledger — Langganan bulanan" }],
    }),
  });
  const data = await res.json();
  if (!res.ok) return c.json({ error: data.error_messages?.join(", ") || "Failed to create payment" }, 500);
  return c.json({
    token: data.token,
    redirect_url: data.redirect_url,
    client_key: c.env.MIDTRANS_CLIENT_KEY,
    is_production: c.env.MIDTRANS_IS_PRODUCTION === "true",
  });
});

app.post("/api/billing/notification", async (c) => {
  const body = await c.req.json();
  const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status } = body;

  const raw = `${order_id}${status_code}${gross_amount}${c.env.MIDTRANS_SERVER_KEY}`;
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(raw));
  const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected !== signature_key) return c.json({ error: "Invalid signature" }, 403);

  const payment = await c.env.DB.prepare("SELECT * FROM payments WHERE order_id = ?").bind(order_id).first();
  if (!payment) return c.json({ error: "Unknown order" }, 404);

  const isSuccess = transaction_status === "capture" || transaction_status === "settlement";
  const isFailed = ["deny", "cancel", "expire"].includes(transaction_status);

  if (isSuccess && fraud_status !== "deny") {
    await c.env.DB.prepare(
      "UPDATE payments SET status = 'paid', paid_at = datetime('now'), midtrans_transaction_id = ? WHERE order_id = ?"
    )
      .bind(body.transaction_id || null, order_id)
      .run();

    const company = await c.env.DB.prepare("SELECT subscription_expires_at, plan_status FROM companies WHERE id = ?")
      .bind(payment.company_id)
      .first();
    const now = new Date();
    const base =
      company.plan_status === "active" && company.subscription_expires_at && new Date(company.subscription_expires_at) > now
        ? new Date(company.subscription_expires_at)
        : now;
    base.setDate(base.getDate() + 30);
    await c.env.DB.prepare("UPDATE companies SET plan_status = 'active', subscription_expires_at = ? WHERE id = ?")
      .bind(base.toISOString(), payment.company_id)
      .run();
  } else if (isFailed) {
    await c.env.DB.prepare("UPDATE payments SET status = ? WHERE order_id = ?").bind(transaction_status, order_id).run();
  }

  return c.json({ ok: true });
});

// ---------- scheduled: mark absences for the day that just ended ----------

async function runDailySweep(env) {
  const db = env.DB;
  const yesterday = todayStr(new Date(Date.now() - 86400000));
  const { results: companies } = await db.prepare("SELECT id FROM companies").all();
  for (const company of companies) {
    const holiday = await db
      .prepare("SELECT id FROM holidays WHERE company_id = ? AND date = ?")
      .bind(company.id, yesterday)
      .first();
    if (holiday) continue;

    const { results: employees } = await db
      .prepare("SELECT id FROM employees WHERE company_id = ? AND status = 'active'")
      .bind(company.id)
      .all();
    for (const emp of employees) {
      const existing = await db
        .prepare("SELECT id FROM attendance WHERE employee_id = ? AND work_date = ?")
        .bind(emp.id, yesterday)
        .first();
      if (!existing) {
        await db
          .prepare(
            "INSERT INTO attendance (company_id, employee_id, work_date, status) VALUES (?, ?, ?, 'absent')"
          )
          .bind(company.id, emp.id, yesterday)
          .run();
        await db
          .prepare(
            "INSERT INTO notifications (company_id, employee_id, type, message) VALUES (?, ?, 'absent', ?)"
          )
          .bind(company.id, emp.id, `Marked absent on ${yesterday} (no check-in recorded)`)
          .run();
      }
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySweep(env));
  },
};
