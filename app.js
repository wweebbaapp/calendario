'use strict';

const PIN_KEY = 'agenda-personale.pin.v1';
const DB_NAME = 'agenda-personale';
const DB_VERSION = 2;
const APPOINTMENTS_STORE = 'appointments';
const NOTE_PAGES_STORE = 'notePages';
const PIN_ITERATIONS = 250000;
const AUTO_LOCK_MS = 60 * 1000;
const MAX_BACKUP_SIZE = 10 * 1024 * 1024;
const LOCALE = 'it-IT';

const state = {
  appointments: [],
  notePages: [],
  activePageId: null,
  currentView: 'calendar',
  viewDate: startOfMonth(new Date()),
  selectedDate: null,
  dayDate: null,
  editingAppointmentId: null,
  editingNoteId: null,
  unlocked: false,
  failedUnlocks: 0,
  unlockBlockedUntil: 0,
  hiddenAt: 0,
  toastTimer: null,
  deferredInstallPrompt: null,
  confirmResolver: null
};

let dbPromise = null;
let swRegistration = null;
let holidayCache = new Map();

const dom = {};

function cacheDom() {
  [
    'bootScreen', 'setupScreen', 'lockScreen', 'appShell',
    'secureWarning', 'setupForm', 'setupPin', 'setupPinConfirm', 'setupError',
    'lockDate', 'unlockForm', 'unlockPin', 'unlockError', 'forgotPinBtn', 'forgotInfo',
    'settingsBtn', 'lockBtn',
    'calendarScreen', 'notesScreen', 'monthLabel', 'prevMonthBtn', 'nextMonthBtn',
    'todayBtn', 'calendarGrid', 'calendarTab', 'notesTab',
    'pageTabs', 'addPageBtn', 'noPagesState', 'createFirstPageBtn', 'notePagePanel',
    'pageCounter', 'activePageTitle', 'pageProgress', 'deletePageBtn', 'addNoteForm',
    'newNoteText', 'addNoteBtn', 'noteList',
    'dayDialog', 'dayRelative', 'dayTitle', 'dayHoliday', 'dayList', 'addAppointmentForDay',
    'appointmentDialog', 'appointmentForm', 'appointmentDateLabel', 'appointmentDialogTitle',
    'appointmentId', 'appointmentDate', 'appointmentTime', 'appointmentDescription',
    'appointmentError', 'saveAppointmentBtn', 'deleteAppointmentBtn',
    'noteDialog', 'noteForm', 'noteText', 'noteError', 'saveNoteBtn', 'deleteNoteBtn',
    'settingsDialog', 'toggleChangePinBtn', 'changePinForm', 'currentPin', 'newPin',
    'newPinConfirm', 'cancelChangePinBtn', 'changePinError', 'exportBtn', 'importBtn',
    'importFile', 'installAppBtn', 'deleteAllBtn',
    'confirmDialog', 'confirmTitle', 'confirmMessage', 'confirmActionBtn', 'confirmCancelBtn',
    'toast'
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateFromKey(key) {
  const parts = String(key).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function parseDateTime(key, time) {
  const day = dateFromKey(key);
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!day || !match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const result = new Date(day);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatMonthYear(date) {
  return capitalize(new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(date));
}

function formatLongDate(date, includeYear = true) {
  const options = { weekday: 'long', day: 'numeric', month: 'long' };
  if (includeYear) options.year = 'numeric';
  return capitalize(new Intl.DateTimeFormat(LOCALE, options).format(date));
}

function formatDateOnly(date) {
  return capitalize(new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date));
}

function dayDifference(first, second) {
  const a = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate());
  const b = Date.UTC(second.getFullYear(), second.getMonth(), second.getDate());
  return Math.round((a - b) / 86400000);
}

function createElement(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === 'className') {
      element.className = value;
    } else if (key === 'text') {
      element.textContent = value;
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else {
      element.setAttribute(key, value);
    }
  });
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function svgIcon(symbol, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

function showScreen(screen) {
  dom.bootScreen.hidden = true;
  dom.setupScreen.hidden = screen !== 'setup';
  dom.lockScreen.hidden = screen !== 'lock';
  dom.appShell.hidden = screen !== 'app';
}

function showToast(message, duration = 3000) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add('is-visible');
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove('is-visible');
  }, duration);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    return false;
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

function base64ToBytes(value) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePinHash(pin, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function createPinRecord(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PIN_ITERATIONS);
  return {
    version: 1,
    algorithm: 'PBKDF2-SHA-256',
    iterations: PIN_ITERATIONS,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash)
  };
}

function readPinRecord() {
  const raw = safeStorageGet(PIN_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return null;
    return record;
  } catch (error) {
    return null;
  }
}

function savePinRecord(record) {
  return safeStorageSet(PIN_KEY, JSON.stringify(record));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

async function verifyPin(pin) {
  const record = readPinRecord();
  if (!record) return false;
  const iterations = Number(record.iterations) || PIN_ITERATIONS;
  const salt = base64ToBytes(record.salt);
  const expected = base64ToBytes(record.hash);
  const actual = await derivePinHash(pin, salt, iterations);
  return timingSafeEqual(actual, expected);
}

function pinIsValid(pin) {
  return /^\d{4,8}$/.test(pin);
}

function cryptoAvailable() {
  return Boolean(window.isSecureContext && window.crypto && window.crypto.subtle);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(APPOINTMENTS_STORE)) {
        const appointments = database.createObjectStore(APPOINTMENTS_STORE, { keyPath: 'id' });
        appointments.createIndex('byDate', 'date', { unique: false });
      }
      if (!database.objectStoreNames.contains(NOTE_PAGES_STORE)) {
        database.createObjectStore(NOTE_PAGES_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Database non disponibile'));
    request.onblocked = () => reject(new Error('Database occupato'));
  });
}

function getDatabase() {
  if (!dbPromise) {
    dbPromise = openDatabase().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function dbGetAll(storeName) {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('Lettura non riuscita'));
  });
}

async function dbPut(storeName, value) {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Salvataggio non riuscito'));
    transaction.onabort = () => reject(transaction.error || new Error('Salvataggio annullato'));
  });
}

async function dbDelete(storeName, id) {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Eliminazione non riuscita'));
  });
}

async function dbReplaceAll(appointments, pages) {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([APPOINTMENTS_STORE, NOTE_PAGES_STORE], 'readwrite');
    const appointmentStore = transaction.objectStore(APPOINTMENTS_STORE);
    const pageStore = transaction.objectStore(NOTE_PAGES_STORE);
    appointmentStore.clear();
    pageStore.clear();
    appointments.forEach((appointment) => appointmentStore.put(appointment));
    pages.forEach((page) => pageStore.put(page));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Importazione non riuscita'));
    transaction.onabort = () => reject(transaction.error || new Error('Importazione annullata'));
  });
}

async function dbClearAll() {
  const database = await getDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([APPOINTMENTS_STORE, NOTE_PAGES_STORE], 'readwrite');
    transaction.objectStore(APPOINTMENTS_STORE).clear();
    transaction.objectStore(NOTE_PAGES_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Eliminazione non riuscita'));
  });
}

function safeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeStoredAppointment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = safeText(raw.date, 10);
  const time = safeText(raw.time, 5);
  if (!parseDateTime(date, time)) return null;
  const description = safeText(raw.description, 500)
    || safeText(raw.person, 100)
    || 'Appuntamento';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    date,
    time,
    description,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
  };
}

function normalizeNoteItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = safeText(raw.text, 500);
  if (!text) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    text,
    checked: Boolean(raw.checked),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString()
  };
}

function normalizeNotePage(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeNoteItem).filter(Boolean).slice(0, 1000)
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title: safeText(raw.title, 50) || `Pagina ${index + 1}`,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    items,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
  };
}

function compareAppointments(a, b) {
  return a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt);
}

function sortNotePages() {
  state.notePages.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

async function loadData() {
  const [storedAppointments, storedPages] = await Promise.all([
    dbGetAll(APPOINTMENTS_STORE),
    dbGetAll(NOTE_PAGES_STORE)
  ]);
  state.appointments = storedAppointments
    .map(normalizeStoredAppointment)
    .filter(Boolean)
    .sort(compareAppointments);
  state.notePages = storedPages
    .map((page, index) => normalizeNotePage(page, index))
    .filter(Boolean);
  sortNotePages();
  state.activePageId = state.notePages[0]?.id || null;
}

function findAppointment(id) {
  return state.appointments.find((appointment) => appointment.id === id) || null;
}

function findPage(id) {
  return state.notePages.find((page) => page.id === id) || null;
}

function getActivePage() {
  let page = findPage(state.activePageId);
  if (!page && state.notePages.length) {
    page = state.notePages[0];
    state.activePageId = page.id;
  }
  return page || null;
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function holidaysForYear(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const holidays = new Map();
  const fixed = [
    [0, 1, 'Capodanno'],
    [0, 6, 'Epifania'],
    [3, 25, 'Festa della Liberazione'],
    [4, 1, 'Festa del Lavoro'],
    [5, 2, 'Festa della Repubblica'],
    [7, 15, 'Ferragosto'],
    [10, 1, 'Ognissanti'],
    [11, 8, 'Immacolata Concezione'],
    [11, 25, 'Natale'],
    [11, 26, 'Santo Stefano']
  ];
  fixed.forEach(([month, day, name]) => {
    holidays.set(dateKey(new Date(year, month, day)), name);
  });
  const easter = easterSunday(year);
  holidays.set(dateKey(easter), 'Pasqua');
  holidays.set(dateKey(addDays(easter, 1)), 'Lunedì dell\'Angelo');
  holidayCache.set(year, holidays);
  return holidays;
}

function holidayName(key) {
  const date = dateFromKey(key);
  if (!date) return null;
  return holidaysForYear(date.getFullYear()).get(key) || null;
}

function switchView(view) {
  state.currentView = view;
  const showCalendar = view === 'calendar';
  dom.calendarScreen.hidden = !showCalendar;
  dom.notesScreen.hidden = showCalendar;
  dom.calendarTab.classList.toggle('is-active', showCalendar);
  dom.notesTab.classList.toggle('is-active', !showCalendar);
  dom.calendarTab.setAttribute('aria-selected', showCalendar ? 'true' : 'false');
  dom.notesTab.setAttribute('aria-selected', showCalendar ? 'false' : 'true');
  if (showCalendar) {
    renderCalendar();
  } else {
    renderNotes();
  }
}

function renderAll() {
  renderCalendar();
  renderNotes();
}

function renderCalendar() {
  const year = state.viewDate.getFullYear();
  const month = state.viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const gridStart = addDays(firstDay, -offset);
  const today = dateKey(new Date());

  const appointmentsByDate = new Set(state.appointments.map((appointment) => appointment.date));

  dom.monthLabel.textContent = formatMonthYear(firstDay);
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < 42; index += 1) {
    const day = addDays(gridStart, index);
    const key = dateKey(day);
    const holiday = holidayName(key);
    const count = state.appointments.filter((appointment) => appointment.date === key).length;
    const outside = day.getMonth() !== month;
    const classes = ['calendar-day'];
    if (outside) classes.push('is-outside');
    if (key === today) classes.push('is-today');
    if (key === state.selectedDate) classes.push('is-selected');
    if (holiday) classes.push('is-holiday');
    if (count) classes.push('has-appointment');

    const appointmentText = count === 0
      ? 'nessun appuntamento'
      : count === 1
        ? '1 appuntamento'
        : `${count} appuntamenti`;
    const holidayText = holiday ? `, ${holiday}` : '';

    const children = [
      createElement('span', { className: 'day-number', text: String(day.getDate()) })
    ];
    if (count) {
      children.push(createElement('span', { className: 'appointment-dot', 'aria-hidden': 'true' }));
    }

    fragment.append(createElement(
      'button',
      {
        type: 'button',
        className: classes.join(' '),
        dataset: { date: key },
        title: holiday ? `${formatDateOnly(day)} · ${holiday}` : formatDateOnly(day),
        'aria-label': `${formatLongDate(day)}${holidayText}, ${appointmentText}`,
        'aria-pressed': key === state.selectedDate ? 'true' : 'false'
      },
      children
    ));
  }

  dom.calendarGrid.replaceChildren(fragment);
}

function navigateMonth(offset) {
  state.viewDate = new Date(
    state.viewDate.getFullYear(),
    state.viewDate.getMonth() + offset,
    1
  );
  state.selectedDate = null;
  renderCalendar();
}

function goToToday() {
  state.viewDate = startOfMonth(new Date());
  state.selectedDate = null;
  renderCalendar();
}

function openDay(key) {
  const date = dateFromKey(key);
  if (!date) return;
  state.selectedDate = key;
  state.dayDate = key;
  renderCalendar();
  renderDayDialog();
  if (!dom.dayDialog.open) dom.dayDialog.showModal();
}

function renderDayDialog() {
  const date = dateFromKey(state.dayDate);
  if (!date) return;
  const difference = dayDifference(date, new Date());
  if (difference === 0) {
    dom.dayRelative.textContent = 'Oggi';
  } else if (difference === 1) {
    dom.dayRelative.textContent = 'Domani';
  } else if (difference === -1) {
    dom.dayRelative.textContent = 'Ieri';
  } else {
    dom.dayRelative.textContent = capitalize(new Intl.DateTimeFormat(LOCALE, {
      weekday: 'long'
    }).format(date));
  }
  dom.dayTitle.textContent = formatDateOnly(date);
  const holiday = holidayName(state.dayDate);
  dom.dayHoliday.hidden = !holiday;
  dom.dayHoliday.textContent = holiday || '';

  const appointments = state.appointments
    .filter((appointment) => appointment.date === state.dayDate)
    .sort(compareAppointments);

  if (!appointments.length) {
    dom.dayList.replaceChildren(
      createElement('div', { className: 'day-empty', text: 'Nessun appuntamento per questo giorno.' })
    );
  } else {
    dom.dayList.replaceChildren(...appointments.map((appointment) => {
      const button = createElement(
        'button',
        {
          type: 'button',
          className: 'day-appointment',
          dataset: { appointmentId: appointment.id },
          'aria-label': `Modifica appuntamento delle ${appointment.time}: ${appointment.description}`
        },
        createElement('span', { className: 'time-pill', text: appointment.time }),
        createElement('span', { className: 'day-appointment-text', text: appointment.description }),
        createElement(
          'span',
          { className: 'day-appointment-edit', 'aria-hidden': 'true' },
          svgIcon('i-edit')
        )
      );
      return button;
    }));
  }
}

function findNextFreeTime(date) {
  const now = new Date();
  if (date !== dateKey(now)) return '09:00';
  const suggestion = new Date(now.getTime() + 30 * 60 * 1000);
  let hours = suggestion.getHours();
  let minutes = Math.ceil(suggestion.getMinutes() / 15) * 15;
  if (minutes === 60) {
    minutes = 0;
    hours = (hours + 1) % 24;
  }
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function openAppointmentForm(id = null) {
  const appointment = id ? findAppointment(id) : null;
  const date = appointment?.date || state.dayDate || state.selectedDate || dateKey(new Date());
  state.editingAppointmentId = appointment?.id || null;
  dom.appointmentForm.reset();
  dom.appointmentError.textContent = '';
  dom.appointmentId.value = appointment?.id || '';
  dom.appointmentDate.value = date;
  dom.appointmentDateLabel.textContent = formatLongDate(dateFromKey(date) || new Date());
  dom.appointmentDialogTitle.textContent = appointment ? 'Modifica appuntamento' : 'Nuovo appuntamento';
  dom.appointmentTime.value = appointment?.time || findNextFreeTime(date);
  dom.appointmentDescription.value = appointment?.description || '';
  dom.deleteAppointmentBtn.hidden = !appointment;
  if (!dom.appointmentDialog.open) dom.appointmentDialog.showModal();
  window.requestAnimationFrame(() => dom.appointmentDescription.focus());
}

async function saveAppointment(event) {
  event.preventDefault();
  dom.appointmentError.textContent = '';
  const date = dom.appointmentDate.value;
  const time = dom.appointmentTime.value;
  const description = dom.appointmentDescription.value.trim();

  if (!parseDateTime(date, time)) {
    dom.appointmentError.textContent = 'Inserisci un orario valido.';
    return;
  }
  if (!description) {
    dom.appointmentError.textContent = 'Scrivi una descrizione.';
    return;
  }

  const existing = state.editingAppointmentId ? findAppointment(state.editingAppointmentId) : null;
  const now = new Date().toISOString();
  const appointment = {
    id: existing?.id || crypto.randomUUID(),
    date,
    time,
    description: description.slice(0, 500),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  setBusy(dom.saveAppointmentBtn, true);
  try {
    await dbPut(APPOINTMENTS_STORE, appointment);
    const index = state.appointments.findIndex((entry) => entry.id === appointment.id);
    if (index >= 0) {
      state.appointments[index] = appointment;
    } else {
      state.appointments.push(appointment);
    }
    state.appointments.sort(compareAppointments);
    dom.appointmentDialog.close();
    renderCalendar();
    if (dom.dayDialog.open) renderDayDialog();
    showToast(existing ? 'Appuntamento modificato' : 'Appuntamento salvato');
  } catch (error) {
    dom.appointmentError.textContent = 'Salvataggio non riuscito. Riprova.';
  } finally {
    setBusy(dom.saveAppointmentBtn, false);
  }
}

async function deleteAppointment() {
  const appointment = findAppointment(state.editingAppointmentId);
  if (!appointment) return;
  const confirmed = await askConfirm(
    'Eliminare l\'appuntamento?',
    `L'appuntamento delle ${appointment.time} verrà eliminato.`,
    'Elimina'
  );
  if (!confirmed) return;

  try {
    await dbDelete(APPOINTMENTS_STORE, appointment.id);
    state.appointments = state.appointments.filter((entry) => entry.id !== appointment.id);
    dom.appointmentDialog.close();
    renderCalendar();
    if (dom.dayDialog.open) renderDayDialog();
    showToast('Appuntamento eliminato');
  } catch (error) {
    showToast('Eliminazione non riuscita');
  }
}

function renderPageTabs() {
  const tabs = state.notePages.map((page) => {
    const button = createElement('button', {
      type: 'button',
      className: `page-tab${page.id === state.activePageId ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': page.id === state.activePageId ? 'true' : 'false',
      dataset: { pageId: page.id },
      text: page.title
    });
    return button;
  });
  dom.pageTabs.replaceChildren(...tabs);
  const activeTab = dom.pageTabs.querySelector('.page-tab.is-active');
  if (activeTab) {
    window.requestAnimationFrame(() => activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
  }
}

function updateProgress(page) {
  const total = page.items.length;
  const done = page.items.filter((item) => item.checked).length;
  if (!total) {
    dom.pageProgress.textContent = '';
    dom.pageProgress.removeAttribute('aria-label');
    return;
  }
  dom.pageProgress.textContent = `${done}/${total}`;
  dom.pageProgress.setAttribute('aria-label', `${done} note completate su ${total}`);
}

function renderNoteList(page) {
  if (!page.items.length) {
    dom.noteList.replaceChildren(
      createElement('div', { className: 'note-empty', text: 'Ancora nessuna nota. Scrivi la prima qui sopra.' })
    );
    return;
  }

  const rows = page.items.map((item) => {
    const checkboxId = `note-check-${item.id}`;
    const row = createElement('div', { className: `note-item${item.checked ? ' is-done' : ''}` });
    const checkbox = createElement('input', {
      type: 'checkbox',
      className: 'note-check',
      id: checkboxId,
      dataset: { noteId: item.id }
    });
    checkbox.checked = item.checked;
    const label = createElement('label', {
      className: 'note-text-label',
      for: checkboxId,
      text: item.text
    });
    const edit = createElement(
      'button',
      {
        type: 'button',
        className: 'note-edit-btn',
        dataset: { editNote: item.id },
        'aria-label': `Modifica nota: ${item.text.slice(0, 60)}`
      },
      svgIcon('i-edit')
    );
    row.append(checkbox, label, edit);
    return row;
  });
  dom.noteList.replaceChildren(...rows);
}

function renderNotes() {
  if (!state.notePages.length) {
    state.activePageId = null;
    dom.pageTabs.replaceChildren();
    dom.noPagesState.hidden = false;
    dom.notePagePanel.hidden = true;
    return;
  }

  const page = getActivePage();
  dom.noPagesState.hidden = true;
  dom.notePagePanel.hidden = false;
  const index = state.notePages.findIndex((entry) => entry.id === page.id);
  dom.pageCounter.textContent = `Pagina ${index + 1} di ${state.notePages.length}`;
  dom.activePageTitle.textContent = page.title;
  renderPageTabs();
  updateProgress(page);
  renderNoteList(page);
}

function nextPageNumber() {
  const numbers = state.notePages
    .map((page) => {
      const match = String(page.title).match(/(\d+)/);
      return match ? Number(match[1]) : 0;
    })
    .filter((number) => Number.isFinite(number));
  return Math.max(0, ...numbers) + 1;
}

async function addPage() {
  if (state.notePages.length >= 100) {
    showToast('Hai raggiunto il limite di pagine.');
    return;
  }
  const now = new Date().toISOString();
  const nextOrder = state.notePages.reduce((maximum, page) => Math.max(maximum, page.order), -1) + 1;
  const page = {
    id: crypto.randomUUID(),
    title: `Pagina ${nextPageNumber()}`,
    order: nextOrder,
    items: [],
    createdAt: now,
    updatedAt: now
  };
  try {
    await dbPut(NOTE_PAGES_STORE, page);
    state.notePages.push(page);
    sortNotePages();
    state.activePageId = page.id;
    renderNotes();
    window.requestAnimationFrame(() => dom.newNoteText.focus());
  } catch (error) {
    showToast('Non è stato possibile creare la pagina.');
  }
}

async function deleteCurrentPage() {
  const page = getActivePage();
  if (!page) return;
  const noteText = page.items.length === 1 ? '1 nota' : `${page.items.length} note`;
  const confirmed = await askConfirm(
    'Eliminare la pagina?',
    `La pagina "${page.title}" e ${noteText} verranno eliminati.`,
    'Elimina pagina'
  );
  if (!confirmed) return;

  const index = state.notePages.findIndex((entry) => entry.id === page.id);
  try {
    await dbDelete(NOTE_PAGES_STORE, page.id);
    state.notePages.splice(index, 1);
    state.activePageId = state.notePages[index]?.id || state.notePages[index - 1]?.id || null;
    renderNotes();
    showToast('Pagina eliminata');
  } catch (error) {
    showToast('Eliminazione non riuscita');
  }
}

async function addNote(event) {
  event.preventDefault();
  const page = getActivePage();
  const text = dom.newNoteText.value.trim();
  if (!page || !text) {
    dom.newNoteText.focus();
    return;
  }

  const note = {
    id: crypto.randomUUID(),
    text: text.slice(0, 500),
    checked: false,
    createdAt: new Date().toISOString()
  };
  page.items.push(note);
  page.updatedAt = new Date().toISOString();

  try {
    await dbPut(NOTE_PAGES_STORE, page);
    dom.newNoteText.value = '';
    renderNotes();
    window.requestAnimationFrame(() => {
      dom.noteList.lastElementChild?.scrollIntoView({ block: 'nearest' });
      dom.newNoteText.focus();
    });
  } catch (error) {
    page.items = page.items.filter((item) => item.id !== note.id);
    showToast('Non è stato possibile salvare la nota.');
  }
}

async function toggleNote(noteId, checked, row) {
  const page = getActivePage();
  const note = page?.items.find((item) => item.id === noteId);
  if (!page || !note) return;
  const previous = note.checked;
  note.checked = checked;
  note.updatedAt = new Date().toISOString();
  page.updatedAt = note.updatedAt;
  row?.classList.toggle('is-done', checked);
  updateProgress(page);

  try {
    await dbPut(NOTE_PAGES_STORE, page);
  } catch (error) {
    note.checked = previous;
    const checkbox = row?.querySelector('.note-check');
    if (checkbox) checkbox.checked = previous;
    row?.classList.toggle('is-done', previous);
    updateProgress(page);
    showToast('Non è stato possibile salvare la modifica.');
  }
}

function openNoteEditor(noteId) {
  const page = getActivePage();
  const note = page?.items.find((item) => item.id === noteId);
  if (!note) return;
  state.editingNoteId = noteId;
  dom.noteForm.reset();
  dom.noteError.textContent = '';
  dom.noteText.value = note.text;
  if (!dom.noteDialog.open) dom.noteDialog.showModal();
  window.requestAnimationFrame(() => {
    dom.noteText.focus();
    dom.noteText.setSelectionRange(dom.noteText.value.length, dom.noteText.value.length);
  });
}

async function saveNoteText(event) {
  event.preventDefault();
  dom.noteError.textContent = '';
  const text = dom.noteText.value.trim();
  if (!text) {
    dom.noteError.textContent = 'Scrivi il testo della nota.';
    return;
  }
  const page = getActivePage();
  const note = page?.items.find((item) => item.id === state.editingNoteId);
  if (!page || !note) return;
  note.text = text.slice(0, 500);
  note.updatedAt = new Date().toISOString();
  page.updatedAt = note.updatedAt;

  setBusy(dom.saveNoteBtn, true);
  try {
    await dbPut(NOTE_PAGES_STORE, page);
    dom.noteDialog.close();
    renderNotes();
    showToast('Nota modificata');
  } catch (error) {
    dom.noteError.textContent = 'Salvataggio non riuscito.';
  } finally {
    setBusy(dom.saveNoteBtn, false);
  }
}

async function deleteNote() {
  const page = getActivePage();
  const note = page?.items.find((item) => item.id === state.editingNoteId);
  if (!page || !note) return;
  const confirmed = await askConfirm('Eliminare la nota?', note.text, 'Elimina');
  if (!confirmed) return;

  try {
    await dbDeleteNotePromise(page, note.id);
    dom.noteDialog.close();
    renderNotes();
    showToast('Nota eliminata');
  } catch (error) {
    showToast('Eliminazione non riuscita');
  }
}

async function dbDeleteNotePromise(page, noteId) {
  page.items = page.items.filter((item) => item.id !== noteId);
  page.updatedAt = new Date().toISOString();
  await dbPut(NOTE_PAGES_STORE, page);
}

function askConfirm(title, message, confirmLabel = 'Conferma') {
  if (state.confirmResolver) {
    const previous = state.confirmResolver;
    state.confirmResolver = null;
    previous(false);
  }
  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmActionBtn.textContent = confirmLabel;
  if (!dom.confirmDialog.open) dom.confirmDialog.showModal();
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

function finishConfirm(value) {
  const resolver = state.confirmResolver;
  state.confirmResolver = null;
  if (dom.confirmDialog.open) dom.confirmDialog.close();
  if (resolver) resolver(value);
}

function readPageId(target) {
  const button = target.closest('[data-page-id]');
  return button ? button.dataset.pageId : null;
}

function openSettings() {
  dom.changePinForm.hidden = true;
  dom.changePinForm.reset();
  dom.changePinError.textContent = '';
  dom.installAppBtn.hidden = !state.deferredInstallPrompt || isStandalone();
  if (!dom.settingsDialog.open) dom.settingsDialog.showModal();
}

async function changePin(event) {
  event.preventDefault();
  dom.changePinError.textContent = '';
  const current = dom.currentPin.value;
  const next = dom.newPin.value;
  const confirmation = dom.newPinConfirm.value;

  if (!pinIsValid(next)) {
    dom.changePinError.textContent = 'Il nuovo PIN deve contenere da 4 a 8 cifre.';
    return;
  }
  if (next !== confirmation) {
    dom.changePinError.textContent = 'I nuovi PIN non coincidono.';
    return;
  }
  if (!(await verifyPin(current))) {
    dom.changePinError.textContent = 'Il PIN attuale non è corretto.';
    return;
  }

  try {
    const record = await createPinRecord(next);
    if (!savePinRecord(record)) throw new Error('Storage non disponibile');
    dom.changePinForm.reset();
    dom.changePinForm.hidden = true;
    showToast('PIN aggiornato');
  } catch (error) {
    dom.changePinError.textContent = 'Non è stato possibile aggiornare il PIN.';
  }
}

async function exportBackup() {
  try {
    const payload = {
      app: 'Agenda Personale',
      version: 2,
      exportedAt: new Date().toISOString(),
      appointments: state.appointments,
      notePages: state.notePages
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = createElement('a', {
      href: url,
      download: `agenda-backup-${dateKey(new Date())}.json`
    });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Backup esportato');
  } catch (error) {
    showToast('Esportazione non riuscita');
  }
}

function normalizeBackupAppointment(raw) {
  return normalizeStoredAppointment(raw);
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > MAX_BACKUP_SIZE) {
    showToast('Il file di backup è troppo grande.');
    return;
  }

  try {
    const raw = JSON.parse(await file.text());
    const sourceAppointments = Array.isArray(raw) ? raw : Array.isArray(raw?.appointments) ? raw.appointments : [];
    const sourcePages = Array.isArray(raw?.notePages) ? raw.notePages : [];
    if (!sourceAppointments.length && !sourcePages.length) throw new Error('Formato vuoto');
    if (sourceAppointments.length > 5000 || sourcePages.length > 100) throw new Error('Troppi dati');

    const appointments = sourceAppointments.map(normalizeBackupAppointment).filter(Boolean);
    const pages = sourcePages.map((page, index) => normalizeNotePage(page, index)).filter(Boolean);
    if (!appointments.length && !pages.length) throw new Error('Nessun dato valido');

    const confirmed = await askConfirm(
      'Sostituire i dati?',
      `Verranno importati ${appointments.length} appuntamenti e ${pages.length} pagine di note. I dati attuali saranno sostituiti.`,
      'Importa'
    );
    if (!confirmed) return;

    await dbReplaceAll(appointments, pages);
    state.appointments = appointments.sort(compareAppointments);
    state.notePages = pages;
    sortNotePages();
    state.activePageId = state.notePages[0]?.id || null;
    renderAll();
    showToast('Backup importato');
  } catch (error) {
    showToast('Backup non valido o illeggibile.');
  } finally {
    dom.importFile.value = '';
  }
}

async function deleteAllData() {
  const appointmentCount = state.appointments.length;
  const pageCount = state.notePages.length;
  if (!appointmentCount && !pageCount) {
    showToast('Non ci sono dati da eliminare.');
    return;
  }
  const confirmed = await askConfirm(
    'Eliminare tutti i dati?',
    `Verranno eliminati ${appointmentCount} appuntamenti e ${pageCount} pagine di note. L'operazione non può essere annullata.`,
    'Elimina tutto'
  );
  if (!confirmed) return;

  try {
    await dbClearAll();
    state.appointments = [];
    state.notePages = [];
    state.activePageId = null;
    state.selectedDate = null;
    renderAll();
    showToast('Tutti i dati sono stati eliminati');
  } catch (error) {
    showToast('Eliminazione non riuscita');
  }
}

async function unlockApp(options = {}) {
  try {
    await loadData();
  } catch (error) {
    state.appointments = [];
    state.notePages = [];
    state.activePageId = null;
    showToast('Impossibile leggere i dati salvati.');
  }
  state.unlocked = true;
  state.viewDate = startOfMonth(new Date());
  state.selectedDate = null;
  state.dayDate = null;
  state.editingAppointmentId = null;
  state.editingNoteId = null;
  showScreen('app');
  switchView('calendar');
  renderAll();
  if (options.welcome) showToast('Agenda pronta');
}

function lockApp() {
  if (!state.unlocked) return;
  state.unlocked = false;
  state.appointments = [];
  state.notePages = [];
  state.activePageId = null;
  state.selectedDate = null;
  state.dayDate = null;
  state.editingAppointmentId = null;
  state.editingNoteId = null;
  state.hiddenAt = 0;
  [dom.dayDialog, dom.appointmentDialog, dom.noteDialog, dom.settingsDialog, dom.confirmDialog]
    .forEach((dialog) => {
      if (dialog.open) dialog.close();
    });
  dom.unlockPin.value = '';
  dom.unlockError.textContent = '';
  dom.forgotInfo.hidden = true;
  showScreen('lock');
  updateLockDate();
  window.requestAnimationFrame(() => dom.unlockPin.focus());
}

function updateLockDate() {
  dom.lockDate.textContent = capitalize(new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(new Date()));
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function launch() {
  cacheDom();
  bindEvents();
  updateLockDate();
  registerServiceWorker();

  if (isStandalone()) dom.installAppBtn.hidden = true;

  if (!cryptoAvailable()) {
    dom.secureWarning.hidden = false;
    if (readPinRecord()) {
      dom.unlockError.textContent = 'Apri l\'app tramite HTTPS o localhost per poter usare il PIN.';
      showScreen('lock');
      dom.unlockForm.querySelector('button[type="submit"]').disabled = true;
    } else {
      showScreen('setup');
      dom.setupForm.querySelector('button[type="submit"]').disabled = true;
    }
    return;
  }

  if (readPinRecord()) {
    showScreen('lock');
    window.requestAnimationFrame(() => dom.unlockPin.focus());
  } else {
    showScreen('setup');
    window.requestAnimationFrame(() => dom.setupPin.focus());
  }
}

function bindEvents() {
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog && dialog.open) dialog.close();
    });
  });

  dom.confirmDialog.addEventListener('close', () => {
    if (state.confirmResolver) {
      const resolver = state.confirmResolver;
      state.confirmResolver = null;
      resolver(false);
    }
  });
  dom.confirmCancelBtn.addEventListener('click', () => finishConfirm(false));
  dom.confirmActionBtn.addEventListener('click', () => finishConfirm(true));

  dom.setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    dom.setupError.textContent = '';
    if (!cryptoAvailable()) {
      dom.setupError.textContent = 'Apri l\'app tramite HTTPS o localhost.';
      return;
    }
    const pin = dom.setupPin.value;
    const confirmation = dom.setupPinConfirm.value;
    if (!pinIsValid(pin)) {
      dom.setupError.textContent = 'Il PIN deve contenere da 4 a 8 cifre.';
      return;
    }
    if (pin !== confirmation) {
      dom.setupError.textContent = 'I due PIN non coincidono.';
      return;
    }

    const submitButton = dom.setupForm.querySelector('button[type="submit"]');
    setBusy(submitButton, true);
    try {
      const record = await createPinRecord(pin);
      if (!savePinRecord(record)) throw new Error('Storage non disponibile');
      dom.setupForm.reset();
      await unlockApp({ welcome: true });
    } catch (error) {
      dom.setupError.textContent = 'Non è stato possibile salvare il PIN su questo dispositivo.';
    } finally {
      setBusy(submitButton, false);
    }
  });

  [dom.setupPin, dom.setupPinConfirm, dom.unlockPin, dom.currentPin, dom.newPin, dom.newPinConfirm]
    .forEach((input) => {
      input.addEventListener('input', () => {
        const cleaned = input.value.replace(/\D/g, '').slice(0, 8);
        if (cleaned !== input.value) input.value = cleaned;
      });
    });

  dom.unlockForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    dom.unlockError.textContent = '';
    const now = Date.now();
    if (now < state.unlockBlockedUntil) {
      const seconds = Math.ceil((state.unlockBlockedUntil - now) / 1000);
      dom.unlockError.textContent = `Troppi tentativi. Riprova tra ${seconds} secondi.`;
      return;
    }
    if (!pinIsValid(dom.unlockPin.value)) {
      dom.unlockError.textContent = 'Inserisci il PIN.';
      return;
    }

    const submitButton = dom.unlockForm.querySelector('button[type="submit"]');
    setBusy(submitButton, true);
    try {
      if (await verifyPin(dom.unlockPin.value)) {
        state.failedUnlocks = 0;
        state.unlockBlockedUntil = 0;
        dom.unlockPin.value = '';
        await unlockApp();
      } else {
        state.failedUnlocks += 1;
        if (state.failedUnlocks >= 5) {
          state.failedUnlocks = 0;
          state.unlockBlockedUntil = Date.now() + 30000;
          dom.unlockError.textContent = 'Troppi tentativi. Riprova tra 30 secondi.';
        } else {
          dom.unlockError.textContent = 'PIN non corretto.';
        }
        dom.unlockPin.value = '';
        dom.unlockPin.focus();
      }
    } catch (error) {
      dom.unlockError.textContent = 'Verifica non riuscita. Riprova.';
    } finally {
      setBusy(submitButton, false);
    }
  });

  dom.forgotPinBtn.addEventListener('click', () => {
    dom.forgotInfo.hidden = !dom.forgotInfo.hidden;
  });

  dom.calendarTab.addEventListener('click', () => switchView('calendar'));
  dom.notesTab.addEventListener('click', () => switchView('notes'));

  dom.prevMonthBtn.addEventListener('click', () => navigateMonth(-1));
  dom.nextMonthBtn.addEventListener('click', () => navigateMonth(1));
  dom.todayBtn.addEventListener('click', goToToday);

  dom.calendarGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-date]');
    if (button) openDay(button.dataset.date);
  });

  dom.dayList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-appointment-id]');
    if (button) openAppointmentForm(button.dataset.appointmentId);
  });
  dom.addAppointmentForDay.addEventListener('click', () => openAppointmentForm());
  dom.appointmentForm.addEventListener('submit', saveAppointment);
  dom.deleteAppointmentBtn.addEventListener('click', deleteAppointment);

  dom.pageTabs.addEventListener('click', (event) => {
    const pageId = readPageId(event.target);
    if (!pageId) return;
    state.activePageId = pageId;
    renderNotes();
  });
  dom.addPageBtn.addEventListener('click', addPage);
  dom.createFirstPageBtn.addEventListener('click', addPage);
  dom.deletePageBtn.addEventListener('click', deleteCurrentPage);
  dom.addNoteForm.addEventListener('submit', addNote);

  dom.noteList.addEventListener('change', (event) => {
    const checkbox = event.target.closest('.note-check');
    if (!checkbox) return;
    const row = checkbox.closest('.note-item');
    toggleNote(checkbox.dataset.noteId, checkbox.checked, row);
  });

  dom.noteList.addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-note]');
    if (editButton) openNoteEditor(editButton.dataset.editNote);
  });

  dom.noteForm.addEventListener('submit', saveNoteText);
  dom.deleteNoteBtn.addEventListener('click', deleteNote);

  dom.settingsBtn.addEventListener('click', openSettings);
  dom.lockBtn.addEventListener('click', lockApp);

  dom.toggleChangePinBtn.addEventListener('click', () => {
    dom.changePinForm.hidden = !dom.changePinForm.hidden;
    dom.changePinError.textContent = '';
    if (!dom.changePinForm.hidden) {
      dom.currentPin.value = '';
      dom.newPin.value = '';
      dom.newPinConfirm.value = '';
      dom.currentPin.focus();
    }
  });
  dom.cancelChangePinBtn.addEventListener('click', () => {
    dom.changePinForm.reset();
    dom.changePinForm.hidden = true;
    dom.changePinError.textContent = '';
  });
  dom.changePinForm.addEventListener('submit', changePin);

  dom.exportBtn.addEventListener('click', exportBackup);
  dom.importBtn.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', () => importBackup(dom.importFile.files[0]));
  dom.deleteAllBtn.addEventListener('click', deleteAllData);

  dom.installAppBtn.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    dom.installAppBtn.hidden = true;
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    if (!isStandalone()) dom.installAppBtn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    dom.installAppBtn.hidden = true;
    showToast('Agenda installata');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.hiddenAt = Date.now();
      return;
    }
    const hiddenFor = state.hiddenAt ? Date.now() - state.hiddenAt : 0;
    state.hiddenAt = 0;
    if (state.unlocked && hiddenFor > AUTO_LOCK_MS) {
      lockApp();
    }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    swRegistration = await navigator.serviceWorker.register('sw.js');
  } catch (error) {
    console.info('Modalità offline non disponibile');
  }
}

launch();
