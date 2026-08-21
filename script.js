/**
 * MoisturLyzer / Gateway / SimCard — Frontend
 * Phase 1: Login + Session, Near-realtime polling sync, Local cache (cache-first),
 *          Dashboard (read-only summary), รายการอุปกรณ์ 3 ประเภท (read-only)
 * Phase 2: ระบบเบิกอุปกรณ์แบบตะกร้า (ส่งคำขอ), หน้าอนุมัติ/ปฏิเสธ (Admin), ประวัติ + คืนของ (Admin)
 * Phase 3: Offline queue + Optimistic UI สำหรับการส่งคำขอเบิก (ใช้งานหน้างานที่ Wi-Fi ไม่เสถียรได้)
 * Phase 4: Dashboard กราฟเส้นโค้ง, ระบบพิมพ์ใบเบิก/รายงาน, สร้างรูปรายงานสำหรับคัดลอกไปวางส่ง LINE, จัดการผู้ใช้งาน (Admin)
 */

// ============================================================
// ตั้งค่า — ใส่ URL ของ Apps Script Web App ที่ deploy แล้ว
// ============================================================
const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzvEFmD5Vq7yDhkzdtjkPlzso-V5RKBAk91ibtxKUB1rXxEKVWKkTrTMf7D-ldACnb6SQ/exec",
  POLL_INTERVAL_MS: 9000,
};

const LS_TOKEN = "ml_token";
const LS_USER = "ml_user";
const LS_CACHE = "ml_cache";
const LS_QUEUE = "ml_offline_queue";

// ============================================================
// State
// ============================================================
let state = {
  token: null,
  user: null,
  data: {
    moisturlyzer: [], gateway: [], simcard: [], issuanceLog: [], issuanceItems: [], users: [],
    partsCatalog: [], colorSorterParts: [], panolyzerParts: [], partsActivityLog: [], version: 0,
  },
  cachedAt: null,
  currentView: "dashboard",
  pollTimer: null,
  offlineQueue: [],
  charts: {},
  // Phase 10: หน้าแรกแบบตารางไอคอนสำหรับมือถือ — true = กำลังแสดงอยู่ (ทับหน้าเนื้อหาปกติ)
  mobileHomeVisible: true,
};

// ตะกร้าเบิกที่กำลังกรอกอยู่ (อยู่ใน memory เท่านั้น ไม่ persist — เคลียร์เมื่อส่งสำเร็จ)
let issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [] };

// Phase 5: เลขที่ธุรกรรมที่เลือกไว้สำหรับดำเนินการแบบกลุ่ม (bulk) ในหน้าอนุมัติ/ประวัติ — เคลียร์ทุกครั้งที่เปลี่ยนหน้า
let bulkSelection = new Set();

// ============================================================
// คอลัมน์ที่แสดงในตารางแต่ละประเภท (ตรงกับข้อมูลต้นฉบับ)
// assetType/serialField/connectField ต้องตรงกับ ASSET_SHEETS ใน Code.gs ฝั่ง backend
// ============================================================
const VIEW_CONFIG = {
  moisturlyzer: {
    title: "MoisturLyzer",
    key: "moisturlyzer",
    assetType: "MoisturLyzer",
    serialField: "Product ID",
    connectField: null,
    columns: [
      { field: "No", label: "No" },
      { field: "Products_Name", label: "สินค้า" },
      { field: "Model", label: "รุ่น" },
      { field: "Product ID", label: "Product ID" },
      { field: "MFD", label: "MFD" },
      { field: "Lot_No.", label: "Lot No." },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานะ/ตำแหน่ง" },
      { field: "install_date", label: "วันติดตั้ง" },
      { field: "_linkedAccessories", label: "เชื่อมต่อกับ", computed: true },
    ],
    stockField: "Location",
  },
  gateway: {
    title: "Gateway",
    key: "gateway",
    assetType: "Gateway",
    serialField: "S/N Gateway",
    connectField: "Install_device",
    deviceSerialField: "S/N Device",
    connectOptions: ["Panolyzer (L)", "Panolyzer (RT)", "MoisturLyzer", "Other"],
    columns: [
      { field: "Model", label: "รุ่น" },
      { field: "S/N Gateway", label: "S/N Gateway" },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานที่ติดตั้ง" },
      { field: "Install_device", label: "เชื่อมต่อกับ" },
      { field: "S/N Device", label: "S/N อุปกรณ์ปลายทาง" },
      { field: "Activate_date", label: "วันเปิดใช้งาน" },
    ],
    stockField: "Install_device",
  },
  simcard: {
    title: "SimCard",
    key: "simcard",
    assetType: "SimCard",
    serialField: "S/N",
    connectField: "Installed_device",
    connectOptions: ["MoisturLyzer", "Panolyzer", "Wifi Router", "Other"],
    columns: [
      { field: "Mobile No.", label: "เบอร์โทร" },
      { field: "S/N", label: "S/N ซิม" },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานที่ใช้งาน" },
      { field: "Installed_device", label: "ใส่ในอุปกรณ์" },
      { field: "Activate_date", label: "วันเปิดใช้บริการ" },
    ],
    stockField: "Installed_device",
    // Phase 9: ซิมต้องรอ AIS Activate ก่อนถึงจะนับเป็น Stock จริง แม้ Installed_device จะเป็น "Stock" อยู่ก็ตาม
    stockRequiresField: "Activate_date",
  },
  // Phase 8: อะไหล่แบบมี S/N — โครงสร้างเดียวกับ MoisturLyzer เป๊ะ ใช้กลไกรายการ/แก้ไข/ลบ/เบิกเดิมได้ทันที
  // (ตัวหน้าเว็บจะแสดงตารางนี้คู่กับตารางอะไหล่แบบนับจำนวนในหน้าเดียวกัน — ดู renderPartsListView)
  // หมายเหตุ: key ของ VIEW_CONFIG นี้ตั้งชื่อให้ตรงกับ state.data field ที่ backend ส่งมาเป๊ะ (เหมือนที่ moisturlyzer/gateway/simcard ทำ)
  colorSorterParts: {
    title: "อะไหล่ Color Sorter (มี S/N)",
    key: "colorSorterParts",
    assetType: "ColorSorterPart",
    serialField: "SerialNo",
    connectField: null,
    partCategory: "ColorSorter",
    columns: [
      { field: "PartName", label: "ชื่ออะไหล่" },
      { field: "SerialNo", label: "S/N" },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานะ/ตำแหน่ง" },
    ],
    stockField: "Location",
  },
  panolyzerParts: {
    title: "อะไหล่ Panolyzer (มี S/N)",
    key: "panolyzerParts",
    assetType: "PanolyzerPart",
    serialField: "SerialNo",
    connectField: null,
    partCategory: "Panolyzer",
    columns: [
      { field: "PartName", label: "ชื่ออะไหล่" },
      { field: "SerialNo", label: "S/N" },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานะ/ตำแหน่ง" },
    ],
    stockField: "Location",
  },
};

// Phase 8: nav key ของแต่ละหมวดอะไหล่ -> asset type แบบนับจำนวน (ไม่มี S/N) ที่ใช้ตอนเบิก + Category ที่ตรงกับ PartsCatalog
const PART_QTY_ASSET_TYPE_BY_VIEW = {
  colorSorterParts: "ColorSorterPartQty",
  panolyzerParts: "PanolyzerPartQty",
};
const PART_CATEGORY_BY_VIEW = {
  colorSorterParts: "ColorSorter",
  panolyzerParts: "Panolyzer",
};

// ประเภทอุปกรณ์ที่สามารถเลือก Serial เจาะจงมาผูก (เชื่อมโยง/sync) ตอนเบิก Gateway/SimCard ได้ — ต้องตรงกับ
// LINKABLE_TARGET_ASSET_TYPE ฝั่ง Code.gs (Phase 5)
const LINKABLE_TARGET_ASSET_TYPE = "MoisturLyzer";
const LINKABLE_TARGET_KEY = "moisturlyzer";

// Phase 6: กติกา Gateway 2 รุ่น — ต้องตรงกับ Code.gs
// EPG-001S = สำหรับ Panolyzer เท่านั้น (ไม่ได้ตามอยู่ในระบบนี้ ต้องกรอก S/N เป็นข้อความอิสระ)
// EPG-001B = สำหรับ MoisturLyzer เท่านั้น (ต้องเลือกเครื่องเจาะจงจากในระบบ)
const GATEWAY_MODEL_FIELD = "Model";
const GATEWAY_MODEL_PANOLYZER = "EPG-001S";
const GATEWAY_MODEL_MOISTURLYZER = "EPG-001B";

// ============================================================
// Phase 7: โมดัลยืนยัน/แจ้งเตือน C2TECH (แทน native confirm()/alert())
// ใช้ Promise แทน blocking dialog — รองรับ Mobile (bottom sheet) + Desktop (card กลางจอ)
// ============================================================
const C2_MODAL_ICONS = { confirm: "?", success: "✓", error: "✕", warning: "!" };
let _c2ModalResolve = null;
let _c2ModalKeyHandler = null;
let _c2ModalGen = 0; // นับรุ่นการเปิดโมดัล กันไม่ให้ setTimeout ปิดโมดัลรอบเก่าไปซ่อนโมดัลรอบใหม่ที่เพิ่งเปิดทับ (เช่น alert เปิดต่อจาก confirm ทันที)

function _c2ModalEls() {
  return {
    overlay: document.getElementById("c2Modal"),
    icon: document.getElementById("c2ModalIcon"),
    title: document.getElementById("c2ModalTitle"),
    message: document.getElementById("c2ModalMessage"),
    cancelBtn: document.getElementById("c2ModalCancelBtn"),
    okBtn: document.getElementById("c2ModalOkBtn"),
  };
}

function _c2ModalOpen(opts) {
  const els = _c2ModalEls();
  if (!els.overlay) {
    // fallback ปลอดภัยกรณี DOM ยังไม่พร้อม (ไม่ควรเกิดในการใช้งานจริง)
    return Promise.resolve(opts.mode === "confirm" ? window.confirm(opts.message) : (window.alert(opts.message), true));
  }
  const type = opts.type || (opts.mode === "confirm" ? "confirm" : "success");
  els.icon.className = "c2-modal-icon " + type;
  els.icon.textContent = C2_MODAL_ICONS[type] || C2_MODAL_ICONS.confirm;
  els.title.textContent = opts.title || (opts.mode === "confirm" ? "ยืนยันการทำรายการ" : "แจ้งเตือน");
  els.message.textContent = opts.message || "";
  els.okBtn.textContent = opts.okText || "ตกลง";
  els.okBtn.className = "c2-modal-btn-ok" + (opts.danger ? " danger" : "");
  els.cancelBtn.style.display = opts.mode === "confirm" ? "" : "none";
  els.cancelBtn.textContent = opts.cancelText || "ยกเลิก";

  els.overlay.style.display = "flex";
  // force reflow ก่อนใส่ class open เพื่อให้ transition เล่นทุกครั้ง
  void els.overlay.offsetWidth;
  els.overlay.classList.add("open");
  const myGen = ++_c2ModalGen;

  return new Promise((resolve) => {
    _c2ModalResolve = resolve;
    const cleanup = (result) => {
      els.overlay.classList.remove("open");
      setTimeout(() => {
        // ถ้ามีโมดัลรอบใหม่เปิดทับไปแล้วระหว่างรอ transition ปิด ห้ามไปซ่อนของรอบใหม่
        if (_c2ModalGen === myGen) els.overlay.style.display = "none";
      }, 180);
      document.removeEventListener("keydown", _c2ModalKeyHandler);
      _c2ModalKeyHandler = null;
      els.okBtn.onclick = null;
      els.cancelBtn.onclick = null;
      _c2ModalResolve = null;
      resolve(result);
    };
    els.okBtn.onclick = () => cleanup(true);
    els.cancelBtn.onclick = () => cleanup(false);
    _c2ModalKeyHandler = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter" && opts.mode !== "confirm") cleanup(true);
    };
    document.addEventListener("keydown", _c2ModalKeyHandler);
    els.okBtn.focus();
  });
}

/** แทน confirm() เดิม — คืนค่าเป็น Promise<boolean> ต้อง await หรือ .then() */
function showConfirm(message, opts) {
  opts = opts || {};
  return _c2ModalOpen({ mode: "confirm", message, type: opts.type || "confirm", title: opts.title, okText: opts.okText, cancelText: opts.cancelText, danger: opts.danger });
}

/** แทน alert() เดิม — คืนค่าเป็น Promise<boolean> (resolve เมื่อกดตกลง/ปิด) */
function showAlert(message, opts) {
  if (typeof opts === "string") opts = { type: opts };
  opts = opts || {};
  return _c2ModalOpen({ mode: "alert", message, type: opts.type || "success", title: opts.title, okText: opts.okText || "รับทราบ" });
}

// ============================================================
// Boot
// ============================================================
document.addEventListener("DOMContentLoaded", init);

function init() {
  document.getElementById("login-form").addEventListener("submit", onLoginSubmit);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onConnectivityChange);
  window.addEventListener("offline", onConnectivityChange);
  setupInstallPrompt();

  const savedToken = localStorage.getItem(LS_TOKEN);
  const savedUser = localStorage.getItem(LS_USER);
  const savedCache = localStorage.getItem(LS_CACHE);
  state.offlineQueue = loadOfflineQueue();

  updateOfflineBanner();

  // ปรับปรุง: เดิมหน้าจอ loading จะหายไปหลังจาก 350ms เสมอ ไม่ว่าข้อมูลจะโหลดเสร็จจริงหรือยัง —
  // ถ้าเครื่อง/เบราว์เซอร์นี้ยังไม่เคยมี cache มาก่อน (เช่น login ครั้งแรก หรือเพิ่งเคลียร์ข้อมูล) จะเห็น
  // ตาราง/หน้าจอว่างเปล่าโผล่มาแวบหนึ่งก่อนข้อมูลจริงมาถึง ตอนนี้ถ้าไม่มี cache จะรอให้ดึงข้อมูลจบก่อนค่อยซ่อน
  // (มีเพดานเวลาสูงสุดกันไว้ เผื่อเน็ตมีปัญหา จะได้ไม่ค้างที่หน้า loading ตลอดไป)
  const hideLoader = () => document.getElementById("app-loader").classList.add("hidden");
  const withTimeoutCap = (promise, ms) =>
    Promise.race([Promise.resolve(promise), new Promise((resolve) => setTimeout(resolve, ms))]);

  if (savedToken && savedUser) {
    state.token = savedToken;
    state.user = JSON.parse(savedUser);

    let hasCache = false;
    if (savedCache) {
      try {
        const cache = JSON.parse(savedCache);
        state.data = cache.data;
        state.cachedAt = cache.cachedAt;
        hasCache = true;
      } catch (e) { /* ignore corrupt cache */ }
    }
    if (!state.data.users) state.data.users = [];

    showApp();
    // แสดงข้อมูลจาก cache ทันที (ถ้ามี) แล้วค่อยรีเฟรชเบื้องหลัง
    renderCurrentView();
    const initialLoad = navigator.onLine
      ? drainOfflineQueue().then(() => refreshInBackground())
      : refreshInBackground();
    startPolling();

    if (hasCache) {
      // มี cache อยู่แล้ว ข้อมูลพร้อมแสดงทันที — ปิดหน้า loading แบบมีดีเลย์สั้นๆ พอให้เห็น animation ไม่กระพริบ
      setTimeout(hideLoader, 350);
    } else {
      // ยังไม่มี cache เลย ต้องรอให้ดึงข้อมูลจบก่อนถึงจะซ่อนหน้า loading (สูงสุด 8 วินาที กันเน็ตมีปัญหาแล้วค้าง)
      withTimeoutCap(initialLoad, 8000).then(hideLoader);
    }
  } else {
    showLogin();
    setTimeout(hideLoader, 350);
  }
}

// ============================================================
// PWA: ติดตั้งแอปลงหน้าจอโฮม (Add to Home Screen)
// ============================================================
let deferredInstallPrompt = null;

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS ใหม่ๆ ปลอมตัวเป็น Mac
}

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function setupInstallPrompt() {
  const btn = document.getElementById("installAppBtn");
  const btnText = document.getElementById("installAppBtnText");
  if (!btn) return;

  // ถ้าเปิดแอปในโหมด standalone อยู่แล้ว (ติดตั้งไปแล้ว) ไม่ต้องโชว์ปุ่ม
  if (isStandaloneDisplay()) return;

  if (isIos()) {
    // iOS Safari ไม่รองรับ beforeinstallprompt เลย ต้องแนะนำขั้นตอนด้วยมือ (Share → Add to Home Screen)
    btn.style.display = "";
    btnText.textContent = "วิธีติดตั้งลงหน้าจอ (iPhone/iPad)";
    return;
  }

  // Android/Chrome/Edge ฯลฯ: รอ event นี้ก่อนถึงจะโชว์ปุ่ม (เบราว์เซอร์เป็นคนตัดสินใจว่าติดตั้งได้เมื่อไหร่)
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.style.display = "";
    btnText.textContent = "ติดตั้งแอปลงมือถือ";
  });

  window.addEventListener("appinstalled", () => {
    btn.style.display = "none";
    deferredInstallPrompt = null;
  });
}

async function handleInstallClick() {
  if (isIos()) {
    await showAlert(
      "วิธีติดตั้ง C2 LOOP ลงหน้าจอโฮม (iPhone/iPad):\n\n1. แตะปุ่ม \"แชร์\" (ไอคอนสี่เหลี่ยมมีลูกศรชี้ขึ้น) แถบด้านล่างของ Safari\n2. เลื่อนหาแล้วแตะ \"เพิ่มไปที่หน้าจอโฮม\" (Add to Home Screen)\n3. แตะ \"เพิ่ม\" ที่มุมขวาบน",
      "info"
    );
    return;
  }
  if (!deferredInstallPrompt) {
    await showAlert("เบราว์เซอร์นี้ยังไม่พร้อมให้ติดตั้งในขณะนี้ ลองรีเฟรชหน้าใหม่แล้วลองอีกครั้ง หรือใช้เมนู \"เพิ่มไปยังหน้าจอโฮม\" ของเบราว์เซอร์เอง", "info");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById("installAppBtn").style.display = "none";
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* ไม่ critical — แค่ทำให้ติดตั้งเป็น PWA ได้ ถ้าลงทะเบียนไม่สำเร็จก็แค่ไม่มีปุ่มติดตั้ง แอปยังใช้งานปกติ */ });
  });
}

function onConnectivityChange() {
  updateOfflineBanner();
  if (navigator.onLine && state.token) {
    drainOfflineQueue().then(() => refreshInBackground(true));
  }
}

function updateOfflineBanner() {
  const banner = document.getElementById("offlineBanner");
  const text = document.getElementById("offlineBannerText");
  if (!banner) return;
  if (!navigator.onLine) {
    banner.style.display = "block";
    text.textContent = "ออฟไลน์ — การเปลี่ยนแปลงจะถูกส่งอัตโนมัติเมื่อกลับมาออนไลน์";
  } else if (state.offlineQueue.length > 0) {
    banner.style.display = "block";
    text.textContent = `กำลังส่งคำขอที่ค้างไว้ตอนออฟไลน์ (${state.offlineQueue.length} รายการ)...`;
  } else {
    banner.style.display = "none";
  }
}

// ============================================================
// Login / Logout
// ============================================================
async function onLoginSubmit(ev) {
  ev.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("login-submit-btn");
  const errBox = document.getElementById("login-error");
  errBox.style.display = "none";

  btn.disabled = true;
  btn.textContent = "กำลังเข้าสู่ระบบ...";

  try {
    const res = await apiPost({ action: "login", username, password });
    if (!res.ok) {
      throw new Error(loginErrorMessage(res.error));
    }
    state.token = res.token;
    state.user = res.user;
    localStorage.setItem(LS_TOKEN, state.token);
    localStorage.setItem(LS_USER, JSON.stringify(state.user));

    showApp();
    await refreshInBackground(true);
    startPolling();
  } catch (err) {
    errBox.textContent = err.message || "เข้าสู่ระบบไม่สำเร็จ";
    errBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "เข้าสู่ระบบ";
  }
}

function loginErrorMessage(code) {
  switch (code) {
    case "invalid_credentials": return "Username หรือรหัสผ่านไม่ถูกต้อง";
    case "account_disabled": return "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อ Admin";
    case "missing_credentials": return "กรุณากรอก Username และรหัสผ่าน";
    default: return "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่";
  }
}

function logout() {
  stopPolling();
  destroyAllCharts();
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
  localStorage.removeItem(LS_CACHE);
  // หมายเหตุ: ไม่ลบ LS_QUEUE ตอน logout เผื่อมีคำขอค้างส่งอยู่ (จะส่งต่อเมื่อ login กลับเข้ามาและออนไลน์)
  state = {
    token: null, user: null,
    data: {
      moisturlyzer: [], gateway: [], simcard: [], issuanceLog: [], issuanceItems: [], users: [],
      partsCatalog: [], colorSorterParts: [], panolyzerParts: [], partsActivityLog: [], version: 0,
    },
    cachedAt: null, currentView: "dashboard", pollTimer: null,
    offlineQueue: loadOfflineQueue(), charts: {},
    mobileHomeVisible: true,
  };
  issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [] };
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";
  showLogin();
}

function showLogin() {
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app-shell").classList.remove("visible");
  // Phase 10: หน้าแรกแบบไอคอน (mobile home) เป็น overlay เต็มจอทับทุกอย่างอยู่ ต้องซ่อนออกตอนกลับไปหน้า login ด้วย
  // ไม่งั้นบนจอมือถือจะทับฟอร์ม login จนกดอะไรไม่ได้เลยหลัง logout
  const mobileHomeEl = document.getElementById("mobileHomeScreen");
  if (mobileHomeEl) mobileHomeEl.classList.remove("visible");
}

function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").classList.add("visible");
  document.getElementById("userChip").innerHTML =
    escapeHtml(state.user.name) + '<span class="role-badge">' + escapeHtml(state.user.role) + "</span>";

  const isAdmin = state.user.role === "Admin";
  document.querySelectorAll(".nav-item.admin-only").forEach((el) => el.classList.toggle("role-visible", isAdmin));
  updatePendingBadge();

  // Phase 10: มือถือ (จอแคบ) เจอหน้าแรกแบบตารางไอคอนก่อนเสมอหลัง login ใหม่ทุกครั้ง
  state.mobileHomeVisible = true;
  syncMobileHomeVisibility();
}

function updatePendingBadge() {
  const badge = document.getElementById("pendingBadge");
  const count = (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").length;
  if (badge) {
    badge.style.display = count > 0 ? "inline-block" : "none";
    badge.textContent = count;
  }
  // Phase 10: ถ้าหน้าแรกแบบตารางไอคอนกำลังแสดงอยู่ ให้อัปเดตตัวเลข/badge ให้ตรงกับข้อมูลล่าสุดด้วย
  if (state.mobileHomeVisible) renderMobileHome();
  // อัปเดต badge รออนุมัติที่แถบเมนูด้านล่าง (แสดงอยู่ทุกหน้าจอมือถือ ไม่ใช่แค่หน้าแรก)
  syncMobileTabbar();
}

// ============================================================
// Phase 10: หน้าแรกแบบตารางไอคอนสำหรับมือถือ (Mobile Home Screen)
// ============================================================
function isMobileViewport() {
  return window.innerWidth <= 760;
}

/** แสดง/ซ่อนหน้าแรกให้ตรงกับสถานะ mobileHomeVisible เสมอ (เรียกซ้ำได้ปลอดภัย เช่น ตอน resize จอ) — อัปเดตแถบเมนูด้านล่างพร้อมกันเสมอ */
function syncMobileHomeVisibility() {
  const el = document.getElementById("mobileHomeScreen");
  if (el) {
    if (state.mobileHomeVisible && isMobileViewport()) {
      renderMobileHome();
      el.classList.add("visible");
    } else {
      el.classList.remove("visible");
    }
  }
  syncMobileTabbar();
}

function showMobileHome() {
  state.mobileHomeVisible = true;
  syncMobileHomeVisibility();
}

function hideMobileHome() {
  state.mobileHomeVisible = false;
  syncMobileHomeVisibility();
}

let _lastIsMobileViewport = isMobileViewport();
window.addEventListener("resize", () => {
  if (!state.user) return;
  syncMobileHomeVisibility();
  // ถ้าข้ามเส้นแบ่งมือถือ/เดสก์ท็อป ให้ render หน้าปัจจุบันใหม่ (ตาราง <-> การ์ด, กราฟ Dashboard เดสก์ท็อป/มือถือ)
  const nowMobile = isMobileViewport();
  if (nowMobile !== _lastIsMobileViewport) {
    _lastIsMobileViewport = nowMobile;
    if (!state.mobileHomeVisible) renderCurrentView();
  }
});

// เมนูหลัก (เรียงตามเมนูด้านซ้ายจริง) — adminOnly = แสดงเฉพาะ Admin, badge = true ให้แปะจำนวนรออนุมัติ
const MOBILE_HOME_TILES = [
  { key: "dashboard", label: "Dashboard", icon: "fa-chart-line", color: "mh-c1" },
  { key: "moisturlyzer", label: "MoisturLyzer", icon: "fa-tint", color: "mh-c2" },
  { key: "gateway", label: "Gateway", icon: "fa-broadcast-tower", color: "mh-c3" },
  { key: "simcard", label: "SimCard", icon: "fa-sim-card", color: "mh-c4" },
  { key: "colorSorterParts", label: "อะไหล่ Color Sorter", icon: "fa-cogs", color: "mh-c5" },
  { key: "panolyzerParts", label: "อะไหล่ Panolyzer", icon: "fa-cogs", color: "mh-c6" },
  { key: "issue", label: "เบิกอุปกรณ์", icon: "fa-dolly", color: "mh-c7" },
  { key: "approvals", label: "อนุมัติการเบิก", icon: "fa-check-circle", color: "mh-c8", adminOnly: true, badge: true },
  { key: "history", label: "ประวัติเบิก/คืน", icon: "fa-history", color: "mh-c9" },
];
const MOBILE_HOME_ADMIN_TILES = [
  { key: "users", label: "จัดการผู้ใช้งาน", icon: "fa-users-cog", color: "mh-c9" },
  { key: "manageparts", label: "จัดการอะไหล่", icon: "fa-toolbox", color: "mh-c5" },
];

/** สรุปยอดรวมสั้นๆ สำหรับแถบสถิติในหน้าแรก (รวมทุกประเภทอุปกรณ์เข้าด้วยกัน) */
function computeMobileHomeStats() {
  let stock = 0;
  let used = 0;
  Object.values(VIEW_CONFIG).forEach((cfg) => {
    const s = computeSummary(state.data[cfg.key] || [], cfg);
    stock += s.stock;
    used += s.used;
  });
  const pending = (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").length;
  return { stock, used, pending };
}

function mobileHomeSearch(term) {
  if (!term) return;
  switchView("history");
  hideMobileHome();
  const input = document.getElementById("historySearch");
  if (input) {
    input.value = term;
    input.dispatchEvent(new Event("input"));
  }
}

function renderMobileHome() {
  const wrap = document.getElementById("mobileHomeScreen");
  if (!wrap || !state.user) return;
  const isAdmin = state.user.role === "Admin";
  const stats = computeMobileHomeStats();
  const pending = stats.pending;
  const tiles = MOBILE_HOME_TILES.filter((t) => !t.adminOnly || isAdmin);

  wrap.innerHTML = `
    <div class="mh-header">
      <div class="mh-brand-row">
        <div class="mh-brand-badge"><img src="assets/c2loop-mark-white.svg" alt=""></div>
        <div class="mh-brand-txt">C2 LOOP</div>
      </div>
      <div class="mh-header-top">
        <div>
          <div class="mh-greeting">สวัสดี</div>
          <div class="mh-username">${escapeHtml(state.user.name)}</div>
          <span class="mh-role-chip">${escapeHtml(state.user.role)}</span>
        </div>
        <div class="mh-header-icons">
          <button class="mh-icon-btn" onclick="logout()" title="ออกจากระบบ"><i class="fas fa-sign-out-alt"></i></button>
        </div>
      </div>
      <div class="mh-search-box">
        <i class="fas fa-search"></i>
        <input type="text" id="mhSearchInput" placeholder="ค้นหาชื่อลูกค้า, เลขที่ธุรกรรม...">
      </div>
    </div>
    <div class="mh-content">
      ${isAdmin && pending > 0 ? `
        <div class="mh-alert-card" onclick="switchView('approvals'); hideMobileHome();">
          <div class="mh-alert-icon"><i class="fas fa-clock"></i></div>
          <div class="mh-alert-text"><b>มีคำขอรออนุมัติ ${pending} รายการ</b><span>แตะเพื่อตรวจสอบและอนุมัติทันที</span></div>
          <i class="fas fa-chevron-right"></i>
        </div>` : ""}
      <div class="mh-stat-row">
        <div class="mh-stat-pill"><div class="mh-stat-num ok">${stats.stock}</div><div class="mh-stat-lbl">อยู่ในคลัง</div></div>
        <div class="mh-stat-pill"><div class="mh-stat-num warn">${stats.used}</div><div class="mh-stat-lbl">เบิกออกไปแล้ว</div></div>
        <div class="mh-stat-pill"><div class="mh-stat-num">${pending}</div><div class="mh-stat-lbl">รออนุมัติ</div></div>
      </div>
      <div class="mh-section-title">เมนูหลัก</div>
      <div class="mh-grid">
        ${tiles.map((t) => `
          <div class="mh-tile" onclick="switchView('${t.key}'); hideMobileHome();">
            ${t.badge && pending > 0 ? `<span class="mh-tile-badge">${pending}</span>` : ""}
            <div class="mh-tile-icon ${t.color}"><i class="fas ${t.icon}"></i></div>
            <div class="mh-tile-lbl">${escapeHtml(t.label)}</div>
          </div>`).join("")}
      </div>
      ${isAdmin ? `
        <div class="mh-section-title">การจัดการ (Admin)</div>
        <div class="mh-grid mh-grid-2">
          ${MOBILE_HOME_ADMIN_TILES.map((t) => `
            <div class="mh-tile" onclick="switchView('${t.key}'); hideMobileHome();">
              <div class="mh-tile-icon ${t.color}"><i class="fas ${t.icon}"></i></div>
              <div class="mh-tile-lbl">${escapeHtml(t.label)}</div>
            </div>`).join("")}
        </div>` : ""}
    </div>
  `;

  const searchInput = document.getElementById("mhSearchInput");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") mobileHomeSearch(searchInput.value.trim());
    });
  }
}

// ============================================================
// แถบเมนูด้านล่างแบบถาวรสำหรับมือถือ — แสดงทุกหน้าจอ (ไม่ใช่แค่หน้าแรกแบบตารางไอคอนอีกต่อไป)
// แทนที่แถบเมนูไอคอนด้านบนแบบเดิม (ซึ่งต้องเลื่อนซ้าย-ขวาและซ้ำซ้อนกับปุ่มเหล่านี้)
// ============================================================
function renderMobileTabbar() {
  const wrap = document.getElementById("mobileTabbar");
  if (!wrap || !state.user) return;
  const isAdmin = state.user.role === "Admin";
  const pending = (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").length;
  const onHome = state.mobileHomeVisible;
  const active = (key) => (!onHome && state.currentView === key ? "active" : "");

  wrap.innerHTML = `
    <div class="mh-tab-item ${onHome ? "active" : ""}" onclick="showMobileHome()"><i class="fas fa-th-large"></i><span>เมนูหลัก</span></div>
    <div class="mh-tab-item ${active("issue")}" onclick="switchView('issue'); hideMobileHome();"><i class="fas fa-dolly"></i><span>เบิกของ</span></div>
    ${isAdmin ? `<div class="mh-tab-item ${active("approvals")}" onclick="switchView('approvals'); hideMobileHome();"><i class="fas fa-check-circle"></i><span>อนุมัติ</span>${pending > 0 ? `<span class="mh-tab-badge">${pending}</span>` : ""}</div>` : ""}
    <div class="mh-tab-item ${active("history")}" onclick="switchView('history'); hideMobileHome();"><i class="fas fa-history"></i><span>ประวัติ</span></div>
  `;
}

/** แสดง/ซ่อนแถบเมนูด้านล่างให้ตรงกับขนาดจอเสมอ (มือถือเท่านั้น) เรียกคู่กับ syncMobileHomeVisibility เสมอ */
function syncMobileTabbar() {
  const wrap = document.getElementById("mobileTabbar");
  if (!wrap) return;
  if (isMobileViewport() && state.user) {
    renderMobileTabbar();
    wrap.style.display = "flex";
  } else {
    wrap.style.display = "none";
  }
}

// ============================================================
// API helpers
// ============================================================
// โอเวอร์เลย์โหลดทั่วแอป (global loading overlay) — นับจำนวนคำขอ apiPost ที่กำลังทำงานอยู่พร้อมกัน
// (ใช้ตัวนับแทนธง true/false เดี่ยวๆ เพราะบางจุดยิงหลายคำขอซ้อนกัน เช่น bulk actions — กันบั๊กที่คำขอนึงจบแล้วไปปิดโอเวอร์เลย์
// ทั้งที่อีกคำขอยังไม่เสร็จ) ไม่ผูกกับ apiGet ตั้งใจ เพราะ apiGet ใช้กับ polling พื้นหลังทุก 9 วินาทีด้วย
// ถ้าโชว์โอเวอร์เลย์ทุกรอบ poll จะกระพริบรำคาญโดยไม่มีประโยชน์ — สถานะซิงค์พื้นหลังมี syncDot ของตัวเองอยู่แล้ว
let activeApiPostCount = 0;
function showGlobalLoading() {
  activeApiPostCount++;
  const overlay = document.getElementById("globalLoadingOverlay");
  if (overlay) overlay.classList.add("active");
}
function hideGlobalLoading() {
  activeApiPostCount = Math.max(0, activeApiPostCount - 1);
  if (activeApiPostCount === 0) {
    const overlay = document.getElementById("globalLoadingOverlay");
    if (overlay) overlay.classList.remove("active");
  }
}

async function apiGet(params) {
  const url = new URL(CONFIG.API_URL);
  Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  const resp = await fetch(url.toString(), { method: "GET" });
  return resp.json();
}

async function apiPost(body) {
  showGlobalLoading();
  try {
    // ส่งเป็น text/plain เพื่อเลี่ยง CORS preflight ที่ Apps Script Web App ไม่รองรับ
    const resp = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    return await resp.json();
  } finally {
    hideGlobalLoading();
  }
}

// ============================================================
// Phase 3: Offline queue (สำหรับคำขอเบิกที่ทำระหว่างไม่มีสัญญาณอินเทอร์เน็ต)
// ============================================================
function loadOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]");
  } catch (e) {
    return [];
  }
}

function saveOfflineQueue() {
  localStorage.setItem(LS_QUEUE, JSON.stringify(state.offlineQueue));
  updateOfflineBanner();
}

/** ส่งคำขอที่ค้างอยู่ในคิว (สร้างตอนออฟไลน์) ทีละรายการตามลำดับ — เอาออกจากคิวไม่ว่าจะสำเร็จหรือถูกปฏิเสธ (กันวนซ้ำค้างตลอดไป) */
async function drainOfflineQueue() {
  if (!state.offlineQueue.length) return;
  const failures = [];

  while (state.offlineQueue.length) {
    const job = state.offlineQueue[0];
    try {
      const res = await apiPost(job.body);
      if (!res.ok) failures.push(`${job.label}: ${issuanceErrorMessage(res.error)}`);
    } catch (err) {
      failures.push(`${job.label}: ส่งไม่สำเร็จ (${err.message})`);
    }
    state.offlineQueue.shift();
    saveOfflineQueue();
  }

  if (failures.length) {
    showAlert("คำขอบางรายการที่ค้างไว้ตอนออฟไลน์ส่งไม่สำเร็จ:\n" + failures.join("\n") + "\n\nกรุณาตรวจสอบและทำรายการใหม่หากจำเป็น", "error");
  }
}

// ============================================================
// Sync: cache-first + background revalidate + polling
// ============================================================
async function refreshInBackground(forceFullLoad) {
  setSyncStatus("syncing");
  try {
    const versionRes = await apiGet({ action: "checkVersion", token: state.token });
    if (!versionRes.ok) throw new Error(versionRes.error || "sync_failed");

    if (forceFullLoad || versionRes.version !== state.data.version) {
      const dataRes = await apiGet({ action: "getData", token: state.token });
      if (!dataRes.ok) {
        if (dataRes.error === "unauthorized") return handleUnauthorized();
        throw new Error(dataRes.error || "load_failed");
      }
      state.data = {
        moisturlyzer: dataRes.moisturlyzer,
        gateway: dataRes.gateway,
        simcard: dataRes.simcard,
        issuanceLog: dataRes.issuanceLog || [],
        issuanceItems: dataRes.issuanceItems || [],
        users: dataRes.users || [],
        partsCatalog: dataRes.partsCatalog || [],
        colorSorterParts: dataRes.colorSorterParts || [],
        panolyzerParts: dataRes.panolyzerParts || [],
        partsActivityLog: dataRes.partsActivityLog || [],
        version: dataRes.version,
      };
      state.cachedAt = new Date().toISOString();
      localStorage.setItem(LS_CACHE, JSON.stringify({ data: state.data, cachedAt: state.cachedAt }));
      updatePendingBadge();
      renderCurrentView();
    }
    setSyncStatus("online");
  } catch (err) {
    console.error("sync error", err);
    setSyncStatus("offline");
  }
}

async function handleUnauthorized() {
  stopPolling();
  await showAlert("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", "warning");
  logout();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.hidden) return; // ประหยัด quota เมื่อพับ/สลับแท็บ (Page Visibility API)
    refreshInBackground(false);
  }, CONFIG.POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function onVisibilityChange() {
  if (!document.hidden && state.token) {
    refreshInBackground(false); // กลับมาที่แท็บ -> เช็คทันที ไม่ต้องรอรอบถัดไป
  }
}

function setSyncStatus(status) {
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  if (!dot) return;
  dot.className = "sync-dot" + (status === "offline" ? " offline" : status === "syncing" ? " stale" : "");
  label.textContent = status === "offline" ? "ออฟไลน์ / เชื่อมต่อไม่ได้" : status === "syncing" ? "กำลังซิงค์..." : "ซิงค์ล่าสุดแล้ว";
  const note = document.getElementById("cacheNote");
  if (note && state.cachedAt) {
    note.textContent = "ข้อมูลล่าสุด: " + new Date(state.cachedAt).toLocaleString("th-TH");
  }
}

// ============================================================
// View switching
// ============================================================
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  renderCurrentView();
  syncMobileTabbar();
}

function renderCurrentView() {
  const titleEl = document.getElementById("viewTitle");
  if (state.currentView === "dashboard") {
    titleEl.textContent = "Dashboard";
    renderDashboard();
  } else if (state.currentView === "issue") {
    titleEl.textContent = "เบิกอุปกรณ์";
    renderIssueView();
  } else if (state.currentView === "approvals") {
    titleEl.textContent = "อนุมัติการเบิก";
    renderApprovalsView();
  } else if (state.currentView === "history") {
    titleEl.textContent = "ประวัติการเบิก/คืน";
    renderHistoryView();
  } else if (state.currentView === "users") {
    titleEl.textContent = "จัดการผู้ใช้งาน";
    renderUsersView();
  } else if (state.currentView === "manageparts") {
    titleEl.textContent = "จัดการอะไหล่";
    renderManagePartsView();
  } else {
    const cfg = VIEW_CONFIG[state.currentView];
    titleEl.textContent = cfg.title.replace(" (มี S/N)", "");
    if (cfg.partCategory) {
      renderPartsListView(state.currentView, cfg);
    } else {
      renderListView(cfg);
    }
  }
}

// ============================================================
// Dashboard (read-only summary — เทียบเท่าชีต Dashboard เดิม)
// ============================================================
// Phase 9: requireField (ถ้ามี) ต้องมีค่าไม่ว่างด้วยจึงจะนับเป็น "Stock" จริง — ใช้กับ SimCard
// ที่ต้องรอ AIS Activate (กรอกวันที่ใน Activate_date) ก่อน แม้ Installed_device จะเป็น "Stock" แล้วก็ตาม
function isStockRow(row, stockField, requireField) {
  const v = row[stockField];
  const inStock = v && String(v).trim().toLowerCase() === "stock";
  if (!inStock) return false;
  if (requireField && !(row[requireField] && String(row[requireField]).trim())) return false;
  return true;
}

function computeSummary(rows, cfg) {
  const total = rows.length;
  const stock = rows.filter((r) => isStockRow(r, cfg.stockField, cfg.stockRequiresField)).length;
  const used = total - stock;
  const activateField = rows.length && "Activate_date" in rows[0] ? "Activate_date" : (rows.length && "install_date" in rows[0] ? "install_date" : null);
  const activated = activateField ? rows.filter((r) => r[activateField] && String(r[activateField]).trim() !== "").length : null;

  // Phase 9: สำหรับอุปกรณ์ที่ต้องรอ Activate ก่อนถึงจะนับเป็น Stock (เช่น SimCard) แยกยอดให้ชัดเจน
  // ว่า Activate แล้วเหลือกี่ชิ้น (พร้อมเบิก), Activate แล้วเบิกไปกี่ชิ้น, และยังไม่ได้ Activate อีกกี่ชิ้น
  let notActivated = null;
  let activatedUsed = null;
  if (cfg.stockRequiresField) {
    notActivated = rows.filter((r) => !String(r[cfg.stockRequiresField] || "").trim()).length;
    activatedUsed = used - notActivated;
  }
  return { total, stock, used, activated, notActivated, activatedUsed };
}

// สีประจำแต่ละหมวดอุปกรณ์บนหน้า Dashboard มือถือ — ใช้สีเดียวกับไอคอนหน้าแรกมือถือ (mh-c2..mh-c6) เพื่อให้สื่อความหมายตรงกันทั้งแอป
const DASHBOARD_CATEGORY_META = {
  moisturlyzer: { icon: "fa-tint", color: "#17A672" },
  gateway: { icon: "fa-broadcast-tower", color: "#2f6fb0" },
  simcard: { icon: "fa-sim-card", color: "#8B5CF6" },
  colorSorterParts: { icon: "fa-cogs", color: "#e08e0b" },
  panolyzerParts: { icon: "fa-cogs", color: "#EC6BAA" },
};

// เกณฑ์ "ของใกล้หมด" บน Dashboard มือถือ — ใช้ค่าคงที่เดียวกันทุกหมวด (ปรับตัวเลขนี้ได้ถ้าต้องการ threshold ต่างจากนี้)
const LOW_STOCK_THRESHOLD = 5;

/** นับจำนวนธุรกรรมที่ "เบิกแล้ว/คืนแล้ว" (นับเป็นการเบิกจริง) ในเดือนปัจจุบันเทียบกับเดือนก่อนหน้า */
function computeMonthlyIssuedComparison() {
  const now = new Date();
  const curKey = `${now.getFullYear()}-${now.getMonth()}`;
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = `${prevDate.getFullYear()}-${prevDate.getMonth()}`;
  let current = 0;
  let previous = 0;
  (state.data.issuanceLog || []).forEach((txn) => {
    if (txn.RequestStatus !== "Issued" && txn.RequestStatus !== "Returned") return;
    const d = new Date(txn.Timestamp);
    if (isNaN(d.getTime())) return;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key === curKey) current++;
    else if (key === prevKey) previous++;
  });
  return { current, previous };
}

/** รวมเหตุการณ์เบิก/อนุมัติ/ปฏิเสธ/คืนของ ล่าสุด เรียงตามเวลาล่าสุดก่อน ใช้แสดงเป็น "กิจกรรมล่าสุด" บน Dashboard มือถือ */
function computeRecentActivity(limit) {
  const events = [];
  (state.data.issuanceLog || []).forEach((txn) => {
    const items = getItemsForTransaction(txn.TransactionID);
    const firstItem = items[0];
    const itemLabel = firstItem
      ? `${escapeHtml(firstItem.AssetType)} ${escapeHtml(firstItem.SerialNo)}${items.length > 1 ? ` +${items.length - 1} อื่นๆ` : ""}`
      : "อุปกรณ์";
    if (txn.Timestamp) {
      events.push({
        type: "issue", time: txn.Timestamp,
        title: `ขอเบิก ${itemLabel}`, sub: `${escapeHtml(txn.CustomerName || "")} · โดย ${escapeHtml(txn.IssuedBy || "")}`,
      });
    }
    if (txn.ApprovedAt) {
      const rejected = txn.RequestStatus === "Rejected";
      events.push({
        type: rejected ? "reject" : "approve", time: txn.ApprovedAt,
        title: rejected ? `ปฏิเสธคำขอ ${escapeHtml(txn.TransactionID)}` : `อนุมัติคำขอ ${escapeHtml(txn.TransactionID)}`,
        sub: `โดย ${escapeHtml(txn.ApprovedBy || "")}`,
      });
    }
    if (txn.ReturnedAt) {
      events.push({
        type: "return", time: txn.ReturnedAt,
        title: `คืนของ ${itemLabel}`, sub: `${escapeHtml(txn.CustomerName || "")}`,
      });
    }
  });
  events.sort((a, b) => new Date(b.time) - new Date(a.time));
  return events.slice(0, limit);
}

const ACTIVITY_TYPE_META = {
  issue: { icon: "fa-arrow-up-from-bracket", cls: "issue" },
  approve: { icon: "fa-check", cls: "approve" },
  reject: { icon: "fa-times", cls: "reject" },
  return: { icon: "fa-rotate-left", cls: "return" },
};

/** ข้อความเวลาแบบสั้น ("N นาทีที่แล้ว", "เมื่อวาน" ฯลฯ) สำหรับกิจกรรมล่าสุดบน Dashboard มือถือ */
function formatRelativeTimeTh(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "-";
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  if (diffMin < 1) return "เมื่อสักครู่";
  if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ชม.ที่แล้ว`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "เมื่อวาน";
  if (diffDay < 7) return `${diffDay} วันที่แล้ว`;
  return formatDateTh(isoStr);
}

function renderDashboard() {
  const content = document.getElementById("viewContent");
  const summaries = Object.values(VIEW_CONFIG).map((cfg) => ({
    cfg,
    summary: computeSummary(state.data[cfg.key] || [], cfg),
  }));

  if (isMobileViewport()) { renderDashboardMobile(content, summaries); return; }

  let html = `
    <div class="dashboard-actions no-print">
      <button class="btn-secondary" onclick="printDashboard()"><i class="fas fa-print"></i> พิมพ์รายงาน</button>
      <button class="btn-secondary" onclick="generateReportImage(this)"><i class="fas fa-camera"></i> สร้างรูปรายงาน (สำหรับส่ง LINE)</button>
    </div>
    <div id="dashboardReportArea" class="report-doc">
      ${reportHeaderHtml("รายงานสรุปคลังอุปกรณ์", "Equipment Inventory Summary Report", "วันที่ออกรายงาน", formatDateTh(new Date().toISOString()))}
      <div class="kpi-grid">`;
  summaries.forEach(({ cfg, summary }) => {
    if (cfg.stockRequiresField) {
      // Phase 9: SimCard (หรืออุปกรณ์อื่นที่ต้องรอ Activate) — แยกยอดให้ชัดว่า Activate แล้วเหลือ/ใช้ไปกี่ชิ้น
      // และยังไม่ได้ Activate (รอ AIS) อีกกี่ชิ้น แทนที่จะรวมกับ "เบิกออกไปแล้ว" แบบเดิมจนสับสน
      html += `
      <div class="kpi-card">
        <div class="kpi-card-title">${escapeHtml(cfg.title)}</div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-label">ทั้งหมด</span>
          <span class="kpi-stat-value">${summary.total}</span>
        </div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-dot dot-info"></span>
          <span class="kpi-stat-label">Activate แล้ว — พร้อมเบิก (Stock)</span>
          <span class="kpi-stat-value info">${summary.stock}</span>
        </div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-dot dot-warn"></span>
          <span class="kpi-stat-label">Activate แล้ว — เบิกออกไปแล้ว</span>
          <span class="kpi-stat-value warn">${summary.activatedUsed}</span>
        </div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-dot dot-danger"></span>
          <span class="kpi-stat-label">ยังไม่ได้ Activate (รอ AIS)</span>
          <span class="kpi-stat-value danger">${summary.notActivated}</span>
        </div>
      </div>`;
      return;
    }
    html += `
      <div class="kpi-card">
        <div class="kpi-card-title">${escapeHtml(cfg.title)}</div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-label">ทั้งหมด</span>
          <span class="kpi-stat-value">${summary.total}</span>
        </div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-dot dot-info"></span>
          <span class="kpi-stat-label">อยู่ในคลัง (Stock)</span>
          <span class="kpi-stat-value info">${summary.stock}</span>
        </div>
        <div class="kpi-stat-row">
          <span class="kpi-stat-dot dot-warn"></span>
          <span class="kpi-stat-label">เบิกออกไปแล้ว</span>
          <span class="kpi-stat-value warn">${summary.used}</span>
        </div>
        ${summary.activated !== null ? `<div class="kpi-stat-sub">เปิดใช้งานแล้ว (Activated): ${summary.activated}</div>` : ""}
      </div>`;
  });
  html += `
      </div>
      <div class="chart-grid">
        <div class="chart-card">
          <h3>แนวโน้มการเบิกรายเดือน (ธุรกรรมที่อนุมัติแล้ว)</h3>
          <canvas id="chartMonthlyTrend"></canvas>
        </div>
        <div class="chart-card">
          <h3>สัดส่วนคงคลัง ณ ปัจจุบัน (Stock เทียบกับเบิกออกไปแล้ว)</h3>
          <canvas id="chartStockSnapshot"></canvas>
        </div>
      </div>
      ${reportFooterHtml()}
    </div>
  `;

  content.innerHTML = html;
  renderMonthlyTrendChart();
  renderStockSnapshotChart(summaries);
}

// ============================================================
// Dashboard เวอร์ชันมือถือ — วงแหวนสรุปสัดส่วนคงคลัง + ตารางไอคอนแยกตามประเภท (ดูง่ายกว่ากราฟเดิมบนจอเล็ก)
// ============================================================
function renderDashboardMobile(content, summaries) {
  const isAdmin = state.user.role === "Admin";
  const totalStock = summaries.reduce((sum, s) => sum + s.summary.stock, 0);
  const pending = (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").length;

  // คำนวณส่วนโค้งของวงแหวนแต่ละหมวด (เรียงตาม summaries เดิม ให้สีตรงกับไอคอนหน้าแรกมือถือเสมอ)
  const RADIUS = 80;
  const CIRC = 2 * Math.PI * RADIUS;
  let cumulative = 0;
  const segments = totalStock > 0 ? summaries
    .filter((s) => s.summary.stock > 0)
    .map((s) => {
      const meta = DASHBOARD_CATEGORY_META[s.cfg.key] || { color: "#3F654D" };
      const pct = s.summary.stock / totalStock;
      const arcLen = pct * CIRC;
      const seg = { color: meta.color, arcLen, offset: -cumulative, pct: Math.round(pct * 100) };
      cumulative += arcLen;
      return seg;
    }) : [];

  const donutSvg = totalStock > 0
    ? `
      <svg width="200" height="200" viewBox="0 0 200 200">
        <g transform="translate(100,100) rotate(-90)">
          <circle r="${RADIUS}" cx="0" cy="0" fill="none" stroke="#eef1ef" stroke-width="24"/>
          ${segments.map((seg) => `<circle r="${RADIUS}" cx="0" cy="0" fill="none" stroke="${seg.color}" stroke-width="24" stroke-dasharray="${seg.arcLen.toFixed(1)} ${CIRC.toFixed(1)}" stroke-dashoffset="${seg.offset.toFixed(1)}" stroke-linecap="butt"/>`).join("")}
        </g>
        <text x="100" y="96" text-anchor="middle" style="font-size:26px; font-weight:700; fill:#2C4C3A; font-family:inherit;">${totalStock}</text>
        <text x="100" y="116" text-anchor="middle" style="font-size:11px; fill:#63816F; font-family:inherit;">อยู่ในคลังทั้งหมด</text>
      </svg>`
    : `
      <svg width="200" height="200" viewBox="0 0 200 200">
        <circle r="${RADIUS}" cx="100" cy="100" fill="none" stroke="#eef1ef" stroke-width="24"/>
        <text x="100" y="104" text-anchor="middle" style="font-size:13px; fill:#8a938d; font-family:inherit;">ยังไม่มีของในคลัง</text>
      </svg>`;

  const legendHtml = segments.map((seg, i) => {
    const s = summaries.filter((x) => x.summary.stock > 0)[i];
    return `<div class="dash-legend-item"><span class="dash-legend-dot" style="background:${seg.color}"></span>${escapeHtml(s.cfg.title.replace(" (มี S/N)", ""))} ${seg.pct}%</div>`;
  }).join("");

  // ของใกล้หมด — เฉพาะหมวดที่เคยมีของจริง (total > 0) แต่ตอนนี้เหลือน้อยกว่าหรือเท่ากับเกณฑ์ที่ตั้งไว้
  const lowStockCats = summaries.filter(({ summary }) => summary.total > 0 && summary.stock <= LOW_STOCK_THRESHOLD);
  const lowStockNames = lowStockCats.map((s) => s.cfg.title.replace(" (มี S/N)", ""));
  const lowStockText = lowStockCats.length === 1
    ? `${escapeHtml(lowStockNames[0])} เหลือในคลังแค่ ${lowStockCats[0].summary.stock} ชิ้น`
    : `${escapeHtml(lowStockNames.join(", "))} ใกล้หมด`;

  const monthly = computeMonthlyIssuedComparison();
  const monthlyDiff = monthly.current - monthly.previous;
  const monthlyPct = monthly.previous > 0 ? Math.round((monthlyDiff / monthly.previous) * 100) : (monthly.current > 0 ? 100 : 0);
  const monthlyCompareHtml = monthly.previous === 0 && monthly.current === 0
    ? `<span class="dash-m-compare">เดือนก่อนไม่มีข้อมูล</span>`
    : `<span class="dash-m-compare ${monthlyDiff >= 0 ? "up" : "down"}">${monthlyDiff >= 0 ? "▲" : "▼"} ${Math.abs(monthlyPct)}% จากเดือนก่อน (${monthly.previous})</span>`;

  const recentActivity = computeRecentActivity(5);

  content.innerHTML = `
    <div class="dash-mobile-header">
      <div class="dash-mobile-title">ภาพรวมคลังอุปกรณ์</div>
      <div class="dash-mobile-actions no-print">
        <button class="dash-icon-btn" onclick="printDashboard()" title="พิมพ์รายงาน"><i class="fas fa-print"></i></button>
        <button class="dash-icon-btn" onclick="generateReportImage(this)" title="สร้างรูปรายงาน"><i class="fas fa-camera"></i></button>
      </div>
    </div>
    <div id="dashboardReportArea">
      <div class="dash-donut-wrap">${donutSvg}</div>
      ${segments.length ? `<div class="dash-legend-row">${legendHtml}</div>` : ""}

      <button class="dash-cta-btn no-print" onclick="switchView('issue')"><i class="fas fa-dolly"></i> เบิกอุปกรณ์</button>

      ${isAdmin && pending > 0 ? `
        <div class="dash-pending-alert" onclick="switchView('approvals')">
          <div class="dash-pending-icon"><i class="fas fa-clock"></i></div>
          <div class="dash-pending-text"><b>มีคำขอรออนุมัติ ${pending} รายการ</b><span>แตะเพื่อตรวจสอบและอนุมัติทันที</span></div>
          <i class="fas fa-chevron-right"></i>
        </div>` : ""}

      ${lowStockCats.length ? `
        <div class="dash-lowstock-alert">
          <div class="dash-lowstock-icon"><i class="fas fa-triangle-exclamation"></i></div>
          <div class="dash-pending-text"><b>${lowStockText}</b><span>ใกล้หมด — ควรเตรียมสั่งเพิ่ม</span></div>
        </div>` : ""}

      <div class="dash-monthly-stat">
        <div><div class="dash-m-label">เดือนนี้เบิกไปแล้ว</div><div class="dash-m-value">${monthly.current} รายการ</div></div>
        ${monthlyCompareHtml}
      </div>

      <div class="section-subtitle" style="margin-top:18px;">แยกตามประเภทอุปกรณ์</div>
      <div class="dash-cat-grid">
        ${summaries.map(({ cfg, summary }) => {
          const meta = DASHBOARD_CATEGORY_META[cfg.key] || { icon: "fa-box", color: "#3F654D" };
          const isLow = summary.total > 0 && summary.stock <= LOW_STOCK_THRESHOLD;
          return `
          <div class="dash-cat-tile" onclick="switchView('${escapeAttr(cfg.key)}')">
            <div class="dash-cat-icon" style="background:${meta.color}"><i class="fas ${meta.icon}"></i></div>
            <div class="dash-cat-name">${escapeHtml(cfg.title.replace(" (มี S/N)", ""))}</div>
            <div class="dash-cat-count${isLow ? " low" : ""}">${summary.stock} ในคลัง</div>
          </div>`;
        }).join("")}
      </div>

      ${recentActivity.length ? `
        <div class="section-subtitle" style="margin-top:18px;">กิจกรรมล่าสุด</div>
        <div class="dash-activity-list">
          ${recentActivity.map((ev) => {
            const meta = ACTIVITY_TYPE_META[ev.type] || { icon: "fa-circle", cls: "issue" };
            return `
            <div class="dash-activity-item">
              <div class="dash-activity-icon ${meta.cls}"><i class="fas ${meta.icon}"></i></div>
              <div class="dash-activity-text"><b>${ev.title}</b><span>${ev.sub}</span></div>
              <div class="dash-activity-time">${formatRelativeTimeTh(ev.time)}</div>
            </div>`;
          }).join("")}
        </div>` : ""}
    </div>
  `;
}

// ============================================================
// Phase 5: หัว/ท้ายเอกสารรูปแบบทางการของ C2TECH — ใช้ร่วมกันทั้ง Dashboard, รูปรายงาน LINE, และใบเบิกพิมพ์
// ============================================================
function reportHeaderHtml(titleTh, titleEn, dateLabel, dateValue) {
  return `
    <div class="report-header">
      <div class="report-logo-col">
        <img src="assets/c2tech-logo.png" class="report-logo" alt="C2TECH">
        <div class="report-app-tag">C2-LOOP</div>
      </div>
      <div class="report-header-text">
        <div class="report-doc-title">${escapeHtml(titleTh)}</div>
        <div class="report-doc-sub">${escapeHtml(titleEn)}</div>
      </div>
      <div class="report-header-date">
        <div>${escapeHtml(dateLabel)}</div>
        <div class="report-date-value">${escapeHtml(dateValue)}</div>
      </div>
    </div>
    <div class="report-divider"></div>
  `;
}

function reportFooterHtml() {
  return `
    <div class="report-footer">
      <div>บริษัท ซีทูเทค จำกัด (C2 Tech Company Limited) · 99/3 หมู่ 9 ต.วังไก่เถื่อน อ.หันคา จ.ชัยนาท 17130</div>
      <div>063-929-1999 · 064-654-5636 · www.c2tech.app</div>
    </div>
  `;
}

// ============================================================
// Phase 4: กราฟ Dashboard (Chart.js)
// ============================================================
const CHART_COLORS = {
  moisturlyzer: "#3F654D",
  gateway: "#2f6fb0",
  simcard: "#e08e0b",
};

function destroyAllCharts() {
  Object.values(state.charts).forEach((c) => { if (c) c.destroy(); });
  state.charts = {};
}

/** นับจำนวนชิ้นที่ถูกอนุมัติเบิก (Issued/Returned) แยกตามเดือน (YYYY-MM) และประเภทอุปกรณ์ */
function computeMonthlyTrend() {
  const approvedTxnIds = new Set(
    (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "Issued" || r.RequestStatus === "Returned").map((r) => r.TransactionID)
  );
  const txnMonth = {};
  (state.data.issuanceLog || []).forEach((r) => {
    const d = new Date(r.Timestamp);
    if (!isNaN(d.getTime())) txnMonth[r.TransactionID] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const monthly = {}; // { "2026-08": { MoisturLyzer: 2, Gateway: 1, SimCard: 0 } }
  (state.data.issuanceItems || []).forEach((item) => {
    if (!approvedTxnIds.has(item.TransactionID)) return;
    const month = txnMonth[item.TransactionID];
    if (!month) return;
    if (!monthly[month]) monthly[month] = { MoisturLyzer: 0, Gateway: 0, SimCard: 0 };
    monthly[month][item.AssetType] = (monthly[month][item.AssetType] || 0) + 1;
  });

  const months = Object.keys(monthly).sort();
  return { months, monthly };
}

function renderMonthlyTrendChart() {
  const canvas = document.getElementById("chartMonthlyTrend");
  if (!canvas || typeof Chart === "undefined") return;
  const { months, monthly } = computeMonthlyTrend();

  if (!months.length) {
    canvas.replaceWith(Object.assign(document.createElement("div"), { className: "empty-state", textContent: "ยังไม่มีข้อมูลการเบิกที่อนุมัติแล้ว" }));
    return;
  }

  const datasets = ["MoisturLyzer", "Gateway", "SimCard"].map((assetType) => ({
    label: assetType,
    data: months.map((m) => monthly[m][assetType] || 0),
    borderColor: CHART_COLORS[assetType.toLowerCase()],
    backgroundColor: CHART_COLORS[assetType.toLowerCase()] + "33",
    tension: 0.4,
    fill: true,
    pointRadius: 3,
  }));

  if (state.charts.monthlyTrend) state.charts.monthlyTrend.destroy();
  state.charts.monthlyTrend = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: months, datasets },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function renderStockSnapshotChart(summaries) {
  const canvas = document.getElementById("chartStockSnapshot");
  if (!canvas || typeof Chart === "undefined") return;

  if (state.charts.stockSnapshot) state.charts.stockSnapshot.destroy();
  state.charts.stockSnapshot = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: summaries.map((s) => s.cfg.title),
      datasets: [
        { label: "อยู่ในคลัง (Stock)", data: summaries.map((s) => s.summary.stock), backgroundColor: "#2f9e58" },
        { label: "เบิกออกไปแล้ว", data: summaries.map((s) => s.summary.used), backgroundColor: "#e08e0b" },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { stacked: false } },
    },
  });
}

// ============================================================
// Phase 4: ระบบพิมพ์
// ============================================================

/**
 * เช็คว่าหน้านี้ถูกฝัง (embed) อยู่ใน iframe ของหน้าอื่นหรือไม่ (เช่น ตอนแปะแอปนี้ไว้บน Google Sites)
 * เหตุผลที่ต้องเช็ค: Google Sites ฝังหน้าเว็บผ่าน iframe ที่ sandbox ไม่ได้เปิดสิทธิ์ allow-modals ให้
 * ทำให้ window.print()/alert()/confirm() ที่เรียกตรงๆ ข้างในหน้านี้ใช้งานไม่ได้เลย (เงียบๆ ไม่มี error)
 * ทางแก้คือเปิดหน้าต่างใหม่ (window.open) แล้วสั่งพิมพ์จากหน้าต่างนั้นแทน เพราะหน้าต่างที่เปิดใหม่นี้
 * จะไม่ได้อยู่ภายใต้ sandbox ของ iframe เดิมแล้ว
 */
function isInIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    // เข้าถึง window.top ไม่ได้ (cross-origin) แปลว่าถูกฝังอยู่แน่นอน
    return true;
  }
}

function printDashboard() {
  if (isInIframe()) {
    printDashboardViaPopup();
    return;
  }
  document.body.classList.add("print-dashboard-active");
  window.print();
}

/**
 * ทางเลือกสำรองสำหรับตอนแอปถูกฝังใน iframe (เช่น Google Sites): ใช้ html2canvas ถ่ายภาพ
 * พื้นที่ Dashboard (รวมกราฟ Chart.js ที่เป็น canvas สดๆ) เป็นรูปเดียว แล้วเปิดหน้าต่างใหม่
 * ใส่รูปนั้นเต็มหน้าแล้วสั่งพิมพ์จากหน้าต่างนั้น — ไม่ต้องสร้างกราฟใหม่ในหน้าต่าง popup ให้ซับซ้อน
 */
async function printDashboardViaPopup() {
  if (typeof html2canvas === "undefined") {
    await showAlert("ไม่สามารถโหลดไลบรารีสำหรับสร้างรูปเพื่อพิมพ์ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่", "error");
    return;
  }
  const popup = window.open("", "_blank");
  if (!popup) {
    await showAlert("เบราว์เซอร์บล็อกการเปิดหน้าต่างใหม่ กรุณาอนุญาต Pop-up สำหรับเว็บไซต์นี้แล้วลองอีกครั้ง", "error");
    return;
  }
  popup.document.write('<!DOCTYPE html><html><head><title>C2 LOOP — พิมพ์ Dashboard</title><style>body{margin:0;padding:16px;text-align:center;background:#fff;}img{max-width:100%;}</style></head><body><p>กำลังเตรียมข้อมูลสำหรับพิมพ์...</p></body></html>');
  popup.document.close();
  try {
    const area = document.getElementById("dashboardReportArea");
    const canvas = await html2canvas(area, { backgroundColor: "#ffffff", scale: 2 });
    const dataUrl = canvas.toDataURL("image/png");
    popup.document.body.innerHTML = `<img src="${dataUrl}" alt="C2 LOOP Dashboard">`;
    popup.document.title = "C2 LOOP — พิมพ์ Dashboard";
    setTimeout(() => {
      popup.focus();
      popup.print();
    }, 300);
  } catch (err) {
    popup.close();
    await showAlert("สร้างรูปสำหรับพิมพ์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", "error");
  }
}

function printSlip(transactionId) {
  const txn = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (!txn) return;
  const items = getItemsForTransaction(transactionId);
  const statusLabel = { PendingApproval: "รออนุมัติ", Issued: "เบิกแล้ว", Rejected: "ถูกปฏิเสธ", Returned: "คืนแล้ว" };

  const html = `
    <div class="print-slip report-doc formal-doc">
      <div class="formal-page-tag">C2-LOOP</div>
      <div class="formal-header">
        <img src="assets/c2tech-logo.png" class="formal-logo" alt="C2TECH">
        <div class="formal-company">
          <div class="formal-company-name">บริษัท ซีทูเทค จำกัด</div>
          <div class="formal-company-sub">C2 Tech Company Limited</div>
          <div class="formal-company-addr">99/3 หมู่ 9 ต.วังไก่เถื่อน อ.หันคา จ.ชัยนาท 17130 · 063-929-1999, 064-654-5636</div>
        </div>
      </div>
      <div class="formal-doctitle">ใบเบิกอุปกรณ์ <span class="formal-doctitle-en">Equipment Issuance Form</span></div>

      <div class="formal-toprow">
        <div class="formal-toprow-left">
          <div class="formal-field"><span class="formal-field-label">ลูกค้า</span><span class="formal-field-value">${escapeHtml(txn.CustomerName)}</span></div>
          <div class="formal-field"><span class="formal-field-label">สถานที่ติดตั้ง</span><span class="formal-field-value">${escapeHtml(txn.SiteLocation || "-")}</span></div>
        </div>
        <table class="formal-docinfo">
          <tr><th>เลขที่เอกสาร</th><td>${escapeHtml(txn.TransactionID)}</td></tr>
          <tr><th>วันที่เอกสาร</th><td>${escapeHtml(formatDateTh(txn.Timestamp))}</td></tr>
          <tr><th>สถานะ</th><td>${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}</td></tr>
        </table>
      </div>

      <table class="slip-table">
        <colgroup><col class="slip-col-no"><col class="slip-col-type"><col class="slip-col-serial"></colgroup>
        <thead><tr><th>#</th><th>ประเภทอุปกรณ์</th><th>Serial</th></tr></thead>
        <tbody>
          ${items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${escapeHtml(i.AssetType)}</td><td>${escapeHtml(i.SerialNo)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="slip-table-summary">รวมทั้งหมด ${items.length} รายการ</div>

      <div class="formal-remark-box"><strong>หมายเหตุ:</strong> ${txn.Details ? escapeHtml(txn.Details) : ""}</div>

      <div class="signature-row-3">
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ผู้เบิก / ผู้ส่งมอบ</div>
          <div class="signature-name">${escapeHtml(txn.IssuedBy || "")}</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ผู้อนุมัติ (Approved by)</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ผู้รับของ (ลูกค้า)</div>
          <div class="signature-name">&nbsp;</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
      </div>
    </div>
  `;

  if (isInIframe()) {
    printSlipViaPopup(html);
    return;
  }

  document.getElementById("printSlipRoot").innerHTML = html;
  document.body.classList.add("print-slip-active");
  window.print();
}

/**
 * ทางเลือกสำรองสำหรับตอนแอปถูกฝังใน iframe: เปิดหน้าต่างใหม่ ใส่ HTML ของใบเบิกที่สร้างไว้แล้ว
 * พร้อมลิงก์ style.css เดิมของแอป (ให้หน้าตาใบเบิกเหมือนเดิมทุกอย่าง) แล้วสั่งพิมพ์จากหน้าต่างนั้น
 */
function printSlipViaPopup(html) {
  const popup = window.open("", "_blank");
  if (!popup) {
    showAlert("เบราว์เซอร์บล็อกการเปิดหน้าต่างใหม่ กรุณาอนุญาต Pop-up สำหรับเว็บไซต์นี้แล้วลองอีกครั้ง", "error");
    return;
  }
  const styleHref = new URL("style.css", window.location.href).href;
  popup.document.write(`<!DOCTYPE html><html><head><title>C2 LOOP — ใบเบิกอุปกรณ์</title><link rel="stylesheet" href="${styleHref}"></head><body class="print-slip-active"><div id="printSlipRoot">${html}</div></body></html>`);
  popup.document.close();
  setTimeout(() => {
    popup.focus();
    popup.print();
  }, 300);
}

window.addEventListener("afterprint", () => {
  document.body.classList.remove("print-dashboard-active", "print-slip-active");
  document.getElementById("printSlipRoot").innerHTML = "";
});

// ============================================================
// Phase 4: สร้างรูปรายงานสำหรับคัดลอกไปวางส่งใน LINE
// ============================================================
async function generateReportImage(btnEl) {
  if (typeof html2canvas === "undefined") {
    await showAlert("ไม่สามารถโหลดไลบรารีสร้างรูปภาพได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต", "error");
    return;
  }
  // ขั้นตอนนี้ไม่ได้ผ่าน apiPost (เป็นการเรนเดอร์ภาพในเครื่องล้วนๆ) จึงต้องใส่สถานะโหลดที่ปุ่มเองโดยตรง
  // เพราะรูป Dashboard ที่มีกราฟเยอะอาจใช้เวลาเรนเดอร์สักครู่ ไม่งั้นจะดูเหมือนกดแล้วไม่มีอะไรเกิดขึ้น
  const originalText = btnEl ? btnEl.innerHTML : "";
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> กำลังสร้างรูป...'; }
  try {
    const area = document.getElementById("dashboardReportArea");
    const canvas = await html2canvas(area, { backgroundColor: "#ffffff", scale: 2 });
    const dataUrl = canvas.toDataURL("image/png");

    document.getElementById("reportPreviewImg").src = dataUrl;
    document.getElementById("downloadImageBtn").href = dataUrl;
    document.getElementById("imageModalMsg").className = "form-msg";
    document.getElementById("imageModalMsg").textContent = "";
    document.getElementById("imagePreviewModal").style.display = "flex";
    document.getElementById("imagePreviewModal")._canvas = canvas;
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = originalText; }
  }
}

function closeImagePreviewModal() {
  document.getElementById("imagePreviewModal").style.display = "none";
}

async function copyReportImage() {
  const modal = document.getElementById("imagePreviewModal");
  const canvas = modal._canvas;
  const msg = document.getElementById("imageModalMsg");
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error("ไม่รองรับ");
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    msg.className = "form-msg success";
    msg.textContent = "คัดลอกรูปแล้ว — ไปวาง (Ctrl+V) ในแชท LINE ได้เลย";
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = "เบราว์เซอร์นี้ไม่รองรับการคัดลอกรูปโดยตรง กรุณากด \"บันทึกรูป\" แล้วแนบไฟล์ใน LINE แทน";
  }
}

// ============================================================
// List views (read-only, Phase 1 — ยังไม่มีระบบเบิก/แก้ไข)
// ============================================================
function renderListView(cfg) {
  const content = document.getElementById("viewContent");
  const rows = state.data[cfg.key] || [];
  const isAdmin = state.user.role === "Admin";
  const mobile = isMobileViewport();

  content.innerHTML = `
    <div class="controls-row">
      <input type="text" id="searchBox" placeholder="ค้นหา (S/N, ลูกค้า, สถานะ...)">
      <select id="statusFilter">
        <option value="all">-- สถานะทั้งหมด --</option>
        <option value="stock">อยู่ในคลัง (Stock)</option>
        <option value="used">เบิกออกไปแล้ว</option>
      </select>
    </div>
    ${mobile
      ? `<div id="listCards" class="mcard-list"></div>`
      : `<div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr>${cfg.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}${isAdmin ? "<th>จัดการ</th>" : ""}</tr></thead>
          <tbody id="listTbody"></tbody>
        </table>
      </div>
    </div>`}
  `;

  document.getElementById("searchBox").addEventListener("input", () => renderRows(cfg, rows, isAdmin));
  document.getElementById("statusFilter").addEventListener("change", () => renderRows(cfg, rows, isAdmin));
  renderRows(cfg, rows, isAdmin);
}

function renderRows(cfg, rows, isAdmin) {
  const search = (document.getElementById("searchBox").value || "").toLowerCase();
  const statusFilter = document.getElementById("statusFilter").value;

  const filtered = rows.filter((row) => {
    const matchesSearch = !search || cfg.columns.some((c) => String(row[c.field] || "").toLowerCase().includes(search));
    const stock = isStockRow(row, cfg.stockField, cfg.stockRequiresField);
    const matchesStatus = statusFilter === "all" || (statusFilter === "stock" ? stock : !stock);
    return matchesSearch && matchesStatus;
  });

  if (isMobileViewport()) {
    renderRowsAsCards(cfg, filtered, isAdmin);
  } else {
    renderRowsAsTable(cfg, filtered, isAdmin);
  }
}

function renderRowsAsTable(cfg, filtered, isAdmin) {
  const tbody = document.getElementById("listTbody");
  if (!tbody) return;
  const hasExtraCol = isAdmin || cfg.partCategory;
  const colspan = cfg.columns.length + (hasExtraCol ? 1 : 0);

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row) => {
    const cells = cfg.columns.map((c) => {
      if (c.computed) {
        const serial = String(row[cfg.serialField] || "");
        const linked = computeLinkedAccessories(serial);
        return `<td>${linked.length ? linked.map((l) => `<span class="badge-linked">${escapeHtml(l)}</span>`).join(" ") : `<span class="cache-note">-</span>`}</td>`;
      }
      let val = row[c.field];
      if (c.field === cfg.stockField) {
        const stock = isStockRow(row, cfg.stockField, cfg.stockRequiresField);
        val = `<span class="${stock ? "badge-stock" : "badge-used"}">${escapeHtml(String(val || ""))}</span>`;
        return `<td>${val}</td>`;
      }
      return `<td>${escapeHtml(String(val === undefined || val === null ? "" : val))}</td>`;
    }).join("");
    const serial = String(row[cfg.serialField] || "");
    // Phase 10: อะไหล่แบบมี S/N มีปุ่ม "ประวัติ" เพิ่ม เพื่อดู timeline ของอะไหล่ชิ้นนี้ (เพิ่ม/เติม/แก้ชื่อ/ลบ/เบิก/คืน)
    const historyBtn = cfg.partCategory
      ? `<button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}')">ประวัติ</button>`
      : "";
    const actionsCell = isAdmin
      ? `<td class="no-wrap">
           <button class="btn-sm btn-secondary" onclick="openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>
           <button class="btn-sm btn-remove" onclick="deleteAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ลบ</button>
           ${historyBtn}
         </td>`
      : (cfg.partCategory ? `<td class="no-wrap">${historyBtn}</td>` : "");
    return `<tr>${cells}${actionsCell}</tr>`;
  }).join("");
}

// Phase: มือถือ — แปลงแถวข้อมูลเป็นการ์ด (แทนตารางที่ต้องเลื่อนซ้าย-ขวา) ใช้ร่วมกันทุกประเภทอุปกรณ์/อะไหล่แบบมี S/N
function renderRowsAsCards(cfg, filtered, isAdmin) {
  const wrap = document.getElementById("listCards");
  if (!wrap) return;

  if (!filtered.length) {
    wrap.innerHTML = `<div class="mcard-empty">ไม่พบข้อมูล</div>`;
    return;
  }

  wrap.innerHTML = filtered.map((row) => {
    const serial = String(row[cfg.serialField] || "");
    const stock = isStockRow(row, cfg.stockField, cfg.stockRequiresField);

    const bodyRows = cfg.columns
      .filter((c) => c.field !== cfg.serialField && c.field !== "No" && c.field !== cfg.stockField)
      .map((c) => {
        if (c.computed) {
          const linked = computeLinkedAccessories(serial);
          const val = linked.length ? linked.join(", ") : "-";
          return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(c.label)}</div><div class="mcard-val">${escapeHtml(val)}</div></div>`;
        }
        const val = row[c.field];
        if (val === undefined || val === null || val === "") return "";
        return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(c.label)}</div><div class="mcard-val">${escapeHtml(String(val))}</div></div>`;
      }).join("");

    const historyBtn = cfg.partCategory
      ? `<button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}')">ประวัติ</button>`
      : "";
    const actionsHtml = isAdmin
      ? `<div class="mcard-actions">
           <button class="btn-sm btn-secondary" onclick="openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>
           <button class="btn-sm btn-remove" onclick="deleteAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ลบ</button>
           ${historyBtn}
         </div>`
      : (cfg.partCategory ? `<div class="mcard-actions">${historyBtn}</div>` : "");

    return `
      <div class="mcard">
        <div class="mcard-head">
          <div class="mcard-title">${escapeHtml(serial || "-")}</div>
          <span class="mcard-pill ${stock ? "stock" : "used"}">${stock ? "อยู่ในคลัง" : "เบิกออกแล้ว"}</span>
        </div>
        ${bodyRows}
        ${actionsHtml}
      </div>`;
  }).join("");
}

// ============================================================
// Phase 8: อะไหล่ Color Sorter / Panolyzer — หน้ารายการ (รวมแบบมี S/N + แบบนับจำนวนในหน้าเดียวกัน)
// ============================================================

/** อะไหล่แบบนับจำนวน (ไม่มี S/N) ทั้งหมดของหมวดที่ระบุ */
function getQtyPartsForCategory(category) {
  return (state.data.partsCatalog || []).filter((p) => p.Category === category && String(p.HasSerial).toLowerCase() === "no");
}

/** อะไหล่แบบมี S/N ทั้งหมดของหมวดที่ระบุ (ใช้เลือกใน dropdown "เติมของที่มีอยู่แล้ว") */
function getSerialPartsForCategory(category) {
  return (state.data.partsCatalog || []).filter((p) => p.Category === category && String(p.HasSerial).toLowerCase() === "yes");
}

/** จำนวนที่ "กำลังเบิกอยู่" (ธุรกรรมสถานะ Issued ที่ยังไม่คืน) ของอะไหล่แบบนับจำนวนชิ้นหนึ่ง */
function computePartIssuedQty(partId, assetType) {
  const issuedTxnIds = new Set((state.data.issuanceLog || []).filter((r) => r.RequestStatus === "Issued").map((r) => r.TransactionID));
  let total = 0;
  (state.data.issuanceItems || []).forEach((it) => {
    if (issuedTxnIds.has(it.TransactionID) && it.AssetType === assetType && String(it.SerialNo) === String(partId)) {
      total += Number(it.Quantity) || 0;
    }
  });
  return total;
}

/** จำนวนที่ "รออนุมัติ" ของอะไหล่แบบนับจำนวนชิ้นหนึ่ง */
function computePartPendingQty(partId, assetType) {
  const pendingTxnIds = new Set((state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").map((r) => r.TransactionID));
  let total = 0;
  (state.data.issuanceItems || []).forEach((it) => {
    if (pendingTxnIds.has(it.TransactionID) && it.AssetType === assetType && String(it.SerialNo) === String(partId)) {
      total += Number(it.Quantity) || 0;
    }
  });
  return total;
}

function renderPartsListView(viewKey, cfg) {
  const content = document.getElementById("viewContent");
  const rows = state.data[cfg.key] || [];
  const isAdmin = state.user.role === "Admin";
  const mobile = isMobileViewport();
  const qtyAssetType = PART_QTY_ASSET_TYPE_BY_VIEW[viewKey];
  const qtyParts = getQtyPartsForCategory(PART_CATEGORY_BY_VIEW[viewKey]);
  const qtyColspan = isAdmin ? 6 : 5;

  const qtyPartsSectionHtml = mobile
    ? `<div class="mcard-list">
        ${qtyParts.length ? qtyParts.map((p) => {
          const issued = computePartIssuedQty(p.PartID, qtyAssetType);
          const pending = computePartPendingQty(p.PartID, qtyAssetType);
          const actionsHtml = isAdmin
            ? `<div class="mcard-actions">
                 <button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">ดูประวัติ</button>
                 <button class="btn-sm btn-secondary" onclick="renamePartPrompt('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">แก้ไขชื่อ</button>
                 <button class="btn-sm btn-remove" onclick="deletePartHandler('${escapeAttr(p.PartID)}')">ลบ</button>
               </div>`
            : `<div class="mcard-actions"><button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">ดูประวัติ</button></div>`;
          return `
          <div class="mcard">
            <div class="mcard-head">
              <div class="mcard-title">${escapeHtml(p.PartName)}</div>
              <span class="mcard-pill stock">${escapeHtml(String(p.QuantityInStock))} ในสต็อก</span>
            </div>
            <div class="mcard-row"><div class="mcard-label">กำลังเบิกอยู่</div><div class="mcard-val">${issued}</div></div>
            <div class="mcard-row"><div class="mcard-label">รออนุมัติ</div><div class="mcard-val">${pending}</div></div>
            ${actionsHtml}
          </div>`;
        }).join("") : `<div class="mcard-empty">ยังไม่มีอะไหล่แบบนับจำนวนในหมวดนี้</div>`}
      </div>`
    : `<div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr><th>ชื่ออะไหล่</th><th>คงเหลือในสต็อก</th><th>กำลังเบิกอยู่</th><th>รออนุมัติ</th><th>ประวัติ</th>${isAdmin ? "<th>จัดการ</th>" : ""}</tr></thead>
          <tbody>
            ${qtyParts.length ? qtyParts.map((p) => {
              const issued = computePartIssuedQty(p.PartID, qtyAssetType);
              const pending = computePartPendingQty(p.PartID, qtyAssetType);
              const historyCell = `<td><button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">ดูประวัติ</button></td>`;
              const actionsCell = isAdmin
                ? `<td class="no-wrap">
                     <button class="btn-sm btn-secondary" onclick="renamePartPrompt('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">แก้ไขชื่อ</button>
                     <button class="btn-sm btn-remove" onclick="deletePartHandler('${escapeAttr(p.PartID)}')">ลบ</button>
                   </td>`
                : "";
              return `<tr><td>${escapeHtml(p.PartName)}</td><td><span class="badge-stock">${escapeHtml(String(p.QuantityInStock))}</span></td><td>${issued}</td><td>${pending}</td>${historyCell}${actionsCell}</tr>`;
            }).join("") : `<tr class="empty-row"><td colspan="${qtyColspan}">ยังไม่มีอะไหล่แบบนับจำนวนในหมวดนี้</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  content.innerHTML = `
    <h3 class="section-subtitle">อะไหล่แบบนับจำนวน (ไม่มี S/N)</h3>
    ${qtyPartsSectionHtml}

    <h3 class="section-subtitle" style="margin-top:22px;">อะไหล่แบบมี S/N (รายชิ้น)</h3>
    <div class="controls-row">
      <input type="text" id="searchBox" placeholder="ค้นหา (S/N, ลูกค้า, สถานะ...)">
      <select id="statusFilter">
        <option value="all">-- สถานะทั้งหมด --</option>
        <option value="stock">อยู่ในคลัง (Stock)</option>
        <option value="used">เบิกออกไปแล้ว</option>
      </select>
    </div>
    ${mobile
      ? `<div id="listCards" class="mcard-list"></div>`
      : `<div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr>${cfg.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}${isAdmin ? "<th>จัดการ</th>" : "<th>ประวัติ</th>"}</tr></thead>
          <tbody id="listTbody"></tbody>
        </table>
      </div>
    </div>`}
    ${isAdmin ? `<div class="cache-note" style="margin-top:10px;">ต้องการเพิ่มอะไหล่ใหม่หรือเติมสต็อก? ไปที่เมนู "จัดการอะไหล่"</div>` : ""}
  `;

  document.getElementById("searchBox").addEventListener("input", () => renderRows(cfg, rows, isAdmin));
  document.getElementById("statusFilter").addEventListener("change", () => renderRows(cfg, rows, isAdmin));
  renderRows(cfg, rows, isAdmin);
}

async function renamePartPrompt(partId, currentName) {
  openGenericFormModal(`แก้ไขชื่ออะไหล่`, [{ key: "PartName", label: "ชื่ออะไหล่", value: currentName }], async (values) => {
    const msg = document.getElementById("genericFormModalMsg");
    try {
      const res = await apiPost({ action: "updatePartCatalog", token: state.token, partId, updates: { PartName: values[0] } });
      if (!res.ok) {
        if (res.error === "unauthorized") return handleUnauthorized();
        throw new Error(res.error === "part_name_taken" ? "ชื่ออะไหล่นี้มีอยู่แล้วในหมวดเดียวกัน" : "บันทึกไม่สำเร็จ กรุณาลองใหม่");
      }
      await refreshInBackground(true);
      closeGenericFormModal();
      renderCurrentView();
    } catch (err) {
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });
}

function partErrorMessage(code) {
  switch (code) {
    case "part_has_units": return "ไม่สามารถลบได้ — อะไหล่นี้ยังมีชิ้นที่มี S/N เหลืออยู่ในระบบ กรุณาลบทีละชิ้นให้หมดก่อน";
    case "part_in_use": return "ไม่สามารถลบได้ — อะไหล่นี้ยังมีสต็อกเหลืออยู่ หรือมีคำขอเบิกที่ยังไม่ปิดจบอ้างอิงถึงอยู่";
    case "part_not_found": return "ไม่พบอะไหล่นี้ในระบบ (อาจถูกลบไปแล้ว)";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

async function deletePartHandler(partId) {
  const confirmed = await showConfirm("ยืนยันลบอะไหล่นี้ออกจากรายการทั้งหมด? การลบไม่สามารถย้อนกลับได้", { type: "warning", okText: "ลบเลย", danger: true });
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "deletePart", token: state.token, partId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(partErrorMessage(res.error), "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

// ============================================================
// Phase 10: ประวัติการทำรายการของอะไหล่ (PartsActivityLog)
// ============================================================
const PART_HISTORY_ACTION_LABELS = {
  Added: "เพิ่มอะไหล่ใหม่", Restocked: "เติมของเข้าสต็อก", Renamed: "แก้ไขชื่อ",
  Deleted: "ลบอะไหล่", Issued: "เบิกออก", Returned: "คืนของ",
};
const PART_HISTORY_ACTION_ICONS = {
  Added: '<i class="fas fa-plus"></i>', Restocked: '<i class="fas fa-box"></i>', Renamed: '<i class="fas fa-pen"></i>',
  Deleted: '<i class="fas fa-trash"></i>', Issued: '<i class="fas fa-arrow-up"></i>', Returned: '<i class="fas fa-arrow-down"></i>',
};

function closePartHistoryModal() {
  document.getElementById("partHistoryModal").style.display = "none";
}

/** แสดงประวัติทั้งหมดของอะไหล่ 1 ชิ้น (partId) เรียงจากล่าสุดไปเก่าสุด */
function showPartHistory(partId, partName) {
  const logs = (state.data.partsActivityLog || [])
    .filter((l) => l.PartID === partId)
    .slice()
    .sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
  document.getElementById("partHistoryModalTitle").textContent = `ประวัติ — ${partName || partId}`;
  renderPartHistoryBody(logs, "ยังไม่มีประวัติของอะไหล่ชิ้นนี้");
  document.getElementById("partHistoryModal").style.display = "flex";
}

/** แสดงประวัติล่าสุดของอะไหล่ทุกชิ้นรวมกัน (จำกัดจำนวนแถวล่าสุด เพื่อไม่ให้รายการยาวเกินไป) */
function showPartsActivityFeed(category) {
  const logs = (state.data.partsActivityLog || [])
    .filter((l) => !category || l.Category === category)
    .slice()
    .sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))
    .slice(0, 100);
  document.getElementById("partHistoryModalTitle").textContent = category ? `ประวัติอะไหล่ล่าสุด — ${category}` : "ประวัติอะไหล่ล่าสุดทั้งหมด";
  renderPartHistoryBody(logs, "ยังไม่มีประวัติอะไหล่");
  document.getElementById("partHistoryModal").style.display = "flex";
}

function renderPartHistoryBody(logs, emptyMessage) {
  const body = document.getElementById("partHistoryModalBody");
  if (!logs.length) {
    body.innerHTML = `<div class="cache-note">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  body.innerHTML = `<div class="history-timeline">${logs.map((l) => `
    <div class="history-entry">
      <div class="history-entry-icon">${PART_HISTORY_ACTION_ICONS[l.Action] || "•"}</div>
      <div class="history-entry-body">
        <div class="history-entry-head"><b>${escapeHtml(PART_HISTORY_ACTION_LABELS[l.Action] || l.Action)}${l.PartName ? " — " + escapeHtml(l.PartName) : ""}</b><span>${formatDateTh(l.Timestamp)}</span></div>
        <div class="history-entry-detail">${escapeHtml(l.Detail || "")}</div>
        <div class="history-entry-actor">โดย ${escapeHtml(l.Actor || "-")}</div>
      </div>
    </div>`).join("")}</div>`;
}

// ============================================================
// Phase 8: จัดการอะไหล่ (Admin เท่านั้น) — เพิ่มอะไหล่ใหม่ / เติมของที่มีอยู่แล้ว
// ============================================================
let managePartsForm = { mode: "new", partName: "", category: "ColorSorter", hasSerial: "no", quantity: "", serials: [""], restockPartId: "" };

function renderManagePartsView() {
  const content = document.getElementById("viewContent");
  const f = managePartsForm;

  content.innerHTML = `
    <div class="form-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0;">จัดการอะไหล่ Color Sorter / Panolyzer</h3>
        <button class="btn-sm btn-secondary" onclick="showPartsActivityFeed()">ดูประวัติอะไหล่ล่าสุดทั้งหมด</button>
      </div>
      <div class="picker-row" style="margin:14px 0;">
        <select id="mp-mode">
          <option value="new" ${f.mode === "new" ? "selected" : ""}>+ เพิ่มอะไหล่ใหม่ (ชื่อที่ยังไม่เคยมีในระบบ)</option>
          <option value="restock" ${f.mode === "restock" ? "selected" : ""}>เติมของอะไหล่ที่มีอยู่แล้ว</option>
        </select>
      </div>
      <div id="mp-formArea"></div>
      <div id="mp-msg" class="form-msg"></div>
      <button class="btn-primary" id="mp-submitBtn" style="margin-top:12px;">บันทึก</button>
    </div>
  `;

  document.getElementById("mp-mode").addEventListener("change", (e) => { f.mode = e.target.value; renderManagePartsFormArea(); });
  document.getElementById("mp-submitBtn").addEventListener("click", submitManagePartsForm);
  renderManagePartsFormArea();
}

function renderManagePartsFormArea() {
  const area = document.getElementById("mp-formArea");
  const f = managePartsForm;

  if (f.mode === "new") {
    area.innerHTML = `
      <div class="form-grid">
        <div class="form-field">
          <label>ชื่ออะไหล่ *</label>
          <input type="text" id="mp-partName" value="${escapeAttr(f.partName)}" placeholder="เช่น สายพาน Color Sorter">
        </div>
        <div class="form-field">
          <label>หมวดหมู่ *</label>
          <select id="mp-category">
            <option value="ColorSorter" ${f.category === "ColorSorter" ? "selected" : ""}>อะไหล่ Color Sorter</option>
            <option value="Panolyzer" ${f.category === "Panolyzer" ? "selected" : ""}>อะไหล่ Panolyzer</option>
          </select>
        </div>
        <div class="form-field">
          <label>มี S/N (Serial Number) เฉพาะชิ้นหรือไม่? *</label>
          <select id="mp-hasSerial">
            <option value="no" ${f.hasSerial === "no" ? "selected" : ""}>ไม่มี — นับจำนวนรวม</option>
            <option value="yes" ${f.hasSerial === "yes" ? "selected" : ""}>มี — ต้องกรอก S/N ทีละชิ้น</option>
          </select>
        </div>
      </div>
      <div id="mp-qtyOrSerialArea"></div>
    `;
    document.getElementById("mp-partName").addEventListener("input", (e) => { f.partName = e.target.value; });
    document.getElementById("mp-category").addEventListener("change", (e) => { f.category = e.target.value; });
    document.getElementById("mp-hasSerial").addEventListener("change", (e) => { f.hasSerial = e.target.value; renderQtyOrSerialArea(); });
    renderQtyOrSerialArea();
  } else {
    const allParts = [...getQtyPartsForCategory("ColorSorter"), ...getSerialPartsForCategory("ColorSorter"),
                       ...getQtyPartsForCategory("Panolyzer"), ...getSerialPartsForCategory("Panolyzer")];
    if (!allParts.length) {
      area.innerHTML = `<div class="cache-note">ยังไม่มีอะไหล่ในระบบ — กรุณาเลือก "เพิ่มอะไหล่ใหม่" ก่อน</div>`;
      return;
    }
    if (!f.restockPartId) f.restockPartId = allParts[0].PartID;
    area.innerHTML = `
      <div class="form-field">
        <label>เลือกอะไหล่ที่จะเติมของ *</label>
        <select id="mp-restockPartId">
          ${allParts.map((p) => `<option value="${escapeAttr(p.PartID)}" ${p.PartID === f.restockPartId ? "selected" : ""}>
            ${escapeHtml(p.PartName)} — ${p.Category === "ColorSorter" ? "Color Sorter" : "Panolyzer"} (${String(p.HasSerial).toLowerCase() === "yes" ? "มี S/N" : "นับจำนวน"})
          </option>`).join("")}
        </select>
      </div>
      <div id="mp-qtyOrSerialArea"></div>
    `;
    document.getElementById("mp-restockPartId").addEventListener("change", (e) => { f.restockPartId = e.target.value; renderQtyOrSerialArea(); });
    renderQtyOrSerialArea();
  }
}

function currentManagePartsHasSerial() {
  const f = managePartsForm;
  if (f.mode === "new") return f.hasSerial === "yes";
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === f.restockPartId);
  return part ? String(part.HasSerial).toLowerCase() === "yes" : false;
}

function renderQtyOrSerialArea() {
  const area = document.getElementById("mp-qtyOrSerialArea");
  if (!area) return;
  const f = managePartsForm;
  const hasSerial = currentManagePartsHasSerial();

  if (hasSerial) {
    area.innerHTML = `
      <div class="form-field">
        <label>เลข S/N ของแต่ละชิ้น (กรอกทีละชิ้น) *</label>
        <div id="mp-serialRows">
          ${f.serials.map((s, i) => `
            <div class="picker-row" style="margin-bottom:6px;">
              <input type="text" class="mp-serial-input" data-idx="${i}" value="${escapeAttr(s)}" placeholder="เช่น SNS-001">
              ${f.serials.length > 1 ? `<button type="button" class="btn-sm btn-remove" onclick="removeSerialRow(${i})">ลบแถว</button>` : ""}
            </div>`).join("")}
        </div>
        <button type="button" class="btn-sm btn-secondary" onclick="addSerialRow()">+ เพิ่มอีกแถว</button>
      </div>
    `;
    area.querySelectorAll(".mp-serial-input").forEach((el) => {
      el.addEventListener("input", (e) => { f.serials[Number(e.target.dataset.idx)] = e.target.value; });
    });
  } else {
    area.innerHTML = `
      <div class="form-field">
        <label>จำนวน${f.mode === "new" ? "เริ่มต้น" : "ที่เติมเข้าไป"} (ชิ้น) *</label>
        <input type="number" id="mp-quantity" min="1" step="1" value="${escapeAttr(f.quantity)}">
      </div>
    `;
    document.getElementById("mp-quantity").addEventListener("input", (e) => { f.quantity = e.target.value; });
  }
}

function addSerialRow() {
  managePartsForm.serials.push("");
  renderQtyOrSerialArea();
}

function removeSerialRow(idx) {
  managePartsForm.serials.splice(idx, 1);
  if (!managePartsForm.serials.length) managePartsForm.serials = [""];
  renderQtyOrSerialArea();
}

async function submitManagePartsForm() {
  const f = managePartsForm;
  const msg = document.getElementById("mp-msg");
  const btn = document.getElementById("mp-submitBtn");
  msg.className = "form-msg";
  msg.textContent = "";

  const hasSerial = currentManagePartsHasSerial();
  const cleanSerials = f.serials.map((s) => s.trim()).filter(Boolean);

  try {
    let res;
    if (f.mode === "new") {
      if (!f.partName.trim()) throw new Error("กรุณากรอกชื่ออะไหล่");
      if (hasSerial && !cleanSerials.length) throw new Error("กรุณากรอก S/N อย่างน้อย 1 ชิ้น");
      if (!hasSerial && (!f.quantity || Number(f.quantity) <= 0)) throw new Error("กรุณากรอกจำนวนเริ่มต้นให้มากกว่า 0");

      btn.disabled = true; btn.textContent = "กำลังบันทึก...";
      res = await apiPost({
        action: "addPart", token: state.token,
        payload: { partName: f.partName.trim(), category: f.category, hasSerial, quantity: Number(f.quantity) || 0, serials: cleanSerials },
      });
    } else {
      if (!f.restockPartId) throw new Error("กรุณาเลือกอะไหล่ที่จะเติมของ");
      if (hasSerial && !cleanSerials.length) throw new Error("กรุณากรอก S/N อย่างน้อย 1 ชิ้น");
      if (!hasSerial && (!f.quantity || Number(f.quantity) <= 0)) throw new Error("กรุณากรอกจำนวนที่เติมให้มากกว่า 0");

      btn.disabled = true; btn.textContent = "กำลังบันทึก...";
      res = await apiPost({
        action: "restockPart", token: state.token,
        payload: { partId: f.restockPartId, quantity: Number(f.quantity) || 0, serials: cleanSerials },
      });
    }

    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      throw new Error(managePartErrorMessage(res.error));
    }

    await refreshInBackground(true);
    managePartsForm = { mode: "new", partName: "", category: "ColorSorter", hasSerial: "no", quantity: "", serials: [""], restockPartId: "" };
    renderManagePartsView();
    const freshMsg = document.getElementById("mp-msg");
    freshMsg.className = "form-msg success";
    freshMsg.textContent = "บันทึกสำเร็จ";
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "บันทึก"; }
  }
}

function managePartErrorMessage(code) {
  switch (code) {
    case "part_name_taken": return "ชื่ออะไหล่นี้มีอยู่แล้วในหมวดเดียวกัน";
    case "duplicate_serial": return "S/N ที่กรอกมาซ้ำกับที่มีอยู่แล้วในระบบ (หรือซ้ำกันเองในชุดที่กรอก)";
    case "part_not_found": return "ไม่พบอะไหล่นี้ในระบบ (อาจถูกลบไปแล้ว)";
    case "forbidden": return "เฉพาะ Admin เท่านั้นที่จัดการอะไหล่ได้";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

// ============================================================
// Phase 5: แก้ไข/ลบข้อมูลอุปกรณ์ + รายการเบิก (Admin เท่านั้น)
// ============================================================

/** เปิด modal ฟอร์มทั่วไปสำหรับแก้ไขข้อมูล — fields: [{key,label,value}], onSave(values[]) */
function openGenericFormModal(title, fields, onSave) {
  document.getElementById("genericFormModalTitle").textContent = title;
  const body = document.getElementById("genericFormModalBody");
  body.innerHTML = fields.map((f, i) => {
    // Phase 10: รองรับ field แบบ dropdown (type: "select") นอกเหนือจากช่องข้อความธรรมดาแบบเดิม
    if (f.type === "select") {
      return `<div class="form-field">
        <label>${escapeHtml(f.label)}</label>
        <select id="gfm-field-${i}">
          ${(f.options || []).map((o) => `<option value="${escapeAttr(o.value)}" ${String(o.value) === String(f.value) ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
        </select>
      </div>`;
    }
    return `<div class="form-field">
      <label>${escapeHtml(f.label)}</label>
      <input type="text" id="gfm-field-${i}" value="${escapeAttr(f.value === undefined || f.value === null ? "" : String(f.value))}">
    </div>`;
  }).join("");
  const msgEl = document.getElementById("genericFormModalMsg");
  msgEl.className = "form-msg";
  msgEl.textContent = "";

  const saveBtn = document.getElementById("genericFormSaveBtn");
  const originalText = saveBtn.textContent;
  saveBtn.onclick = async () => {
    const values = fields.map((f, i) => document.getElementById(`gfm-field-${i}`).value);
    saveBtn.disabled = true; saveBtn.textContent = "กำลังบันทึก...";
    try {
      await onSave(values);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = originalText;
    }
  };
  document.getElementById("genericFormModal").style.display = "flex";
}

function closeGenericFormModal() {
  document.getElementById("genericFormModal").style.display = "none";
}

function openEditAsset(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const row = (state.data[cfg.key] || []).find((r) => String(r[cfg.serialField]) === String(serial));
  if (!row) return;
  const fields = Object.keys(row).filter((k) => !k.startsWith("_")).map((k) => ({ key: k, label: k, value: row[k] }));

  openGenericFormModal(`แก้ไขข้อมูล ${cfg.title} — ${serial}`, fields, async (values) => {
    const updates = {};
    fields.forEach((f, i) => { updates[f.key] = values[i]; });
    const msg = document.getElementById("genericFormModalMsg");
    try {
      const res = await apiPost({ action: "updateAsset", token: state.token, assetType: cfg.assetType, serialNo: serial, updates });
      if (!res.ok) {
        if (res.error === "unauthorized") return handleUnauthorized();
        throw new Error(assetErrorMessage(res.error));
      }
      await refreshInBackground(true);
      closeGenericFormModal();
      renderCurrentView();
    } catch (err) {
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });
}

async function deleteAsset(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const confirmed = await showConfirm(`ยืนยันลบ ${cfg.title} — ${serial}? การลบไม่สามารถย้อนกลับได้`, { type: "warning", okText: "ลบเลย", danger: true });
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "deleteAsset", token: state.token, assetType: cfg.assetType, serialNo: serial });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(assetErrorMessage(res.error), "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

function assetErrorMessage(code) {
  switch (code) {
    case "asset_in_use": return "ไม่สามารถลบได้ — อุปกรณ์นี้กำลังอยู่ระหว่างรออนุมัติ/เบิกใช้งานอยู่ กรุณาคืนของหรือปฏิเสธคำขอที่เกี่ยวข้องก่อน";
    case "duplicate_serial": return "Serial นี้ซ้ำกับอุปกรณ์อื่นที่มีอยู่แล้วในระบบ";
    case "not_found": return "ไม่พบอุปกรณ์นี้ในระบบ (อาจถูกลบไปแล้ว)";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

/** Phase 10: ข้อความ error สำหรับการสลับเปลี่ยนเครื่อง Gateway/SimCard ที่ผูกกับรายการเบิก */
function linkedItemErrorMessage(code) {
  switch (code) {
    case "item_conflict": return "เครื่องที่เลือกใหม่ไม่ว่างแล้ว หรือถูกจองไว้ในคำขออื่นที่รออนุมัติอยู่";
    case "model_mismatch": return "รุ่นของเครื่องใหม่ไม่ตรงกับเครื่องเดิม";
    case "not_editable": return "ธุรกรรมนี้ปิดจบแล้ว ไม่สามารถแก้ไขเครื่องที่เชื่อมต่อได้อีก";
    case "item_not_found": return "ไม่พบรายการเดิมในธุรกรรมนี้ (ข้อมูลอาจมีการเปลี่ยนแปลง กรุณาลองใหม่)";
    case "not_found": return "ไม่พบเครื่องที่เลือกใหม่ในระบบ";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

function openEditIssuance(transactionId) {
  const txn = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (!txn) return;
  const fields = [
    { key: "CustomerName", label: "ชื่อลูกค้า", value: txn.CustomerName },
    { key: "SiteLocation", label: "สถานที่ติดตั้ง", value: txn.SiteLocation },
    { key: "Details", label: "รายละเอียด / หมายเหตุ", value: txn.Details },
  ];

  // Phase 10: ถ้าธุรกรรมนี้ยังไม่ปิดจบ (Issued/PendingApproval) และมี Gateway/SimCard อยู่ด้วย
  // อนุญาตให้สลับเปลี่ยนเครื่องที่ผูกอยู่ได้จากฟอร์มแก้ไขเดียวกันนี้เลย โดยไม่ต้องลบทั้งรายการแล้วเบิกใหม่
  const canSwapLinked = txn.RequestStatus === "Issued" || txn.RequestStatus === "PendingApproval";
  const linkedFieldsMeta = []; // { assetType, oldSerial, fieldIndex }

  if (canSwapLinked) {
    const items = getItemsForTransaction(transactionId);
    ["Gateway", "SimCard"].forEach((assetType) => {
      const item = items.find((i) => i.AssetType === assetType);
      if (!item) return;
      const cfg = VIEW_CONFIG[assetType.toLowerCase()];
      const rows = state.data[cfg.key] || [];
      const currentRow = rows.find((r) => String(r[cfg.serialField]) === String(item.SerialNo));
      let candidateRows = rows.filter((r) =>
        isStockRow(r, cfg.stockField, cfg.stockRequiresField) || String(r[cfg.serialField]) === String(item.SerialNo));
      if (assetType === "Gateway" && currentRow) {
        const model = String(currentRow[GATEWAY_MODEL_FIELD] || "").trim().toUpperCase();
        candidateRows = candidateRows.filter((r) => String(r[GATEWAY_MODEL_FIELD] || "").trim().toUpperCase() === model);
      }
      const options = candidateRows.map((r) => {
        const serial = String(r[cfg.serialField]);
        const isCurrent = serial === String(item.SerialNo);
        const inStock = isStockRow(r, cfg.stockField, cfg.stockRequiresField);
        const label = serial + (isCurrent ? " (ตัวปัจจุบัน)" : inStock ? " (ว่าง/Stock)" : "");
        return { value: serial, label };
      });
      linkedFieldsMeta.push({ assetType, oldSerial: item.SerialNo, fieldIndex: fields.length });
      fields.push({
        key: "_linked_" + assetType, label: `เปลี่ยนเครื่อง ${assetType} ที่เชื่อมต่อ`, type: "select",
        value: item.SerialNo, options,
      });
    });
  }

  openGenericFormModal(`แก้ไขรายการเบิก — ${transactionId}`, fields, async (values) => {
    const updates = {};
    fields.forEach((f, i) => { if (!f.key.startsWith("_linked_")) updates[f.key] = values[i]; });
    const msg = document.getElementById("genericFormModalMsg");
    try {
      const res = await apiPost({ action: "updateIssuance", token: state.token, transactionId, updates });
      if (!res.ok) {
        if (res.error === "unauthorized") return handleUnauthorized();
        throw new Error("บันทึกไม่สำเร็จ กรุณาลองใหม่");
      }
      for (const meta of linkedFieldsMeta) {
        const newSerial = values[meta.fieldIndex];
        if (String(newSerial) === String(meta.oldSerial)) continue;
        const linkRes = await apiPost({
          action: "updateIssuanceLinkedItem", token: state.token, transactionId,
          assetType: meta.assetType, oldSerial: meta.oldSerial, newSerial,
        });
        if (!linkRes.ok) {
          if (linkRes.error === "unauthorized") return handleUnauthorized();
          throw new Error(`เปลี่ยน ${meta.assetType} ไม่สำเร็จ: ${linkedItemErrorMessage(linkRes.error)}`);
        }
      }
      await refreshInBackground(true);
      closeGenericFormModal();
      renderCurrentView();
    } catch (err) {
      msg.className = "form-msg error";
      msg.textContent = err.message;
    }
  });
}

async function deleteIssuance(transactionId) {
  const confirmed = await showConfirm(`ยืนยันลบรายการเบิก ${transactionId}? ใช้ได้เฉพาะรายการที่ถูกปฏิเสธหรือคืนของแล้วเท่านั้น และไม่สามารถย้อนกลับได้`, { type: "warning", okText: "ลบเลย", danger: true });
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "deleteIssuance", token: state.token, transactionId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(res.error === "not_deletable" ? "ลบได้เฉพาะรายการที่ถูกปฏิเสธหรือคืนของแล้วเท่านั้น" : "ดำเนินการไม่สำเร็จ กรุณาลองใหม่", "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

// ============================================================
// Phase 2: เบิกอุปกรณ์ (ส่งคำขอ — รออนุมัติ)
// ============================================================
function getPendingKeys() {
  const pendingTxnIds = new Set(
    (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").map((r) => r.TransactionID)
  );
  const keys = new Set();
  (state.data.issuanceItems || []).forEach((item) => {
    if (pendingTxnIds.has(item.TransactionID)) keys.add(item.AssetType + "||" + item.SerialNo);
  });
  return keys;
}

function getAvailableItems(cfg, search) {
  const pendingKeys = getPendingKeys();
  const basketKeys = new Set(issuanceForm.basket.map((b) => b.assetType + "||" + b.serialNo));
  const rows = state.data[cfg.key] || [];
  return rows.filter((row) => {
    if (!isStockRow(row, cfg.stockField, cfg.stockRequiresField)) return false;
    const serial = String(row[cfg.serialField] || "");
    const key = cfg.assetType + "||" + serial;
    if (pendingKeys.has(key) || basketKeys.has(key)) return false;
    if (search) {
      const s = search.toLowerCase();
      return cfg.columns.some((c) => String(row[c.field] || "").toLowerCase().includes(s));
    }
    return true;
  });
}

function renderIssueView() {
  const content = document.getElementById("viewContent");
  content.innerHTML = `
    <div class="form-card">
      <h3>1. ข้อมูลการเบิก</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>ชื่อลูกค้า *</label>
          <input type="text" id="f-customerName" list="customerList" value="${escapeHtml(issuanceForm.customerName)}" placeholder="เช่น ธนกรรวมผล999">
          <datalist id="customerList">${getKnownCustomerNames().map((n) => `<option value="${escapeHtml(n)}">`).join("")}</datalist>
        </div>
        <div class="form-field">
          <label>สถานที่ติดตั้ง / ไซต์งาน *</label>
          <input type="text" id="f-siteLocation" value="${escapeHtml(issuanceForm.siteLocation)}" placeholder="เช่น โกดัง 8 A">
        </div>
      </div>
      <div class="form-grid full">
        <div class="form-field">
          <label>รายละเอียด / หมายเหตุ</label>
          <textarea id="f-details">${escapeHtml(issuanceForm.details)}</textarea>
        </div>
      </div>
    </div>

    <div class="form-card">
      <h3>2. เลือกอุปกรณ์ที่จะเบิก (แสดงเฉพาะรายการที่อยู่ในสถานะ Stock และไม่มีคำขออื่นค้างอยู่)</h3>
      <div class="picker-row">
        <select id="f-assetType">
          <option value="moisturlyzer">MoisturLyzer</option>
          <option value="gateway">Gateway</option>
          <option value="simcard">SimCard</option>
          <option value="colorSorterParts">อะไหล่ Color Sorter</option>
          <option value="panolyzerParts">อะไหล่ Panolyzer</option>
        </select>
        <input type="text" id="f-itemSearch" placeholder="ค้นหา Serial / รุ่น...">
      </div>
      <div class="picker-list" id="pickerList"></div>
    </div>

    <div class="form-card">
      <h3>3. ตะกร้าเบิก (<span id="basketCount">${issuanceForm.basket.length}</span> รายการ)</h3>
      <div id="basketArea"></div>
      <div id="issueMsg" class="form-msg"></div>
      <button class="btn-primary" id="submitIssuanceBtn">ส่งคำขอเบิก (รออนุมัติ)</button>
    </div>
  `;

  document.getElementById("f-customerName").addEventListener("input", (e) => { issuanceForm.customerName = e.target.value; });
  document.getElementById("f-siteLocation").addEventListener("input", (e) => { issuanceForm.siteLocation = e.target.value; });
  document.getElementById("f-details").addEventListener("input", (e) => { issuanceForm.details = e.target.value; });
  document.getElementById("f-assetType").addEventListener("change", renderPickerList);
  document.getElementById("f-itemSearch").addEventListener("input", renderPickerList);
  document.getElementById("submitIssuanceBtn").addEventListener("click", submitIssuanceRequest);

  renderPickerList();
  renderBasket();
}

function getKnownCustomerNames() {
  const names = new Set();
  Object.values(VIEW_CONFIG).forEach((cfg) => {
    (state.data[cfg.key] || []).forEach((r) => {
      const n = String(r.Customer_name || "").trim();
      if (n) names.add(n);
    });
  });
  return Array.from(names).sort();
}

function renderPickerList() {
  const assetKey = document.getElementById("f-assetType").value;
  const cfg = VIEW_CONFIG[assetKey];
  const search = document.getElementById("f-itemSearch").value;
  const listEl = document.getElementById("pickerList");

  // Phase 8: หมวดอะไหล่ (Color Sorter/Panolyzer) แสดงทั้งชิ้นที่มี S/N และแบบนับจำนวนรวมในรายการเดียวกัน
  if (cfg.partCategory) {
    const items = getAvailablePartsCombined(assetKey, search);
    if (!items.length) {
      listEl.innerHTML = `<div class="picker-empty">ไม่พบอะไหล่ที่พร้อมเบิก</div>`;
      return;
    }
    listEl.innerHTML = items.slice(0, 50).map((it) => {
      if (it.kind === "unit") {
        const serial = String(it.row[cfg.serialField] || "");
        const label = `${escapeHtml(it.row.PartName || cfg.title)} — S/N ${escapeHtml(serial)}`;
        return `
          <div class="picker-list-item">
            <span>${label}</span>
            <button class="btn-sm btn-add" onclick="addToBasket('${assetKey}', '${escapeAttr(serial)}')">+ เพิ่ม</button>
          </div>`;
      }
      const p = it.part;
      const inputId = "qty-input-" + escapeAttr(p.PartID);
      return `
        <div class="picker-list-item">
          <span>${escapeHtml(p.PartName)} <span class="cache-note">(คงเหลือให้เบิก ${it.available} ชิ้น — นับจำนวน ไม่มี S/N)</span></span>
          <span class="picker-qty-controls">
            <input type="number" id="${inputId}" class="qty-input-sm" min="1" max="${it.available}" value="1">
            <button class="btn-sm btn-add" onclick="addQtyToBasket('${assetKey}', '${escapeAttr(p.PartID)}', document.getElementById('${inputId}').value)">+ เพิ่ม</button>
          </span>
        </div>`;
    }).join("");
    return;
  }

  const items = getAvailableItems(cfg, search);

  if (!items.length) {
    listEl.innerHTML = `<div class="picker-empty">ไม่พบอุปกรณ์ที่พร้อมเบิก</div>`;
    return;
  }

  listEl.innerHTML = items.slice(0, 50).map((row) => {
    const serial = String(row[cfg.serialField] || "");
    const label = `${escapeHtml(cfg.title)} — ${escapeHtml(serial)}${row.Model ? " (" + escapeHtml(row.Model) + ")" : ""}`;
    return `
      <div class="picker-list-item">
        <span>${label}</span>
        <button class="btn-sm btn-add" onclick="addToBasket('${assetKey}', '${escapeAttr(serial)}')">+ เพิ่ม</button>
      </div>`;
  }).join("");
}

/** Phase 8: รวมรายการอะไหล่ที่พร้อมเบิกของหมวดหนึ่ง — ทั้งชิ้นที่มี S/N (ว่างอยู่ในสต๊อก) และแบบนับจำนวน (ยังมีจำนวนเหลือให้เบิกหลังหักลบที่ตะกร้า+รออนุมัติแล้ว) */
function getAvailablePartsCombined(assetKey, search) {
  const cfg = VIEW_CONFIG[assetKey];
  const unitItems = getAvailableItems(cfg, search).map((row) => ({ kind: "unit", row }));

  const qtyAssetType = PART_QTY_ASSET_TYPE_BY_VIEW[assetKey];
  const basketQtyByPart = {};
  issuanceForm.basket.forEach((b) => {
    if (b.assetType === qtyAssetType) basketQtyByPart[b.serialNo] = (basketQtyByPart[b.serialNo] || 0) + (Number(b.quantity) || 0);
  });
  const pendingTxnIds = new Set((state.data.issuanceLog || []).filter((r) => r.RequestStatus === "PendingApproval").map((r) => r.TransactionID));
  const pendingQtyByPart = {};
  (state.data.issuanceItems || []).forEach((it) => {
    if (pendingTxnIds.has(it.TransactionID) && it.AssetType === qtyAssetType) {
      pendingQtyByPart[it.SerialNo] = (pendingQtyByPart[it.SerialNo] || 0) + (Number(it.Quantity) || 0);
    }
  });

  const s = (search || "").toLowerCase();
  const qtyItems = getQtyPartsForCategory(PART_CATEGORY_BY_VIEW[assetKey])
    .map((p) => {
      const reserved = (pendingQtyByPart[p.PartID] || 0) + (basketQtyByPart[p.PartID] || 0);
      const available = (Number(p.QuantityInStock) || 0) - reserved;
      return { kind: "qty", part: p, available };
    })
    .filter((q) => q.available > 0)
    .filter((q) => !s || q.part.PartName.toLowerCase().includes(s));

  return [...unitItems, ...qtyItems];
}

/** Phase 8: เพิ่มอะไหล่แบบนับจำนวนลงตะกร้า — ถ้ามีของอะไหล่ตัวเดียวกันในตะกร้าอยู่แล้วจะรวมจำนวนเข้าด้วยกัน */
function addQtyToBasket(assetKey, partId, quantityStr) {
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === partId);
  if (!part) return;
  const assetType = PART_QTY_ASSET_TYPE_BY_VIEW[assetKey];
  const qty = Math.max(1, Math.floor(Number(quantityStr) || 1));

  const existing = issuanceForm.basket.find((b) => b.assetType === assetType && b.serialNo === partId);
  if (existing) {
    existing.quantity = (Number(existing.quantity) || 0) + qty;
  } else {
    issuanceForm.basket.push({
      assetType, assetKey, serialNo: partId, partName: part.PartName, quantity: qty, connectTo: "", connectSerial: "",
    });
  }
  renderPickerList();
  renderBasket();
}

/** Phase 8: แก้ไขจำนวนของอะไหล่แบบนับจำนวนที่อยู่ในตะกร้าแล้ว */
function updateBasketQuantity(index, value) {
  const qty = Math.max(1, Math.floor(Number(value) || 1));
  issuanceForm.basket[index].quantity = qty;
  refreshBasketNotice();
}

function addToBasket(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const item = {
    assetType: cfg.assetType, assetKey, serialNo: serial,
    connectTo: cfg.connectOptions ? cfg.connectOptions[0] : "",
    connectSerial: "",
  };

  if (cfg.assetType === "MoisturLyzer") {
    // Phase 6: เบิก MoisturLyzer ต้องเลือก Gateway รุ่น EPG-001B และ SimCard ที่จะติดตั้งคู่กันเสมอ (บังคับ) — เลือกได้ในแถวเดียวกันเลย
    item.linkedGatewaySerial = "";
    item.linkedSimSerial = "";
  }

  if (cfg.assetType === "Gateway") {
    const row = (state.data.gateway || []).find((r) => String(r[cfg.serialField]) === String(serial));
    item.model = String((row && row[GATEWAY_MODEL_FIELD]) || "").trim().toUpperCase();
    if (item.model === GATEWAY_MODEL_MOISTURLYZER) {
      item.connectTo = "MoisturLyzer"; // รุ่นนี้ใช้กับ MoisturLyzer เท่านั้น
    }
    // Phase 6: เบิก Gateway (รุ่นใดก็ตาม) ต้องมี SimCard คู่กันเสมอ (บังคับ) — เลือกได้ในแถวเดียวกันเลย
    item.linkedSimSerial = "";
  }

  issuanceForm.basket.push(item);
  renderPickerList();
  renderBasket();
}

function removeFromBasket(index) {
  issuanceForm.basket.splice(index, 1);
  renderPickerList();
  renderBasket();
}

function updateBasketConnectTo(index, value) {
  issuanceForm.basket[index].connectTo = value;
  if (value !== LINKABLE_TARGET_ASSET_TYPE) issuanceForm.basket[index].connectSerial = "";
  renderBasket();
}

function updateBasketConnectSerial(index, value) {
  issuanceForm.basket[index].connectSerial = value;
  refreshBasketNotice();
}

/** อัปเดตเฉพาะกล่องแจ้งเตือน "ยังกรอกข้อมูลไม่ครบ" โดยไม่วาดตะกร้าใหม่ทั้งตาราง
 * (กันไม่ให้ช่องกรอกข้อความ เช่น S/N Panolyzer เสีย focus ระหว่างพิมพ์) */
function refreshBasketNotice() {
  const el = document.getElementById("basketRequirementNotice");
  if (el) el.innerHTML = renderBasketRequirementNotice();
}

/** Phase 6: อัปเดต Gateway (EPG-001B) ที่เลือกมาติดตั้งคู่กับ MoisturLyzer ที่ตะกร้าลำดับนี้ */
function updateLinkedGateway(index, value) {
  issuanceForm.basket[index].linkedGatewaySerial = value;
  // ถ้าเอา Gateway คู่กันออก (เลือกเป็นว่าง) ต้องเคลียร์ SimCard ที่เคยเลือกไว้ด้วย เพราะ SimCard
  // ผูกอยู่กับ Gateway ตัวนั้น ไม่ใช่กับตัวเครื่อง MoisturLyzer เอง (ใส่ซิมไม่ได้)
  if (!value) issuanceForm.basket[index].linkedSimSerial = "";
  renderBasket();
}

/** Phase 6: ชุด Serial ของ Gateway ที่ "ถูกใช้ไปแล้ว" ในตะกร้าปัจจุบัน (ทั้งที่เพิ่มเป็นรายการของตัวเอง
 * และที่ถูกเลือกเป็น Gateway คู่กันของ MoisturLyzer แถวอื่น) เพื่อไม่ให้เลือกเครื่องเดียวกันซ้ำ */
function getUsedGatewaySerialsInBasket(excludeIndex) {
  const used = new Set();
  issuanceForm.basket.forEach((it, idx) => {
    if (idx === excludeIndex) return;
    if (it.assetType === "Gateway") used.add(it.serialNo);
    if (it.assetType === "MoisturLyzer" && it.linkedGatewaySerial) used.add(it.linkedGatewaySerial);
  });
  return used;
}

/** Phase 6: รายการ Gateway รุ่นที่ระบุ ที่ยังว่างอยู่ในสต๊อก และยังไม่ถูกใช้ไปแล้วในตะกร้านี้ */
function getAvailableGatewaysByModel(model, excludeIndex) {
  const cfg = VIEW_CONFIG.gateway;
  const used = getUsedGatewaySerialsInBasket(excludeIndex);
  return (state.data.gateway || []).filter((row) => {
    const rowModel = String(row[GATEWAY_MODEL_FIELD] || "").trim().toUpperCase();
    const serial = String(row[cfg.serialField] || "");
    if (rowModel !== model) return false;
    if (!isStockRow(row, cfg.stockField, cfg.stockRequiresField)) return false;
    if (used.has(serial)) return false;
    return true;
  });
}

/** Phase 6: อัปเดต SimCard ที่เลือกมาเบิกคู่กับแถวนี้ (MoisturLyzer หรือ Gateway) */
function updateLinkedSim(index, value) {
  issuanceForm.basket[index].linkedSimSerial = value;
  renderBasket();
}

/** Phase 6: ชุด Serial ของ SimCard ที่ "ถูกใช้ไปแล้ว" ในตะกร้าปัจจุบัน (ทั้งที่เพิ่มเป็นรายการของตัวเอง
 * และที่ถูกเลือกเป็น SimCard คู่กันของแถว MoisturLyzer/Gateway อื่น) เพื่อไม่ให้เลือกซิมเดียวกันซ้ำ */
function getUsedSimSerialsInBasket(excludeIndex) {
  const used = new Set();
  issuanceForm.basket.forEach((it, idx) => {
    if (idx === excludeIndex) return;
    if (it.assetType === "SimCard") used.add(it.serialNo);
    if ((it.assetType === "MoisturLyzer" || it.assetType === "Gateway") && it.linkedSimSerial) used.add(it.linkedSimSerial);
  });
  return used;
}

/** Phase 6: รายการ SimCard ที่ยังว่างอยู่ในสต๊อก และยังไม่ถูกใช้ไปแล้วในตะกร้านี้ */
function getAvailableSimCards(excludeIndex) {
  const cfg = VIEW_CONFIG.simcard;
  const used = getUsedSimSerialsInBasket(excludeIndex);
  return (state.data.simcard || []).filter((row) => {
    const serial = String(row[cfg.serialField] || "");
    if (!isStockRow(row, cfg.stockField, cfg.stockRequiresField)) return false;
    if (used.has(serial)) return false;
    return true;
  });
}

/** รายการเครื่อง MoisturLyzer ที่เลือกมาผูกกับ Gateway/SimCard ได้ — ทั้งเครื่องที่ว่าง (Stock) และเครื่องที่เบิกไปติดตั้งแล้ว
 * (กรณีนำ Gateway ไปติดตั้งเพิ่มให้เครื่องที่ใช้งานอยู่แล้ว) โดยเรียงเครื่องว่างไว้ก่อน */
function getLinkableTargets() {
  const rows = state.data[LINKABLE_TARGET_KEY] || [];
  const cfg = VIEW_CONFIG[LINKABLE_TARGET_KEY];
  return rows
    .map((row) => ({
      serial: String(row[cfg.serialField] || ""),
      stock: isStockRow(row, cfg.stockField, cfg.stockRequiresField),
      customer: String(row.Customer_name || "").trim(),
    }))
    .filter((r) => r.serial)
    .sort((a, b) => (a.stock === b.stock ? a.serial.localeCompare(b.serial) : a.stock ? -1 : 1));
}

function renderBasket() {
  const countEl = document.getElementById("basketCount");
  if (countEl) countEl.textContent = issuanceForm.basket.length;

  const area = document.getElementById("basketArea");
  if (!issuanceForm.basket.length) {
    area.innerHTML = `<div class="basket-empty">ยังไม่ได้เลือกอุปกรณ์ — เลือกจากรายการด้านบน</div>`;
    return;
  }

  if (isMobileViewport()) {
    renderBasketMobile(area);
    return;
  }

  const linkableTargets = getLinkableTargets();

  area.innerHTML = `
    <table class="basket-table">
      <thead><tr><th>ประเภท</th><th>Serial</th><th>เชื่อมต่อกับ / ใส่ใน</th><th>เครื่องที่เชื่อมต่อ (เจาะจง)</th><th>SimCard คู่กัน</th><th></th></tr></thead>
      <tbody>
        ${issuanceForm.basket.map((item, idx) => {
          // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N) — แถวของตัวเองแยกจากอุปกรณ์อื่นทั้งหมด ไม่มีเรื่อง Gateway/SimCard คู่กัน
          if (item.quantity !== undefined) {
            return `<tr>
              <td>${escapeHtml(item.partName)} <span class="cache-note">(นับจำนวน)</span></td>
              <td><span class="cache-note">-</span></td>
              <td><input type="number" min="1" value="${escapeAttr(String(item.quantity))}" style="width:80px;" onchange="updateBasketQuantity(${idx}, this.value)"> ชิ้น</td>
              <td><span class="cache-note">-</span></td>
              <td><span class="cache-note">-</span></td>
              <td><button class="btn-sm btn-remove" onclick="removeFromBasket(${idx})">ลบ</button></td>
            </tr>`;
          }

          const cfg = VIEW_CONFIG[item.assetKey];
          let connectCell = `<span class="cache-note">-</span>`;
          let serialCell = `<span class="cache-note">-</span>`;
          let simCell = `<span class="cache-note">-</span>`;

          // Phase 7 (ปรับ): SimCard ผูกกับ Gateway เท่านั้น ไม่ใช่ MoisturLyzer โดยตรง (ตัวเครื่อง MoisturLyzer
          // เองใส่ซิมไม่ได้) — จึงแสดงตัวเลือก SimCard เฉพาะแถว Gateway จริง หรือแถว MoisturLyzer ที่เลือก
          // Gateway คู่กันไว้เท่านั้น แต่ "ไม่บังคับ" อีกต่อไป (เผื่อกรณีลูกค้ายืม Gateway ไปทดลองเฉยๆ โดยยังไม่ต้อง
          // เปิดใช้งานซิม) ถ้า MoisturLyzer ไม่ได้เบิก Gateway คู่ไปด้วยก็ไม่ต้องมี SimCard เลย
          const canPickSimCard = item.assetType === "Gateway" || (item.assetType === "MoisturLyzer" && !!item.linkedGatewaySerial);
          if (canPickSimCard) {
            const availableSim = getAvailableSimCards(idx);
            const simCfg = VIEW_CONFIG.simcard;
            if (!availableSim.length && !item.linkedSimSerial) {
              simCell = `<span class="cache-note">ไม่มี SimCard ว่างในสต๊อก (ไม่บังคับ)</span>`;
            } else {
              simCell = `<select onchange="updateLinkedSim(${idx}, this.value)">
                <option value="">-- ไม่เบิก SimCard คู่กัน (ไม่บังคับ) --</option>
                ${availableSim.map((s) => `<option value="${escapeAttr(String(s[simCfg.serialField]))}" ${String(s[simCfg.serialField]) === item.linkedSimSerial ? "selected" : ""}>${escapeHtml(String(s[simCfg.serialField]))}</option>`).join("")}
              </select>`;
            }
          } else if (item.assetType === "MoisturLyzer") {
            simCell = `<span class="cache-note">ไม่ต้องใช้ (ไม่ได้เบิก Gateway คู่กัน)</span>`;
          }

          if (item.assetType === "MoisturLyzer") {
            // Phase 6 (ปรับ): เดิมบังคับต้องเลือก Gateway EPG-001B คู่กันเสมอ — ตอนนี้ไม่บังคับแล้ว
            // เผื่อกรณีลูกค้ายืม MoisturLyzer ไปทดลองใช้เองโดยไม่ต้องเบิก Gateway คู่ไปด้วย
            connectCell = `<span class="cache-note">Gateway (${escapeHtml(GATEWAY_MODEL_MOISTURLYZER)}) คู่กัน (ไม่บังคับ)</span>`;
            const availableGw = getAvailableGatewaysByModel(GATEWAY_MODEL_MOISTURLYZER, idx);
            if (!availableGw.length && !item.linkedGatewaySerial) {
              serialCell = `<span class="cache-note">ไม่มี Gateway ${escapeHtml(GATEWAY_MODEL_MOISTURLYZER)} ว่างในสต๊อก</span>`;
            } else {
              const gwCfg = VIEW_CONFIG.gateway;
              serialCell = `<select onchange="updateLinkedGateway(${idx}, this.value)">
                <option value="">-- ไม่เบิก Gateway คู่กัน (ไม่บังคับ) --</option>
                ${availableGw.map((g) => `<option value="${escapeAttr(String(g[gwCfg.serialField]))}" ${String(g[gwCfg.serialField]) === item.linkedGatewaySerial ? "selected" : ""}>${escapeHtml(String(g[gwCfg.serialField]))}</option>`).join("")}
              </select>`;
            }
          } else if (item.assetType === "Gateway" && item.model === GATEWAY_MODEL_PANOLYZER) {
            // Gateway รุ่น EPG-001S — ใช้กับ Panolyzer เท่านั้น (ล็อครุ่นไว้กันเบิกผิด) แต่ไม่บังคับให้กรอก S/N
            // เครื่องเจาะจง เผื่อกรณีนำไปทดลอง/ติดตั้งกับเครื่องที่ยังไม่ได้ขึ้นทะเบียนในระบบ
            connectCell = `<span class="cache-note">Panolyzer (${escapeHtml(GATEWAY_MODEL_PANOLYZER)})</span>`;
            serialCell = `<input type="text" placeholder="กรอก S/N เครื่อง Panolyzer (ไม่บังคับ)"
              value="${escapeAttr(item.connectSerial)}" oninput="updateBasketConnectSerial(${idx}, this.value)">`;
          } else if (item.assetType === "Gateway" && item.model === GATEWAY_MODEL_MOISTURLYZER) {
            // Gateway รุ่น EPG-001B ที่ถูกเพิ่มโดยตรง — ล็อครุ่นไว้ว่าใช้กับ MoisturLyzer เท่านั้น (กันเบิกผิดรุ่น)
            // แต่ไม่บังคับให้เลือกเครื่องเจาะจง เผื่อกรณีนำ Gateway+SimCard ไปทดลองกับเครื่องอื่นที่ไม่ได้อยู่ในระบบ
            connectCell = `<span class="cache-note">MoisturLyzer (${escapeHtml(GATEWAY_MODEL_MOISTURLYZER)})</span>`;
            if (!linkableTargets.length) {
              serialCell = `<span class="cache-note">ไม่มีเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} ในระบบ</span>`;
            } else {
              serialCell = `<select onchange="updateBasketConnectSerial(${idx}, this.value)">
                <option value="">-- ไม่ระบุเครื่องเจาะจง (ไม่บังคับ) --</option>
                ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
              </select>`;
            }
          } else if (cfg.connectOptions) {
            // SimCard หรือ Gateway ที่ยังไม่ระบุรุ่น — คงพฤติกรรมเดิม (ไม่บังคับ)
            connectCell = `<select onchange="updateBasketConnectTo(${idx}, this.value)">
                 ${cfg.connectOptions.map((o) => `<option value="${escapeAttr(o)}" ${o === item.connectTo ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
               </select>`;
            if (item.connectTo === LINKABLE_TARGET_ASSET_TYPE) {
              if (!linkableTargets.length) {
                serialCell = `<span class="cache-note">ไม่มีเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} ในระบบ</span>`;
              } else {
                serialCell = `<select onchange="updateBasketConnectSerial(${idx}, this.value)">
                  <option value="">-- ไม่ระบุเครื่องเจาะจง --</option>
                  ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
                </select>`;
              }
            }
          }

          return `<tr>
            <td>${escapeHtml(cfg.title)}</td>
            <td>${escapeHtml(item.serialNo)}</td>
            <td>${connectCell}</td>
            <td>${serialCell}</td>
            <td>${simCell}</td>
            <td><button class="btn-sm btn-remove" onclick="removeFromBasket(${idx})">ลบ</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <div class="cache-note" style="margin-top:8px;">หมายเหตุ: การเลือก "เครื่องที่เชื่อมต่อ (เจาะจง)" เป็นการบันทึกความสัมพันธ์เพื่อการติดตามเท่านั้น ไม่ได้ตัดสต๊อกของเครื่องที่เลือก (ยกเว้น Gateway ที่เลือกคู่กับ MoisturLyzer ซึ่งจะถูกเบิกออกจากสต๊อกจริง)</div>
    <div id="basketRequirementNotice">${renderBasketRequirementNotice()}</div>
  `;
}

/** เวอร์ชันมือถือของตะกร้าเบิก — แต่ละชิ้นเป็นการ์ดแยก วางฟิลด์ซ้อนแนวตั้งเต็มความกว้างจอ แทนตารางแนวนอนที่ต้องเลื่อนซ้าย-ขวา (ลอจิกการเลือก Gateway/SimCard/เชื่อมต่อเหมือนกับเวอร์ชันคอมพิวเตอร์ทุกประการ ต่างแค่การจัดวาง) */
function renderBasketMobile(area) {
  const linkableTargets = getLinkableTargets();

  const cardsHtml = issuanceForm.basket.map((item, idx) => {
    // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N)
    if (item.quantity !== undefined) {
      return `
        <div class="basket-card">
          <div class="basket-card-head">
            <div>
              <div class="basket-card-title">${escapeHtml(item.partName)}</div>
              <div class="basket-card-serial">แบบนับจำนวน (ไม่มี S/N)</div>
            </div>
            <button class="basket-card-remove" onclick="removeFromBasket(${idx})">ลบ</button>
          </div>
          <div class="basket-field">
            <label>จำนวนที่จะเบิก</label>
            <input type="number" min="1" value="${escapeAttr(String(item.quantity))}" onchange="updateBasketQuantity(${idx}, this.value)">
          </div>
        </div>`;
    }

    const cfg = VIEW_CONFIG[item.assetKey];
    const fields = []; // { label, html, req }

    // Phase 7 (ปรับ): SimCard ผูกกับ Gateway เท่านั้น ไม่ใช่ MoisturLyzer โดยตรง (ตัวเครื่อง MoisturLyzer เอง
    // ใส่ซิมไม่ได้) — แสดงตัวเลือก SimCard เฉพาะแถว Gateway จริง หรือแถว MoisturLyzer ที่เลือก Gateway คู่กันไว้
    // แต่ไม่บังคับอีกต่อไป (เผื่อกรณีลูกค้ายืม Gateway ไปทดลองเฉยๆ โดยยังไม่ต้องเปิดใช้งานซิม)
    let simFieldHtml = null;
    const canPickSimCardMobile = item.assetType === "Gateway" || (item.assetType === "MoisturLyzer" && !!item.linkedGatewaySerial);
    if (canPickSimCardMobile) {
      const availableSim = getAvailableSimCards(idx);
      const simCfg = VIEW_CONFIG.simcard;
      if (!availableSim.length && !item.linkedSimSerial) {
        simFieldHtml = `<span class="warn-text">ไม่มี SimCard ว่างในสต๊อก (ไม่บังคับ)</span>`;
      } else {
        simFieldHtml = `<select onchange="updateLinkedSim(${idx}, this.value)">
          <option value="">-- ไม่เบิก SimCard คู่กัน (ไม่บังคับ) --</option>
          ${availableSim.map((s) => `<option value="${escapeAttr(String(s[simCfg.serialField]))}" ${String(s[simCfg.serialField]) === item.linkedSimSerial ? "selected" : ""}>${escapeHtml(String(s[simCfg.serialField]))}</option>`).join("")}
        </select>`;
      }
    }

    if (item.assetType === "MoisturLyzer") {
      // เลือก Gateway EPG-001B ว่างในสต๊อกคู่กัน (ไม่บังคับแล้ว — เผื่อลูกค้ายืม MoisturLyzer ไปทดลองใช้เอง)
      const availableGw = getAvailableGatewaysByModel(GATEWAY_MODEL_MOISTURLYZER, idx);
      const gwCfg = VIEW_CONFIG.gateway;
      let gwFieldHtml;
      if (!availableGw.length && !item.linkedGatewaySerial) {
        gwFieldHtml = `<span class="cache-note">ไม่มี Gateway ${escapeHtml(GATEWAY_MODEL_MOISTURLYZER)} ว่างในสต๊อก</span>`;
      } else {
        gwFieldHtml = `<select onchange="updateLinkedGateway(${idx}, this.value)">
          <option value="">-- ไม่เบิก Gateway คู่กัน (ไม่บังคับ) --</option>
          ${availableGw.map((g) => `<option value="${escapeAttr(String(g[gwCfg.serialField]))}" ${String(g[gwCfg.serialField]) === item.linkedGatewaySerial ? "selected" : ""}>${escapeHtml(String(g[gwCfg.serialField]))}</option>`).join("")}
        </select>`;
      }
      fields.push({ label: `Gateway (${escapeHtml(GATEWAY_MODEL_MOISTURLYZER)}) คู่กัน (ไม่บังคับ)`, html: gwFieldHtml, req: false });
      if (item.linkedGatewaySerial) {
        fields.push({ label: "SimCard คู่กัน (ไม่บังคับ)", html: simFieldHtml, req: false });
      }
    } else if (item.assetType === "Gateway" && item.model === GATEWAY_MODEL_PANOLYZER) {
      // Panolyzer ไม่ได้ถูกเก็บเป็นอุปกรณ์ในระบบ จึงไม่มีสต๊อกให้เลือก — กรอก S/N เองได้ถ้าทราบ แต่ไม่บังคับ
      // (ล็อคไว้แค่ว่า Gateway รุ่นนี้ใช้กับ Panolyzer เท่านั้น กันเบิกผิดรุ่น)
      fields.push({
        label: "S/N เครื่อง Panolyzer",
        html: `<input type="text" placeholder="กรอก S/N เครื่อง Panolyzer (ไม่บังคับ)"
          value="${escapeAttr(item.connectSerial)}" oninput="updateBasketConnectSerial(${idx}, this.value)">`,
        req: false,
      });
      fields.push({ label: "SimCard คู่กัน (ไม่บังคับ)", html: simFieldHtml, req: false });
    } else if (item.assetType === "Gateway" && item.model === GATEWAY_MODEL_MOISTURLYZER) {
      // Gateway EPG-001B ที่เพิ่มโดยตรง — ล็อคไว้แค่ว่ารุ่นนี้ใช้กับ MoisturLyzer เท่านั้น (กันเบิกผิดรุ่น)
      // แต่ไม่บังคับให้เลือกเครื่องเจาะจง เผื่อนำ Gateway+SimCard ไปทดลองกับเครื่องอื่นนอกระบบ
      let targetFieldHtml;
      if (!linkableTargets.length) {
        targetFieldHtml = `<span class="warn-text">ไม่มีเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} ในระบบ</span>`;
      } else {
        targetFieldHtml = `<select onchange="updateBasketConnectSerial(${idx}, this.value)">
          <option value="">-- ไม่ระบุเครื่องเจาะจง (ไม่บังคับ) --</option>
          ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
        </select>`;
      }
      fields.push({ label: `เชื่อมต่อกับเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} (ไม่บังคับ)`, html: targetFieldHtml, req: false });
      fields.push({ label: "SimCard คู่กัน (ไม่บังคับ)", html: simFieldHtml, req: false });
    } else if (cfg.connectOptions) {
      // SimCard หรือ Gateway ที่ยังไม่ระบุรุ่น — dropdown ตัวเลือกเดิม
      fields.push({
        label: "เชื่อมต่อกับ / ใส่ใน",
        html: `<select onchange="updateBasketConnectTo(${idx}, this.value)">
          ${cfg.connectOptions.map((o) => `<option value="${escapeAttr(o)}" ${o === item.connectTo ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>`,
        req: false,
      });
      if (item.connectTo === LINKABLE_TARGET_ASSET_TYPE) {
        let targetFieldHtml;
        if (!linkableTargets.length) {
          targetFieldHtml = `<span class="warn-text">ไม่มีเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} ในระบบ</span>`;
        } else {
          targetFieldHtml = `<select onchange="updateBasketConnectSerial(${idx}, this.value)">
            <option value="">-- ไม่ระบุเครื่องเจาะจง --</option>
            ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
          </select>`;
        }
        fields.push({ label: "เครื่องที่เชื่อมต่อ (เจาะจง)", html: targetFieldHtml, req: false });
      }
    }

    const fieldsHtml = fields.map((f) => `
      <div class="basket-field">
        <label class="${f.req ? "req" : ""}">${f.label}</label>
        ${f.html}
      </div>`).join("");

    return `
      <div class="basket-card">
        <div class="basket-card-head">
          <div>
            <div class="basket-card-title">${escapeHtml(cfg.title)}</div>
            <div class="basket-card-serial">S/N ${escapeHtml(item.serialNo)}</div>
          </div>
          <button class="basket-card-remove" onclick="removeFromBasket(${idx})">ลบ</button>
        </div>
        ${fieldsHtml}
      </div>`;
  }).join("");

  area.innerHTML = `
    <div class="basket-cards">${cardsHtml}</div>
    <div class="cache-note" style="margin-top:10px;">หมายเหตุ: การเลือก "เครื่องที่เชื่อมต่อ (เจาะจง)" เป็นการบันทึกความสัมพันธ์เพื่อการติดตามเท่านั้น ไม่ได้ตัดสต๊อกของเครื่องที่เลือก (ยกเว้น Gateway ที่เลือกคู่กับ MoisturLyzer ซึ่งจะถูกเบิกออกจากสต๊อกจริง)</div>
    <div id="basketRequirementNotice">${renderBasketRequirementNotice()}</div>
  `;
}

/** Phase 6: สรุปสิ่งที่ยังขาดในตะกร้า (ถ้ามี) ให้เห็นชัดก่อนกดส่งคำขอ */
function renderBasketRequirementNotice() {
  // หมายเหตุ (Phase 7): ตอนนี้ไม่มีเงื่อนไข "ต้องกรอกให้ครบ" เหลืออยู่แล้วในตะกร้า — MoisturLyzer/Gateway/
  // SimCard ทั้งสามอย่างเลือกได้อิสระจากกันทั้งหมด (ไม่บังคับคู่กันไม่ว่ากรณีใด) เพราะลูกค้าอาจยืมไปทดลองใช้
  // โดยใส่หรือไม่ใส่ Gateway/SimCard ก็ได้ ยังคงล็อคไว้แค่รุ่น Gateway ที่ใช้ได้กับอุปกรณ์แต่ละประเภทเท่านั้น
  // (ผ่าน GATEWAY_MODEL_PANOLYZER / GATEWAY_MODEL_MOISTURLYZER) ฟังก์ชันนี้คงไว้เผื่ออนาคตมีเงื่อนไขบังคับเพิ่ม
  return "";
}

async function submitIssuanceRequest() {
  const msg = document.getElementById("issueMsg");
  const btn = document.getElementById("submitIssuanceBtn");
  msg.className = "form-msg";
  msg.textContent = "";

  if (!issuanceForm.customerName.trim() || !issuanceForm.siteLocation.trim()) {
    msg.className = "form-msg error"; msg.textContent = "กรุณากรอกชื่อลูกค้าและสถานที่ติดตั้ง";
    return;
  }
  if (!issuanceForm.basket.length) {
    msg.className = "form-msg error"; msg.textContent = "กรุณาเลือกอุปกรณ์อย่างน้อย 1 รายการ";
    return;
  }

  // ---- Phase 7: ไม่มีเงื่อนไขบังคับ Gateway/SimCard เหลืออยู่แล้ว (เลือกได้อิสระจากกันทั้งหมด) ----
  // ยังคงล็อคไว้แค่รุ่น Gateway ที่ใช้ได้กับอุปกรณ์แต่ละประเภท (ตรวจตอน addToBasket และฝั่งเซิร์ฟเวอร์เสมอ)

  // ---- Phase 6: MoisturLyzer/Gateway แต่ละชิ้นที่เลือก Gateway/SimCard คู่กันไว้ ให้เพิ่มเป็นรายการจริงในคำขอด้วย ----
  const items = [];
  issuanceForm.basket.forEach((b) => {
    // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N) — ส่ง quantity ไปด้วย ไม่มีเรื่อง Gateway/SimCard คู่กัน
    if (b.quantity !== undefined) {
      items.push({ assetType: b.assetType, serialNo: b.serialNo, quantity: b.quantity, connectTo: "", connectSerial: "" });
      return;
    }
    items.push({ assetType: b.assetType, serialNo: b.serialNo, connectTo: b.connectTo, connectSerial: b.connectSerial || "" });
    if (b.assetType === "MoisturLyzer" && b.linkedGatewaySerial) {
      items.push({ assetType: "Gateway", serialNo: b.linkedGatewaySerial, connectTo: "MoisturLyzer", connectSerial: b.serialNo });
    }
    if ((b.assetType === "MoisturLyzer" || b.assetType === "Gateway") && b.linkedSimSerial) {
      const simConnectTo = b.assetType === "MoisturLyzer" ? "MoisturLyzer" : (b.model === GATEWAY_MODEL_PANOLYZER ? "Panolyzer" : "MoisturLyzer");
      const simConnectSerial = b.assetType === "MoisturLyzer" ? b.serialNo : (b.connectSerial || "");
      items.push({ assetType: "SimCard", serialNo: b.linkedSimSerial, connectTo: simConnectTo, connectSerial: simConnectSerial });
    }
  });

  const payload = {
    customerName: issuanceForm.customerName.trim(),
    siteLocation: issuanceForm.siteLocation.trim(),
    details: issuanceForm.details.trim(),
    items: items,
  };

  // ---- ออฟไลน์: บันทึกลง Local cache แบบ Optimistic ทันที + เข้าคิวรอส่งเมื่อกลับมาออนไลน์ ----
  if (!navigator.onLine) {
    const tempTxnId = "TEMPTXN" + Date.now();
    applyOptimisticIssuance(tempTxnId, payload);
    state.offlineQueue.push({ label: `เบิก ${payload.customerName}`, body: { action: "requestIssuance", token: state.token, payload } });
    saveOfflineQueue();
    persistCache();
    issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [] };
    renderIssueView();
    const freshMsg = document.getElementById("issueMsg");
    freshMsg.className = "form-msg success";
    freshMsg.textContent = "ขณะนี้ออฟไลน์ — บันทึกคำขอไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติทันทีที่กลับมาออนไลน์";
    return;
  }

  btn.disabled = true; btn.textContent = "กำลังส่งคำขอ...";
  try {
    const res = await apiPost({ action: "requestIssuance", token: state.token, payload });

    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      const conflictMsg = res.conflicts ? " (" + res.conflicts.join(", ") + ")" : "";
      throw new Error(issuanceErrorMessage(res.error) + conflictMsg);
    }

    issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [] };
    const successText = "ส่งคำขอเบิกสำเร็จ (เลขที่ธุรกรรม " + res.transactionId + ") — รอ Admin อนุมัติ";
    await refreshInBackground(true);
    renderIssueView(); // สร้างฟอร์มใหม่ (ว่างเปล่า) ก่อน แล้วค่อยแปะข้อความสำเร็จทับ #issueMsg ของฟอร์มใหม่
    const freshMsg = document.getElementById("issueMsg");
    freshMsg.className = "form-msg success";
    freshMsg.textContent = successText;
    return;
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = err.message || "ส่งคำขอไม่สำเร็จ";
  } finally {
    btn.disabled = false; btn.textContent = "ส่งคำขอเบิก (รออนุมัติ)";
  }
}

/** เพิ่มธุรกรรม "เดา" ลงใน state ทันที (ก่อนเซิร์ฟเวอร์ยืนยัน) เพื่อ Optimistic UI ตอนออฟไลน์ — จะถูกแทนที่ด้วยข้อมูลจริงเมื่อซิงค์สำเร็จ */
function applyOptimisticIssuance(tempTxnId, payload) {
  state.data.issuanceLog.push({
    TransactionID: tempTxnId, Timestamp: new Date().toISOString(), CustomerName: payload.customerName,
    SiteLocation: payload.siteLocation, IssuedBy: state.user.name, Details: payload.details,
    RequestStatus: "PendingApproval", ApprovedBy: "", ApprovedAt: "", ReturnedAt: "", _pendingSync: true,
  });
  payload.items.forEach((item) => {
    state.data.issuanceItems.push({
      TransactionID: tempTxnId, AssetType: item.assetType, SerialNo: item.serialNo, ConnectTo: item.connectTo || "",
      ConnectSerial: item.connectSerial || "", PreviousStatus: "Stock", NewLocation: payload.siteLocation, _pendingSync: true,
    });
  });
  updatePendingBadge();
}

function persistCache() {
  localStorage.setItem(LS_CACHE, JSON.stringify({ data: state.data, cachedAt: state.cachedAt }));
}

function issuanceErrorMessage(code) {
  switch (code) {
    case "missing_fields": return "กรอกข้อมูลไม่ครบ";
    case "item_conflict": return "มีรายการที่เบิกไม่ได้แล้ว";
    default: return "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่";
  }
}

// ============================================================
// Phase 2: หน้าอนุมัติการเบิก (Admin เท่านั้น)
// ============================================================
function getItemsForTransaction(transactionId) {
  return (state.data.issuanceItems || []).filter((i) => i.TransactionID === transactionId);
}

/** สร้างข้อความ "(เชื่อมกับ Gateway — เครื่อง MZ-002)" สำหรับแสดงในประวัติ/ใบเบิก — รวม ConnectSerial ถ้ามีการระบุเครื่องเจาะจงไว้ */
function formatConnectInfo(item) {
  if (!item.ConnectTo) return "";
  let text = " (เชื่อมกับ " + escapeHtml(item.ConnectTo);
  if (item.ConnectSerial) text += " — เครื่อง " + escapeHtml(item.ConnectSerial);
  text += ")";
  return text;
}

/** เครื่องที่ Issued อยู่ (ยังไม่คืน) เท่านั้นถือเป็นความสัมพันธ์ที่ "active" จริงในปัจจุบัน */
function computeLinkedAccessories(productId) {
  const issuedTxnIds = new Set(
    (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "Issued").map((r) => r.TransactionID)
  );
  return (state.data.issuanceItems || [])
    .filter((i) => i.ConnectSerial === productId && issuedTxnIds.has(i.TransactionID))
    .map((i) => `${i.AssetType} ${i.SerialNo}`);
}

function renderApprovalsView() {
  const content = document.getElementById("viewContent");
  if (state.user.role !== "Admin") {
    content.innerHTML = `<div class="empty-state">หน้านี้สำหรับ Admin เท่านั้น</div>`;
    return;
  }

  const pending = (state.data.issuanceLog || [])
    .filter((r) => r.RequestStatus === "PendingApproval")
    .sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));

  bulkSelection.clear();

  if (!pending.length) {
    content.innerHTML = `<div class="empty-state">ไม่มีคำขอเบิกที่รออนุมัติในขณะนี้</div>`;
    return;
  }

  // เฉพาะรายการที่ซิงค์กับเซิร์ฟเวอร์แล้วเท่านั้นที่เลือกทำแบบกลุ่มได้ (รายการออฟไลน์ที่ยังไม่ซิงค์ยังไม่มีเลขที่ธุรกรรมจริง)
  const selectableCount = pending.filter((t) => !t._pendingSync).length;

  content.innerHTML = `
    ${bulkActionBarHtml("bulk-approval-cb", selectableCount, [
      { action: "approveIssuance", label: "อนุมัติ", cls: "btn-approve" },
      { action: "rejectIssuance", label: "ปฏิเสธ", cls: "btn-reject" },
    ])}
    ${pending.map((txn) => {
      const items = getItemsForTransaction(txn.TransactionID);
      return `
      <div class="txn-card">
        <div class="txn-card-head">
          ${txn._pendingSync ? "" : `<label class="txn-select"><input type="checkbox" class="bulk-approval-cb" data-txn-id="${escapeAttr(txn.TransactionID)}" onchange="toggleBulkSelect('${escapeAttr(txn.TransactionID)}', this.checked)"></label>`}
          <div>
            <div class="txn-title">${escapeHtml(txn.CustomerName)} — ${escapeHtml(txn.SiteLocation || "")}</div>
            <div class="txn-meta">เลขที่ ${escapeHtml(txn.TransactionID)} · ผู้เบิก: ${escapeHtml(txn.IssuedBy)} · ${formatDateTh(txn.Timestamp)}</div>
          </div>
          <span class="status-badge status-PendingApproval">รออนุมัติ</span>
        </div>
        ${txn.Details ? `<div class="txn-meta">หมายเหตุ: ${escapeHtml(txn.Details)}</div>` : ""}
        <div class="txn-items">
          ${items.map((i) => `<div class="txn-item-row">${escapeHtml(i.AssetType)} — ${escapeHtml(i.SerialNo)}${formatConnectInfo(i)}</div>`).join("")}
        </div>
        ${txn._pendingSync
          ? `<div class="txn-meta">🔄 บันทึกไว้ตอนออฟไลน์ — รอซิงค์กับเซิร์ฟเวอร์ก่อนจึงจะอนุมัติได้</div>`
          : `<div class="txn-actions">
               <button class="btn-sm btn-approve" onclick="approveTxn('${escapeAttr(txn.TransactionID)}', this)">อนุมัติ</button>
               <button class="btn-sm btn-reject" onclick="rejectTxn('${escapeAttr(txn.TransactionID)}', this)">ปฏิเสธ</button>
             </div>`}
      </div>`;
    }).join("")}
  `;
}

// ============================================================
// Phase 5: ดำเนินการแบบกลุ่ม (bulk) — ใช้ร่วมกันระหว่างหน้าอนุมัติ (อนุมัติ/ปฏิเสธหลายรายการ) และหน้าประวัติ (คืนของหลายรายการ)
// ============================================================

/** สร้างแถบเครื่องมือ bulk action — actions: [{ action, label, cls }] */
function bulkActionBarHtml(checkboxClass, selectableCount, actions) {
  if (!selectableCount) return "";
  return `
    <div class="bulk-action-bar no-print" id="bulkActionBar">
      <label class="bulk-select-all">
        <input type="checkbox" onchange="toggleBulkSelectAll('${checkboxClass}', this.checked)">
        เลือกทั้งหมด (${selectableCount} รายการ)
      </label>
      <span class="bulk-progress" id="bulkProgress"></span>
      <div class="bulk-action-buttons">
        ${actions.map((a) => `<button class="btn-sm ${a.cls}" disabled onclick="runBulkAction('${a.action}', '${escapeAttr(a.label)}')">${escapeHtml(a.label)}ที่เลือก (<span class="bulk-count">0</span>)</button>`).join("")}
      </div>
    </div>`;
}

function toggleBulkSelect(transactionId, checked) {
  if (checked) bulkSelection.add(transactionId); else bulkSelection.delete(transactionId);
  updateBulkBar();
}

function toggleBulkSelectAll(checkboxClass, checked) {
  document.querySelectorAll("." + checkboxClass).forEach((cb) => {
    cb.checked = checked;
    const id = cb.dataset.txnId;
    if (!id) return;
    if (checked) bulkSelection.add(id); else bulkSelection.delete(id);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById("bulkActionBar");
  if (!bar) return;
  const count = bulkSelection.size;
  bar.querySelectorAll(".bulk-count").forEach((el) => { el.textContent = count; });
  bar.querySelectorAll("button").forEach((b) => { b.disabled = count === 0; });
}

/** เรียก action เดิม (approveIssuance/rejectIssuance/returnTransaction) ทีละรายการตามลำดับสำหรับทุกเลขที่ธุรกรรมที่เลือกไว้ */
async function runBulkAction(action, actionLabel) {
  const ids = Array.from(bulkSelection);
  if (!ids.length) return;
  const confirmed = await showConfirm(`ยืนยัน${actionLabel} ${ids.length} รายการที่เลือก?`);
  if (!confirmed) return;

  const bar = document.getElementById("bulkActionBar");
  const progressEl = document.getElementById("bulkProgress");
  if (bar) bar.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });

  const failures = [];
  for (let i = 0; i < ids.length; i++) {
    if (progressEl) progressEl.textContent = `กำลังดำเนินการ ${i + 1}/${ids.length}...`;
    try {
      const res = await apiPost({ action, token: state.token, transactionId: ids[i] });
      if (!res.ok) {
        if (res.error === "unauthorized") { handleUnauthorized(); return; }
        failures.push(`${ids[i]}: ${res.conflicts ? res.conflicts.join(", ") : (res.error || "unknown_error")}`);
      }
    } catch (err) {
      failures.push(`${ids[i]}: ${err.message}`);
    }
  }

  bulkSelection.clear();
  await refreshInBackground(true);
  renderCurrentView();

  if (failures.length) {
    await showAlert(`ดำเนินการเสร็จสิ้น แต่มีบางรายการล้มเหลว (${failures.length}/${ids.length}):\n` + failures.join("\n"), "warning");
  }
}

async function approveTxn(transactionId, btnEl) {
  await runTxnAction("approveIssuance", transactionId, btnEl, "กำลังอนุมัติ...");
}

async function rejectTxn(transactionId, btnEl) {
  const confirmed = await showConfirm("ยืนยันปฏิเสธคำขอนี้?", { type: "warning" });
  if (!confirmed) return;
  await runTxnAction("rejectIssuance", transactionId, btnEl, "กำลังปฏิเสธ...");
}

async function returnTxn(transactionId, btnEl) {
  const confirmed = await showConfirm("ยืนยันคืนของสำหรับธุรกรรมนี้? อุปกรณ์ทั้งหมดในธุรกรรมจะกลับเป็นสถานะ Stock");
  if (!confirmed) return;
  await runTxnAction("returnTransaction", transactionId, btnEl, "กำลังคืนของ...");
}

async function runTxnAction(action, transactionId, btnEl, loadingText) {
  const originalText = btnEl ? btnEl.textContent : "";
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = loadingText; }
  try {
    const res = await apiPost({ action, token: state.token, transactionId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      const conflictMsg = res.conflicts ? "\n" + res.conflicts.join("\n") : "";
      await showAlert("ดำเนินการไม่สำเร็จ: " + (res.error || "unknown_error") + conflictMsg, "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText; }
  }
}

// ============================================================
// Phase 2: ประวัติการเบิก/คืน
// ============================================================
function renderHistoryView() {
  const content = document.getElementById("viewContent");
  const isAdmin = state.user.role === "Admin";
  const logs = [...(state.data.issuanceLog || [])].sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));

  if (!logs.length) {
    content.innerHTML = `<div class="empty-state">ยังไม่มีประวัติการเบิก</div>`;
    return;
  }

  const statusLabel = {
    PendingApproval: "รออนุมัติ", Issued: "เบิกแล้ว", Rejected: "ถูกปฏิเสธ", Returned: "คืนแล้ว",
  };

  content.innerHTML = `
    <div class="controls-row">
      <input type="text" id="historySearch" placeholder="ค้นหาชื่อลูกค้า, เลขที่ธุรกรรม, ผู้เบิก...">
    </div>
    <div id="historyBulkBar"></div>
    <div id="historyList"></div>
  `;
  document.getElementById("historySearch").addEventListener("input", () => renderHistoryList(logs, isAdmin, statusLabel));
  renderHistoryList(logs, isAdmin, statusLabel);
}

function renderHistoryList(logs, isAdmin, statusLabel) {
  const search = (document.getElementById("historySearch").value || "").toLowerCase();
  const listEl = document.getElementById("historyList");
  const bulkBarEl = document.getElementById("historyBulkBar");

  const filtered = logs.filter((txn) => !search ||
    [txn.CustomerName, txn.TransactionID, txn.IssuedBy, txn.SiteLocation].some((v) => String(v || "").toLowerCase().includes(search))
  );

  bulkSelection.clear();

  if (!filtered.length) {
    if (bulkBarEl) bulkBarEl.innerHTML = "";
    listEl.innerHTML = `<div class="empty-state">ไม่พบรายการที่ตรงกับคำค้นหา</div>`;
    return;
  }

  // เฉพาะ Admin เท่านั้นที่คืนของแบบกลุ่มได้ นับเฉพาะรายการที่สถานะ "เบิกแล้ว" (Issued) และซิงค์กับเซิร์ฟเวอร์แล้ว
  const returnableCount = isAdmin ? filtered.filter((t) => !t._pendingSync && t.RequestStatus === "Issued").length : 0;
  if (bulkBarEl) {
    bulkBarEl.innerHTML = bulkActionBarHtml("bulk-return-cb", returnableCount, [
      { action: "returnTransaction", label: "คืนของ", cls: "btn-return" },
    ]);
  }

  listEl.innerHTML = filtered.map((txn) => {
    const items = getItemsForTransaction(txn.TransactionID);
    const canReturn = isAdmin && txn.RequestStatus === "Issued";
    const canPrint = !txn._pendingSync;
    const canEdit = isAdmin && !txn._pendingSync;
    const canDelete = isAdmin && !txn._pendingSync && (txn.RequestStatus === "Rejected" || txn.RequestStatus === "Returned");
    const canBulkReturn = canReturn && !txn._pendingSync;
    return `
      <div class="txn-card">
        <div class="txn-card-head">
          ${canBulkReturn ? `<label class="txn-select"><input type="checkbox" class="bulk-return-cb" data-txn-id="${escapeAttr(txn.TransactionID)}" onchange="toggleBulkSelect('${escapeAttr(txn.TransactionID)}', this.checked)"></label>` : ""}
          <div>
            <div class="txn-title">${escapeHtml(txn.CustomerName)} — ${escapeHtml(txn.SiteLocation || "")}</div>
            <div class="txn-meta">เลขที่ ${escapeHtml(txn.TransactionID)} · ผู้เบิก: ${escapeHtml(txn.IssuedBy)} · ${formatDateTh(txn.Timestamp)}</div>
            ${txn.ApprovedBy ? `<div class="txn-meta">ดำเนินการโดย: ${escapeHtml(txn.ApprovedBy)} เมื่อ ${formatDateTh(txn.ApprovedAt)}</div>` : ""}
            ${txn.ReturnedAt ? `<div class="txn-meta">คืนของเมื่อ: ${formatDateTh(txn.ReturnedAt)}</div>` : ""}
            ${txn._pendingSync ? `<div class="txn-meta">🔄 บันทึกไว้ตอนออฟไลน์ — รอซิงค์กับเซิร์ฟเวอร์</div>` : ""}
          </div>
          <span class="status-badge status-${txn.RequestStatus}">${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}</span>
        </div>
        ${txn.Details ? `<div class="txn-meta">หมายเหตุ: ${escapeHtml(txn.Details)}</div>` : ""}
        <div class="txn-items">
          ${items.map((i) => `<div class="txn-item-row">${escapeHtml(i.AssetType)} — ${escapeHtml(i.SerialNo)}${formatConnectInfo(i)}</div>`).join("")}
        </div>
        <div class="txn-actions">
          ${canReturn ? `<button class="btn-sm btn-return" onclick="returnTxn('${escapeAttr(txn.TransactionID)}', this)">คืนของ</button>` : ""}
          ${canPrint ? `<button class="btn-sm btn-secondary" onclick="printSlip('${escapeAttr(txn.TransactionID)}')">พิมพ์ใบเบิก</button>` : ""}
          ${canEdit ? `<button class="btn-sm btn-secondary" onclick="openEditIssuance('${escapeAttr(txn.TransactionID)}')">แก้ไข</button>` : ""}
          ${canDelete ? `<button class="btn-sm btn-remove" onclick="deleteIssuance('${escapeAttr(txn.TransactionID)}')">ลบ</button>` : ""}
        </div>
      </div>`;
  }).join("");
}

function formatDateTh(isoStr) {
  if (!isoStr) return "-";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return String(isoStr);
  return d.toLocaleString("th-TH");
}

// ============================================================
// Phase 4: จัดการผู้ใช้งาน (Admin เท่านั้น)
// ============================================================
function renderUsersView() {
  const content = document.getElementById("viewContent");
  if (state.user.role !== "Admin") {
    content.innerHTML = `<div class="empty-state">หน้านี้สำหรับ Admin เท่านั้น</div>`;
    return;
  }

  const users = state.data.users || [];
  content.innerHTML = `
    <div class="form-card">
      <h3>เพิ่มผู้ใช้งานใหม่</h3>
      <div class="form-grid">
        <div class="form-field"><label>ชื่อ-นามสกุล *</label><input type="text" id="nu-name"></div>
        <div class="form-field"><label>Username *</label><input type="text" id="nu-username"></div>
        <div class="form-field"><label>รหัสผ่านเริ่มต้น * (อย่างน้อย 6 ตัวอักษร)</label><input type="password" id="nu-password"></div>
        <div class="form-field">
          <label>สิทธิ์การใช้งาน</label>
          <select id="nu-role"><option value="Staff">Staff</option><option value="Admin">Admin</option></select>
        </div>
      </div>
      <div id="createUserMsg" class="form-msg"></div>
      <button class="btn-primary" id="createUserBtn" onclick="createUser()">เพิ่มผู้ใช้งาน</button>
    </div>

    ${isMobileViewport()
      ? `<div class="mcard-list">
          ${users.map((u) => `
            <div class="mcard">
              <div class="mcard-head">
                <div><div class="mcard-title">${escapeHtml(u.Name)} <span class="role-chip">${escapeHtml(u.Role)}</span></div><div class="mcard-sub">${escapeHtml(u.Username)}</div></div>
                <span class="mcard-pill ${isActiveUser(u) ? "stock" : "used"}">${isActiveUser(u) ? "ใช้งานอยู่" : "ปิดใช้งาน"}</span>
              </div>
              <div class="mcard-row"><div class="mcard-label">เข้าใช้งานล่าสุด</div><div class="mcard-val">${formatDateTh(u.LastLoginAt)}</div></div>
              <div class="mcard-actions">
                <button class="btn-sm ${isActiveUser(u) ? "btn-reject" : "btn-approve"}" onclick="toggleUserActive('${escapeAttr(u.UserID)}', ${!isActiveUser(u)}, this)">
                  ${isActiveUser(u) ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                </button>
                <button class="btn-sm btn-secondary" onclick="resetUserPassword('${escapeAttr(u.UserID)}', '${escapeAttr(u.Name)}')">รีเซ็ตรหัสผ่าน</button>
              </div>
            </div>`).join("")}
        </div>`
      : `<div class="users-table-wrap">
      <table class="users-table">
        <thead><tr><th>ชื่อ</th><th>Username</th><th>สิทธิ์</th><th>สถานะ</th><th>เข้าใช้งานล่าสุด</th><th></th></tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${escapeHtml(u.Name)}</td>
              <td>${escapeHtml(u.Username)}</td>
              <td>${escapeHtml(u.Role)}</td>
              <td><span class="status-pill ${isActiveUser(u) ? "active" : "inactive"}">${isActiveUser(u) ? "ใช้งานอยู่" : "ปิดใช้งาน"}</span></td>
              <td>${formatDateTh(u.LastLoginAt)}</td>
              <td>
                <button class="btn-sm ${isActiveUser(u) ? "btn-reject" : "btn-approve"}" onclick="toggleUserActive('${escapeAttr(u.UserID)}', ${!isActiveUser(u)}, this)">
                  ${isActiveUser(u) ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                </button>
                <button class="btn-sm btn-secondary" onclick="resetUserPassword('${escapeAttr(u.UserID)}', '${escapeAttr(u.Name)}')">รีเซ็ตรหัสผ่าน</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`}
  `;
}

function isActiveUser(u) {
  return u.Active === true || String(u.Active).toUpperCase() === "TRUE";
}

async function createUser() {
  const msg = document.getElementById("createUserMsg");
  const btn = document.getElementById("createUserBtn");
  const name = document.getElementById("nu-name").value.trim();
  const username = document.getElementById("nu-username").value.trim();
  const password = document.getElementById("nu-password").value;
  const role = document.getElementById("nu-role").value;

  msg.className = "form-msg";
  if (!name || !username || !password) {
    msg.className = "form-msg error"; msg.textContent = "กรุณากรอกข้อมูลให้ครบ"; return;
  }
  if (password.length < 6) {
    msg.className = "form-msg error"; msg.textContent = "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"; return;
  }

  btn.disabled = true; btn.textContent = "กำลังเพิ่ม...";
  try {
    const res = await apiPost({ action: "createUser", token: state.token, payload: { name, username, password, role } });
    if (!res.ok) throw new Error(userErrorMessage(res.error));
    await refreshInBackground(true);
    renderUsersView();
    const freshMsg = document.getElementById("createUserMsg");
    freshMsg.className = "form-msg success";
    freshMsg.textContent = `เพิ่มผู้ใช้งาน "${name}" สำเร็จ`;
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "เพิ่มผู้ใช้งาน";
  }
}

function userErrorMessage(code) {
  switch (code) {
    case "username_taken": return "Username นี้มีผู้ใช้งานแล้ว";
    case "password_too_short": return "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร";
    case "missing_fields": return "กรอกข้อมูลไม่ครบ";
    case "cannot_disable_self": return "ไม่สามารถปิดใช้งานบัญชีของตัวเองได้";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

async function toggleUserActive(userId, active, btnEl) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  try {
    const res = await apiPost({ action: "setUserActive", token: state.token, userId, active });
    if (!res.ok) { await showAlert(userErrorMessage(res.error), "error"); return; }
    await refreshInBackground(true);
    renderUsersView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  } finally {
    btnEl.disabled = false; btnEl.textContent = originalText;
  }
}

async function resetUserPassword(userId, userName) {
  const confirmed = await showConfirm(`ยืนยันสุ่มรหัสผ่านใหม่ให้ "${userName}"? รหัสผ่านเดิมจะใช้ไม่ได้ทันที`, { type: "warning" });
  if (!confirmed) return;

  try {
    const res = await apiPost({ action: "resetPassword", token: state.token, userId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(userErrorMessage(res.error), "error");
      return;
    }
    showPasswordResultModal(userName, res.newPassword);
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

function showPasswordResultModal(userName, newPassword) {
  document.getElementById("passwordResultUserLabel").textContent = `รหัสผ่านใหม่สำหรับ "${userName}" (กรุณาแจ้งให้เจ้าของบัญชีทราบ แล้วแนะนำให้เปลี่ยนรหัสผ่านเองภายหลัง):`;
  document.getElementById("passwordResultText").textContent = newPassword;
  const msg = document.getElementById("passwordResultMsg");
  msg.className = "form-msg";
  msg.textContent = "";
  document.getElementById("passwordResultModal").style.display = "flex";
}

function closePasswordResultModal() {
  document.getElementById("passwordResultModal").style.display = "none";
}

async function copyNewPassword() {
  const text = document.getElementById("passwordResultText").textContent;
  const msg = document.getElementById("passwordResultMsg");
  try {
    if (!navigator.clipboard) throw new Error("ไม่รองรับ");
    await navigator.clipboard.writeText(text);
    msg.className = "form-msg success";
    msg.textContent = "คัดลอกรหัสผ่านแล้ว";
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = "คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกข้อความแล้วคัดลอกด้วยตนเอง";
  }
}

// ============================================================
// Utility
// ============================================================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** สำหรับใส่ค่าใน attribute ของ HTML ที่สร้างด้วย onclick="...('...')" — กัน string ที่มี ' หรือ \ ทำลาย syntax */
function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;").replace(/\\/g, "\\\\");
}
