// TEMPETO 2.0 — daily planner
// The `tasks` array is the single source of truth. The page is redrawn from it
// every time something changes, and it is saved to Local Storage each time.

const STORAGE_KEY = "tempetoTasks";          // same key as version 1, so old tasks still load
const CELEBRATION_KEY = "tempetoCelebrated"; // remembers which dates already got the celebration
const SPLASH_TIME = 3500;                    // splash screen length in milliseconds

let tasks = loadTasks();
let celebrated = loadCelebrated();
let currentFilter = "all";
let editingTaskId = null;
let pendingDetails = null;   // task details waiting for the "overlap" decision
let celebrateDate = null;    // date the celebration modal belongs to
let toastTimer;

// ---------- DOM ELEMENTS ----------
const $ = id => document.getElementById(id);

const splashScreen = $("splashScreen");
const appShell = $("appShell");
const dashboardView = $("dashboardView");
const historyView = $("historyView");
const tasksSection = $("tasksSection");
const datePicker = $("datePicker");
const prettyDate = $("prettyDate");
const greeting = $("greeting");
const welcomeCopy = $("welcomeCopy");
const todayLabel = $("todayLabel");

const totalCount = $("totalCount");
const doneCount = $("doneCount");
const pendingCount = $("pendingCount");
const progressPercent = $("progressPercent");
const progressFill = $("progressFill");
const progressBar = $("progressBar");
const progressCaption = $("progressCaption");

const scheduledTasks = $("scheduledTasks");
const unscheduledTasks = $("unscheduledTasks");
const scheduledCount = $("scheduledCount");
const unscheduledCount = $("unscheduledCount");
const clearCompletedButton = $("clearCompletedButton");
const historyList = $("historyList");

const taskModal = $("taskModal");
const overlapModal = $("overlapModal");
const celebrateModal = $("celebrateModal");
const taskForm = $("taskForm");
const modalTitle = $("modalTitle");
const taskNameInput = $("taskName");
const startTimeInput = $("startTime");
const endTimeInput = $("endTime");
const importantInput = $("importantTask");
const formError = $("formError");
const saveTaskButton = $("saveTaskButton");
const toast = $("toast");

// ---------- LOCAL STORAGE ----------
function loadTasks() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    // Make older saved tasks (version 1) compatible with the new "archived" property.
    return saved
      .filter(task => task && typeof task.name === "string" && task.date)
      .map(task => ({
        id: task.id,
        name: task.name,
        date: task.date,
        startTime: task.startTime || null,
        endTime: task.endTime || null,
        duration: task.duration || null,
        status: task.status === "done" ? "done" : "pending",
        isImportant: Boolean(task.isImportant),
        archived: Boolean(task.archived)
      }));
  } catch (error) {
    console.error("Could not read Tempeto tasks:", error);
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (error) {
    console.error("Could not save Tempeto tasks:", error);
    showToast("Could not save your tasks. Check your browser storage settings.");
  }
}

function loadCelebrated() {
  try {
    const saved = JSON.parse(localStorage.getItem(CELEBRATION_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (error) {
    return {};
  }
}

function saveCelebrated() {
  try {
    localStorage.setItem(CELEBRATION_KEY, JSON.stringify(celebrated));
  } catch (error) {
    console.error("Could not save celebration state:", error);
  }
}

// ---------- DATE AND TIME HELPERS ----------
function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSelectedDate() {
  if (!datePicker.value) datePicker.value = getLocalDateString();
  return datePicker.value;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return new Intl.DateTimeFormat("en", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);
}

function calculateDuration(startTime, endTime) {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Tasks that are still on the daily list (not moved to history).
function getActiveTasks(date) {
  return tasks.filter(task => task.date === date && !task.archived);
}

function updateWelcomeSection(dateString) {
  prettyDate.textContent = formatDate(dateString);
  const hour = new Date().getHours();
  greeting.textContent = hour < 12 ? "Good morning!" : hour < 17 ? "Good afternoon!" : "Good evening!";

  if (dateString === getLocalDateString()) {
    todayLabel.textContent = "YOUR DAILY SPACE";
    welcomeCopy.textContent = "A fresh day, a fresh opportunity. Let's make it count.";
  } else {
    todayLabel.textContent = "YOUR SELECTED DAY";
    welcomeCopy.textContent = "Plan it well and make that day count too.";
  }
}

// ---------- VALIDATION ----------
function validateTask(name, startTime, endTime) {
  if (!name.trim()) return "Please enter a task name.";
  if ((startTime && !endTime) || (!startTime && endTime)) {
    return "Please enter both a start time and an end time, or leave both empty.";
  }
  if (startTime && endTime && endTime <= startTime) {
    return "The end time must be later than the start time.";
  }
  return "";
}

// Two time ranges overlap when each one begins before the other one ends.
function findScheduleConflict(startTime, endTime, date, ignoredTaskId = null) {
  if (!startTime || !endTime) return null;
  return tasks.find(task => {
    if (task.date !== date || task.archived || task.id === ignoredTaskId) return false;
    if (!task.startTime || !task.endTime) return false;
    return startTime < task.endTime && endTime > task.startTime;
  }) || null;
}

// ---------- TASK ACTIONS ----------
function makeId() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function addTask(details) {
  tasks.push({
    id: makeId(),
    name: details.name.trim(),
    date: details.date,
    startTime: details.startTime || null,
    endTime: details.endTime || null,
    duration: details.startTime && details.endTime ? calculateDuration(details.startTime, details.endTime) : null,
    status: "pending",
    isImportant: details.isImportant,
    archived: false
  });
  afterTaskChange(details.date);
}

function editTask(taskId, details) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  task.name = details.name.trim();
  task.startTime = details.startTime || null;
  task.endTime = details.endTime || null;
  task.duration = task.startTime && task.endTime ? calculateDuration(task.startTime, task.endTime) : null;
  task.isImportant = details.isImportant;
  afterTaskChange(task.date);
}

function deleteTask(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  tasks = tasks.filter(item => item.id !== taskId);
  afterTaskChange(task.date);
  showToast("Task deleted.");
}

function toggleStatus(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  task.status = task.status === "done" ? "pending" : "done";
  afterTaskChange(task.date);

  if (task.status === "done" && checkDailyCompletion(task.date)) return; // celebration replaces the toast
  showToast(task.status === "done" ? "Task completed. Well done!" : "Task moved back to pending.");
}

function togglePriority(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  task.isImportant = !task.isImportant;
  afterTaskChange(task.date);
  showToast(task.isImportant ? "Marked as important." : "Priority removed.");
}

// Save, reset the celebration flag if the day is no longer finished, and redraw.
function afterTaskChange(date) {
  const day = getActiveTasks(date);
  if (celebrated[date] && (day.length === 0 || day.some(task => task.status === "pending"))) {
    delete celebrated[date];
    saveCelebrated();
  }
  saveTasks();
  renderDashboard();
  renderHistory();
}

// Move finished tasks into Completed History. Nothing is deleted.
function archiveCompletedTasks(date) {
  let moved = 0;
  tasks.forEach(task => {
    if (task.date === date && task.status === "done" && !task.archived) {
      task.archived = true;
      moved++;
    }
  });
  if (moved > 0) afterTaskChange(date);
  return moved;
}

// Shows the celebration only the first time a day becomes fully complete.
function checkDailyCompletion(date) {
  const day = getActiveTasks(date);
  if (day.length === 0 || day.some(task => task.status === "pending")) return false;
  if (celebrated[date]) return false;

  celebrated[date] = true;
  saveCelebrated();
  celebrateDate = date;
  setTimeout(() => openModal(celebrateModal), 350);
  return true;
}

// ---------- MODALS ----------
function openModal(modal) {
  modal._lastFocus = document.activeElement;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal(modal) {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-backdrop.open")) document.body.style.overflow = "";
  if (modal._lastFocus && modal._lastFocus.focus) modal._lastFocus.focus();
}

function openTaskForm(taskId = null) {
  editingTaskId = taskId;
  taskForm.reset();
  formError.textContent = "";

  if (taskId) {
    const task = tasks.find(item => item.id === taskId);
    if (!task) return;
    modalTitle.textContent = "Edit task";
    saveTaskButton.textContent = "Save changes";
    taskNameInput.value = task.name;
    startTimeInput.value = task.startTime || "";
    endTimeInput.value = task.endTime || "";
    importantInput.checked = task.isImportant;
  } else {
    modalTitle.textContent = "Add a task";
    saveTaskButton.textContent = "Save task";
  }

  openModal(taskModal);
  setTimeout(() => taskNameInput.focus(), 120);
}

function closeTaskForm() {
  closeModal(taskModal);
  editingTaskId = null;
  pendingDetails = null;
  taskForm.reset();
  formError.textContent = "";
}

// ---------- TASK DISPLAY ----------
function createTaskCard(task) {
  const done = task.status === "done";
  const timeText = task.startTime && task.endTime
    ? `${formatTime(task.startTime)} – ${formatTime(task.endTime)}  ·  ${formatDuration(task.duration)}`
    : "No time assigned";
  const star = task.isImportant ? "★" : "☆";
  const starTitle = task.isImportant ? "Remove important status" : "Mark as important";

  return `
    <article class="task-card${task.isImportant ? " important" : ""}${done ? " completed" : ""}" data-id="${escapeHtml(task.id)}">
      <button type="button" class="task-check${done ? " checked" : ""}" data-action="toggle"
        aria-label="${done ? "Mark task as pending" : "Mark task as done"}">${done ? "✓" : ""}</button>
      <div class="task-main">
        <div class="task-title-row">
          <span class="task-name">${escapeHtml(task.name)}</span>
          ${task.isImportant ? '<span class="important-tag">★ IMPORTANT</span>' : ""}
        </div>
        <div class="task-meta">${escapeHtml(timeText)}</div>
      </div>
      <span class="task-status${done ? " done" : ""}">${done ? "Done" : "Pending"}</span>
      <div class="task-actions">
        <button type="button" class="task-action${task.isImportant ? " star-on" : ""}" data-action="priority"
          title="${starTitle}" aria-label="${starTitle}" aria-pressed="${task.isImportant}">${star}</button>
        <button type="button" class="task-action" data-action="edit" title="Edit task" aria-label="Edit task">✎</button>
        <button type="button" class="task-action delete" data-action="delete" title="Delete task" aria-label="Delete task">⌫</button>
      </div>
    </article>`;
}

function createEmptyState(title, message) {
  return `<div class="empty-state"><span class="empty-icon">✳</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

// filterTasks(): returns only the tasks that match the chosen filter.
function filterTasks(dayTasks) {
  if (currentFilter === "pending") return dayTasks.filter(task => task.status === "pending");
  if (currentFilter === "done") return dayTasks.filter(task => task.status === "done");
  return dayTasks;
}

function renderTaskSection(container, sectionTasks, sectionName, hasAnyTasks) {
  if (sectionTasks.length > 0) {
    container.innerHTML = sectionTasks.map(createTaskCard).join("");
    return;
  }
  if (currentFilter !== "all" && hasAnyTasks) {
    const label = currentFilter === "done" ? "completed" : "pending";
    container.innerHTML = createEmptyState(`No ${label} ${sectionName} tasks`, "Try another filter to see more of your tasks.");
  } else if (sectionName === "scheduled") {
    container.innerHTML = createEmptyState("Your schedule is clear", "Add a task with a start and end time and it will appear here.");
  } else {
    container.innerHTML = createEmptyState("No unscheduled tasks", "Tasks without a time will appear here.");
  }
}

// renderTasks(): draws the scheduled and unscheduled lists for the selected date.
function renderTasks(dayTasks) {
  const visible = filterTasks(dayTasks);
  const scheduled = visible
    .filter(task => task.startTime && task.endTime)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
  const unscheduled = visible.filter(task => !task.startTime && !task.endTime);

  const allScheduled = dayTasks.filter(task => task.startTime && task.endTime).length;
  const allUnscheduled = dayTasks.length - allScheduled;

  scheduledCount.textContent = plural(allScheduled, "task");
  unscheduledCount.textContent = plural(allUnscheduled, "task");

  renderTaskSection(scheduledTasks, scheduled, "scheduled", allScheduled > 0);
  renderTaskSection(unscheduledTasks, unscheduled, "unscheduled", allUnscheduled > 0);
}

// ---------- SUMMARY AND PROGRESS ----------
function updateSummary(dayTasks) {
  const total = dayTasks.length;
  const completed = dayTasks.filter(task => task.status === "done").length;
  const pending = total - completed;

  totalCount.textContent = total;
  doneCount.textContent = completed;
  pendingCount.textContent = pending;
  $("allFilterCount").textContent = total;
  $("pendingFilterCount").textContent = pending;
  $("doneFilterCount").textContent = completed;
  clearCompletedButton.hidden = completed === 0;

  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  updateProgress(percentage, completed, total);
}

// The bar blends smoothly: amber → mint → sky blue → periwinkle → lavender.
const PROGRESS_COLORS = ["#F6A623", "#1FBF8F", "#2EA8F5", "#5B5BF0", "#9B6BF2"];

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function getProgressColor(percentage) {
  const position = (Math.min(Math.max(percentage, 0), 100) / 100) * (PROGRESS_COLORS.length - 1);
  const index = Math.min(Math.floor(position), PROGRESS_COLORS.length - 2);
  const mix = position - index;
  const from = hexToRgb(PROGRESS_COLORS[index]);
  const to = hexToRgb(PROGRESS_COLORS[index + 1]);
  const rgb = from.map((value, i) => Math.round(value + (to[i] - value) * mix));
  return `rgb(${rgb.join(",")})`;
}

function updateProgress(percentage, completed, total) {
  progressPercent.textContent = `${percentage}%`;
  progressFill.style.width = `${percentage}%`;
  progressBar.setAttribute("aria-valuenow", percentage);
  document.documentElement.style.setProperty("--progress-color", getProgressColor(percentage));

  if (total === 0) {
    progressCaption.textContent = "Your day is looking empty. Add your first task to get started!";
  } else if (percentage === 100) {
    progressCaption.textContent = "Everything is complete. You made today count!";
  } else {
    progressCaption.textContent = `${completed} of ${total} tasks completed. Keep going at your own pace.`;
  }
}

function updateFilterButtons() {
  document.querySelectorAll(".filter-button").forEach(button => {
    button.classList.toggle("active", button.dataset.filter === currentFilter);
  });
  document.querySelectorAll(".summary-card").forEach(card => {
    const selected = card.dataset.filter === currentFilter;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", selected);
  });
}

function setFilter(filter, scrollToTasks = false) {
  currentFilter = filter;
  renderDashboard();
  if (scrollToTasks) tasksSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDashboard() {
  const date = getSelectedDate();
  const dayTasks = getActiveTasks(date);
  updateWelcomeSection(date);
  updateSummary(dayTasks);
  renderTasks(dayTasks);
  updateFilterButtons();
}

// ---------- COMPLETED HISTORY ----------
function renderHistory() {
  const archived = tasks.filter(task => task.archived);

  if (archived.length === 0) {
    historyList.innerHTML = createEmptyState(
      "No completed tasks yet",
      "When you clear your completed tasks, they'll be kept here so you can look back on them."
    );
    return;
  }

  const dates = [...new Set(archived.map(task => task.date))].sort().reverse(); // newest first
  historyList.innerHTML = dates.map(date => {
    const items = archived
      .filter(task => task.date === date)
      .sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"));

    const rows = items.map(task => {
      const meta = task.startTime && task.endTime
        ? `${formatTime(task.startTime)} – ${formatTime(task.endTime)}  ·  ${formatDuration(task.duration)}`
        : "No fixed time";
      return `
        <div class="history-item" data-id="${escapeHtml(task.id)}">
          <span class="history-check" aria-hidden="true">✓</span>
          <div class="history-main">
            <div class="history-name">${escapeHtml(task.name)}</div>
            <div class="history-meta">${escapeHtml(meta)}</div>
          </div>
          <span class="task-status done">Completed</span>
          <button type="button" class="task-action delete" data-action="remove-history"
            title="Remove from history" aria-label="Remove from history">⌫</button>
        </div>`;
    }).join("");

    return `<section class="history-group">
      <h3 class="history-date">${escapeHtml(formatDate(date))} <small>${plural(items.length, "task")}</small></h3>
      ${rows}
    </section>`;
  }).join("");
}

// Remove one task from Completed History (with a short Undo window).
let lastRemoved = null;

function removeFromHistory(taskId) {
  const index = tasks.findIndex(task => task.id === taskId && task.archived);
  if (index === -1) return;
  lastRemoved = { task: tasks[index], index };
  tasks.splice(index, 1);
  saveTasks();
  renderHistory();
  showToast("Removed from history.", undoRemoveFromHistory);
}

function undoRemoveFromHistory() {
  if (!lastRemoved) return;
  tasks.splice(Math.min(lastRemoved.index, tasks.length), 0, lastRemoved.task);
  lastRemoved = null;
  saveTasks();
  renderHistory();
  showToast("Task restored to history.");
}

// ---------- VIEWS AND NAVIGATION ----------
function showView(view) {
  const showingHistory = view === "history";
  dashboardView.hidden = showingHistory;
  historyView.hidden = !showingHistory;
  document.body.classList.toggle("view-history", showingHistory);

  document.querySelectorAll("[data-view].nav-link, [data-view].mobile-nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.view === view);
  });

  requestAnimationFrame(() => {
    if (view === "tasks") tasksSection.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// ---------- FEEDBACK ----------
function showToast(message, undoAction = null) {
  toast.textContent = message;
  if (undoAction) {
    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.className = "toast-undo";
    undoButton.textContent = "Undo";
    undoButton.addEventListener("click", () => {
      toast.classList.remove("show");
      undoAction();
    });
    toast.appendChild(undoButton);
  }
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), undoAction ? 5000 : 2600);
}

// ---------- SAVING FROM THE FORM ----------
function saveFromForm(details) {
  const wasEditing = Boolean(editingTaskId);
  if (wasEditing) editTask(editingTaskId, details);
  else addTask(details);
  closeTaskForm();
  showToast(wasEditing ? "Task updated." : "Task added to your day.");
}

// ---------- EVENT LISTENERS ----------
$("addTaskButton").addEventListener("click", () => openTaskForm());
$("mobileAddButton").addEventListener("click", () => openTaskForm());
$("closeModalButton").addEventListener("click", closeTaskForm);
$("cancelModalButton").addEventListener("click", closeTaskForm);

taskModal.addEventListener("click", event => {
  if (event.target === taskModal) closeTaskForm();
});

taskForm.addEventListener("submit", event => {
  event.preventDefault();

  const name = taskNameInput.value;
  const startTime = startTimeInput.value;
  const endTime = endTimeInput.value;
  const error = validateTask(name, startTime, endTime);

  if (error) {
    formError.textContent = error;
    return;
  }
  formError.textContent = "";

  const editedTask = editingTaskId ? tasks.find(task => task.id === editingTaskId) : null;
  const details = {
    name, startTime, endTime,
    isImportant: importantInput.checked,
    date: editedTask ? editedTask.date : getSelectedDate()
  };

  // Warn about clashes, but let the person decide.
  const conflict = findScheduleConflict(startTime, endTime, details.date, editingTaskId);
  if (conflict) {
    pendingDetails = details;
    $("overlapMessage").textContent =
      `This overlaps with "${conflict.name}" (${formatTime(conflict.startTime)} – ${formatTime(conflict.endTime)}). Do you want to save it anyway?`;
    openModal(overlapModal);
    return;
  }
  saveFromForm(details);
});

$("overlapCancelButton").addEventListener("click", () => {
  pendingDetails = null;
  closeModal(overlapModal);
});

$("overlapSaveButton").addEventListener("click", () => {
  const details = pendingDetails;
  pendingDetails = null;
  closeModal(overlapModal);
  if (details) saveFromForm(details);
});

// Task cards: one listener handles every button inside the lists.
function handleTaskClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".task-card");
  if (!card) return;
  const id = card.dataset.id;

  if (button.dataset.action === "toggle") toggleStatus(id);
  else if (button.dataset.action === "priority") togglePriority(id);
  else if (button.dataset.action === "edit") openTaskForm(id);
  else if (button.dataset.action === "delete") deleteTask(id);
}
scheduledTasks.addEventListener("click", handleTaskClick);
unscheduledTasks.addEventListener("click", handleTaskClick);

historyList.addEventListener("click", event => {
  const button = event.target.closest('[data-action="remove-history"]');
  const row = button && button.closest(".history-item");
  if (row) removeFromHistory(row.dataset.id);
});

// Filters and summary cards share the same filter.
document.querySelectorAll(".filter-button").forEach(button => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});
document.querySelectorAll(".summary-card").forEach(card => {
  card.addEventListener("click", () => setFilter(card.dataset.filter, true));
});

clearCompletedButton.addEventListener("click", () => {
  const moved = archiveCompletedTasks(getSelectedDate());
  if (moved > 0) showToast(`${plural(moved, "task")} moved to Completed History.`);
});

// Celebration modal buttons
$("celebrateClearButton").addEventListener("click", () => {
  closeModal(celebrateModal);
  const moved = archiveCompletedTasks(celebrateDate || getSelectedDate());
  if (moved > 0) showToast(`${plural(moved, "task")} moved to Completed History.`);
});
$("celebrateKeepButton").addEventListener("click", () => closeModal(celebrateModal));

// Date picker
datePicker.addEventListener("change", () => {
  getSelectedDate();
  renderDashboard();
});

// Navigation (header and bottom bar)
document.querySelectorAll("[data-view]").forEach(link => {
  link.addEventListener("click", event => {
    event.preventDefault();
    showView(link.dataset.view);
  });
});

// Escape key closes the top-most open dialog
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (overlapModal.classList.contains("open")) {
    pendingDetails = null;
    closeModal(overlapModal);
  } else if (celebrateModal.classList.contains("open")) {
    closeModal(celebrateModal);
  } else if (taskModal.classList.contains("open")) {
    closeTaskForm();
  }
});

// ---------- STARTUP ----------
datePicker.value = getLocalDateString();
renderDashboard();
renderHistory();

// Splash screen stays for about 3 seconds, then fades out.
setTimeout(() => {
  splashScreen.classList.add("hide");
  appShell.classList.add("show");
}, SPLASH_TIME);
