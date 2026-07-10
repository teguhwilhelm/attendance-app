const state = { me: null, employees: [], shifts: [] };

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ---------- dark mode ----------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
})();
document.getElementById("theme-toggle").onclick = () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
};

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3000);
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { timeout: 5000 }
    );
  });
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function badge(status) {
  const label = { present: "Present", late: "Late", absent: "Absent", on_leave: "On leave", half_day: "Half day" }[status] || status;
  return `<span class="badge badge-${status}">${label}</span>`;
}

// ---------- auth ----------

document.getElementById("tab-login").onclick = () => setAuthTab("login");
document.getElementById("tab-register").onclick = () => setAuthTab("register");
function setAuthTab(tab) {
  document.getElementById("tab-login").classList.toggle("active-tab", tab === "login");
  document.getElementById("tab-register").classList.toggle("active-tab", tab === "register");
  document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
}

document.getElementById("login-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
};

document.getElementById("register-form").onsubmit = async (e) => {
  e.preventDefault();
  const company_name = document.getElementById("reg-company").value;
  const email = document.getElementById("reg-email").value;
  const password = document.getElementById("reg-password").value;
  const errEl = document.getElementById("register-error");
  errEl.classList.add("hidden");
  try {
    await api("/api/auth/register", { method: "POST", body: JSON.stringify({ company_name, email, password }) });
    await boot();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
};

document.getElementById("logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
};

// ---------- forgot / reset password ----------

document.getElementById("show-forgot").onclick = () => {
  document.getElementById("login-form").classList.add("hidden");
  document.getElementById("register-form").classList.add("hidden");
  document.getElementById("forgot-form").classList.remove("hidden");
};
document.getElementById("back-to-login").onclick = () => {
  document.getElementById("forgot-form").classList.add("hidden");
  setAuthTab("login");
};

document.getElementById("forgot-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById("forgot-email").value;
  const msgEl = document.getElementById("forgot-message");
  try {
    await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
    msgEl.textContent = "Kalau email itu terdaftar, link reset password sudah dikirim. Cek inbox/spam kamu.";
    msgEl.classList.remove("hidden", "text-danger");
    msgEl.classList.add("text-success");
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.classList.remove("hidden", "text-success");
    msgEl.classList.add("text-danger");
  }
};

document.getElementById("reset-password-form").onsubmit = async (e) => {
  e.preventDefault();
  const token = new URLSearchParams(location.search).get("reset");
  const password = document.getElementById("reset-password-input").value;
  const errEl = document.getElementById("reset-password-error");
  try {
    await api("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password }) });
    toast("Password berhasil diubah, silakan sign in.");
    location.href = location.origin;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
};

(function checkResetLink() {
  const token = new URLSearchParams(location.search).get("reset");
  if (token) {
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("reset-password-screen").classList.remove("hidden");
  }
})();

// ---------- mobile sidebar drawer ----------

const sidebarEl = document.querySelector(".app-sidebar");
const overlayEl = document.getElementById("sidebar-overlay");
document.getElementById("hamburger-btn").onclick = () => {
  sidebarEl.classList.add("open");
  overlayEl.classList.add("open");
};
function closeSidebar() {
  sidebarEl.classList.remove("open");
  overlayEl.classList.remove("open");
}
overlayEl.onclick = closeSidebar;

// ---------- navigation ----------

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.onclick = () => { showView(btn.dataset.view); closeSidebar(); };
});

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById("view-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("view-title").textContent = {
    dashboard: "Dashboard", attendance: "Attendance", employees: "Employees",
    reports: "Reports & analytics", notifications: "Notifications", settings: "Settings", billing: "Billing",
  }[name];
  if (name === "employees") loadEmployees();
  if (name === "attendance") loadAttendance();
  if (name === "reports") loadReports();
  if (name === "notifications") loadNotifications();
  if (name === "settings") loadSettings();
  if (name === "billing") loadBilling();
}

// ---------- boot ----------

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.me = me;

    const billing = await api("/api/billing/status").catch(() => ({ is_active: true }));
    state.billing = billing;
    if (!billing.is_active) {
      document.getElementById("auth-screen").classList.add("hidden");
      document.getElementById("app-shell").classList.add("hidden");
      showPaywall(billing);
      return;
    }
    document.getElementById("paywall-screen").classList.add("hidden");

    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");
    document.body.classList.toggle("is-admin", me.user.role === "admin");
    document.getElementById("company-badge").textContent = me.company.name;
    document.getElementById("who-am-i").textContent = `${me.user.email} · ${me.user.role}`;
    if (me.user.role !== "admin") {
      document.getElementById("btn-checkin").classList.remove("hidden");
      document.getElementById("btn-checkout").classList.remove("hidden");
    } else if (!me.employee) {
      document.getElementById("btn-checkin").disabled = true;
      document.getElementById("btn-checkout").disabled = true;
    }
    startClock();
    await loadEmployeesQuiet();
    await loadDashboard();
    await pollNotifDot();
  } catch {
    if (!new URLSearchParams(location.search).get("reset")) {
      document.getElementById("auth-screen").classList.remove("hidden");
    }
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("paywall-screen").classList.add("hidden");
  }
}

// ---------- billing / paywall ----------

function formatIDR(n) {
  return "Rp" + Number(n).toLocaleString("id-ID");
}

function showPaywall(billing) {
  document.getElementById("paywall-screen").classList.remove("hidden");
  document.getElementById("paywall-message").textContent =
    billing.plan_status === "trial"
      ? "Masa trial gratis 14 hari kamu sudah habis."
      : "Langganan bulanan kamu sudah berakhir.";
  document.getElementById("paywall-price").textContent = formatIDR(billing.monthly_price) + " / bulan";
}

async function startCheckout() {
  try {
    const res = await api("/api/billing/checkout", { method: "POST" });
    document.head.querySelectorAll('script[data-snap]').forEach((s) => s.remove());
    const script = document.createElement("script");
    script.setAttribute("data-snap", "1");
    script.setAttribute("data-client-key", res.client_key);
    script.src = res.is_production ? "https://app.midtrans.com/snap/snap.js" : "https://app.sandbox.midtrans.com/snap/snap.js";
    script.onload = () => {
      window.snap.pay(res.token, {
        onSuccess: () => { toast("Pembayaran berhasil!"); boot(); },
        onPending: () => toast("Pembayaran diproses, mohon tunggu konfirmasi."),
        onError: () => toast("Pembayaran gagal, coba lagi."),
        onClose: () => {},
      });
    };
    document.head.appendChild(script);
  } catch (err) { toast(err.message); }
}

document.getElementById("paywall-pay-btn").onclick = startCheckout;
document.getElementById("billing-pay-btn").onclick = startCheckout;
document.getElementById("paywall-logout-btn").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
};

async function loadBilling() {
  const billing = await api("/api/billing/status");
  const el = document.getElementById("billing-status-text");
  if (billing.plan_status === "trial") {
    el.innerHTML = `Kamu sedang masa trial gratis — <b>${billing.trial_days_left} hari lagi</b>. Setelah itu, langganan bulanan ${formatIDR(billing.monthly_price)}.`;
  } else if (billing.is_active) {
    el.innerHTML = `Langganan aktif sampai <b>${new Date(billing.subscription_expires_at).toLocaleDateString("id-ID")}</b>.`;
  } else {
    el.innerHTML = `Langganan sudah berakhir. Bayar ${formatIDR(billing.monthly_price)} untuk mengaktifkan lagi.`;
  }
}

function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById("ledger-clock").textContent = now.toLocaleTimeString([], { hour12: false });
    document.getElementById("ledger-date").textContent = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- dashboard ----------

document.getElementById("btn-checkin").onclick = async () => {
  const loc = await getLocation();
  try {
    const r = await api("/api/attendance/checkin", { method: "POST", body: JSON.stringify(loc) });
    toast(`Checked in — ${r.status}${r.verified ? "" : " (location not verified)"}`);
    loadDashboard();
  } catch (err) { toast(err.message); }
};
document.getElementById("btn-checkout").onclick = async () => {
  const loc = await getLocation();
  try {
    const r = await api("/api/attendance/checkout", { method: "POST", body: JSON.stringify(loc) });
    toast(`Checked out${r.verified ? "" : " (location not verified)"}`);
    loadDashboard();
  } catch (err) { toast(err.message); }
};

async function loadDashboard() {
  const { records } = await api("/api/attendance?view=daily");
  const present = records.filter((r) => r.status === "present").length;
  const late = records.filter((r) => r.status === "late").length;
  const absent = records.filter((r) => r.status === "absent").length;
  document.getElementById("stat-present").textContent = present;
  document.getElementById("stat-late").textContent = late;
  document.getElementById("stat-absent").textContent = absent;

  const tbody = document.querySelector("#today-table tbody");
  tbody.innerHTML = records.map((r) => `
    <tr>
      <td class="font-sans font-medium">${r.full_name}</td>
      <td class="font-sans">${r.department || "—"}</td>
      <td>${fmtTime(r.check_in_time)}</td>
      <td>${fmtTime(r.check_out_time)}</td>
      <td>${badge(r.status)}</td>
      <td class="font-sans text-xs">${r.check_in_time ? (r.check_in_verified ? "✅ On site" : "⚠️ Unverified") : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="text-muted font-sans">No attendance recorded yet today.</td></tr>`;
}

// ---------- shifts ----------

async function loadShiftsQuiet() {
  try { state.shifts = await api("/api/shifts"); } catch { state.shifts = []; }
  const sel = document.getElementById("emp-shift");
  const current = sel.value;
  sel.innerHTML = `<option value="">Jam kerja default (tanpa shift)</option>` +
    state.shifts.map((s) => `<option value="${s.id}">${s.name} (${s.start_time}–${s.end_time})</option>`).join("");
  sel.value = current;
}

async function loadShiftsSettings() {
  await loadShiftsQuiet();
  document.getElementById("shifts-list").innerHTML = state.shifts.map((s) => `
    <div class="flex items-center justify-between border border-line rounded-lg px-3 py-2 text-sm">
      <div>
        <span class="font-medium">${s.name}</span>
        <span class="text-muted font-mono ml-2">${s.start_time}–${s.end_time}</span>
        <span class="text-muted text-xs ml-2">toleransi ${s.late_grace_minutes}m</span>
      </div>
      <button class="text-danger underline text-xs" onclick="deleteShift(${s.id})">Hapus</button>
    </div>`).join("") || `<p class="text-sm text-muted">Belum ada shift dibuat.</p>`;
}

window.deleteShift = async (id) => {
  if (!confirm("Hapus shift ini? Karyawan yang memakainya akan kembali ke jam kerja default.")) return;
  await api(`/api/shifts/${id}`, { method: "DELETE" });
  toast("Shift dihapus");
  loadShiftsSettings();
};

document.getElementById("add-shift-btn").onclick = async () => {
  const body = {
    name: document.getElementById("shift-name").value,
    start_time: document.getElementById("shift-start").value,
    end_time: document.getElementById("shift-end").value,
    late_grace_minutes: parseInt(document.getElementById("shift-grace").value) || 0,
  };
  if (!body.name || !body.start_time || !body.end_time) { toast("Isi nama, jam mulai, dan jam selesai dulu"); return; }
  try {
    await api("/api/shifts", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("shift-name").value = "";
    document.getElementById("shift-start").value = "";
    document.getElementById("shift-end").value = "";
    document.getElementById("shift-grace").value = "10";
    toast("Shift ditambahkan");
    loadShiftsSettings();
  } catch (err) { toast(err.message); }
};

// ---------- employees ----------

async function loadEmployeesQuiet() {
  try { state.employees = await api("/api/employees"); } catch { state.employees = []; }
  const sel = document.getElementById("att-employee");
  sel.innerHTML = `<option value="">All employees</option>` + state.employees.map((e) => `<option value="${e.id}">${e.full_name}</option>`).join("");
  await loadShiftsQuiet();
}

async function loadEmployees() {
  await loadEmployeesQuiet();
  const myEmployeeId = state.me?.user?.employee_id;
  const tbody = document.querySelector("#employees-table tbody");
  tbody.innerHTML = state.employees.map((e) => {
    const roleLabel = !e.user_id ? '<span class="text-muted text-xs">No login</span>'
      : e.user_role === "admin" ? '<span class="badge badge-present">Admin</span>'
      : '<span class="badge badge-half_day">Employee</span>';
    const roleToggle = (myEmployeeId !== e.id && e.user_id)
      ? `<button class="text-muted underline" onclick="setEmployeeRole(${e.id}, '${e.user_role === "admin" ? "employee" : "admin"}')">${e.user_role === "admin" ? "Jadikan karyawan" : "Jadikan admin"}</button>`
      : "";
    return `
    <tr>
      <td class="font-sans font-medium">${e.full_name}</td>
      <td class="font-sans">${e.email}</td>
      <td class="font-sans">${e.department || "—"}</td>
      <td class="font-sans">${e.position || "—"}</td>
      <td class="font-sans">${e.shift_name ? `${e.shift_name} (${e.shift_start}–${e.shift_end})` : "Default"}</td>
      <td>${roleLabel}</td>
      <td>${e.status === "active" ? '<span class="badge badge-present">Active</span>' : '<span class="badge badge-half_day">Inactive</span>'}</td>
      <td class="font-sans text-xs whitespace-nowrap space-x-2">
        <button class="text-primary underline" onclick="editEmployee(${e.id})">Edit</button>
        <button class="text-danger underline" onclick="deleteEmployee(${e.id})">Delete</button>
        ${myEmployeeId === e.id ? '<span class="text-success">✓ Ini saya</span>' : ""}
        ${roleToggle}
        ${myEmployeeId !== e.id && !e.user_id && state.me?.user?.role === "admin" ? `<button class="text-muted underline" onclick="linkMe(${e.id})">Jadikan akun saya</button>` : ""}
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="text-muted font-sans p-4">No employees yet — add your first one.</td></tr>`;
}

window.setEmployeeRole = async (id, role) => {
  const label = role === "admin" ? "menjadikan orang ini admin" : "mengembalikan orang ini jadi karyawan biasa";
  if (!confirm(`Yakin ${label}?`)) return;
  try {
    await api(`/api/employees/${id}/set-role`, { method: "POST", body: JSON.stringify({ role }) });
    toast("Role berhasil diubah");
    loadEmployees();
  } catch (err) { toast(err.message); }
};

window.linkMe = async (id) => {
  if (!confirm("Hubungkan akun admin kamu ke data karyawan ini? Kamu akan bisa check-in/check-out pakai akun ini.")) return;
  try {
    await api(`/api/employees/${id}/link-me`, { method: "POST" });
    state.me = await api("/api/auth/me");
    document.getElementById("btn-checkin").disabled = false;
    document.getElementById("btn-checkout").disabled = false;
    toast("Akun kamu sekarang terhubung ke data karyawan ini");
    loadEmployees();
  } catch (err) { toast(err.message); }
};

document.getElementById("btn-add-employee").onclick = () => openEmployeeModal();
document.getElementById("employee-cancel").onclick = () => closeEmployeeModal();
document.getElementById("emp-create-login").onchange = (e) => {
  document.getElementById("emp-password").classList.toggle("hidden", !e.target.checked);
};

function openEmployeeModal(emp) {
  document.getElementById("employee-form").reset();
  document.getElementById("emp-password").classList.add("hidden");
  document.getElementById("emp-id").value = emp ? emp.id : "";
  document.getElementById("emp-name").value = emp ? emp.full_name : "";
  document.getElementById("emp-email").value = emp ? emp.email : "";
  document.getElementById("emp-department").value = emp ? emp.department || "" : "";
  document.getElementById("emp-position").value = emp ? emp.position || "" : "";
  document.getElementById("emp-phone").value = emp ? emp.phone || "" : "";
  document.getElementById("emp-shift").value = emp ? (emp.shift_id || "") : "";
  document.getElementById("emp-status").value = emp ? emp.status : "active";
  document.getElementById("emp-status-wrap").classList.toggle("hidden", !emp);
  document.getElementById("emp-login-wrap").classList.toggle("hidden", !!emp);
  document.getElementById("employee-modal-title").textContent = emp ? "Edit employee" : "Add employee";
  document.getElementById("employee-modal").classList.remove("hidden");
}
function closeEmployeeModal() { document.getElementById("employee-modal").classList.add("hidden"); }

window.editEmployee = (id) => openEmployeeModal(state.employees.find((e) => e.id === id));
window.deleteEmployee = async (id) => {
  if (!confirm("Delete this employee and all of their attendance history? This cannot be undone.")) return;
  try {
    await api(`/api/employees/${id}`, { method: "DELETE" });
    toast("Employee deleted");
    loadEmployees();
  } catch (err) { toast(err.message); }
};

document.getElementById("employee-form").onsubmit = async (e) => {
  e.preventDefault();
  const id = document.getElementById("emp-id").value;
  const body = {
    full_name: document.getElementById("emp-name").value,
    email: document.getElementById("emp-email").value,
    department: document.getElementById("emp-department").value,
    position: document.getElementById("emp-position").value,
    phone: document.getElementById("emp-phone").value,
    shift_id: document.getElementById("emp-shift").value || null,
    status: document.getElementById("emp-status").value,
    create_login: document.getElementById("emp-create-login").checked,
    password: document.getElementById("emp-password").value,
  };
  try {
    if (id) await api(`/api/employees/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/api/employees", { method: "POST", body: JSON.stringify(body) });
    toast("Saved");
    closeEmployeeModal();
    loadEmployees();
  } catch (err) { toast(err.message); }
};

// ---------- attendance ----------

document.getElementById("att-refresh").onclick = loadAttendance;
async function loadAttendance() {
  if (!document.getElementById("att-date").value) document.getElementById("att-date").valueAsDate = new Date();
  const view = document.getElementById("att-view").value;
  const date = document.getElementById("att-date").value;
  const employee_id = document.getElementById("att-employee").value;
  const q = new URLSearchParams({ view, date, ...(employee_id ? { employee_id } : {}) });
  const { start, end, records } = await api(`/api/attendance?${q}`);
  document.getElementById("att-range-label").textContent = start === end ? start : `${start} → ${end}`;
  const isAdmin = state.me?.user?.role === "admin";
  document.querySelector("#att-table tbody").innerHTML = records.map((r) => `
    <tr>
      <td>${r.work_date}</td>
      <td class="font-sans">${r.full_name}</td>
      <td>${fmtTime(r.check_in_time)}</td>
      <td>${fmtTime(r.check_out_time)}</td>
      <td>${badge(r.status)}</td>
      <td class="font-sans text-xs">${r.check_in_time ? (r.check_in_verified ? "✅" : "⚠️") : "—"}</td>
      <td class="font-sans text-xs">${isAdmin ? `<button class="text-danger underline" onclick="deleteAttendance(${r.id})">Delete</button>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="text-muted font-sans p-4">No records for this range.</td></tr>`;
}

window.deleteAttendance = async (id) => {
  if (!confirm("Hapus catatan absensi ini? Tindakan ini tidak bisa dibatalkan.")) return;
  try {
    await api(`/api/attendance/${id}`, { method: "DELETE" });
    toast("Catatan dihapus");
    loadAttendance();
  } catch (err) { toast(err.message); }
};

// ---------- reports ----------

document.getElementById("rep-refresh").onclick = loadReports;
async function loadReports() {
  if (!document.getElementById("rep-end").value) {
    document.getElementById("rep-end").valueAsDate = new Date();
    const s = new Date(); s.setDate(s.getDate() - 30);
    document.getElementById("rep-start").valueAsDate = s;
  }
  const start = document.getElementById("rep-start").value;
  const end = document.getElementById("rep-end").value;
  const data = await api(`/api/reports/summary?start=${start}&end=${end}`);
  document.getElementById("rep-attendance-rate").textContent = data.totals.attendance_rate + "%";
  document.getElementById("rep-tardiness-rate").textContent = data.totals.tardiness_rate + "%";
  document.getElementById("rep-absence-rate").textContent = data.totals.absence_rate + "%";
  document.querySelector("#reports-table tbody").innerHTML = data.by_employee.map((r) => `
    <tr>
      <td class="font-sans font-medium">${r.full_name}</td>
      <td class="font-sans">${r.department || "—"}</td>
      <td>${r.total_days}</td>
      <td class="text-success">${r.present_days}</td>
      <td class="text-warning">${r.late_days}</td>
      <td class="text-danger">${r.absent_days}</td>
      <td>${r.leave_days}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="text-muted font-sans p-4">No data for this range.</td></tr>`;
}

document.getElementById("export-csv").onclick = () => {
  const start = document.getElementById("rep-start").value, end = document.getElementById("rep-end").value;
  window.open(`/api/export/csv?start=${start}&end=${end}`, "_blank");
};
document.getElementById("export-xlsx").onclick = () => {
  const start = document.getElementById("rep-start").value, end = document.getElementById("rep-end").value;
  window.open(`/api/export/xlsx?start=${start}&end=${end}`, "_blank");
};
document.getElementById("export-pdf").onclick = async () => {
  const start = document.getElementById("rep-start").value, end = document.getElementById("rep-end").value;
  const rows = await api(`/api/export/report-data?start=${start}&end=${end}`);
  const w = window.open("", "_blank");
  w.document.write(`
    <html><head><title>Attendance report ${start} to ${end}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:32px;color:#16181D}
      h1{font-size:18px;margin-bottom:2px} p{color:#5B6472;margin-top:0;font-size:13px}
      table{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px}
      th,td{border-bottom:1px solid #E4E7EC;text-align:left;padding:6px 8px}
      th{background:#F7F8FA}
    </style></head><body>
    <h1>Attendance report</h1><p>${start} to ${end}</p>
    <table><thead><tr><th>Employee</th><th>Department</th><th>Date</th><th>Check in</th><th>Check out</th><th>Status</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${r.full_name}</td><td>${r.department||""}</td><td>${r.work_date}</td><td>${r.check_in_time?fmtTime(r.check_in_time):"—"}</td><td>${r.check_out_time?fmtTime(r.check_out_time):"—"}</td><td>${r.status}</td></tr>`).join("")}</tbody>
    </table>
    <script>window.print()<\/script>
    </body></html>`);
  w.document.close();
};

// ---------- notifications ----------

async function loadNotifications() {
  const items = await api("/api/notifications");
  document.getElementById("notif-dot").classList.toggle("hidden", !items.some((n) => !n.is_read));
  document.getElementById("notifications-list").innerHTML = items.map((n) => `
    <div class="p-4 flex items-start justify-between gap-3 ${n.is_read ? "" : "bg-blue-50/40"}">
      <div>
        <span class="badge badge-${n.type === "late" ? "late" : n.type === "absent" ? "absent" : "half_day"}">${n.type}</span>
        <p class="text-sm mt-1">${n.message}</p>
        <p class="text-xs text-muted mt-0.5">${new Date(n.created_at).toLocaleString()}</p>
      </div>
      ${n.is_read ? "" : `<button class="btn-ghost text-xs" onclick="markRead(${n.id})">Mark read</button>`}
    </div>`).join("") || `<div class="p-6 text-muted text-sm">No notifications yet.</div>`;
}
window.markRead = async (id) => { await api(`/api/notifications/${id}/read`, { method: "POST" }); loadNotifications(); };
async function pollNotifDot() {
  try {
    const items = await api("/api/notifications");
    document.getElementById("notif-dot").classList.toggle("hidden", !items.some((n) => !n.is_read));
  } catch {}
  setTimeout(pollNotifDot, 60000);
}

// ---------- settings ----------

async function loadSettings() {
  const c = await api("/api/company");
  document.getElementById("set-lat").value = c.office_lat ?? "";
  document.getElementById("set-lng").value = c.office_lng ?? "";
  document.getElementById("set-radius").value = c.geofence_radius_m ?? 200;
  document.getElementById("set-start").value = c.work_start_time ?? "09:00";
  document.getElementById("set-end").value = c.work_end_time ?? "17:00";
  document.getElementById("set-grace").value = c.late_grace_minutes ?? 10;
  await loadShiftsSettings();
}
document.getElementById("set-use-location").onclick = async () => {
  const loc = await getLocation();
  if (loc.lat) { document.getElementById("set-lat").value = loc.lat; document.getElementById("set-lng").value = loc.lng; }
  else toast("Couldn't read your location — check browser permissions.");
};
document.getElementById("save-settings").onclick = async (e) => {
  e.preventDefault();
  const body = {
    office_lat: parseFloat(document.getElementById("set-lat").value) || null,
    office_lng: parseFloat(document.getElementById("set-lng").value) || null,
    geofence_radius_m: parseInt(document.getElementById("set-radius").value) || 200,
    work_start_time: document.getElementById("set-start").value,
    work_end_time: document.getElementById("set-end").value,
    late_grace_minutes: parseInt(document.getElementById("set-grace").value) || 0,
  };
  await api("/api/company", { method: "PUT", body: JSON.stringify(body) });
  const el = document.getElementById("settings-saved");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2000);
};

boot();
