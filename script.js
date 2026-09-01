/**
 * MoisturLyzer / Gateway / SimCard — Frontend
 * Phase 1: Login + Session, Near-realtime polling sync, Local cache (cache-first),
 *          Dashboard (read-only summary), รายการอุปกรณ์ 3 ประเภท (read-only)
 * Phase 2: ระบบเบิกอุปกรณ์แบบตะกร้า (ส่งคำขอ), หน้าอนุมัติ/ปฏิเสธ (Admin), ประวัติ + คืนของ (Admin)
 * Phase 3: Offline queue + Optimistic UI สำหรับการส่งคำขอเบิก (ใช้งานหน้างานที่ Wi-Fi ไม่เสถียรได้)
 * Phase 4: Dashboard กราฟเส้นโค้ง, ระบบพิมพ์ใบเบิก/รายงาน, สร้างรูปรายงานสำหรับคัดลอกไปวางส่ง LINE, จัดการผู้ใช้งาน (Admin)
 */

// ============================================================
// ตั้งค่า — ย้ายจาก Apps Script Web App มาเป็น Firebase แล้ว (ดู firebaseConfig ในหัวข้อ "Firebase adapter"
// ด้านล่าง สำหรับ config การเชื่อมต่อจริง) เหลือไว้แค่ค่า interval ของ refresh รายชื่อผู้ใช้งาน (ดู startPolling)
// ============================================================
const CONFIG = {
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
let issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [], isLoan: false };

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
      { field: "_linkedAccessories", label: "เชื่อมต่อกับ", computed: true, compute: computeLinkedAccessories },
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
      { field: "S/N Device", label: "S/N อุปกรณ์ปลายทาง", computed: true, compute: computeGatewayLinkedMoisturlyzer },
      { field: "SimCard_SN", label: "SimCard ที่ใส่อยู่" },
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
    // หมายเหตุ: SimCard ใส่ได้เฉพาะใน Gateway เท่านั้นทางกายภาพ (ใส่ตรงกับ MoisturLyzer/Panolyzer ไม่ได้)
    // จึงไม่มี connectOptions ให้เลือกหลายแบบเหมือนเดิมอีกต่อไป — ดู addToBasket/renderBasket ที่ล็อก
    // connectTo ไว้เป็น "Gateway" ตายตัวเสมอสำหรับ SimCard โดยเฉพาะ
    columns: [
      { field: "No", label: "ลำดับ" },
      { field: "Mobile No.", label: "เบอร์โทร" },
      { field: "S/N", label: "S/N ซิม" },
      { field: "Customer_name", label: "ลูกค้า" },
      { field: "Location", label: "สถานที่ใช้งาน" },
      { field: "Installed_device", label: "ใส่ในอุปกรณ์" },
      { field: "_installedGateway", label: "Gateway ที่เชื่อมต่อ", computed: true, compute: computeSimInstalledGateway },
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
// ป้ายกำกับ "เป็นอะไหล่ของอุปกรณ์อะไร" สำหรับแสดงคู่กับชื่ออะไหล่ในประวัติ/ใบเบิก (ดูฟังก์ชัน formatItemLabel)
const PART_QTY_DEVICE_LABEL = {
  ColorSorterPartQty: "Color Sorter",
  PanolyzerPartQty: "Panolyzer",
};

// ประเภทอุปกรณ์ที่สามารถเลือก Serial เจาะจงมาผูก (เชื่อมโยง/sync) ตอนเบิก Gateway/SimCard ได้ — ต้องตรงกับ
// LINKABLE_TARGET_ASSET_TYPE ฝั่ง Code.gs (Phase 5)
const LINKABLE_TARGET_ASSET_TYPE = "MoisturLyzer";
const LINKABLE_TARGET_KEY = "moisturlyzer";

// เบิก SimCard เชื่อมกับ Gateway ที่เบิกออกไปแล้ว (ต้องตรงกับ GATEWAY_SIMCARD_FIELD ฝั่ง Cloud Functions) —
// เก็บ S/N ของ SimCard ที่ "ใส่อยู่จริง" ไว้ในเอกสาร Gateway เอง เพื่อให้หน้าตาราง Gateway แสดงได้ และเพื่อกันเบิก
// ซิมใหม่ไปทับ Gateway ที่มีซิมเดิมใส่อยู่แล้วโดยไม่ตั้งใจ
const GATEWAY_SIMCARD_FIELD = "SimCard_SN";

// ฟีเจอร์ "ย้าย/เคลม" — ค่าพิเศษของ stockField (ต้องตรงกับ CLAIM_STOCK_VALUE/WRITEOFF_STOCK_VALUE ฝั่ง Cloud
// Functions เป๊ะ) ใช้แยกสถานะ "อยู่ระหว่างเคลม"/"ตัดจำหน่าย" ออกจาก Stock/Issued ปกติ โดยไม่ต้องเพิ่ม field ใหม่
// เอาไว้เช็คสถานะ — อ่านค่าจาก field เดิม (stockField) ที่ตารางแสดงอยู่แล้วได้เลย
const CLAIM_STOCK_VALUE = "Claim";
const WRITEOFF_STOCK_VALUE = "WrittenOff";
// ประเภทอุปกรณ์ที่เปิดปุ่ม "ย้าย/เคลม" ให้ (เฉพาะ 3 ชนิดที่ติดตั้งอยู่กับลูกค้าจริง — ไม่รวมอะไหล่ ColorSorter/Panolyzer)
const TRANSFER_CLAIM_ASSET_KEYS = ["moisturlyzer", "gateway", "simcard"];

// Phase 6: กติกา Gateway 2 รุ่น — ต้องตรงกับ Code.gs
// EPG-001S = สำหรับ Panolyzer เท่านั้น (ไม่ได้ตามอยู่ในระบบนี้ ต้องกรอก S/N เป็นข้อความอิสระ)
// EPG-001B = สำหรับ MoisturLyzer เท่านั้น (ต้องเลือกเครื่องเจาะจงจากในระบบ)
const GATEWAY_MODEL_FIELD = "Model";
const GATEWAY_MODEL_PANOLYZER = "EPG-001S";
const GATEWAY_MODEL_MOISTURLYZER = "EPG-001B";

/** ทำความสะอาดค่า Model ของ Gateway ก่อนเทียบกับ EPG-001S/EPG-001B — ต้อง sync ตรรกะเดียวกันกับ
 * normalizeGatewayModel_() ฝั่ง Code.gs เป๊ะ กันเคสค่าในชีต "หน้าตาถูก" แต่มีอักขระที่มองไม่เห็นปนอยู่
 * (ขีดกลางคนละแบบ/NBSP/zero-width space) ทำให้ trim()+toUpperCase() เฉยๆ ไม่พอจะจับได้ */
function normalizeGatewayModel(raw) {
  return String(raw || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-") // ขีดกลาง/ขีดยาว/เครื่องหมายลบทุกแบบ -> "-" ปกติ
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ") // NBSP/zero-width space -> ช่องว่างปกติ (ให้ trim() เก็บงานต่อได้)
    .trim()
    .toUpperCase();
}

// ============================================================
// Panolyzer — เครื่องมิเรอร์มาจากแอป "Panolyzer Management" คนละระบบ (Google Apps Script Web App แยกต่างหาก,
// ดู Panolyzer-main/Google script ที่ห้ามแก้ไข) เข้า collection "panolyzer" ผ่าน syncPanolyzerNow/
// panolyzerScheduledSync ฝั่ง Cloud Functions — ไม่ใช่อุปกรณ์แบบ ASSET_CONFIG/VIEW_CONFIG ปกติ (C2-Loop ไม่ได้
// เป็นเจ้าของข้อมูลหลัก แค่มิเรอร์มาให้เบิก/ดูสถานะได้) จึงไม่เพิ่มเข้า VIEW_CONFIG (จะทำให้ปุ่มแก้ไข/ลบ/ย้าย-เคลม
// มาตรฐานโผล่ในตารางทั้งที่ backend ยังไม่รองรับอุปกรณ์ประเภทนี้) ใช้ค่าคงที่ชุดนี้ + ฟังก์ชันเฉพาะทางแทน
// ============================================================
const PANOLYZER_KEY = "panolyzer";
const PANOLYZER_ASSET_TYPE = "Panolyzer";
const PANOLYZER_SERIAL_FIELD = "S/N Analyzer";
const PANOLYZER_STOCK_FIELD = "Status"; // ค่า "Stock" ตรงกับ isStockRow() เดิมได้พอดี (เทียบแบบ case-insensitive)

/** เครื่อง Panolyzer แถวนี้อยู่ในสถานะ "Stock" (พร้อมเบิก) ตามข้อมูลมิเรอร์ล่าสุดหรือไม่ */
function isPanolyzerStockRow(row) {
  return String((row && row[PANOLYZER_STOCK_FIELD]) || "").trim().toLowerCase() === "stock";
}

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

    // สำคัญ: ต้อง sign in เข้า Firebase Auth ด้วย custom token ที่ backend ออกให้คู่กับ token ของแอปเอง
    // ก่อนแตะ Firestore listener ใดๆ ไม่งั้น firestore.rules (allow read: if request.auth != null) จะปฏิเสธหมด
    // เพราะ token ของแอปเอง (state.token) เป็นคนละระบบกับ Firebase Auth — ใช้คู่กันคนละหน้าที่ (state.token
    // ตรวจสอบสิทธิ์/role ฝั่ง Cloud Functions, Firebase custom token ใช้เปิดสิทธิ์อ่าน Firestore เท่านั้น)
    if (res.firebaseCustomToken) {
      await fbAuth.signInWithCustomToken(res.firebaseCustomToken);
    }

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
  const tokenToRevoke = state.token;
  stopPolling();
  detachFirestoreListeners();
  fbAuth.signOut().catch(() => {}); // เคลียร์ session ฝั่ง Firebase Auth ด้วย ไม่งั้น Firestore listener จะยังอ่านได้ต่อแม้ session ของแอปเองจะออกไปแล้ว
  // แจ้งเซิร์ฟเวอร์ให้ลบ session token ทิ้งจริง ไม่ใช่แค่ลบออกจากเบราว์เซอร์เครื่องนี้ (ป้องกัน token เก่าถูกใช้ต่อได้
  // จนกว่าจะหมดอายุ 8 ชั่วโมงเอง) — ยิงแบบ fire-and-forget ไม่ต้องรอผลลัพธ์ ไม่ให้การออกจากระบบช้าลงถ้าเน็ตมีปัญหา
  if (tokenToRevoke) {
    apiPost({ action: "logoutSession", token: tokenToRevoke }).catch(() => {});
  }
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
  issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [], isLoan: false };
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

  // Phase 18: ตั้งจุดฐาน (root) ของประวัติเบราว์เซอร์ไว้ที่หน้าแรกหลัง login — กด back จากจุดนี้ = ออกจากแอปตามปกติ
  try { history.replaceState({ __c2nav: true, view: state.currentView, home: state.mobileHomeVisible }, ""); } catch (e) {}
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
  updateSupplierClaimBadge();
}

/** เมนู "รอเคลมจาก Supplier" (Admin เท่านั้น) — badge นับจำนวนรวมทุกประเภทอุปกรณ์ (MoisturLyzer/Gateway/SimCard)
 * ที่อยู่ในสถานะ "อยู่ระหว่างเคลม" ตอนนี้ เรียกจุดเดียวกับ updatePendingBadge() ด้านบนเสมอ เพื่อให้อัปเดตพร้อมกัน
 * ทุกจังหวะที่ข้อมูลเปลี่ยน (real-time listener/refreshInBackground/หลังทำรายการต่างๆ) โดยไม่ต้องเพิ่มจุดเรียกใหม่ */
function updateSupplierClaimBadge() {
  const badge = document.getElementById("supplierClaimBadge");
  if (!badge) return;
  const count = getSupplierClaimRows().length;
  badge.style.display = count > 0 ? "inline-block" : "none";
  badge.textContent = count;
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
  _navPushCurrentState();
}

function hideMobileHome() {
  state.mobileHomeVisible = false;
  syncMobileHomeVisibility();
  _navPushCurrentState();
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
  { key: "panolyzer", label: "Panolyzer", icon: "fa-microscope", color: "mh-c10" },
  { key: "colorSorterParts", label: "อะไหล่ Color Sorter", icon: "fa-cogs", color: "mh-c5" },
  { key: "panolyzerParts", label: "อะไหล่ Panolyzer", icon: "fa-cogs", color: "mh-c6" },
  { key: "issue", label: "เบิกอุปกรณ์", icon: "fa-dolly", color: "mh-c7" },
  { key: "transferclaim", label: "ย้าย/เคลม", icon: "fa-exchange-alt", color: "mh-c4" },
  { key: "approvals", label: "อนุมัติการเบิก", icon: "fa-check-circle", color: "mh-c8", adminOnly: true, badge: true },
  { key: "history", label: "ประวัติเบิก/คืน", icon: "fa-history", color: "mh-c9" },
];
const MOBILE_HOME_ADMIN_TILES = [
  { key: "supplierclaim", label: "รอเคลมจาก Supplier", icon: "fa-truck-loading", color: "mh-c4", badge: true },
  { key: "users", label: "จัดการผู้ใช้งาน", icon: "fa-users-cog", color: "mh-c9" },
  { key: "manageparts", label: "จัดการ Stock/อะไหล่", icon: "fa-toolbox", color: "mh-c5" },
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
  const claimPending = getSupplierClaimRows().length;
  return { stock, used, pending, claimPending };
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
          <button class="mh-icon-btn" onclick="openChangePasswordModal()" title="เปลี่ยนรหัสผ่าน"><i class="fas fa-key"></i></button>
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
              ${t.badge && stats.claimPending > 0 ? `<span class="mh-tile-badge">${stats.claimPending}</span>` : ""}
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
    <div class="mh-tab-item ${active("transferclaim")}" onclick="switchView('transferclaim'); hideMobileHome();"><i class="fas fa-exchange-alt"></i><span>ย้าย/เคลม</span></div>
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

// ============================================================
// Firebase adapter (ย้ายระบบจาก Apps Script -> Firebase)
// apiPost() ยังคงชื่อ/พฤติกรรมภายนอกเดิมทุกอย่าง (รับ {action, token, ...} คืน {ok, ...}) เพื่อให้โค้ดส่วนที่เหลือ
// ทั้งไฟล์ (ฟอร์ม/ตาราง/ปุ่มกว่า 20 จุดที่เรียก apiPost อยู่แล้ว) ไม่ต้องแก้อะไรเลยสักบรรทัด — เปลี่ยนแค่ "ข้างใน"
// ให้ไปเรียก Cloud Functions (httpsCallable) แทนการยิง Apps Script Web App ตรงๆ
// ชื่อ action ทุกตัวที่ใช้อยู่ในไฟล์นี้ (login, requestIssuance, approveIssuance, ...) ตรงกับชื่อ Cloud Function
// ที่ deploy ไว้แล้วเป๊ะทุกตัว จึงเรียก httpsCallable(action) ได้ตรงๆ โดยไม่ต้องมีตาราง mapping ชื่อ
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyAEPgb8jWp9tyyUvLh7wDZYBmbgXZGUkcg",
  authDomain: "c2-loop.firebaseapp.com",
  projectId: "c2-loop",
  storageBucket: "c2-loop.firebasestorage.app",
  messagingSenderId: "656451347270",
  appId: "1:656451347270:web:c1d338601d0403fda33b47",
};
const FUNCTIONS_REGION = "asia-southeast1";

firebase.initializeApp(firebaseConfig);
const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
const fbFunctions = firebase.app().functions(FUNCTIONS_REGION);

async function apiGet() {
  // ของเดิมใช้ apiGet เฉพาะ action "checkVersion"/"getData" ซึ่งถูกแทนที่ด้วย Firestore real-time listener
  // (ดูฟังก์ชัน attachFirestoreListeners ด้านล่าง) ไปหมดแล้ว ไม่มีจุดไหนในไฟล์นี้เรียก apiGet อีกต่อไป
  // เหลือฟังก์ชันไว้เฉยๆ กันพังเงียบๆ ถ้ามีจุดที่ตกหล่นเรียกใช้อยู่ (จะได้เห็น error ชัดเจนแทน)
  console.warn("[apiGet] ฟังก์ชันนี้ถูกเลิกใช้แล้วหลังย้ายไป Firestore listener");
  return { ok: false, error: "deprecated_apiGet" };
}

async function apiPost(body) {
  showGlobalLoading();
  try {
    const { action, ...data } = body || {};
    if (!action) throw new Error("missing_action");
    const callable = fbFunctions.httpsCallable(action);
    const res = await callable(data);
    return res.data;
  } catch (err) {
    // ปกติ error จาก httpsCallable จะมี err.code เป็น "functions/xxx" (เช่น permission-denied, unauthenticated)
    // ต่างจาก error code ของแอปเอง (เช่น "invalid_credentials") ที่ฝังมาใน res.data.error ตอนเรียกสำเร็จ (ok:false)
    // ฟังก์ชันแสดงข้อความ error ต่างๆ ในไฟล์นี้ (เช่น loginErrorMessage) เช็คจาก res.error เป็น string เดิม จึงแปลง
    // err.code ให้เข้ารูปแบบเดียวกันตรงนี้ที่จุดเดียว ไม่ต้องแก้ทุกจุดที่เรียก apiPost
    console.error(`[apiPost] เรียก Cloud Function "${body && body.action}" ไม่สำเร็จ:`, err);
    if (err.code === "functions/unauthenticated") return { ok: false, error: "unauthorized" };
    if (err.code === "functions/permission-denied") return { ok: false, error: "forbidden" };
    return { ok: false, error: "network_error" };
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
// Sync: Firestore real-time listener (onSnapshot) แทนที่ polling ทุก 9 วินาทีของเดิมทั้งหมด
// ข้อมูลอัปเดตทันทีที่มีการเปลี่ยนแปลงจริง (ไม่ต้องรอรอบ poll) — นี่คือจุดที่แก้ปัญหา "Apps Script ทำงานช้า"
// ที่ต้นเหตุจริงๆ (เดิมโหลดทั้ง 9 ชีตใหม่ทุกครั้งที่ version เปลี่ยน ผ่าน Apps Script ที่ตอบช้า)
//
// เอกสารในคอลเลกชัน moisturlyzer/gateway/simcard เก็บชื่อคอลัมน์เดิมจากสเปรดชีตตรงๆ (จาก migrate.js)
// จึงใช้ข้อมูลตรงๆ ได้เลยไม่ต้องแปลง ส่วน issuanceLog/issuanceItems/partsCatalog/colorSorterPartUnits/
// panolyzerPartUnits/partsActivityLog ฝั่ง Cloud Functions เก็บเป็น camelCase (ดู functions/index.js) จึงต้อง
// แปลงชื่อฟิลด์กลับเป็น PascalCase แบบเดิมตรงนี้ เพื่อให้โค้ดแสดงผลที่เหลือทั้งไฟล์ (เขียนไว้ก่อนย้ายระบบ) ใช้งานได้
// โดยไม่ต้องแก้โค้ดจุดอื่นเลย — TransactionID/PartID/SerialNo (ของอะไหล่มี S/N) เดิมเป็น doc ID ใน Firestore
// ไม่ได้เก็บซ้ำเป็น field จึงต้องเติมจาก doc.id ตรงนี้ด้วย
// ============================================================
function translateIssuanceLog(doc) {
  const d = doc.data();
  return {
    TransactionID: doc.id,
    Timestamp: d.timestamp || "",
    CustomerName: d.customerName || "",
    SiteLocation: d.siteLocation || "",
    IssuedBy: d.issuedBy || "",
    Details: d.details || "",
    RequestStatus: d.requestStatus || "",
    ApprovedBy: d.approvedBy || "",
    ApprovedAt: d.approvedAt || "",
    ReturnedAt: d.returnedAt || "",
    IssuanceType: d.issuanceType || "เบิก",
    // ฟีเจอร์ "ย้าย/เคลม" — movementType ว่าง = รายการเบิก/คืนปกติ, "Transfer"/"Claim" = ย้าย/เคลม (ดู functions/index.js)
    MovementType: d.movementType || "",
    FromCustomer: d.fromCustomer || "",
    FromLocation: d.fromLocation || "",
    ClaimedSerial: d.claimedSerial || "",
    ReplacementSerial: d.replacementSerial || "",
    Resolution: d.resolution || "",
    ResolvedAt: d.resolvedAt || "",
    ResolvedBy: d.resolvedBy || "",
    // ฟีเจอร์ "ยกเลิกรายการ" — Admin ยกเลิกรายการที่ทำไปแล้ว (เบิก/ย้าย/เคลม) ระบบคืน status ให้อุปกรณ์อัตโนมัติ
    CancelledBy: d.cancelledBy || "",
    CancelledAt: d.cancelledAt || "",
  };
}

function translateIssuanceItem(doc) {
  const d = doc.data();
  return {
    TransactionID: d.transactionId || "",
    AssetType: d.assetType || "",
    SerialNo: d.serialNo || "",
    ConnectTo: d.connectTo || "",
    ConnectSerial: d.connectSerial || "",
    // เก็บไว้ตอนเบิกฝั่งเซิร์ฟเวอร์อยู่แล้ว (ดู index.js) แต่เดิมไม่เคยดึงมาที่ frontend เลย ทำให้ประวัติ/ใบเบิกของ
    // SimCard ที่เบิกคู่กับ MoisturLyzer/Gateway ไม่มีทางโชว์ได้เลยว่าเสียบอยู่ใน Gateway "ตัวไหน" จริงๆ (ConnectTo/
    // ConnectSerial ของเคสนั้นเก็บอุปกรณ์ปลายทาง เช่น MoisturLyzer/Panolyzer ไว้แทน ไม่ใช่ตัว Gateway) — ดู
    // formatConnectColumn/formatConnectInfo ที่ใช้ฟิลด์นี้เป็นตัวหลักสำหรับ SimCard โดยเฉพาะ
    InstalledGatewaySerial: d.installedGatewaySerial || "",
    PreviousStatus: d.previousStatus || "",
    NewLocation: d.newLocation || "",
    Quantity: d.quantity || 1,
    ItemName: d.itemName || "",
  };
}

function translatePartsCatalog(doc) {
  const d = doc.data();
  return {
    PartID: doc.id,
    PartName: d.partName || "",
    Category: d.category || "",
    HasSerial: d.hasSerial || "No",
    QuantityInStock: d.quantityInStock || 0,
    PhotoUrl: d.photoUrl || "", // เหลือไว้เผื่อข้อมูลเก่าก่อนแก้บัคความปลอดภัยรูปภาพ (ดู getPartPhotoUrl ฝั่ง backend) — ของใหม่จะว่างเสมอ
    PhotoPath: d.photoPath || "",
    HasPhoto: !!(d.photoPath || d.photoUrl),
  };
}

function translatePartUnit(doc) {
  const d = doc.data();
  return {
    PartID: d.partId || "",
    PartName: d.partName || "",
    SerialNo: doc.id,
    Customer_name: d.customerName || "",
    Location: d.location || "",
  };
}

function translatePartsActivityLog(doc) {
  const d = doc.data();
  return {
    Timestamp: d.timestamp || "",
    PartID: d.partId || "",
    PartName: d.partName || "",
    Category: d.category || "",
    Action: d.action || "",
    Actor: d.actor || "",
    Detail: d.detail || "",
  };
}

// moisturlyzer/gateway/simcard: ไม่ต้องแปลง (เก็บชื่อคอลัมน์เดิมจากสเปรดชีตตรงๆ อยู่แล้ว)
function translateRaw(doc) {
  return Object.assign({}, doc.data());
}

let firestoreListeners = []; // unsubscribe functions ของ onSnapshot ที่เปิดอยู่ตอนนี้ (เคลียร์ตอน logout)
let listenersReady = false;

function attachFirestoreListeners() {
  if (listenersReady) return;
  listenersReady = true;

  const bind = (collectionName, stateKey, translate) => {
    const unsub = fbDb.collection(collectionName).onSnapshot(
      (snap) => {
        state.data[stateKey] = snap.docs.map(translate);
        state.cachedAt = new Date().toISOString();
        try {
          localStorage.setItem(LS_CACHE, JSON.stringify({ data: state.data, cachedAt: state.cachedAt }));
        } catch (e) { /* เต็ม quota ก็ปล่อยผ่าน ไม่ใช่ปัญหาคอขวด */ }
        updatePendingBadge();
        renderCurrentView();
        setSyncStatus("online");
      },
      (err) => {
        // สาเหตุที่พบบ่อยที่สุด: permission-denied เพราะ Firebase Auth (custom token) ยังไม่พร้อมตอนแอตแทช
        // listener ครั้งแรก (จะหายเองอัตโนมัติทันทีที่ auth พร้อม เพราะ Firestore SDK re-auth listener เดิมให้)
        console.error(`[firestore listener] ${collectionName} error:`, err);
        setSyncStatus("offline");
      }
    );
    firestoreListeners.push(unsub);
  };

  bind("moisturlyzer", "moisturlyzer", translateRaw);
  bind("gateway", "gateway", translateRaw);
  bind("simcard", "simcard", translateRaw);
  bind("issuanceLog", "issuanceLog", translateIssuanceLog);
  bind("issuanceItems", "issuanceItems", translateIssuanceItem);
  bind("partsCatalog", "partsCatalog", translatePartsCatalog);
  bind("colorSorterPartUnits", "colorSorterParts", translatePartUnit);
  bind("panolyzerPartUnits", "panolyzerParts", translatePartUnit);
  bind("partsActivityLog", "partsActivityLog", translatePartsActivityLog);
  // Panolyzer (เครื่อง — ไม่ใช่อะไหล่): มิเรอร์มาจากชีต "Panolyzer Management" คนละระบบผ่าน syncPanolyzerNow/
  // panolyzerScheduledSync ฝั่ง Cloud Functions — เก็บชื่อคอลัมน์ดิบตามหัวชีตเป๊ะ (เช่น "S/N Analyzer",
  // "Client name") บวกฟิลด์ที่เป็นของ C2-Loop เองเพิ่มมา (linkedGatewaySerial/pendingSheetSync/...) จึงไม่ต้องแปลง
  bind("panolyzer", "panolyzer", translateRaw);
}

function detachFirestoreListeners() {
  firestoreListeners.forEach((unsub) => unsub());
  firestoreListeners = [];
  listenersReady = false;
}

// accounts (รายชื่อผู้ใช้งาน) ล็อกอ่านตรงจาก Firestore ไว้เสมอ (มี passwordHash/salt อยู่ข้างใน — ดู firestore.rules)
// จึงไม่มี real-time listener ให้ได้ ต้องขอผ่าน Cloud Function getUserList เป็นครั้งๆ ไป (เฉพาะ Admin เท่านั้น
// ที่มีสิทธิ์เรียก — ตรงกับที่หน้า renderUsersView ก็จำกัดไว้เฉพาะ Admin อยู่แล้วเช่นกัน)
async function refreshUsersList() {
  if (!state.user || state.user.role !== "Admin") return;
  try {
    // ตั้งใจไม่เรียกผ่าน apiPost() ตรงนี้ (เรียก httpsCallable ตรงๆ แทน) เพราะ apiPost ผูกกับ
    // showGlobalLoading()/hideGlobalLoading() ไว้ ถ้าเรียกผ่าน apiPost ทุก 9 วินาทีจากรอบ polling (ดู
    // startPolling ด้านล่าง) จะเห็นหน้าโหลดกระพริบเป็นช่วงๆ ทั้งที่ไม่มีอะไรผิดปกติ — ตรงกับที่คอมเมนต์เดิมของ
    // apiGet ในไฟล์นี้เตือนไว้ตั้งแต่แรกอยู่แล้ว ("ถ้าโชว์โอเวอร์เลย์ทุกรอบ poll จะกระพริบรำคาญโดยไม่มีประโยชน์")
    const res = await fbFunctions.httpsCallable("getUserList")({ token: state.token });
    if (res.data && res.data.ok) state.data.users = res.data.users || [];
  } catch (err) {
    console.error("refreshUsersList error:", err);
  }
}

async function refreshInBackground() {
  setSyncStatus("syncing");
  try {
    attachFirestoreListeners(); // idempotent — เปิด listener จริงแค่ครั้งแรกครั้งเดียวต่อ session
    await refreshUsersList();
    updatePendingBadge();
    renderCurrentView();
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

// เดิมฟังก์ชันนี้ตั้ง setInterval ไว้ยิง refreshInBackground ทุก 9 วินาที (การ "poll") — ตอนนี้ข้อมูลหลักทั้งหมด
// อัปเดตแบบ real-time ผ่าน Firestore listener แล้ว ไม่ต้อง poll อีกต่อไป เหลือไว้แค่ refresh รายชื่อผู้ใช้งานเป็น
// ระยะ (accounts อ่านตรงไม่ได้ ต้องผ่าน Cloud Function ดังนั้นจึงไม่มี real-time ให้ใช้) เผื่อ Admin คนอื่นแก้ไข
// ผู้ใช้งานจากเครื่องอื่นพร้อมกัน — คงชื่อฟังก์ชัน startPolling/stopPolling ไว้เหมือนเดิมเพราะมีเรียกใช้อยู่หลายจุด
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    // เดิมเรียก renderCurrentView() แบบไม่มีเงื่อนไขทุก 9 วินาที ทำให้ทุกหน้ารวมถึง Dashboard ถูกวาดใหม่ทั้งที่
    // ไม่มีอะไรเปลี่ยน — กราฟ Chart.js ที่ destroy+สร้างใหม่ทุกครั้งจึงดูเหมือน "รีเฟรชตลอดเวลา" ทั้งที่ข้อมูลจริง
    // (moisturlyzer/gateway/simcard/issuance ฯลฯ) อัปเดตแบบ real-time ผ่าน Firestore listener อยู่แล้วไม่ต้องพึ่ง
    // ตัวจับเวลานี้เลย ตัวจับเวลานี้มีไว้แค่ refresh รายชื่อผู้ใช้งาน (accounts อ่านตรงไม่ได้) จึงควรวาดหน้าจอใหม่
    // ก็ต่อเมื่อกำลังเปิดหน้า "จัดการผู้ใช้งาน" อยู่จริงเท่านั้น
    refreshUsersList().then(() => {
      if (state.currentView === "users") renderCurrentView();
    });
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
  _navPushCurrentState();
}

// ============================================================
// Phase 18: เชื่อมปุ่ม Back ของระบบ (มือถือ/เบราว์เซอร์) เข้ากับการเปลี่ยนหน้าในแอป
// หลักการ: ทุกครั้งที่เปลี่ยนหน้า (switchView) หรือสลับหน้าแรกแบบตารางไอคอนบนมือถือ (mobileHomeVisible)
// ให้บันทึกสถานะนั้นไว้ใน browser history ด้วย (pushState) ไม่ใช่แค่เปลี่ยน DOM เฉยๆ เหมือนเดิม
// แล้วดักฟัง popstate (ตอนกด back) เพื่อสั่งกลับไปหน้าที่บันทึกไว้ แทนที่จะปล่อยให้เบราว์เซอร์ปิดแอปไปเลย
// หมายเหตุ: รอบนี้ครอบคลุมเฉพาะการสลับ "หน้าหลัก" (เมนูซ้าย/หน้าแรกมือถือ) ยังไม่รวม modal ย่อยๆ
// (เช่น หน้าต่างยืนยัน/ฟอร์มแก้ไข/ประวัติอะไหล่) — ถ้าต้องการให้ back ปิด modal ทีละชั้นด้วย แจ้งเพิ่มได้
// ============================================================
let _navRestoring = false; // true ระหว่างกำลัง apply state จาก popstate (กันไม่ให้ pushState ซ้ำวนลูป)
let _navPushScheduled = false; // กันการ pushState ซ้ำหลายครั้งเวลามีการเรียก switchView()+hideMobileHome() ติดกันในคลิกเดียว

function _navPushCurrentState() {
  if (_navRestoring || !state.user || _navPushScheduled) return;
  _navPushScheduled = true;
  // เลื่อนไป push ใน microtask ถัดไป เพื่อรวมการเรียกซ้อนกันหลายครั้งในคลิกเดียว (เช่น switchView() ตามด้วย hideMobileHome())
  // ให้เหลือ pushState แค่ครั้งเดียวโดยอ้างอิงสถานะสุดท้ายจริงๆ ไม่งั้นกด back 1 ครั้งจะไม่ขยับเพราะติดสถานะกลางทาง
  Promise.resolve().then(() => {
    _navPushScheduled = false;
    if (_navRestoring || !state.user) return;
    try {
      history.pushState({ __c2nav: true, view: state.currentView, home: state.mobileHomeVisible }, "");
    } catch (e) {}
  });
}

window.addEventListener("popstate", (e) => {
  const s = e.state;
  if (!s || !s.__c2nav || !state.user) return; // ก่อน login/ไม่รู้จัก state นี้ ปล่อยให้เบราว์เซอร์ทำงานปกติ (เช่น ออกจากแอป)
  _navRestoring = true;
  state.currentView = s.view || "dashboard";
  state.mobileHomeVisible = !!s.home;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === state.currentView);
  });
  renderCurrentView();
  syncMobileHomeVisibility();
  syncMobileTabbar();
  _navRestoring = false;
});

/** ปุ่มลิงก์ในคอลัมน์ "เชื่อมต่อกับ"/badge อุปกรณ์เชื่อมโยง — พาไปหน้าของอุปกรณ์ปลายทางแล้วกรองรายการเหลือแค่
 * ตัวนั้นตัวเดียวผ่านช่องค้นหาของหน้านั้น (ไม่ใช่การเปิดฟอร์มแก้ไขตรงๆ เพื่อให้เห็นบริบทแถวเต็มๆ ก่อน) — ต้อง
 * สลับหน้าด้วย switchView ให้เสร็จก่อน (synchronous) ค่อยไปยุ่งกับช่องค้นหา เพราะ DOM ของหน้านั้นเพิ่งถูกสร้างตอน
 * switchView เรียก renderCurrentView() ข้างใน */
function goToLinkedAsset(viewKey, serial) {
  switchView(viewKey);
  if (viewKey === "panolyzer") {
    const searchEl = document.getElementById("panoSearchBox");
    const statusEl = document.getElementById("panoStatusFilter");
    if (statusEl) statusEl.value = "all"; // กันแถวที่ไม่ใช่ Stock ถูกกรองซ่อนไปโดยไม่ได้ตั้งใจ
    if (searchEl) {
      searchEl.value = serial;
      renderPanolyzerRows();
    }
  } else {
    const searchEl = document.getElementById("searchBox");
    const statusEl = document.getElementById("statusFilter");
    if (statusEl) statusEl.value = "all";
    if (searchEl) {
      searchEl.value = serial;
      // มี listener ผูก "input" ไว้อยู่แล้วที่ re-render ตาราง/การ์ดของหน้านั้น (ดู renderListView) — ใช้ dispatch
      // แทนเรียก render ตรงๆ เพราะฟังก์ชัน render (renderRows) ต้องการ cfg/rows/isAdmin ที่ผูกไว้ใน closure ของ listener นั้นอยู่แล้ว
      searchEl.dispatchEvent(new Event("input"));
    }
  }
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
  } else if (state.currentView === "transferclaim") {
    titleEl.textContent = "ย้าย/เคลม";
    renderTransferClaimSearchView();
  } else if (state.currentView === "history") {
    titleEl.textContent = "ประวัติการเบิก/คืน";
    renderHistoryView();
  } else if (state.currentView === "users") {
    titleEl.textContent = "จัดการผู้ใช้งาน";
    renderUsersView();
  } else if (state.currentView === "manageparts") {
    titleEl.textContent = "จัดการ Stock/อะไหล่";
    renderManagePartsView();
  } else if (state.currentView === "supplierclaim") {
    titleEl.textContent = "รอเคลมจาก Supplier";
    renderSupplierClaimView();
  } else if (state.currentView === "panolyzer") {
    titleEl.textContent = "Panolyzer";
    renderPanolyzerView();
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

/** ฟีเจอร์ "ย้าย/เคลม" — เช็คว่าอุปกรณ์แถวนี้อยู่ในสถานะ "อยู่ระหว่างเคลม"/"ตัดจำหน่าย" หรือไม่ (ดูค่าคงที่ด้านบน) */
function isClaimedRow(row, cfg) {
  return String(row[cfg.stockField] || "").trim() === CLAIM_STOCK_VALUE;
}
function isWrittenOffRow(row, cfg) {
  return String(row[cfg.stockField] || "").trim() === WRITEOFF_STOCK_VALUE;
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

// Phase 17: รวมอะไหล่ทุกชื่อ (ทั้งแบบมี S/N และแบบนับจำนวน) ของหมวดหนึ่ง เป็นรายการเดียว เรียงจากเหลือน้อยสุดก่อน
// ใช้แทนตัวเลขรวมก้อนเดียวเดิมบน Dashboard (ซึ่งปนทุกชื่อเข้าด้วยกันและไม่รวมอะไหล่แบบนับจำนวนเลย)
function computePartsBreakdown(viewKey) {
  const cfg = VIEW_CONFIG[viewKey];
  const category = PART_CATEGORY_BY_VIEW[viewKey];

  // อะไหล่แบบนับจำนวน (ไม่มี S/N) — เอายอดคงเหลือจาก PartsCatalog ตรงๆ
  const qtyItems = getQtyPartsForCategory(category).map((p) => ({
    name: p.PartName, type: "qty", stock: Number(p.QuantityInStock) || 0, used: null,
  }));

  // อะไหล่แบบมี S/N — รวมรายชิ้นจาก state.data[cfg.key] เป็นยอดต่อชื่ออะไหล่ (คงเหลือ/เบิกแล้ว)
  const grouped = {};
  (state.data[cfg.key] || []).forEach((r) => {
    const name = r.PartName;
    if (!name) return;
    if (!grouped[name]) grouped[name] = { name, type: "serial", stock: 0, used: 0 };
    if (isStockRow(r, cfg.stockField, cfg.stockRequiresField)) grouped[name].stock++;
    else grouped[name].used++;
  });
  const serialItems = Object.values(grouped);

  return [...qtyItems, ...serialItems].sort((a, b) => a.stock - b.stock);
}

/** สร้าง HTML ของรายการอะไหล่ทุกชื่อในหมวดหนึ่ง สำหรับใส่ในการ์ด Dashboard (แทนตัวเลขรวมก้อนเดียว) */
function partsBreakdownListHtml(items) {
  if (!items.length) return `<div class="parts-empty-note">ยังไม่มีอะไหล่ในหมวดนี้</div>`;
  return `<div class="parts-list">${items.map((p) => `
    <div class="part-row">
      <div class="part-name">
        <span class="part-name-text">${escapeHtml(p.name)}</span>
        <span class="part-type-tag">${p.type === "serial" ? "มี S/N" : "นับจำนวน"}</span>
      </div>
      <div class="part-stock">
        <span class="part-stock-num ${p.stock <= LOW_STOCK_THRESHOLD ? "low" : ""}">${p.stock}</span>
        <div class="part-stock-sub">${p.type === "serial" ? "คงเหลือ · เบิกแล้ว " + p.used : "คงเหลือ"}</div>
      </div>
    </div>`).join("")}</div>`;
}

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

  // Phase 17: รวมของใกล้หมด/หมดจากทุกหมวดอะไหล่ (ชื่อละหลายชิ้น) มาเตือนไว้บนสุด เพราะซ่อนอยู่ในรายการ scroll ของแต่ละการ์ด
  const allPartsLow = Object.keys(PART_CATEGORY_BY_VIEW)
    .flatMap((viewKey) => computePartsBreakdown(viewKey))
    .filter((p) => p.stock <= LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.stock - b.stock);
  const lowStockBannerHtml = allPartsLow.length
    ? `<div class="lowstock-strip no-print">
        <div class="lowstock-dot"></div>
        <div class="lowstock-text">
          <b>ของใกล้หมด (≤ ${LOW_STOCK_THRESHOLD} ชิ้น)</b><br>
          ${allPartsLow.map((p) => `<span class="lowstock-chip">${escapeHtml(p.name)} <b>${p.stock}</b> ชิ้น</span>`).join("")}
        </div>
      </div>`
    : "";

  let html = `
    <div class="dashboard-actions no-print">
      <button class="btn-secondary" onclick="printDashboard()"><i class="fas fa-print"></i> พิมพ์รายงาน</button>
      <button class="btn-secondary" onclick="generateReportImage(this)"><i class="fas fa-camera"></i> สร้างรูปรายงาน (สำหรับส่ง LINE)</button>
    </div>
    ${lowStockBannerHtml}
    <div id="dashboardReportArea" class="report-doc">
      ${reportHeaderHtml("รายงานสรุปคลังอุปกรณ์", "Equipment Inventory Summary Report", "วันที่ออกรายงาน", formatDateTh(new Date().toISOString()))}
      <div class="kpi-grid">`;
  summaries.forEach(({ cfg, summary }) => {
    // Phase 17: หมวดอะไหล่ (Color Sorter / Panolyzer) — แสดงรายชื่ออะไหล่ทุกชื่อในการ์ด แทนตัวเลขรวมก้อนเดียว
    if (PART_CATEGORY_BY_VIEW[cfg.key]) {
      const items = computePartsBreakdown(cfg.key);
      html += `
      <div class="kpi-card">
        <div class="kpi-card-title with-count">
          <span>${escapeHtml(cfg.title.replace(" (มี S/N)", ""))}</span>
          <span class="parts-count-pill">${items.length} รายชื่อ</span>
        </div>
        ${partsBreakdownListHtml(items)}
      </div>`;
      return;
    }
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

/** พิมพ์ใบตามประเภทธุรกรรม — เบิกปกติ/ย้าย/เคลม ใช้ปุ่มเดิมปุ่มเดียว ระบบเลือกฟอร์มให้อัตโนมัติตาม MovementType
 * (ฟีเจอร์ "ย้าย/เคลม" — ใบย้าย/ใบเคลมออกแบบใหม่แยกจากใบเบิกเดิมทั้งหมด ตามที่ผู้ใช้ขอ ไม่ใช้โครงใบเบิกซ้ำ) */
function printSlip(transactionId) {
  const txn0 = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (txn0 && txn0.MovementType === "Transfer") return printTransferSlip(transactionId);
  if (txn0 && txn0.MovementType === "Claim") return printClaimSlip(transactionId);
  return printIssuanceSlip(transactionId);
}

/** อุปกรณ์แบบมี S/N จริงที่ควรโชว์ในคอลัมน์ Serial ของใบเบิก — ไม่นับอะไหล่แบบนับจำนวน (SerialNo เป็น PartID ภายใน
 * ไม่ใช่ S/N จริง) และไม่นับของนอกระบบ (Other, ไม่มี Serial เลย) */
function itemHasRealSerial(item) {
  return !PART_QTY_DEVICE_LABEL[item.AssetType] && item.AssetType !== "Other" && !!String(item.SerialNo || "").trim();
}

/** สร้างตารางรายการของใบเบิก (colgroup + thead + tbody) แบบซ่อนคอลัมน์อัตโนมัติ — เช็คระดับ "ทั้งใบเบิก" ไม่ใช่ทีละแถว:
 * คอลัมน์ Serial โชว์ก็ต่อเมื่อมีอย่างน้อย 1 รายการที่มี S/N จริง (ดู itemHasRealSerial), คอลัมน์ "นำไปใส่อุปกรณ์ไหน"
 * โชว์ก็ต่อเมื่อมีอย่างน้อย 1 รายการที่ระบุ ConnectTo ไว้ ถ้าใบเบิกนั้นไม่มีรายการไหนมีข้อมูลคอลัมน์ใดเลย ให้ตัด
 * คอลัมน์นั้นทิ้งทั้งตารางแทนที่จะโชว์ "-"/"—" เกะกะไปเปล่าๆ — คอลัมน์ #, ประเภทอุปกรณ์, จำนวน อยู่เสมอทุกกรณี */
function buildIssuanceSlipTable(items) {
  const hasSerial = items.some(itemHasRealSerial);
  const hasConnect = items.some((i) => !!i.ConnectTo);

  const cols = [
    { key: "no", label: "#", cls: "slip-col-no" },
    { key: "type", label: "ประเภทอุปกรณ์", cls: "slip-col-type" },
    ...(hasSerial ? [{ key: "serial", label: "Serial", cls: "slip-col-serial" }] : []),
    ...(hasConnect ? [{ key: "connect", label: "นำไปใส่อุปกรณ์ไหน", cls: "slip-col-connect" }] : []),
    { key: "qty", label: "จำนวน", cls: "slip-col-qty" },
  ];

  const colgroup = cols.map((c) => `<col class="${c.cls}">`).join("");
  const thead = cols.map((c) => `<th>${c.label}</th>`).join("");
  const rows = items.map((item, idx) => {
    const cells = cols.map((c) => {
      if (c.key === "no") return `<td>${idx + 1}</td>`;
      if (c.key === "type") return `<td>${formatItemLabel(item, { withQty: false })}</td>`;
      if (c.key === "serial") return `<td>${formatItemSerialLabel(item)}</td>`;
      if (c.key === "connect") return `<td>${formatConnectColumn(item)}</td>`;
      if (c.key === "qty") return `<td>${escapeHtml(String(item.AssetType === "Other" || PART_QTY_DEVICE_LABEL[item.AssetType] ? (Number(item.Quantity) || 1) : 1))}</td>`;
      return "<td></td>";
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `
    <table class="slip-table">
      <colgroup>${colgroup}</colgroup>
      <thead><tr>${thead}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function printIssuanceSlip(transactionId) {
  const txn = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (!txn) return;
  const items = getItemsForTransaction(transactionId);
  const statusLabel = { PendingApproval: "รออนุมัติ", Issued: "เบิกแล้ว", Rejected: "ถูกปฏิเสธ", Returned: "คืนแล้ว", Cancelled: "ยกเลิกแล้ว" };

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
          <tr><th>สถานะ</th><td>${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}${txn.IssuanceType === "ยืม" ? ` <span class="status-badge status-loan" style="margin-left:6px;">ยืม</span>` : ""}</td></tr>
        </table>
      </div>

      ${buildIssuanceSlipTable(items)}
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
          <div class="signature-role">ผู้รับของ</div>
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
  printAfterImagesLoad(document.getElementById("printSlipRoot"));
}

/** หา VIEW_CONFIG ที่ตรงกับ AssetType จริง (เช่น "MoisturLyzer") — ใช้แทนการเดา key จาก AssetType ตรงๆ
 * เพราะ key ใน VIEW_CONFIG เป็นตัวพิมพ์เล็กล้วน ("moisturlyzer") ไม่ตรงกับการทำตัวแรกเป็นพิมพ์เล็กเฉยๆ */
function viewConfigByAssetType(assetType) {
  return Object.values(VIEW_CONFIG).find((c) => c.assetType === assetType);
}

/** ใบย้ายอุปกรณ์ — ฟอร์มใหม่ (สีฟ้า) เน้นบล็อก "ย้ายจาก → ย้ายไปที่" ให้เห็นชัดว่าอุปกรณ์ย้ายจากลูกค้า/ไซต์ไหนไปไหน */
function printTransferSlip(transactionId) {
  const txn = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (!txn) return;
  const items = getItemsForTransaction(transactionId);
  const item = items[0];
  const statusLabel = { PendingApproval: "รออนุมัติ", Issued: "ย้ายแล้ว", Rejected: "ถูกปฏิเสธ", Cancelled: "ยกเลิกแล้ว" };
  const assetLabel = item ? `${escapeHtml(viewConfigByAssetType(item.AssetType)?.title || item.AssetType)} — ${escapeHtml(item.SerialNo)}` : "-";
  const connectLine = item && item.ConnectSerial
    ? `<div class="formal-field"><span class="formal-field-label">เชื่อมต่อกับ</span><span class="formal-field-value">${escapeHtml(item.ConnectTo || "")} — ${escapeHtml(item.ConnectSerial)} (ย้ายตามไปด้วย)</span></div>`
    : "";

  const html = `
    <div class="print-slip report-doc formal-doc formal-transfer">
      <div class="formal-page-tag">C2-LOOP</div>
      <div class="formal-header">
        <img src="assets/c2tech-logo.png" class="formal-logo" alt="C2TECH">
        <div class="formal-company">
          <div class="formal-company-name">บริษัท ซีทูเทค จำกัด</div>
          <div class="formal-company-sub">C2 Tech Company Limited</div>
          <div class="formal-company-addr">99/3 หมู่ 9 ต.วังไก่เถื่อน อ.หันคา จ.ชัยนาท 17130 · 063-929-1999, 064-654-5636</div>
        </div>
      </div>
      <div class="formal-doctitle">ใบย้ายอุปกรณ์ <span class="formal-doctitle-en">Equipment Transfer Form</span></div>

      <div class="formal-toprow">
        <div class="formal-toprow-left">
          <div class="formal-field"><span class="formal-field-label">อุปกรณ์</span><span class="formal-field-value">${assetLabel}</span></div>
          ${connectLine}
        </div>
        <table class="formal-docinfo">
          <tr><th>เลขที่เอกสาร</th><td>${escapeHtml(txn.TransactionID)}</td></tr>
          <tr><th>วันที่เอกสาร</th><td>${escapeHtml(formatDateTh(txn.Timestamp))}</td></tr>
          <tr><th>สถานะ</th><td>${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}</td></tr>
        </table>
      </div>

      <div class="formal-swap-row">
        <div class="formal-swap-box out">
          <div class="formal-swap-label">ย้ายจาก (เดิม)</div>
          <div class="formal-swap-value">${escapeHtml(txn.FromCustomer || "-")}</div>
          <div class="formal-swap-sub">${escapeHtml(txn.FromLocation || "-")}</div>
        </div>
        <div class="formal-swap-arrow">➜</div>
        <div class="formal-swap-box in">
          <div class="formal-swap-label">ย้ายไปที่ (ใหม่)</div>
          <div class="formal-swap-value">${escapeHtml(txn.CustomerName || "-")}</div>
          <div class="formal-swap-sub">${escapeHtml(txn.SiteLocation || "-")}</div>
        </div>
      </div>

      ${txn.Details ? `<div class="formal-reason-box"><b>หมายเหตุ:</b> ${escapeHtml(txn.Details)}</div>` : ""}
      <div class="formal-field" style="margin-bottom:16px;"><span class="formal-field-label">ผู้แจ้งคำขอ</span><span class="formal-field-value">${escapeHtml(txn.IssuedBy || "-")}${txn.ApprovedBy ? ` &nbsp;|&nbsp; อนุมัติโดย: ${escapeHtml(txn.ApprovedBy)}` : ""}</span></div>

      <div class="signature-row">
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ผู้ดำเนินการย้าย</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ลูกค้าปลายทางผู้รับเครื่อง</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
      </div>
    </div>
  `;

  if (isInIframe()) { printSlipViaPopup(html); return; }
  document.getElementById("printSlipRoot").innerHTML = html;
  document.body.classList.add("print-slip-active");
  printAfterImagesLoad(document.getElementById("printSlipRoot"));
}

/** ใบเคลม — ฟอร์มใหม่ (สีส้ม) เน้นบล็อก "เครื่องเดิม (ถอดออก) ⇄ เครื่องทดแทน (ให้ใหม่)" คู่กันชัดเจน */
function printClaimSlip(transactionId) {
  const txn = (state.data.issuanceLog || []).find((t) => t.TransactionID === transactionId);
  if (!txn) return;
  const items = getItemsForTransaction(transactionId);
  const outItem = items.find((i) => i.SerialNo === txn.ClaimedSerial) || items[0];
  const inItem = items.find((i) => i.SerialNo === txn.ReplacementSerial);
  const statusLabel = { PendingApproval: "รออนุมัติ", Issued: "เคลมแล้ว", Rejected: "ถูกปฏิเสธ", Cancelled: "ยกเลิกแล้ว" };
  const typeLabel = (assetType) => (assetType ? (viewConfigByAssetType(assetType)?.title || assetType) : "-");

  const html = `
    <div class="print-slip report-doc formal-doc formal-claim">
      <div class="formal-page-tag">C2-LOOP</div>
      <div class="formal-header">
        <img src="assets/c2tech-logo.png" class="formal-logo" alt="C2TECH">
        <div class="formal-company">
          <div class="formal-company-name">บริษัท ซีทูเทค จำกัด</div>
          <div class="formal-company-sub">C2 Tech Company Limited</div>
          <div class="formal-company-addr">99/3 หมู่ 9 ต.วังไก่เถื่อน อ.หันคา จ.ชัยนาท 17130 · 063-929-1999, 064-654-5636</div>
        </div>
      </div>
      <div class="formal-doctitle">ใบเคลมอุปกรณ์ <span class="formal-doctitle-en">Equipment Claim Form</span></div>

      <div class="formal-toprow">
        <div class="formal-toprow-left">
          <div class="formal-field"><span class="formal-field-label">ลูกค้า</span><span class="formal-field-value">${escapeHtml(txn.CustomerName || "-")}</span></div>
          <div class="formal-field"><span class="formal-field-label">สถานที่ติดตั้ง</span><span class="formal-field-value">${escapeHtml(txn.SiteLocation || "-")}</span></div>
        </div>
        <table class="formal-docinfo">
          <tr><th>เลขที่เอกสาร</th><td>${escapeHtml(txn.TransactionID)}</td></tr>
          <tr><th>วันที่เอกสาร</th><td>${escapeHtml(formatDateTh(txn.Timestamp))}</td></tr>
          <tr><th>สถานะ</th><td>${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}</td></tr>
        </table>
      </div>

      <div class="formal-swap-row">
        <div class="formal-swap-box out">
          <div class="formal-swap-label">เครื่องเดิม (ถอดออก)</div>
          <div class="formal-swap-value">${escapeHtml(typeLabel(outItem && outItem.AssetType))} — ${escapeHtml(txn.ClaimedSerial || "-")}</div>
        </div>
        <div class="formal-swap-arrow">⇄</div>
        <div class="formal-swap-box in">
          <div class="formal-swap-label">เครื่องทดแทน (ให้ใหม่)</div>
          <div class="formal-swap-value">${txn.ReplacementSerial ? `${escapeHtml(typeLabel(inItem && inItem.AssetType))} — ${escapeHtml(txn.ReplacementSerial)}` : "(ยังไม่เลือกเครื่องทดแทน)"}</div>
        </div>
      </div>

      ${txn.Details ? `<div class="formal-reason-box"><b>เหตุผลที่เคลม:</b> ${escapeHtml(txn.Details)}</div>` : ""}
      <div class="formal-field" style="margin-bottom:16px;"><span class="formal-field-label">ผู้แจ้งคำขอ</span><span class="formal-field-value">${escapeHtml(txn.IssuedBy || "-")}${txn.ApprovedBy ? ` &nbsp;|&nbsp; อนุมัติโดย: ${escapeHtml(txn.ApprovedBy)}` : ""}</span></div>

      <div class="signature-row">
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ผู้ส่งมอบเครื่องทดแทน</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-role">ลูกค้าผู้รับเครื่องทดแทน</div>
          <div class="signature-date">วันที่ ______/______/________</div>
        </div>
      </div>
    </div>
  `;

  if (isInIframe()) { printSlipViaPopup(html); return; }
  document.getElementById("printSlipRoot").innerHTML = html;
  document.body.classList.add("print-slip-active");
  printAfterImagesLoad(document.getElementById("printSlipRoot"));
}

/**
 * Phase 17: แก้ปัญหาโลโก้หายตอนสั่งพิมพ์ครั้งแรก — สาเหตุคือ <img> ของโลโก้เพิ่งถูกใส่เข้า DOM ผ่าน
 * innerHTML ก่อนหน้านี้เพียงเสี้ยววินาที แล้วเรียก window.print() ทันที โดยที่รูปยังโหลดไม่เสร็จ (โดยเฉพาะ
 * ครั้งแรกที่เปิดแอปที่เบราว์เซอร์ยังไม่เคย cache รูปนี้ไว้) พอถึงจังหวะที่เบราว์เซอร์ capture หน้าไปพิมพ์
 * รูปเลยยังไม่มา — ครั้งต่อๆ ไปรูปถูก cache ไว้แล้วเลยโหลดทันจนดูเหมือนไม่มีปัญหา ทางแก้คือรอให้ <img>
 * ทุกตัวในใบเบิก โหลดเสร็จ (หรือ error ก็ไม่เป็นไร ไม่ให้ค้าง) ก่อนค่อยเรียก window.print() จริง
 */
function printAfterImagesLoad(container) {
  const imgs = Array.from(container.querySelectorAll("img"));
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    window.print();
  };
  const pending = imgs.filter((img) => !img.complete);
  if (!pending.length) { doPrint(); return; }
  let remaining = pending.length;
  pending.forEach((img) => {
    const markDone = () => { remaining -= 1; if (remaining <= 0) doPrint(); };
    img.addEventListener("load", markDone, { once: true });
    img.addEventListener("error", markDone, { once: true });
  });
  // กันเหนียว — เผื่อโหลดรูปไม่สำเร็จ/ช้าผิดปกติ ไม่ให้ผู้ใช้กดพิมพ์ไม่ได้เลย
  setTimeout(doPrint, 1500);
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
    // Phase 17: รอให้โลโก้ในหน้าต่าง popup โหลดเสร็จก่อนสั่งพิมพ์ กันปัญหาเดียวกับ printSlip() หลัก
    // (รูปยังโหลดไม่เสร็จตอน capture พิมพ์ครั้งแรกที่ยังไม่มี cache)
    const imgs = Array.from(popup.document.querySelectorAll("img"));
    let printed = false;
    const doPrint = () => { if (printed) return; printed = true; popup.print(); };
    const pending = imgs.filter((img) => !img.complete);
    if (!pending.length) { doPrint(); return; }
    let remaining = pending.length;
    pending.forEach((img) => {
      const markDone = () => { remaining -= 1; if (remaining <= 0) doPrint(); };
      img.addEventListener("load", markDone, { once: true });
      img.addEventListener("error", markDone, { once: true });
    });
    setTimeout(doPrint, 1500);
  }, 300);
}

window.addEventListener("afterprint", () => {
  document.body.classList.remove("print-dashboard-active", "print-slip-active", "print-label-active");
  document.getElementById("printSlipRoot").innerHTML = "";
  document.getElementById("printLabelRoot").innerHTML = "";
  removeLabelPageStyle();
});

// ============================================================
// Phase 21: พิมพ์ป้ายติดเครื่อง Gateway — ป้ายขนาด 90×50มม. (เท่านามบัตร) โชว์ S/N Gateway ตัวใหญ่สุด, S/N
// อุปกรณ์ปลายทางที่เชื่อมต่อ (MoisturLyzer/Panolyzer ฯลฯ — ใช้เฉพาะค่ายืนยันแล้วเท่านั้น ไม่ใช้ค่าที่ระบบ "เดา"
// ไว้ กันป้ายพิมพ์ข้อมูลผิด), S/N ซิม+เบอร์โทรที่ใส่อยู่ และชื่อลูกค้า/สถานที่ตัวเล็กมุมล่าง
// ============================================================

/** สร้าง HTML ของป้าย 1 ใบจากแถว Gateway — คืน { html } ถ้าพิมพ์ได้ปกติ หรือ { error } ถ้าต้องให้ผู้ใช้ไปยืนยัน
 * ข้อมูลก่อน (กรณี S/N อุปกรณ์ปลายทางมีแต่ค่าที่ระบบเดาไว้ ยังไม่ได้กรอก/ยืนยันจริง) */
function buildGatewayLabelHtml(row, logoHref) {
  const cfg = VIEW_CONFIG.gateway;
  const gwSerial = String(row[cfg.serialField] || "");
  const model = String(row.Model || "");
  const customer = String(row.Customer_name || "").trim();
  const location = String(row.Location || "").trim();

  const confirmedDevice = String(row[cfg.deviceSerialField] || "").trim();
  let deviceLine = "";
  if (confirmedDevice) {
    const deviceType = String(row[cfg.connectField] || "").trim() || "อุปกรณ์ปลายทาง";
    deviceLine = `<div class="gwl-row"><span class="k">${escapeHtml(deviceType)} S/N</span><span class="v">${escapeHtml(confirmedDevice)}</span></div>`;
  } else {
    const guessed = computeGatewayLinkedMoisturlyzer(row);
    if (guessed.length && guessed[0] && typeof guessed[0] === "object" && guessed[0].guessed) {
      return { error: "ช่อง \"S/N อุปกรณ์ปลายทาง\" ของ Gateway เครื่องนี้ยังไม่ได้ยืนยัน (ระบบเดาไว้จากลูกค้า/สถานที่ที่ตรงกันเท่านั้น) กรุณากดแก้ไขแล้วกรอก/ยืนยันค่านี้ก่อนพิมพ์ป้าย กันป้ายพิมพ์ข้อมูลผิด" };
    }
  }

  const simSerial = String(row.SimCard_SN || "").trim();
  let simLine = "";
  if (simSerial) {
    const simRow = (state.data.simcard || []).find((s) => String(s["S/N"] || "") === simSerial);
    const mobileNo = simRow ? String(simRow["Mobile No."] || "").trim() : "";
    simLine = `<div class="gwl-row"><span class="k">SIM S/N</span><span class="v">${escapeHtml(simSerial)}</span></div>`
      + (mobileNo ? `<div class="gwl-row"><span class="k">เบอร์ซิม</span><span class="v">${escapeHtml(mobileNo)}</span></div>` : "");
  }

  const html = `
    <div class="gwl-card">
      <div class="gwl-topline">
        <img src="${escapeAttr(logoHref)}" class="gwl-logo" alt="C2TECH">
        <span class="gwl-tag">GATEWAY</span>
      </div>
      <div class="gwl-model">${escapeHtml(model)}</div>
      <div class="gwl-sn-main">${escapeHtml(gwSerial)}</div>
      <div class="gwl-divider"></div>
      ${deviceLine}
      ${simLine}
      ${(!deviceLine && !simLine) ? `<div class="gwl-row"><span class="k">สถานะ</span><span class="v">ยังไม่เชื่อมต่ออุปกรณ์/ซิม</span></div>` : ""}
      <div class="gwl-footer">
        <div class="cust">${customer ? `<b>${escapeHtml(customer)}</b>` : ""}${escapeHtml(location)}</div>
      </div>
    </div>
  `;
  return { html };
}

function injectLabelPageStyle() {
  removeLabelPageStyle();
  const style = document.createElement("style");
  style.id = "labelPrintPageStyle";
  style.textContent = "@page { size: 90mm 50mm; margin: 0; }";
  document.head.appendChild(style);
}
function removeLabelPageStyle() {
  const el = document.getElementById("labelPrintPageStyle");
  if (el) el.remove();
}

function printGatewayLabel(serial) {
  const cfg = VIEW_CONFIG.gateway;
  const row = (state.data.gateway || []).find((r) => String(r[cfg.serialField]) === String(serial));
  if (!row) return;
  const logoHref = new URL("assets/c2tech-logo.png", window.location.href).href;
  const result = buildGatewayLabelHtml(row, logoHref);
  if (result.error) {
    showAlert(result.error, "error");
    return;
  }
  if (isInIframe()) { printGatewayLabelViaPopup(result.html); return; }
  document.getElementById("printLabelRoot").innerHTML = result.html;
  document.body.classList.add("print-label-active");
  injectLabelPageStyle();
  printAfterImagesLoad(document.getElementById("printLabelRoot"));
}

/** ทางเลือกสำรองสำหรับตอนแอปถูกฝังใน iframe — เปิดหน้าต่างใหม่พร้อม @page ของตัวเอง ไม่กระทบขนาดกระดาษของ
 * การพิมพ์แบบอื่นในหน้าต่างหลัก */
function printGatewayLabelViaPopup(html) {
  const popup = window.open("", "_blank");
  if (!popup) {
    showAlert("เบราว์เซอร์บล็อกการเปิดหน้าต่างใหม่ กรุณาอนุญาต Pop-up สำหรับเว็บไซต์นี้แล้วลองอีกครั้ง", "error");
    return;
  }
  const styleHref = new URL("style.css", window.location.href).href;
  popup.document.write(`<!DOCTYPE html><html><head><title>ป้าย Gateway</title><link rel="stylesheet" href="${styleHref}"><style>@page { size: 90mm 50mm; margin: 0; } body{margin:0;}</style></head><body class="print-label-active"><div id="printLabelRoot">${html}</div></body></html>`);
  popup.document.close();
  setTimeout(() => {
    popup.focus();
    const imgs = Array.from(popup.document.querySelectorAll("img"));
    let printed = false;
    const doPrint = () => { if (printed) return; printed = true; popup.print(); };
    const pending = imgs.filter((img) => !img.complete);
    if (!pending.length) { doPrint(); return; }
    let remaining = pending.length;
    pending.forEach((img) => {
      const markDone = () => { remaining -= 1; if (remaining <= 0) doPrint(); };
      img.addEventListener("load", markDone, { once: true });
      img.addEventListener("error", markDone, { once: true });
    });
    setTimeout(doPrint, 1500);
  }, 300);
}

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
// เก็บค่าช่องค้นหา/ตัวกรองสถานะไว้ข้ามการ render (คั่นตาม key ของแต่ละหน้า) เพราะเดิม input/select ถูกสร้างใหม่
// ทุกครั้งที่ renderListView/renderPartsListView ทำงาน (เช่นหลังกดแก้ไข+บันทึกแล้วเรียก renderCurrentView() ใหม่)
// ทำให้ค่าที่ผู้ใช้กรอกไว้หายไปต้อง filter หาใหม่ทุกครั้ง — ตอนนี้จำค่าไว้ใน object นี้แล้ว restore กลับเข้า
// input/select ทุกครั้งที่ render ใหม่แทน
const listViewFilters = {}; // { [filterKey]: { search: string, status: string } }

function getListViewFilterState(filterKey) {
  return listViewFilters[filterKey] || { search: "", status: "all" };
}

function saveListViewFilterState(filterKey) {
  const searchEl = document.getElementById("searchBox");
  const statusEl = document.getElementById("statusFilter");
  listViewFilters[filterKey] = {
    search: searchEl ? searchEl.value : "",
    status: statusEl ? statusEl.value : "all",
  };
}

// ============================================================
// Panolyzer — หน้ารายการ (read-mostly): มิเรอร์จากชีต Panolyzer Management ผ่าน Cloud Functions เท่านั้น
// ไม่มีปุ่มแก้ไข/ลบ/ย้าย-เคลมแบบมาตรฐานเหมือนตาราง VIEW_CONFIG อื่น (backend ยังไม่รองรับอุปกรณ์ประเภทนี้ในทางนั้น
// เพราะ C2-Loop ไม่ได้เป็นเจ้าของข้อมูลหลัก) มีแค่: ปุ่มรีเฟรชข้อมูลตอนนี้ (syncPanolyzerNow), ปุ่ม "กดลองใหม่"
// ต่อแถวถ้า sync กลับไป Sheet ไม่สำเร็จตอนอนุมัติเบิก (retryPanolyzerSheetSync), และปุ่ม "ผูก Gateway เพิ่มทีหลัง"
// (Admin เท่านั้น — attachGatewayToPanolyzer)
// ============================================================
function renderPanolyzerView() {
  const content = document.getElementById("viewContent");
  const mobile = isMobileViewport();
  content.innerHTML = `
    <div class="controls-row">
      <input type="text" id="panoSearchBox" placeholder="ค้นหา (S/N, ลูกค้า, สถานที่, Model, Mode...)">
      <select id="panoStatusFilter">
        <option value="all">-- สถานะทั้งหมด --</option>
        <option value="stock">อยู่ใน Stock พร้อมเบิก</option>
        <option value="used">เบิกไปแล้ว</option>
      </select>
      <button class="btn-sm btn-secondary" id="panoRefreshBtn">🔄 รีเฟรชข้อมูลตอนนี้</button>
    </div>
    <div class="cache-note" style="margin-bottom:10px;">ข้อมูลเครื่อง Panolyzer มิเรอร์มาจากระบบ "Panolyzer Management" (คนละระบบ) — ซิงค์อัตโนมัติทุก 15 นาที หรือกดรีเฟรชเองได้ทันที ระบบนี้ใช้เบิกส่งมอบ (Status เปลี่ยนเป็น "Complete") เท่านั้น การบันทึกประวัติทดลองเครื่องยังต้องทำในระบบ Panolyzer Management เดิม</div>
    ${mobile
      ? `<div id="panoCards" class="mcard-list"></div>`
      : `<div class="table-card">
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>S/N Analyzer</th><th>ลูกค้า</th><th>สถานที่</th><th>สถานะ</th><th>ประเภท</th><th>Model</th><th>Mode</th><th>S/N Edge server (ในชีต)</th><th>Gateway ที่ผูกไว้ (C2-Loop)</th><th></th>
          </tr></thead>
          <tbody id="panoTbody"></tbody>
        </table>
      </div>
    </div>`}
  `;
  document.getElementById("panoRefreshBtn").addEventListener("click", refreshPanolyzerNow);
  document.getElementById("panoSearchBox").addEventListener("input", renderPanolyzerRows);
  document.getElementById("panoStatusFilter").addEventListener("change", renderPanolyzerRows);
  renderPanolyzerRows();
}

function getFilteredPanolyzerRows() {
  const searchEl = document.getElementById("panoSearchBox");
  const statusEl = document.getElementById("panoStatusFilter");
  const search = (searchEl ? searchEl.value : "").toLowerCase();
  const statusFilter = statusEl ? statusEl.value : "all";
  return (state.data.panolyzer || []).filter((row) => {
    const stock = isPanolyzerStockRow(row);
    if (statusFilter === "stock" && !stock) return false;
    if (statusFilter === "used" && stock) return false;
    if (!search) return true;
    return [PANOLYZER_SERIAL_FIELD, "Client name", "Location", "Type", "Model", "Mode", "S/N Edge server"]
      .some((f) => String(row[f] || "").toLowerCase().includes(search));
  });
}

function renderPanolyzerRows() {
  if (isMobileViewport()) {
    renderPanolyzerRowsAsCards();
  } else {
    renderPanolyzerRowsAsTable();
  }
}

function renderPanolyzerRowsAsTable() {
  const tbody = document.getElementById("panoTbody");
  if (!tbody) return;
  const isAdmin = state.user.role === "Admin";
  const rows = getFilteredPanolyzerRows();

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">ไม่พบข้อมูล — ลองกดรีเฟรชข้อมูลตอนนี้</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((row) => {
    const serial = String(row[PANOLYZER_SERIAL_FIELD] || "");
    const stock = isPanolyzerStockRow(row);
    const statusCell = `<span class="${stock ? "badge-stock" : "badge-used"}">${escapeHtml(String(row["Status"] || ""))}</span>`;
    const syncBadge = row.pendingSheetSync
      ? `<div class="badge-sync-failed">การอัปเดตไปยัง Sheet ไม่สำเร็จ${row.lastSheetSyncError ? " — " + escapeHtml(String(row.lastSheetSyncError)) : ""}</div>${isAdmin ? `<button class="btn-sm btn-secondary sync-retry-btn" onclick="retryPanolyzerSync('${escapeAttr(serial)}')">กดลองใหม่</button>` : ""}`
      : "";
    const attachBtn = isAdmin
      ? `<button class="btn-sm btn-secondary" onclick="openAttachGatewayToPanolyzerModal('${escapeAttr(serial)}')">ผูก Gateway เพิ่มทีหลัง</button>`
      : "";
    // Phase 2 (ดูรายละเอียด): เปลี่ยนจากปุ่มแยกมาเป็นกดที่แถวได้เลยทั้งแถว (เหมือนตารางอุปกรณ์อื่น) — เซลล์ที่มี
    // ปุ่ม/ลิงก์ของตัวเอง (Gateway ที่ผูกไว้, ผูก Gateway เพิ่ม, กดลองใหม่) กัน propagation ไว้ไม่ให้ชนกัน
    return `<tr class="row-clickable" onclick="openPanolyzerDetailModal('${escapeAttr(serial)}')">
      <td>${escapeHtml(serial)}</td>
      <td>${escapeHtml(String(row["Client name"] || ""))}</td>
      <td>${escapeHtml(String(row["Location"] || ""))}</td>
      <td onclick="event.stopPropagation()">${statusCell}${syncBadge}</td>
      <td>${escapeHtml(String(row["Type"] || ""))}</td>
      <td>${escapeHtml(String(row["Model"] || ""))}</td>
      <td>${escapeHtml(String(row["Mode"] || ""))}</td>
      <td>${escapeHtml(String(row["S/N Edge server"] || ""))}</td>
      <td onclick="event.stopPropagation()">${row.linkedGatewaySerial ? `<span class="badge-linkable" onclick="goToLinkedAsset('gateway', '${escapeAttr(String(row.linkedGatewaySerial))}')" title="คลิกเพื่อไปดูรายการนี้">${escapeHtml(String(row.linkedGatewaySerial))}</span>` : `<span class="cache-note">-</span>`}</td>
      <td class="no-wrap" onclick="event.stopPropagation()">${attachBtn}</td>
    </tr>`;
  }).join("");
}

/** เวอร์ชันมือถือของหน้า Panolyzer — การ์ดแนวตั้งแทนตารางกว้างที่ต้องเลื่อนซ้าย-ขวา (ข้อมูล/ปุ่มเหมือนเวอร์ชันตาราง
 * ทุกประการ ต่างแค่การจัดวาง — ใช้คลาส .mcard/.mcard-list ชุดเดียวกับหน้ารายการอุปกรณ์อื่นๆ เพื่อความสม่ำเสมอ) */
function renderPanolyzerRowsAsCards() {
  const wrap = document.getElementById("panoCards");
  if (!wrap) return;
  const isAdmin = state.user.role === "Admin";
  const rows = getFilteredPanolyzerRows();

  if (!rows.length) {
    wrap.innerHTML = `<div class="mcard-empty">ไม่พบข้อมูล — ลองกดรีเฟรชข้อมูลตอนนี้</div>`;
    return;
  }

  wrap.innerHTML = rows.map((row) => {
    const serial = String(row[PANOLYZER_SERIAL_FIELD] || "");
    const stock = isPanolyzerStockRow(row);
    const pillHtml = `<span class="mcard-pill ${stock ? "stock" : "used"}">${escapeHtml(String(row["Status"] || ""))}</span>`;
    const syncBadge = row.pendingSheetSync
      ? `<div class="mcard-row"><div class="badge-sync-failed">การอัปเดตไปยัง Sheet ไม่สำเร็จ${row.lastSheetSyncError ? " — " + escapeHtml(String(row.lastSheetSyncError)) : ""}</div>${isAdmin ? `<button class="btn-sm btn-secondary sync-retry-btn" onclick="retryPanolyzerSync('${escapeAttr(serial)}')">กดลองใหม่</button>` : ""}</div>`
      : "";
    const attachBtn = isAdmin
      ? `<button class="btn-sm btn-secondary" onclick="openAttachGatewayToPanolyzerModal('${escapeAttr(serial)}')">ผูก Gateway เพิ่มทีหลัง</button>`
      : "";
    const rowsHtml = [
      ["ลูกค้า", row["Client name"]],
      ["สถานที่", row["Location"]],
      ["ประเภท", row["Type"]],
      ["Model", row["Model"]],
      ["Mode", row["Mode"]],
      ["S/N Edge server (ในชีต)", row["S/N Edge server"]],
      ["Gateway ที่ผูกไว้ (C2-Loop)", row.linkedGatewaySerial, true],
    ].filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
      .map(([label, v, linkToGateway]) => `<div class="mcard-row"><div class="mcard-label">${escapeHtml(label)}</div><div class="mcard-val">${linkToGateway ? `<span class="badge-linkable" onclick="goToLinkedAsset('gateway', '${escapeAttr(String(v))}')" title="คลิกเพื่อไปดูรายการนี้">${escapeHtml(String(v))}</span>` : escapeHtml(String(v))}</div></div>`)
      .join("");

    return `
      <div class="mcard">
        <div class="mcard-head">
          <div class="mcard-title">${escapeHtml(serial || "-")}</div>
          ${pillHtml}
        </div>
        ${rowsHtml}
        ${syncBadge}
        ${attachBtn ? `<div class="mcard-actions">${attachBtn}</div>` : ""}
      </div>`;
  }).join("");
}

/** ปุ่ม "รีเฟรชข้อมูลตอนนี้" — เรียก syncPanolyzerNow แล้วปล่อยให้ real-time listener (bind("panolyzer", ...))
 * อัปเดตตารางให้เองอัตโนมัติ (ไม่ต้อง manual re-render ผลลัพธ์ตรงนี้) */
async function refreshPanolyzerNow() {
  const btn = document.getElementById("panoRefreshBtn");
  if (btn) { btn.disabled = true; btn.textContent = "กำลังรีเฟรช..."; }
  try {
    const res = await apiPost({ action: "syncPanolyzerNow", token: state.token });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert("รีเฟรชข้อมูล Panolyzer ไม่สำเร็จ: " + (res.error || "unknown_error"), "error");
      return;
    }
    await showAlert(`ซิงค์ข้อมูล Panolyzer สำเร็จ (${res.count || 0} เครื่อง)`, "success");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 รีเฟรชข้อมูลตอนนี้"; }
  }
}

/** ปุ่ม "กดลองใหม่" ของแถวที่ sync กลับไป Sheet ไม่สำเร็จตอนอนุมัติเบิก (Admin เท่านั้น) */
async function retryPanolyzerSync(serial) {
  const confirmed = await showConfirm(`ลองส่งข้อมูลเครื่อง Panolyzer S/N ${serial} ไปที่ Sheet Panolyzer Management ใหม่อีกครั้ง?`);
  if (!confirmed) return;
  const res = await apiPost({ action: "retryPanolyzerSheetSync", token: state.token, serial });
  if (!res.ok) {
    if (res.error === "unauthorized") return handleUnauthorized();
    await showAlert("ลองใหม่ไม่สำเร็จ: " + (res.detail || res.error || "unknown_error"), "error");
    return;
  }
  await showAlert("ส่งข้อมูลไปที่ Sheet สำเร็จแล้ว", "success");
  renderCurrentView();
}

/** โมดัล "ผูก Gateway เพิ่มทีหลัง" — Admin เลือก Gateway รุ่น EPG-001S ว่างในสต๊อกมาผูกกับเครื่อง Panolyzer นี้
 * (ทั้ง Lab/Real-time ใช้ปุ่มนี้ได้เหมือนกันหมด — ไม่มีรุ่นไหนมากับ Gateway ติดตั้งสำเร็จรูปเลย ตามที่ผู้ใช้ยืนยัน)
 * มีผลทันที ไม่ต้องผ่านคำขอ/อนุมัติ (ดูเหตุผลที่คอมเมนต์ exports.attachGatewayToPanolyzer ฝั่ง backend) และไม่เรียก
 * Sheet API เลย (ชีตไม่มีฟิลด์ที่มีความหมายสำหรับข้อมูลนี้ ตามที่ผู้ใช้ยืนยันชัดเจน) */
function openAttachGatewayToPanolyzerModal(panolyzerSerial) {
  const availableGw = getAvailableGatewaysByModel(GATEWAY_MODEL_PANOLYZER, -1);
  if (!availableGw.length) {
    showAlert(`ไม่มี Gateway รุ่น ${GATEWAY_MODEL_PANOLYZER} ว่างในสต๊อกตอนนี้`, "error");
    return;
  }
  const gwCfg = VIEW_CONFIG.gateway;
  const fields = [{
    key: "gatewaySerial",
    label: "เลือก Gateway (ว่างในสต๊อก)",
    type: "select",
    value: String(availableGw[0][gwCfg.serialField]),
    options: availableGw.map((g) => ({ value: String(g[gwCfg.serialField]), label: String(g[gwCfg.serialField]) })),
  }];
  openGenericFormModal(`ผูก Gateway เพิ่มทีหลัง — Panolyzer ${panolyzerSerial}`, fields, async (values) => {
    const gatewaySerial = values[0];
    const msg = document.getElementById("genericFormModalMsg");
    try {
      const res = await apiPost({ action: "attachGatewayToPanolyzer", token: state.token, panolyzerSerial, gatewaySerial });
      if (!res.ok) {
        if (res.error === "unauthorized") return handleUnauthorized();
        throw new Error(res.error || "internal_error");
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

function renderListView(cfg) {
  const content = document.getElementById("viewContent");
  const rows = state.data[cfg.key] || [];
  const isAdmin = state.user.role === "Admin";
  const mobile = isMobileViewport();
  const filterKey = cfg.key;
  const saved = getListViewFilterState(filterKey);

  // Phase 15: ปุ่ม "+ เพิ่มสต๊อก" ถูกย้ายไปรวมไว้ที่หน้า "จัดการ Stock/อะไหล่" หน้าเดียวแล้ว (ไม่มีปุ่มแยกในหน้านี้อีกต่อไป)
  content.innerHTML = `
    <div class="controls-row">
      <input type="text" id="searchBox" placeholder="ค้นหา (S/N, ลูกค้า, สถานะ...)" value="${escapeAttr(saved.search)}">
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
          <thead><tr>${cfg.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr></thead>
          <tbody id="listTbody"></tbody>
        </table>
      </div>
    </div>`}
  `;
  document.getElementById("statusFilter").value = saved.status;

  document.getElementById("searchBox").addEventListener("input", () => { saveListViewFilterState(filterKey); renderRows(cfg, rows, isAdmin); });
  document.getElementById("statusFilter").addEventListener("change", () => { saveListViewFilterState(filterKey); renderRows(cfg, rows, isAdmin); });
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

  // หน้าอะไหล่ Color Sorter/Panolyzer (cfg.partCategory) ใช้การ์ด "ไม่มีเบิก" แม้บนจอ PC ด้วย (ไม่ใช่แค่มือถือ)
  // เพราะรูปอะไหล่ใหญ่ขึ้นเห็นชัดกว่าตารางเดิมมาก ส่วนตารางอุปกรณ์ปกติ (MoisturLyzer/Gateway/SimCard) ยังใช้
  // ตารางแบบเดิมบนจอ PC เหมือนเดิมทุกประการ (ดู .pcard-grid ใน style.css สำหรับ layout แบบ grid หลายคอลัมน์)
  if (isMobileViewport() || cfg.partCategory) {
    renderRowsAsCards(cfg, filtered, isAdmin);
  } else {
    renderRowsAsTable(cfg, filtered, isAdmin);
  }
  hydratePartPhotoThumbnails(); // เติม signed URL ของรูปอะไหล่ (ถ้ามีคอลัมน์รูปในมุมมองนี้) หลัง DOM ขึ้นแล้ว
}

// ===== แคช signed URL ของรูปอะไหล่ (แก้บัคความปลอดภัย: รูปอะไหล่ไม่เปิดสาธารณะแล้ว ต้องขอ URL ชั่วคราวผ่าน
// getPartPhotoUrl ทุกครั้ง — แคชไว้ในเครื่อง ~10 นาที กันยิง request ซ้ำๆ ตอน re-render ตารางบ่อยๆ แต่ไม่นานเกินไป
// จนเกินอายุ signed URL จริง (15 นาทีฝั่งเซิร์ฟเวอร์) =====
const partPhotoUrlCache = {}; // { [partId]: { url, fetchedAt } }
const PART_PHOTO_CACHE_TTL_MS = 10 * 60 * 1000;

/** ขอ signed URL ของรูปอะไหล่จากเซิร์ฟเวอร์ (login แล้วเท่านั้นถึงจะขอได้) พร้อมแคชผลไว้ใช้ซ้ำสั้นๆ */
async function fetchPartPhotoUrl(partId) {
  const cached = partPhotoUrlCache[partId];
  if (cached && Date.now() - cached.fetchedAt < PART_PHOTO_CACHE_TTL_MS) return cached.url;
  try {
    const res = await apiPost({ action: "getPartPhotoUrl", token: state.token, partId });
    const url = res && res.ok ? res.photoUrl || "" : "";
    partPhotoUrlCache[partId] = { url, fetchedAt: Date.now() };
    return url;
  } catch (err) {
    return "";
  }
}

/** เติมรูปให้ทุก <img data-photo-partid> ที่ยังไม่มี src ในหน้าปัจจุบัน (เรียกหลัง render ตาราง/การ์ดที่มีรูปอะไหล่
 * เสร็จแล้ว) โหลดแบบ async ทีละรูปหลัง DOM ขึ้นแล้ว เพราะต้องขอ signed URL ใหม่จากเซิร์ฟเวอร์ทุกครั้ง ไม่ใช่ค่า
 * synchronous เหมือนตอนที่ยังเป็น URL สาธารณะ */
function hydratePartPhotoThumbnails(root) {
  const scope = root || document;
  const imgs = scope.querySelectorAll("img[data-photo-partid]");
  imgs.forEach(async (img) => {
    const partId = img.getAttribute("data-photo-partid");
    if (!partId) return;
    const url = await fetchPartPhotoUrl(partId);
    if (url) {
      img.src = url;
      img.closest("[data-photo-wrap]")?.classList.remove("photo-loading");
    } else {
      img.closest("[data-photo-wrap]")?.classList.add("photo-missing");
    }
  });
}

/** หารูปอะไหล่ (PhotoUrl) จาก PartsCatalog ด้วย PartID — ใช้กับแถวอะไหล่แบบมี S/N ที่แสดงในตาราง/การ์ดรวม
 * (ตัว row เองไม่มี PhotoUrl ติดมาด้วย เพราะอยู่คนละชีตกัน ต้อง join กับ state.data.partsCatalog เอา)
 * หมายเหตุ: ใช้ได้เฉพาะเช็คว่า "มีรูปหรือไม่" (row.HasPhoto ก็เพียงพอ) — ห้ามใช้ผลลัพธ์นี้เป็น src ของ <img>
 * โดยตรงอีกต่อไป เพราะไม่ใช่ URL ที่เปิดดูได้จริงแล้ว (ต้องขอ signed URL สดๆ ผ่าน fetchPartPhotoUrl แทน) */
function getPartPhotoUrlByPartId(partId) {
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === partId);
  return part ? part.PhotoUrl : "";
}

/** เช็คว่าอะไหล่ชิ้นนี้มีรูปหรือไม่ (ใช้แทนการอ่าน URL ตรงๆ — ปลอดภัยต่อทั้งข้อมูลเก่า/ใหม่) */
function hasPartPhotoByPartId(partId) {
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === partId);
  return !!(part && part.HasPhoto);
}

function renderRowsAsTable(cfg, filtered, isAdmin) {
  const tbody = document.getElementById("listTbody");
  if (!tbody) return;
  // Phase: ตัดคอลัมน์ "จัดการ" ออกจากตารางสรุปแล้ว (ตามคำขอผู้ใช้) เพราะปุ่มจัดการชุดเดียวกันไปอยู่ในโมดัล
  // "ดูรายละเอียด" (เปิดได้จากการกดที่แถว) หมดแล้ว — ไม่ต้องมีคอลัมน์นี้ในตารางสรุปอีกต่อไป
  const hasThumbCol = !!cfg.partCategory;
  const colspan = cfg.columns.length + (hasThumbCol ? 1 : 0);

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row) => {
    const thumbCell = hasThumbCol
      ? (() => {
          return hasPartPhotoByPartId(row.PartID)
            ? `<td data-photo-wrap><img data-photo-partid="${escapeAttr(row.PartID)}" class="table-thumb" alt=""></td>`
            : `<td><span class="table-thumb-empty">📦</span></td>`;
        })()
      : "";
    const cells = cfg.columns.map((c) => {
      if (c.computed) {
        const linked = (c.compute || computeLinkedAccessories)(row);
        // onclick="event.stopPropagation()" กันไม่ให้กด badge ที่ลิงก์ไปเมนูอื่น (goToLinkedAsset) แล้วไปโดน
        // onclick ของทั้งแถว (เปิดโมดัลดูรายละเอียด) ทำงานซ้อนด้วย
        return `<td onclick="event.stopPropagation()">${linked.length ? linked.map(renderLinkedBadge).join(" ") : `<span class="cache-note">-</span>`}</td>`;
      }
      let val = row[c.field];
      if (c.field === cfg.stockField) {
        if (TRANSFER_CLAIM_ASSET_KEYS.includes(cfg.key) && isClaimedRow(row, cfg)) {
          const from = [row.ClaimedFromCustomer, row.ClaimedFromLocation].filter((v) => v && String(v).trim()).join(" · ");
          return `<td><span class="badge-claim">อยู่ระหว่างเคลม</span>${from ? `<div class="cell-sub">เดิม: ${escapeHtml(from)}${row.ClaimedAt ? " · เคลมเมื่อ " + escapeHtml(formatDateTh(row.ClaimedAt)) : ""}</div>` : ""}</td>`;
        }
        if (TRANSFER_CLAIM_ASSET_KEYS.includes(cfg.key) && isWrittenOffRow(row, cfg)) {
          return `<td><span class="badge-writeoff">ตัดจำหน่าย</span></td>`;
        }
        const stock = isStockRow(row, cfg.stockField, cfg.stockRequiresField);
        val = `<span class="${stock ? "badge-stock" : "badge-used"}">${escapeHtml(String(val || ""))}</span>`;
        return `<td>${val}</td>`;
      }
      return `<td>${escapeHtml(String(val === undefined || val === null ? "" : val))}</td>`;
    }).join("");
    const serial = String(row[cfg.serialField] || "");
    // Phase 2 (ดูรายละเอียด): เปลี่ยนจากปุ่มแยกมาเป็นกดที่แถวได้เลยทั้งแถว (ง่ายกว่า) ทุก role กดได้ (แค่เปิด
    // โมดัลดูข้อมูล ไม่มีผลแก้ไขอะไร) เซลล์ที่มีปุ่ม/ลิงก์ของตัวเองด้านบนกัน propagation ไว้แล้วไม่ให้ชนกัน
    // Phase: ปุ่มจัดการ (แก้ไข/ย้าย-เคลม/ลบ ฯลฯ) ย้ายไปอยู่ในโมดัลดูรายละเอียดล้วนๆ แล้ว (ตัดคอลัมน์ "จัดการ"
    // ออกจากตารางสรุปตามคำขอผู้ใช้) — buildAssetRowActionButtonsHtml ยังใช้ร่วมกับโมดัลอยู่เหมือนเดิม
    return `<tr class="row-clickable" onclick="openAssetDetailModal('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">${thumbCell}${cells}</tr>`;
  }).join("");
}

/** ปุ่มจัดการของแถวอุปกรณ์ 1 แถว (แก้ไข/ย้าย-เคลม/ลบ/พิมพ์ป้าย/ประวัติ/เพิ่มรูป ฯลฯ) — เดิมอยู่ในตัว
 * renderRowsAsTable ตรงๆ แยกออกมาเป็นฟังก์ชันนี้เพื่อใช้ซ้ำกับโมดัล "ดูรายละเอียด" (openAssetDetailModal, Part 2)
 * ได้โดยไม่ต้องเขียนซ้ำ — คืนแค่ HTML ปุ่ม (ไม่มี wrapper td/div) ผู้เรียกห่อ container เอาเอง เฉพาะ Admin
 * เท่านั้นที่มีปุ่มเหล่านี้ (ยกเว้นอะไหล่มี S/N ที่ role อื่นเห็นปุ่ม "ประวัติ" ได้ด้วย) */
function buildAssetRowActionButtonsHtml(cfg, row, isAdmin) {
  const serial = String(row[cfg.serialField] || "");
  // Phase: หลังตัดคอลัมน์ "จัดการ" ออกจากตารางแล้ว ฟังก์ชันนี้ถูกเรียกใช้จากโมดัล "ดูรายละเอียด" เท่านั้น (ไม่มี
  // ผู้เรียกอื่นเหลืออยู่) — ทุกปุ่มจึงต้องปิดโมดัลรายละเอียดก่อนเปิดโมดัลถัดไปเสมอ (closeAssetDetailModal())
  // ไม่งั้นโมดัลใหม่ (เช่นฟอร์มแก้ไข) จะซ้อนอยู่ "หลัง" โมดัลรายละเอียดเพราะ z-index เท่ากันและ assetDetailModal
  // มาทีหลังใน DOM — ผู้ใช้กดแก้ไขแล้วมองไม่เห็นฟอร์มที่เพิ่งเปิด
  const historyBtn = cfg.partCategory
    ? `<button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); showPartHistory('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}')">ประวัติ</button>`
    : "";
  const photoBtn = cfg.partCategory
    ? `<button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); openChangePartPhotoModal('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}', ${hasPartPhotoByPartId(row.PartID)})">เพิ่ม/เปลี่ยนรูป</button>`
    : "";
  // Phase 21: ปุ่มพิมพ์ป้ายติดเครื่อง Gateway — เฉพาะตาราง Gateway เท่านั้น (ป้ายมีไว้แปะตัวเครื่อง Gateway โชว์
  // S/N ตัวเอง + S/N อุปกรณ์/ซิมที่เชื่อมต่ออยู่ — ดู printGatewayLabel)
  const printLabelBtn = cfg.key === "gateway"
    ? `<button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); printGatewayLabel('${escapeAttr(serial)}')">🏷️ พิมพ์ป้าย</button>`
    : "";
  const isTransferClaimType = TRANSFER_CLAIM_ASSET_KEYS.includes(cfg.key);
  const claimed = isTransferClaimType && isClaimedRow(row, cfg);
  const writtenOff = isTransferClaimType && isWrittenOffRow(row, cfg);
  const issued = isTransferClaimType && !claimed && !writtenOff && !isStockRow(row, cfg.stockField, cfg.stockRequiresField);
  if (isAdmin && claimed) {
    return `<button class="btn-sm btn-primary" onclick="closeAssetDetailModal(); resolveClaimAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}', 'toStock')">คืนเข้าสต็อก</button>
         <button class="btn-sm btn-remove" onclick="closeAssetDetailModal(); resolveClaimAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}', 'writeOff')">ตัดจำหน่าย</button>`;
  } else if (isAdmin && writtenOff) {
    return `<button class="btn-sm btn-primary" onclick="closeAssetDetailModal(); restoreWrittenOffAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">คืนเข้าสต็อก</button>
         <button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>`;
  } else if (isAdmin) {
    return `<button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>
         ${issued ? `<button class="btn-sm btn-transfer" onclick="closeAssetDetailModal(); openTransferClaimModal('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ย้าย/เคลม</button>` : ""}
         <button class="btn-sm btn-remove" onclick="closeAssetDetailModal(); deleteAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ลบ</button>
         ${printLabelBtn}
         ${historyBtn}
         ${photoBtn}`;
  }
  return cfg.partCategory ? historyBtn : "";
}

/** สร้าง HTML รายการ label:value ของ "ทุก" คอลัมน์ตาม cfg.columns สำหรับแถวอุปกรณ์ 1 แถว — ใช้ในโมดัล
 * "ดูรายละเอียด" (openAssetDetailModal, Part 2) เท่านั้น ต่างจากการ์ดมือถือ (renderRowsAsCards) ตรงที่ "ไม่ข้าม"
 * คอลัมน์ serial/สถานะ ออก เพราะโมดัลนี้ตั้งใจให้เห็นข้อมูลครบทุกฟิลด์จริงๆ ไม่ใช่แค่สรุปย่อ */
function buildAssetDetailFieldsHtml(cfg, row) {
  return cfg.columns.map((c) => {
    let valHtml;
    if (c.computed) {
      const linked = (c.compute || computeLinkedAccessories)(row);
      valHtml = linked.length ? linked.map(renderLinkedBadge).join(" ") : `<span class="cache-note">-</span>`;
    } else if (c.field === cfg.stockField) {
      const val = row[c.field];
      const stock = isStockRow(row, cfg.stockField, cfg.stockRequiresField);
      valHtml = `<span class="${stock ? "badge-stock" : "badge-used"}">${escapeHtml(String(val === undefined || val === null ? "" : val))}</span>`;
    } else {
      const val = row[c.field];
      valHtml = escapeHtml(String(val === undefined || val === null ? "" : val));
    }
    return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(c.label)}</div><div class="mcard-val">${valHtml}</div></div>`;
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
    const isTransferClaimType = TRANSFER_CLAIM_ASSET_KEYS.includes(cfg.key);
    const claimed = isTransferClaimType && isClaimedRow(row, cfg);
    const writtenOff = isTransferClaimType && isWrittenOffRow(row, cfg);
    const issued = isTransferClaimType && !claimed && !writtenOff && !stock;

    const bodyRows = cfg.columns
      // หมายเหตุ: เดิมซ่อนคอลัมน์ field "No" ออกจากการ์ดมือถือทุกประเภท เพราะของ MoisturLyzer เป็นแค่เลขลำดับ
      // เก่าจากสเปรดชีต ไม่มีความหมายกับผู้ใช้ — จำกัดการซ่อนนี้ไว้เฉพาะ MoisturLyzer เท่านั้น เพราะ SimCard ใช้ field
      // "No" เก็บ "ลำดับ SIM" จริงที่ AIS อ้างถึง (เช่น "ซิมลำดับที่ 30-40") ซึ่งเป็นข้อมูลสำคัญที่ต้องโชว์บนมือถือด้วย
      .filter((c) => c.field !== cfg.serialField && !(c.field === "No" && cfg.key === "moisturlyzer") && c.field !== cfg.stockField)
      .map((c) => {
        if (c.computed) {
          const linked = (c.compute || computeLinkedAccessories)(row);
          const val = linked.length ? linked.map(linkedItemToText).join(", ") : "-";
          return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(c.label)}</div><div class="mcard-val">${escapeHtml(val)}</div></div>`;
        }
        const val = row[c.field];
        if (val === undefined || val === null || val === "") return "";
        return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(c.label)}</div><div class="mcard-val">${escapeHtml(String(val))}</div></div>`;
      }).join("");

    const historyBtn = cfg.partCategory
      ? `<button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}')">ประวัติ</button>`
      : "";
    const hasPhoto = cfg.partCategory ? hasPartPhotoByPartId(row.PartID) : false;
    const photoBtn = cfg.partCategory
      ? `<button class="btn-sm btn-secondary" onclick="openChangePartPhotoModal('${escapeAttr(row.PartID)}', '${escapeAttr(row.PartName)}', ${hasPhoto})">เพิ่ม/เปลี่ยนรูป</button>`
      : "";
    // Phase 21: ปุ่มพิมพ์ป้ายติดเครื่อง Gateway — เฉพาะการ์ด Gateway เท่านั้น (ดู printGatewayLabel)
    const printLabelBtn = cfg.key === "gateway"
      ? `<button class="btn-sm btn-secondary" onclick="printGatewayLabel('${escapeAttr(serial)}')">🏷️ พิมพ์ป้าย</button>`
      : "";
    let actionsHtml;
    if (isAdmin && claimed) {
      actionsHtml = `<div class="mcard-actions">
           <button class="btn-sm btn-primary" onclick="resolveClaimAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}', 'toStock')">คืนเข้าสต็อก</button>
           <button class="btn-sm btn-remove" onclick="resolveClaimAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}', 'writeOff')">ตัดจำหน่าย</button>
         </div>`;
    } else if (isAdmin && writtenOff) {
      actionsHtml = `<div class="mcard-actions">
           <button class="btn-sm btn-primary" onclick="restoreWrittenOffAction('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">คืนเข้าสต็อก</button>
           <button class="btn-sm btn-secondary" onclick="openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>
         </div>`;
    } else if (isAdmin) {
      actionsHtml = `<div class="mcard-actions">
           <button class="btn-sm btn-secondary" onclick="openEditAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">แก้ไข</button>
           ${issued ? `<button class="btn-sm btn-transfer" onclick="openTransferClaimModal('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ย้าย/เคลม</button>` : ""}
           <button class="btn-sm btn-remove" onclick="deleteAsset('${escapeAttr(cfg.key)}', '${escapeAttr(serial)}')">ลบ</button>
           ${printLabelBtn}
           ${historyBtn}
           ${photoBtn}
         </div>`;
    } else {
      actionsHtml = cfg.partCategory ? `<div class="mcard-actions">${historyBtn}</div>` : "";
    }

    const pillHtml = claimed
      ? `<span class="mcard-pill claim">อยู่ระหว่างเคลม</span>`
      : writtenOff
        ? `<span class="mcard-pill writeoff">ตัดจำหน่าย</span>`
        : `<span class="mcard-pill ${stock ? "stock" : "used"}">${stock ? "อยู่ในคลัง" : "เบิกออกแล้ว"}</span>`;
    const claimSubHtml = claimed
      ? (() => {
          const from = [row.ClaimedFromCustomer, row.ClaimedFromLocation].filter((v) => v && String(v).trim()).join(" · ");
          return from ? `<div class="mcard-row"><div class="mcard-val cache-note">เดิม: ${escapeHtml(from)}${row.ClaimedAt ? " · เคลมเมื่อ " + escapeHtml(formatDateTh(row.ClaimedAt)) : ""}</div></div>` : "";
        })()
      : "";

    if (cfg.partCategory) {
      const photoHtml = hasPhoto
        ? `<div class="mcard-photo" data-photo-wrap><img data-photo-partid="${escapeAttr(row.PartID)}" alt=""></div>`
        : `<div class="mcard-photo">📦</div>`;
      return `
        <div class="mcard mcard-with-photo">
          ${photoHtml}
          <div class="mcard-body">
            <div class="mcard-head">
              <div class="mcard-title">${escapeHtml(serial || "-")}</div>
              <span class="mcard-pill ${stock ? "stock" : "used"}">${stock ? "อยู่ในคลัง" : "เบิกออกแล้ว"}</span>
            </div>
            ${bodyRows}
            ${actionsHtml}
          </div>
        </div>`;
    }

    return `
      <div class="mcard">
        <div class="mcard-head">
          <div class="mcard-title">${escapeHtml(serial || "-")}</div>
          ${pillHtml}
        </div>
        ${claimSubHtml}
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
  const filterKey = `parts:${viewKey}`;
  const saved = getListViewFilterState(filterKey);

  // การ์ดอะไหล่แบบนับจำนวน — ใช้ดีไซน์เดียวกันทั้งมือถือและ PC (ต่างแค่ wrapper: มือถือเรียงคอลัมน์เดียว, PC จัด
  // เป็น grid หลายคอลัมน์ผ่านคลาส .pcard-grid ใน style.css) แทนตารางเดิมที่รูปเล็กมาก (60×60px) ให้เห็นรูปอะไหล่
  // ชัดเจนขึ้นตามที่ผู้ใช้ขอ ตัวเลข 3 ค่าเดิม (คงเหลือ/กำลังเบิก/รออนุมัติ) ยกมาเป็นแถบสถิติใต้ชื่อแทนคอลัมน์ตาราง
  const qtyPartCardsHtml = qtyParts.length ? qtyParts.map((p) => {
    const issued = computePartIssuedQty(p.PartID, qtyAssetType);
    const pending = computePartPendingQty(p.PartID, qtyAssetType);
    const actionsHtml = isAdmin
      ? `<div class="mcard-actions">
           <button class="btn-sm btn-secondary" onclick="renamePartPrompt('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">แก้ไขชื่อ</button>
           <button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">ดูประวัติ</button>
           <button class="btn-sm btn-secondary" onclick="openChangePartPhotoModal('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}', ${!!p.HasPhoto})">เพิ่ม/เปลี่ยนรูป</button>
           <button class="btn-sm btn-remove" onclick="deletePartHandler('${escapeAttr(p.PartID)}')">ลบ</button>
         </div>`
      : `<div class="mcard-actions"><button class="btn-sm btn-secondary" onclick="showPartHistory('${escapeAttr(p.PartID)}', '${escapeAttr(p.PartName)}')">ดูประวัติ</button></div>`;
    const photoHtml = p.HasPhoto
      ? `<div class="mcard-photo" data-photo-wrap><img data-photo-partid="${escapeAttr(p.PartID)}" alt=""></div>`
      : `<div class="mcard-photo">📦</div>`;
    return `
      <div class="mcard mcard-with-photo">
        ${photoHtml}
        <div class="mcard-body">
          <div class="mcard-title">${escapeHtml(p.PartName)}</div>
          <div class="mcard-stat-row">
            <div class="mcard-stat"><div class="num">${escapeHtml(String(p.QuantityInStock))}</div><div class="lbl">คงเหลือ</div></div>
            <div class="mcard-stat${issued > 0 ? " warn" : ""}"><div class="num">${issued}</div><div class="lbl">กำลังเบิก</div></div>
            <div class="mcard-stat"><div class="num">${pending}</div><div class="lbl">รออนุมัติ</div></div>
          </div>
          ${actionsHtml}
        </div>
      </div>`;
  }).join("") : `<div class="mcard-empty">ยังไม่มีอะไหล่แบบนับจำนวนในหมวดนี้</div>`;
  const qtyPartsSectionHtml = `<div class="mcard-list${mobile ? "" : " pcard-grid"}">${qtyPartCardsHtml}</div>`;

  content.innerHTML = `
    <h3 class="section-subtitle">อะไหล่แบบนับจำนวน (ไม่มี S/N)</h3>
    ${qtyPartsSectionHtml}

    <h3 class="section-subtitle" style="margin-top:22px;">อะไหล่แบบมี S/N (รายชิ้น)</h3>
    <div class="controls-row">
      <input type="text" id="searchBox" placeholder="ค้นหา (S/N, ลูกค้า, สถานะ...)" value="${escapeAttr(saved.search)}">
      <select id="statusFilter">
        <option value="all">-- สถานะทั้งหมด --</option>
        <option value="stock">อยู่ในคลัง (Stock)</option>
        <option value="used">เบิกออกไปแล้ว</option>
      </select>
    </div>
    <div id="listCards" class="mcard-list${mobile ? "" : " pcard-grid"}"></div>
    ${isAdmin ? `<div class="cache-note" style="margin-top:10px;">ต้องการเพิ่มอะไหล่ใหม่หรือเติมสต็อก? ไปที่เมนู "จัดการ Stock/อะไหล่"</div>` : ""}
  `;
  document.getElementById("statusFilter").value = saved.status;
  hydratePartPhotoThumbnails(content); // เติมรูปของ "อะไหล่แบบนับจำนวน" (qtyPartsSectionHtml) ที่ set ไว้ข้างบนนี้ก่อน

  document.getElementById("searchBox").addEventListener("input", () => { saveListViewFilterState(filterKey); renderRows(cfg, rows, isAdmin); });
  document.getElementById("statusFilter").addEventListener("change", () => { saveListViewFilterState(filterKey); renderRows(cfg, rows, isAdmin); });
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

/** เพิ่ม/เปลี่ยนรูปให้อะไหล่ที่มีอยู่แล้วในระบบ (Admin เท่านั้น) — ใช้โมดัลเดียวกับฟอร์มแก้ไขข้อมูลทั่วไป (genericFormModal)
 * แต่เขียน body เองแทนการใช้ openGenericFormModal() เพราะต้องการช่องแนบไฟล์รูปแทนช่องข้อความล้วนๆ */
let changePartPhotoState = { partId: null, base64: "", mimeType: "" };

function openChangePartPhotoModal(partId, partName, hasPhoto) {
  changePartPhotoState = { partId, base64: "", mimeType: "" };
  document.getElementById("genericFormModalTitle").textContent = `เพิ่ม/เปลี่ยนรูป — ${partName}`;
  const body = document.getElementById("genericFormModalBody");
  body.innerHTML = `
    <label class="photo-upload" id="cpp-photoUploadBox">
      <div id="cpp-photoUploadInner">
        ${hasPhoto ? `<div class="photo-upload-icon">⏳</div>` : `<div class="photo-upload-icon">📷</div>`}
        <div class="photo-upload-lab">${hasPhoto ? "แตะเพื่อเปลี่ยนรูป" : "แตะเพื่อถ่ายรูป หรือเลือกรูปจากอัลบั้ม"}</div>
      </div>
      <input type="file" accept="image/*" id="cpp-photoInput" style="display:none;">
    </label>
  `;
  document.getElementById("cpp-photoInput").addEventListener("change", (e) => onChangePartPhotoSelected(e.target));

  // รูปเดิม (ถ้ามี) ต้องขอ signed URL จากเซิร์ฟเวอร์แบบ async แล้วค่อยเติมภาพเข้าไป (ไม่ใช่ URL สาธารณะที่รู้ตรงๆ
  // อีกต่อไป) — เช็ค changePartPhotoState.partId ตอนได้ผลลัพธ์กลับมาด้วย เผื่อผู้ใช้ปิดโมดัลนี้ไปเปิดของอะไหล่อื่น
  // ก่อนที่ request จะเสร็จ
  if (hasPhoto) {
    fetchPartPhotoUrl(partId).then((url) => {
      if (!url || changePartPhotoState.partId !== partId) return;
      const inner = document.getElementById("cpp-photoUploadInner");
      if (inner) inner.innerHTML = `<img src="${escapeAttr(url)}" class="photo-preview"><div class="photo-upload-lab">แตะเพื่อเปลี่ยนรูป</div>`;
    });
  }

  const msgEl = document.getElementById("genericFormModalMsg");
  msgEl.className = "form-msg";
  msgEl.textContent = "";

  const saveBtn = document.getElementById("genericFormSaveBtn");
  const originalText = saveBtn.textContent;
  saveBtn.onclick = async () => {
    if (!changePartPhotoState.base64) {
      msgEl.className = "form-msg error";
      msgEl.textContent = "กรุณาเลือกรูปก่อนบันทึก";
      return;
    }
    saveBtn.disabled = true; saveBtn.textContent = "กำลังบันทึก...";
    try {
      const res = await apiPost({
        action: "updatePartPhoto", token: state.token, partId: changePartPhotoState.partId,
        photoBase64: changePartPhotoState.base64, photoMimeType: changePartPhotoState.mimeType,
      });
      if (!res.ok) {
        if (res.error === "unauthorized") return handleUnauthorized();
        throw new Error(res.error === "upload_failed"
          ? "อัปโหลดรูปไม่สำเร็จ — ตรวจสอบว่าตั้งค่าโฟลเดอร์ Drive สำหรับเก็บรูปไว้แล้วหรือยัง"
          : "บันทึกไม่สำเร็จ กรุณาลองใหม่");
      }
      await refreshInBackground(true);
      closeGenericFormModal();
      renderCurrentView();
    } catch (err) {
      msgEl.className = "form-msg error";
      msgEl.textContent = err.message;
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = originalText;
    }
  };
  document.getElementById("genericFormModal").style.display = "flex";
}

function onChangePartPhotoSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  compressImageFileToDataUrl(file, 1000, 0.75, (dataUrl, mimeType) => {
    const commaIdx = dataUrl.indexOf(",");
    changePartPhotoState.mimeType = mimeType;
    changePartPhotoState.base64 = dataUrl.slice(commaIdx + 1);
    const inner = document.getElementById("cpp-photoUploadInner");
    if (inner) inner.innerHTML = `<img src="${dataUrl}" class="photo-preview"><div class="photo-upload-lab" style="margin-top:8px;">แตะเพื่อเปลี่ยนรูป</div>`;
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
  StockAdded: "รับเข้าสต๊อก", // Phase 16: MoisturLyzer/Gateway/SimCard รับเข้าสต๊อกผ่านหน้า "จัดการ Stock/อะไหล่"
  PhotoUpdated: "เพิ่ม/เปลี่ยนรูป",
};
const PART_HISTORY_ACTION_ICONS = {
  Added: '<i class="fas fa-plus"></i>', Restocked: '<i class="fas fa-box"></i>', Renamed: '<i class="fas fa-pen"></i>',
  Deleted: '<i class="fas fa-trash"></i>', Issued: '<i class="fas fa-arrow-up"></i>', Returned: '<i class="fas fa-arrow-down"></i>',
  StockAdded: '<i class="fas fa-dolly"></i>', PhotoUpdated: '<i class="fas fa-camera"></i>',
};

function closePartHistoryModal() {
  document.getElementById("partHistoryModal").style.display = "none";
}

function closeAssetDetailModal() {
  document.getElementById("assetDetailModal").style.display = "none";
}

/** โมดัล "ดูรายละเอียด" (Part 2, PC เท่านั้น) — โชว์ทุกฟิลด์ของแถวอุปกรณ์ 1 แถว (moisturlyzer/gateway/simcard)
 * แบบ label:value พร้อมปุ่มจัดการชุดเดียวกับคอลัมน์ "จัดการ" ในตาราง (ใช้ buildAssetRowActionButtonsHtml ร่วมกัน)
 * กันต้องเลื่อนตารางไปมาดูข้อมูล/ปุ่มที่ล้นจอเวลาข้อมูลยาว */
function openAssetDetailModal(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  if (!cfg) return;
  const row = (state.data[cfg.key] || []).find((r) => String(r[cfg.serialField] || "") === serial);
  if (!row) {
    showAlert("ไม่พบข้อมูลอุปกรณ์นี้ (อาจถูกลบ/ย้ายไปแล้ว)", "error");
    return;
  }
  const isAdmin = state.user.role === "Admin";
  document.getElementById("assetDetailModalTitle").textContent = `${cfg.title} — ${serial}`;
  const fieldsHtml = buildAssetDetailFieldsHtml(cfg, row);
  const actionsHtml = buildAssetRowActionButtonsHtml(cfg, row, isAdmin);
  document.getElementById("assetDetailModalBody").innerHTML = `
    ${fieldsHtml}
    ${actionsHtml ? `<div class="mcard-actions" style="margin-top:14px;">${actionsHtml}</div>` : ""}
  `;
  document.getElementById("assetDetailModal").style.display = "flex";
}

/** เวอร์ชัน Panolyzer ของโมดัล "ดูรายละเอียด" — Panolyzer ไม่ได้อยู่ใน VIEW_CONFIG (โครงสร้างข้อมูล/ปุ่มต่างจาก
 * อุปกรณ์อื่น) จึงแยกฟังก์ชันเฉพาะ ดึงข้อมูล/ปุ่มจาก state.data.panolyzer ตรงๆ (อิงตาม renderPanolyzerRowsAsTable) */
function openPanolyzerDetailModal(serial) {
  const row = (state.data.panolyzer || []).find((r) => String(r[PANOLYZER_SERIAL_FIELD] || "") === serial);
  if (!row) {
    showAlert("ไม่พบข้อมูลเครื่อง Panolyzer นี้ (อาจถูกลบ/ย้ายไปแล้ว)", "error");
    return;
  }
  const isAdmin = state.user.role === "Admin";
  const stock = isPanolyzerStockRow(row);
  document.getElementById("assetDetailModalTitle").textContent = `Panolyzer — ${serial}`;

  const fieldsHtml = [
    [PANOLYZER_SERIAL_FIELD, row[PANOLYZER_SERIAL_FIELD], "text"],
    ["ลูกค้า", row["Client name"], "text"],
    ["สถานที่", row["Location"], "text"],
    ["สถานะ", row["Status"], "status"],
    ["ประเภท", row["Type"], "text"],
    ["Model", row["Model"], "text"],
    ["Mode", row["Mode"], "text"],
    ["S/N Edge server (ในชีต)", row["S/N Edge server"], "text"],
    ["Gateway ที่ผูกไว้ (C2-Loop)", row.linkedGatewaySerial, "gateway"],
  ].map(([label, v, kind]) => {
    let valHtml;
    if (kind === "status") {
      valHtml = `<span class="${stock ? "badge-stock" : "badge-used"}">${escapeHtml(String(v || ""))}</span>`;
    } else if (kind === "gateway" && v) {
      valHtml = `<span class="badge-linkable" onclick="goToLinkedAsset('gateway', '${escapeAttr(String(v))}')" title="คลิกเพื่อไปดูรายการนี้">${escapeHtml(String(v))}</span>`;
    } else {
      valHtml = v ? escapeHtml(String(v)) : `<span class="cache-note">-</span>`;
    }
    return `<div class="mcard-row"><div class="mcard-label">${escapeHtml(label)}</div><div class="mcard-val">${valHtml}</div></div>`;
  }).join("");

  // หมายเหตุ: ปุ่ม "กดลองใหม่"/"ผูก Gateway เพิ่มทีหลัง" ต้องปิดโมดัลรายละเอียดนี้ก่อน (closeAssetDetailModal())
  // ไม่งั้นโมดัลฟอร์มที่เปิดต่อ (openAttachGatewayToPanolyzerModal → openGenericFormModal) จะซ้อนอยู่หลังโมดัล
  // รายละเอียดนี้เพราะ z-index เท่ากันและ #assetDetailModal มาทีหลังใน DOM
  const syncHtml = row.pendingSheetSync
    ? `<div class="mcard-row"><div class="badge-sync-failed">การอัปเดตไปยัง Sheet ไม่สำเร็จ${row.lastSheetSyncError ? " — " + escapeHtml(String(row.lastSheetSyncError)) : ""}</div>${isAdmin ? `<button class="btn-sm btn-secondary sync-retry-btn" onclick="closeAssetDetailModal(); retryPanolyzerSync('${escapeAttr(serial)}')">กดลองใหม่</button>` : ""}</div>`
    : "";
  const attachBtn = isAdmin
    ? `<button class="btn-sm btn-secondary" onclick="closeAssetDetailModal(); openAttachGatewayToPanolyzerModal('${escapeAttr(serial)}')">ผูก Gateway เพิ่มทีหลัง</button>`
    : "";

  document.getElementById("assetDetailModalBody").innerHTML = `
    ${fieldsHtml}
    ${syncHtml}
    ${attachBtn ? `<div class="mcard-actions" style="margin-top:14px;">${attachBtn}</div>` : ""}
  `;
  document.getElementById("assetDetailModal").style.display = "flex";
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
  document.getElementById("partHistoryModalTitle").textContent = category ? `ประวัติ Stock ล่าสุด — ${category}` : "ประวัติ Stock ล่าสุดทั้งหมด";
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
// Phase 15: เลือกประเภทที่จะเพิ่มสต๊อกจากตัวเลือกบนสุดของหน้า "จัดการ Stock/อะไหล่" — คำตอบของคำถาม
// "ระบบจะรู้ได้อย่างไรว่าเป็นเครื่องอะไร" คือ Admin เป็นผู้เลือกเองตรงนี้เสมอ ระบบไม่เดาประเภทให้
const MANAGE_STOCK_ASSET_TYPES = [
  { value: "moisturlyzer", label: "MoisturLyzer" },
  { value: "gateway", label: "Gateway" },
  { value: "simcard", label: "SimCard" },
  { value: "colorSorterParts", label: "อะไหล่ Color Sorter" },
  { value: "panolyzerParts", label: "อะไหล่ Panolyzer" },
];
let mpAssetType = "moisturlyzer";

/** ย่อรูปให้เล็กลงก่อนแปลงเป็น base64 ส่งขึ้นเซิร์ฟเวอร์ (รูปถ่ายจากกล้องมือถือมักมีขนาดหลาย MB ซึ่งใหญ่เกินจำเป็น
 * สำหรับแค่ดูรูปย่อในระบบ และอาจทำให้ request ใหญ่เกินไปจนอัปโหลดไม่สำเร็จ) ย่อด้านที่ยาวสุดให้ไม่เกิน maxDim px
 * แล้วบีบอัดเป็น JPEG คุณภาพ quality — callback(dataUrl, mimeType) */
function compressImageFileToDataUrl(file, maxDim, quality, callback) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      callback(canvas.toDataURL("image/jpeg", quality), "image/jpeg");
    };
    img.onerror = () => callback(reader.result, file.type || "image/jpeg"); // ย่อไม่ได้ (ไฟล์แปลก) — ส่งของเดิมไปตรงๆ แทน
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

let managePartsForm = { mode: "new", partName: "", category: "ColorSorter", hasSerial: "no", quantity: "", serials: [""], restockPartId: "", photoBase64: "", photoMimeType: "" };

function renderManagePartsView() {
  const content = document.getElementById("viewContent");

  content.innerHTML = `
    <div class="form-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0;">จัดการ Stock/อะไหล่</h3>
        <button class="btn-sm btn-secondary" onclick="showPartsActivityFeed()">ดูประวัติ Stock ล่าสุด</button>
      </div>
      <div class="form-field" style="margin:14px 0;">
        <label>เลือกประเภทที่จะเพิ่มสต๊อก *</label>
        <select id="mp-assetType">
          ${MANAGE_STOCK_ASSET_TYPES.map((t) => `<option value="${t.value}" ${t.value === mpAssetType ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}
        </select>
      </div>
      <div id="mp-subArea"></div>
    </div>
  `;

  document.getElementById("mp-assetType").addEventListener("change", (e) => { mpAssetType = e.target.value; renderMpSubArea(); });
  renderMpSubArea();
}

/** สลับเนื้อหาส่วนล่างของหน้าตามประเภทที่เลือกไว้บนสุด — MoisturLyzer/Gateway/SimCard ใช้ฟอร์มเพิ่มสต๊อกแบบตะกร้าใหม่
 * ส่วนอะไหล่ Color Sorter/Panolyzer ยังคงใช้ระบบ new/restock เดิมทุกประการ แค่ย้ายมาอยู่ใต้ตัวเลือกนี้เท่านั้น */
// SimCard เท่านั้น: สลับระหว่าง "+ เพิ่มสต๊อกใหม่" กับ "Activate ซิมที่รอดำเนินการ" ด้วยปุ่มแท็บคู่ (แทนที่จะซ้อนกันไว้
// ทั้ง 2 ส่วนตลอดเวลาแบบเดิม) เพื่อไม่ให้หน้าจอยาวเกินไปเมื่อมีซิมรอ Activate จำนวนมาก — ค่าเริ่มต้นเป็น "เพิ่มสต๊อกใหม่"
let mpSimTab = "addstock";

function renderMpSubArea() {
  const area = document.getElementById("mp-subArea");
  if (mpAssetType === "colorSorterParts" || mpAssetType === "panolyzerParts") {
    managePartsForm.category = mpAssetType === "colorSorterParts" ? "ColorSorter" : "Panolyzer";
    renderPartsSubUI(area);
  } else if (mpAssetType === "simcard") {
    renderMpSimTabs(area);
  } else {
    renderAddStockInlineUI(area, mpAssetType);
  }
}

function renderMpSimTabs(area) {
  const pendingCount = getNotActivatedSimCards().length;
  area.innerHTML = `
    <div class="picker-row" style="margin-bottom:14px;">
      <button class="btn-sm ${mpSimTab === "addstock" ? "btn-primary" : "btn-secondary"}" style="flex:1;" onclick="switchMpSimTab('addstock')">+ เพิ่มสต๊อกใหม่</button>
      <button class="btn-sm ${mpSimTab === "activate" ? "btn-primary" : "btn-secondary"}" style="flex:1;" onclick="switchMpSimTab('activate')">✓ Activate ซิมที่รอดำเนินการ (${pendingCount})</button>
    </div>
    <div id="mp-simTabArea"></div>
  `;
  const tabArea = document.getElementById("mp-simTabArea");
  if (mpSimTab === "activate") renderBulkActivateSimUI(tabArea);
  else renderAddStockInlineUI(tabArea, "simcard");
}

function switchMpSimTab(tab) {
  mpSimTab = tab;
  renderMpSimTabs(document.getElementById("mp-subArea"));
}

// ============================================================
// Phase: Activate SimCard หลายรายการพร้อมกัน (หลัง AIS ยืนยันเปิดเบอร์แล้ว) — อยู่ในหน้า "จัดการ Stock/อะไหล่"
// ต่อท้ายฟอร์มเพิ่มสต๊อก SimCard เดิม ใช้ action "updateAsset" เดิม (ตัวเดียวกับฟอร์ม "แก้ไข") วนเรียกทีละรายการ
// ที่เลือกไว้ — ไม่ต้องแก้ Cloud Functions ฝั่ง backend เลย
// ============================================================
let bulkActivateSimState = { date: "", selected: new Set() };

/** ซิมที่ยังรอ Activate จริง = ยังไม่มีวันที่ Activate_date เลย ไม่ว่าสถานะ Installed_device ตอนนี้จะเป็นอะไร —
 * เดิมจำกัดไว้เฉพาะแถวที่เป็น "Stock" เท่านั้น แต่ในทางปฏิบัติบางครั้งซิมถูกเบิก/ติดตั้งไปหาลูกค้าแล้วตั้งแต่ก่อนที่
 * AIS จะยืนยันเปิดเบอร์จริง (Installed_device จึงไม่ใช่ "Stock" แล้ว) ทำให้รายการเหล่านั้นเคยตกหล่นไปจากลิสต์นี้
 * จึงเปลี่ยนมาเช็คแค่ "ยังไม่มี Activate_date" เป็นหลัก (ยกเว้นแถวที่อยู่ระหว่างเคลม/ตัดจำหน่ายแล้ว ซึ่งไม่เกี่ยวกับ
 * การ Activate อีกต่อไป) */
function getNotActivatedSimCards() {
  const cfg = VIEW_CONFIG.simcard;
  const rows = (state.data.simcard || []).filter((r) => {
    const activated = String(r[cfg.stockRequiresField] || "").trim();
    if (activated) return false;
    const status = String(r[cfg.stockField] || "").trim();
    if (status === CLAIM_STOCK_VALUE || status === WRITEOFF_STOCK_VALUE) return false;
    return true;
  });
  // เรียงตามลำดับ SIM (field "No") จากน้อยไปมาก ถ้ามีข้อมูลและเป็นตัวเลขได้ — ตรงกับที่ AIS แจ้งเป็นช่วง (30-40)
  return rows.slice().sort((a, b) => {
    const na = parseFloat(a.No), nb = parseFloat(b.No);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    return String(a["Mobile No."] || "").localeCompare(String(b["Mobile No."] || ""));
  });
}

function renderBulkActivateSimUI(area) {
  const candidates = getNotActivatedSimCards();
  bulkActivateSimState.selected = new Set(
    [...bulkActivateSimState.selected].filter((s) => candidates.some((r) => String(r["S/N"]) === s))
  );

  if (!candidates.length) {
    area.innerHTML = `
      <div class="form-card">
        <h3 style="margin:0 0 10px;">Activate SimCard หลายรายการพร้อมกัน</h3>
        <div class="cache-note">ตอนนี้ไม่มีซิมที่รอ Activate (ทุกรายการมีวันที่เปิดใช้บริการครบแล้ว)</div>
      </div>`;
    return;
  }

  const allChecked = candidates.length > 0 && candidates.every((r) => bulkActivateSimState.selected.has(String(r["S/N"])));

  area.innerHTML = `
    <div class="form-card">
      <h3 style="margin:0 0 4px;">Activate SimCard หลายรายการพร้อมกัน</h3>
      <div class="cache-note" style="margin-bottom:14px;">
        แสดงซิมทุกรายการที่ยังไม่ได้กรอกวันที่เปิดใช้บริการ (ไม่ว่าจะยังอยู่ใน Stock หรือเบิก/ติดตั้งไปหาลูกค้าแล้วก็ตาม) — เลือกรายการที่ AIS ยืนยันเปิดเบอร์แล้ว แล้วกรอกวันที่ครั้งเดียว ระบบจะใส่ให้ทุกรายการที่เลือก
      </div>
      <div class="form-field" style="max-width:260px;">
        <label>วันที่เปิดใช้บริการ (Activate_date) *</label>
        <input type="date" id="ba-date" value="${escapeAttr(bulkActivateSimState.date)}">
      </div>
      <div class="table-card" style="margin-top:12px;">
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" id="ba-selectAll" ${allChecked ? "checked" : ""}></th>
                <th>ลำดับ</th>
                <th>S/N ซิม</th>
                <th>เบอร์โทร</th>
              </tr>
            </thead>
            <tbody id="ba-tbody">
              ${candidates.map((r) => {
                const sn = String(r["S/N"] || "");
                const checked = bulkActivateSimState.selected.has(sn);
                return `<tr>
                  <td><input type="checkbox" class="ba-check" data-sn="${escapeAttr(sn)}" ${checked ? "checked" : ""}></td>
                  <td>${escapeHtml(String(r.No || "-"))}</td>
                  <td>${escapeHtml(sn)}</td>
                  <td>${escapeHtml(String(r["Mobile No."] || "-"))}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="cache-note" id="ba-countNote" style="margin-top:8px;"></div>
      <div class="form-msg" id="ba-msg"></div>
      <button class="btn-primary" id="ba-submitBtn" style="margin-top:12px;">Activate ที่เลือกไว้</button>
    </div>
  `;

  document.getElementById("ba-date").addEventListener("input", (e) => { bulkActivateSimState.date = e.target.value; });
  document.getElementById("ba-selectAll").addEventListener("change", (e) => {
    if (e.target.checked) candidates.forEach((r) => bulkActivateSimState.selected.add(String(r["S/N"])));
    else bulkActivateSimState.selected.clear();
    renderBulkActivateSimUI(area);
  });
  area.querySelectorAll(".ba-check").forEach((el) => {
    el.addEventListener("change", (e) => {
      const sn = e.target.getAttribute("data-sn");
      if (e.target.checked) bulkActivateSimState.selected.add(sn);
      else bulkActivateSimState.selected.delete(sn);
      updateBulkActivateCountNote();
      const selectAllEl = document.getElementById("ba-selectAll");
      if (selectAllEl) selectAllEl.checked = candidates.every((r) => bulkActivateSimState.selected.has(String(r["S/N"])));
    });
  });
  document.getElementById("ba-submitBtn").addEventListener("click", submitBulkActivateSim);
  updateBulkActivateCountNote();
}

function updateBulkActivateCountNote() {
  const note = document.getElementById("ba-countNote");
  if (note) note.textContent = `เลือกไว้ ${bulkActivateSimState.selected.size} รายการ`;
}

async function submitBulkActivateSim() {
  const msg = document.getElementById("ba-msg");
  msg.className = "form-msg";
  msg.textContent = "";

  const selected = [...bulkActivateSimState.selected];
  if (!selected.length) {
    msg.className = "form-msg error";
    msg.textContent = "กรุณาเลือกซิมอย่างน้อย 1 รายการ";
    return;
  }
  const date = bulkActivateSimState.date;
  if (!date) {
    msg.className = "form-msg error";
    msg.textContent = "กรุณากรอกวันที่เปิดใช้บริการ";
    return;
  }

  const [dy, dm, dd] = date.split("-");
  const dateLabel = dy && dm && dd ? `${dd}/${dm}/${dy}` : date;
  const confirmed = await showConfirm(`ยืนยัน Activate ซิม ${selected.length} รายการ ด้วยวันที่ ${dateLabel}?`);
  if (!confirmed) return;

  const submitBtn = document.getElementById("ba-submitBtn");
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;

  let successCount = 0;
  const failed = [];
  for (let i = 0; i < selected.length; i++) {
    const serialNo = selected[i];
    submitBtn.textContent = `กำลัง Activate... (${i + 1}/${selected.length})`;
    try {
      const res = await apiPost({
        action: "updateAsset", token: state.token, assetType: "SimCard", serialNo,
        updates: { Activate_date: date },
      });
      if (res.ok) {
        successCount++;
        bulkActivateSimState.selected.delete(serialNo);
      } else {
        if (res.error === "unauthorized") { submitBtn.disabled = false; submitBtn.textContent = originalText; return handleUnauthorized(); }
        failed.push(serialNo);
      }
    } catch (err) {
      failed.push(serialNo);
    }
  }

  submitBtn.disabled = false;
  submitBtn.textContent = originalText;
  await refreshInBackground(true);
  renderCurrentView();

  if (!failed.length) {
    await showAlert(`Activate สำเร็จ ${successCount} รายการ`, "success");
  } else {
    await showAlert(`Activate สำเร็จ ${successCount} รายการ — ล้มเหลว ${failed.length} รายการ (${failed.join(", ")}) กรุณาลองใหม่`, "warning");
  }
}

function renderPartsSubUI(area) {
  const f = managePartsForm;
  area.innerHTML = `
    <div class="picker-row" style="margin-bottom:14px;">
      <select id="mp-mode">
        <option value="new" ${f.mode === "new" ? "selected" : ""}>+ เพิ่มอะไหล่ใหม่ (ชื่อที่ยังไม่เคยมีในระบบ)</option>
        <option value="restock" ${f.mode === "restock" ? "selected" : ""}>เติมของอะไหล่ที่มีอยู่แล้ว</option>
      </select>
    </div>
    <div id="mp-formArea"></div>
    <div id="mp-msg" class="form-msg"></div>
    <button class="btn-primary" id="mp-submitBtn" style="margin-top:12px;">บันทึก</button>
  `;

  document.getElementById("mp-mode").addEventListener("change", (e) => { f.mode = e.target.value; f.serials = [""]; f.photoBase64 = ""; f.photoMimeType = ""; renderManagePartsFormArea(); });
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
          <label>มี S/N (Serial Number) เฉพาะชิ้นหรือไม่? *</label>
          <select id="mp-hasSerial">
            <option value="no" ${f.hasSerial === "no" ? "selected" : ""}>ไม่มี — นับจำนวนรวม</option>
            <option value="yes" ${f.hasSerial === "yes" ? "selected" : ""}>มี — ต้องกรอก S/N ทีละชิ้น</option>
          </select>
        </div>
      </div>
      <div id="mp-qtyOrSerialArea"></div>
      <div class="form-field" style="margin-top:4px;">
        <label>รูปอะไหล่ (ไม่บังคับ) — ช่วยให้จำได้จากรูปร่างแม้จำชื่อไม่ได้</label>
        <label class="photo-upload" id="mp-photoUploadBox">
          <div id="mp-photoUploadInner">
            <div class="photo-upload-icon">📷</div>
            <div class="photo-upload-lab">แตะเพื่อถ่ายรูป หรือเลือกรูปจากอัลบั้ม</div>
          </div>
          <input type="file" accept="image/*" id="mp-photoInput" style="display:none;">
        </label>
      </div>
    `;
    document.getElementById("mp-partName").addEventListener("input", (e) => { f.partName = e.target.value; });
    document.getElementById("mp-hasSerial").addEventListener("change", (e) => { f.hasSerial = e.target.value; f.serials = [""]; renderQtyOrSerialArea(); });
    document.getElementById("mp-photoInput").addEventListener("change", (e) => onManagePartsPhotoSelected(e.target));
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
    document.getElementById("mp-restockPartId").addEventListener("change", (e) => { f.restockPartId = e.target.value; f.serials = [""]; renderQtyOrSerialArea(); });
    renderQtyOrSerialArea();
  }
}

/** อ่านไฟล์รูปที่เลือก (ถ่ายจากกล้อง/เลือกจากอัลบั้ม) แปลงเป็น base64 เก็บไว้ใน managePartsForm เพื่อส่งไปกับ
 * action "addPart" ตอนกดบันทึก — แสดงตัวอย่างรูปทันทีในเครื่อง (ยังไม่อัปโหลดจริงจนกว่าจะกดบันทึกฟอร์ม) */
function onManagePartsPhotoSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const f = managePartsForm;
  compressImageFileToDataUrl(file, 1000, 0.75, (dataUrl, mimeType) => {
    const commaIdx = dataUrl.indexOf(",");
    f.photoMimeType = mimeType;
    f.photoBase64 = dataUrl.slice(commaIdx + 1);
    const inner = document.getElementById("mp-photoUploadInner");
    if (inner) {
      inner.innerHTML = `<img src="${dataUrl}" class="photo-preview"><div class="photo-upload-lab" style="margin-top:8px;">แตะเพื่อเปลี่ยนรูป</div>`;
    }
  });
}

function currentManagePartsHasSerial() {
  const f = managePartsForm;
  if (f.mode === "new") return f.hasSerial === "yes";
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === f.restockPartId);
  return part ? String(part.HasSerial).toLowerCase() === "yes" : false;
}

/** หมวดอะไหล่ปัจจุบัน (ใช้หา key ของ state.data ที่เก็บ S/N รายชิ้นจริง สำหรับเช็คซ้ำฝั่ง client ตอนเพิ่มลงตะกร้า) */
function currentManagePartsCategory() {
  const f = managePartsForm;
  if (f.mode === "new") return f.category;
  const part = (state.data.partsCatalog || []).find((p) => p.PartID === f.restockPartId);
  return part ? part.Category : f.category;
}

/** Phase 15: ใช้ระบบ "ตะกร้า" แบบเดียวกับหน้าเพิ่มสต๊อก MoisturLyzer/Gateway — กรอก S/N ทีละชิ้นแล้วกด Enter/+ เพิ่ม
 * รองรับรับของเข้าคลังทีเดียวหลายชิ้น (บางครั้ง 1-2 ชิ้น บางครั้ง 10-20 ชิ้น) แทนแบบเดิมที่ต้องกดเพิ่มแถวอินพุตว่างทีละแถว
 * managePartsForm.serials ยังเป็นโครงสร้างเดิม (array ของ string) — submitManagePartsForm() ด้านล่างไม่ต้องแก้อะไรเลย */
function renderQtyOrSerialArea() {
  const area = document.getElementById("mp-qtyOrSerialArea");
  if (!area) return;
  const f = managePartsForm;
  const hasSerial = currentManagePartsHasSerial();

  if (hasSerial) {
    area.innerHTML = `
      <div class="form-field">
        <label>S/N ของแต่ละชิ้น *</label>
        <div class="picker-row" style="margin-top:2px;">
          <input type="text" id="mp-serialInput" placeholder="กรอก S/N แล้วกด Enter หรือ + เพิ่ม เช่น SNS-001">
          <button type="button" class="btn-sm btn-add" id="mp-addSerialBtn">+ เพิ่ม</button>
        </div>
        <div class="table-card" style="margin-top:8px;">
          <div class="table-scroll">
            <table>
              <thead><tr><th>#</th><th>S/N</th><th></th></tr></thead>
              <tbody id="mp-serialBasketBody"></tbody>
            </table>
          </div>
        </div>
        <div class="cache-note" id="mp-serialCountNote" style="margin-top:6px;"></div>
      </div>
    `;
    const serialInput = document.getElementById("mp-serialInput");
    serialInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManagePartsSerial(); } });
    document.getElementById("mp-addSerialBtn").addEventListener("click", addManagePartsSerial);
    renderManagePartsSerialBasket();
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

/** เพิ่ม S/N จากช่องกรอกลงตะกร้า — เช็คซ้ำทั้งกับที่มีอยู่แล้วในระบบ (cache ฝั่ง client ของหมวดอะไหล่นั้นๆ) และซ้ำกันเอง
 * ในตะกร้าก่อนเพิ่ม (ตอบไว) ผลชี้ขาดจริงยังเช็คซ้ำอีกทีที่เซิร์ฟเวอร์เสมอ (handleAddPart/handleRestockPart) */
function addManagePartsSerial() {
  const input = document.getElementById("mp-serialInput");
  const msg = document.getElementById("mp-msg");
  const serial = input.value.trim();
  msg.className = "form-msg";
  msg.textContent = "";
  if (!serial) return;

  const f = managePartsForm;
  const dupInBasket = f.serials.some((s) => s.trim().toLowerCase() === serial.toLowerCase());
  if (dupInBasket) {
    msg.className = "form-msg error";
    msg.textContent = `"${serial}" ถูกเพิ่มไว้ในตะกร้าแล้ว`;
    return;
  }
  const dataKey = currentManagePartsCategory() === "Panolyzer" ? "panolyzerParts" : "colorSorterParts";
  const dupInSystem = (state.data[dataKey] || []).some((r) => String(r.SerialNo || "").trim().toLowerCase() === serial.toLowerCase());
  if (dupInSystem) {
    msg.className = "form-msg error";
    msg.textContent = `S/N "${serial}" นี้มีอยู่ในระบบแล้ว กรุณาตรวจสอบอีกครั้ง`;
    return;
  }

  // ค่าเริ่มต้นของฟอร์มคือ serials: [""] (แถวว่าง 1 แถว) — ตัดค่าว่างทิ้งก่อนเพิ่มจริงชิ้นแรก
  f.serials = f.serials.filter((s) => s.trim());
  f.serials.push(serial);
  input.value = "";
  renderManagePartsSerialBasket();
  input.focus();
}

function removeManagePartsSerial(idx) {
  managePartsForm.serials.splice(idx, 1);
  renderManagePartsSerialBasket();
}

function renderManagePartsSerialBasket() {
  const tbody = document.getElementById("mp-serialBasketBody");
  if (!tbody) return;
  const serials = managePartsForm.serials.filter((s) => s.trim());
  tbody.innerHTML = serials.length
    ? serials.map((s, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(s)}</td><td class="no-wrap"><button type="button" class="btn-sm btn-remove" onclick="removeManagePartsSerial(${i})">ลบ</button></td></tr>`).join("")
    : `<tr><td colspan="3" class="cache-note" style="text-align:center; padding:12px;">ยังไม่มีรายการ — กรอก S/N แล้วกด "+ เพิ่ม"</td></tr>`;
  document.getElementById("mp-serialCountNote").textContent = `รวมทั้งหมด ${serials.length} ชิ้น`;
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
        payload: {
          partName: f.partName.trim(), category: f.category, hasSerial, quantity: Number(f.quantity) || 0, serials: cleanSerials,
          photoBase64: f.photoBase64 || "", photoMimeType: f.photoMimeType || "",
        },
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
    managePartsForm = { mode: "new", partName: "", category: mpAssetType === "panolyzerParts" ? "Panolyzer" : "ColorSorter", hasSerial: "no", quantity: "", serials: [""], restockPartId: "", photoBase64: "", photoMimeType: "" };
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

/** เรนเดอร์ field เดียวของ genericFormModal — ใช้ร่วมกันทั้งโหมดเดิม (list เรียงตรงๆ) และโหมดจัดกลุ่มใหม่
 * (ดู openGenericFormModal opts.groups) รองรับ f.locked (แสดงไอคอนล็อก+พื้นหลังเทาเตือนว่าไม่ควรแก้บ่อย แต่ยังแก้ได้
 * ปกติ ไม่ได้ disable จริง), f.span2 (กินพื้นที่เต็ม 2 คอลัมน์ตอนอยู่ใน grid), f.hint (ข้อความเล็กใต้ช่อง) และ
 * f.type ใหม่ "date" (ใช้ตัวเลือกวันที่ของเบราว์เซอร์แทนพิมพ์เอง) */
function renderGenericFormField(f, i) {
  const extraClasses = [f.locked ? "locked" : "", f.span2 ? "span2" : ""].filter(Boolean).join(" ");
  const labelHtml = `${f.locked ? "🔒 " : ""}${escapeHtml(f.label)}`;
  const hintHtml = f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : "";
  // Phase 10: รองรับ field แบบ dropdown (type: "select") นอกเหนือจากช่องข้อความธรรมดาแบบเดิม
  if (f.type === "select") {
    // ค้นหา S/N แบบพิมพ์หา — ใช้กับ dropdown ยาวๆ ทุกจุด (รวมถึงฟอร์มแก้ไข Gateway/SimCard ที่ผูกกับรายการเบิก)
    return `<div class="form-field ${extraClasses}">
      <label>${labelHtml}</label>
      <select id="gfm-field-${i}" class="searchable-select">
        ${(f.options || []).map((o) => `<option value="${escapeAttr(o.value)}" ${String(o.value) === String(f.value) ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select>
      ${hintHtml}
    </div>`;
  }
  // Phase 12: รองรับ field แบบรหัสผ่าน (type: "password") — ซ่อนตัวอักษรที่พิมพ์ ใช้กับฟอร์มเปลี่ยนรหัสผ่านของตัวเอง
  // Phase 21: รองรับ field แบบวันที่ (type: "date") — ใช้ตัวเลือกวันที่ของเบราว์เซอร์แทนพิมพ์ข้อความเอง (ดู
  // thaiDateToIso/isoDateToThai ที่แปลงกลับไปมากับรูปแบบ "วัน/เดือน/ปี" ที่ระบบเก็บจริงในฐานข้อมูล)
  const inputType = f.type === "password" ? "password" : f.type === "date" ? "date" : "text";
  return `<div class="form-field ${extraClasses}">
    <label>${labelHtml}</label>
    <input type="${inputType}" id="gfm-field-${i}" autocomplete="${f.type === "password" ? "new-password" : "off"}" value="${escapeAttr(f.value === undefined || f.value === null ? "" : String(f.value))}">
    ${hintHtml}
  </div>`;
}

/** เปิด modal ฟอร์มทั่วไปสำหรับแก้ไขข้อมูล — fields: [{key,label,value,type?,locked?,span2?,hint?,group?}], onSave(values[])
 * opts.groups (ไม่บังคับ): { [groupKey]: { label, order } } — ถ้าใส่มา จะจัด field ที่มี f.group ตรงกันเป็นหมวดๆ
 * พร้อม header กลุ่ม + จัด grid 2 คอลัมน์บนจอกว้าง (ใช้กับฟอร์มแก้ไขอุปกรณ์ที่มีฟิลด์เยอะ ดู openEditAsset) —
 * ถ้าไม่ใส่ opts.groups จะ fallback ไปแบบเดิม (เรียง field ตรงๆ ทีละแถวคอลัมน์เดียว) เหมือนก่อนหน้านี้ทุกจุดที่เรียกใช้
 * (renamePartPrompt, แก้ไขรายการเบิก, เปลี่ยนรหัสผ่าน ฯลฯ) opts.serial (ไม่บังคับ): แสดง S/N ตัวใหญ่แยกบรรทัดใต้ title */
function openGenericFormModal(title, fields, onSave, opts) {
  opts = opts || {};
  const grouped = !!opts.groups;
  const titleEl = document.getElementById("genericFormModalTitle");
  const modalBox = document.querySelector("#genericFormModal .image-modal");
  if (grouped) {
    titleEl.innerHTML = `<div class="gfm2-title">${escapeHtml(title)}</div>${opts.serial ? `<div class="gfm2-serial">${escapeHtml(opts.serial)}</div>` : ""}`;
  } else {
    titleEl.textContent = title;
  }
  if (modalBox) modalBox.classList.toggle("gfm-wide", grouped);

  const body = document.getElementById("genericFormModalBody");
  if (grouped) {
    const byGroup = {};
    fields.forEach((f, i) => {
      const g = f.group || "other";
      (byGroup[g] = byGroup[g] || []).push(i);
    });
    const groupKeys = Object.keys(byGroup).sort((a, b) => ((opts.groups[a] || {}).order ?? 99) - ((opts.groups[b] || {}).order ?? 99));
    body.innerHTML = groupKeys.map((g) => {
      const meta = opts.groups[g] || { label: g };
      const fieldsHtml = byGroup[g].map((i) => renderGenericFormField(fields[i], i)).join("");
      return `<div class="gfm2-section"><div class="gfm2-section-label">${escapeHtml(meta.label)}</div><div class="gfm2-grid">${fieldsHtml}</div></div>`;
    }).join("");
  } else {
    body.innerHTML = fields.map((f, i) => renderGenericFormField(f, i)).join("");
  }
  enhanceSearchableSelects(body);
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

// ฟิลด์ใหม่ที่เพิ่มเข้ามาทีหลัง (เช่น SimCard_SN ของ Gateway) — เอกสารเก่าที่ย้ายมาจากระบบเดิมจะยังไม่มี key นี้อยู่
// เลย ทำให้ Object.keys(row) หาไม่เจอและไม่โผล่ในฟอร์มแก้ไข เติมค่าว่างให้ก่อนสร้างฟอร์ม (แค่ตอนเปิดฟอร์มเท่านั้น)
// เพื่อให้ Admin กรอกค่าแรกเข้าไปได้เลยผ่านหน้านี้ โดยไม่ต้องมีสคริปต์ migrate ข้อมูลเก่าแยกต่างหาก
const EXTRA_EDITABLE_FIELDS = {
  gateway: ["SimCard_SN"],
  // Admin กรอกเองได้ว่าเครื่องนี้เชื่อมต่อกับอะไรบ้าง (เช่น "Gateway 2a72e10a74") สำหรับเครื่องเก่าที่ย้ายมาจาก
  // ระบบเดิมและไม่มีประวัติการเบิกที่เชื่อมกันไว้ในระบบใหม่ — ดู computeLinkedAccessories ว่าค่านี้ไปโผล่ที่คอลัมน์
  // "เชื่อมต่อกับ" ของตาราง MoisturLyzer อย่างไร
  moisturlyzer: ["Linked_Accessories_Note"],
};

// ============================================================
// Phase 21: ปรับหน้าต่างแก้ไขข้อมูลอุปกรณ์ให้ใช้งานง่ายขึ้น — จัดกลุ่มฟิลด์เป็นหมวดๆ (แทนเรียงตาม field ดิบใน
// Firestore), ใช้ป้ายภาษาไทยที่มีอยู่แล้วใน VIEW_CONFIG.columns แทนชื่อ field ดิบ, ใช้ตัวเลือกวันที่แทนพิมพ์เอง
// สำหรับฟิลด์วันที่ และทำเครื่องหมายฟิลด์รหัสอ้างอิง (S/N หลัก, No.) ให้ดูต่างจากฟิลด์อื่นด้วยไอคอนล็อก+พื้นหลังเทา
// (ยังแก้ไขได้ปกติ ไม่ได้ disable จริง — แค่เตือนสายตาว่าไม่ควรแก้โดยไม่จำเป็น)
// ============================================================

// จัดกลุ่ม field ตามชื่อ field (ใช้ชื่อเดียวกันได้ทุกประเภทอุปกรณ์ เพราะ field ชื่อเดียวกันมีความหมายตรงกันเสมอ
// เช่น Customer_name/Location เป็น "ลูกค้า/สถานที่" ทุกที่) — field ที่ไม่ได้ระบุไว้ที่นี่ ตกไปกลุ่ม "other" อัตโนมัติ
const ASSET_FIELD_GROUP = {
  Products_Name: "product", PartName: "product", Model: "product", "Lot_No.": "product",
  MFD: "product", "Mobile No.": "product",
  Customer_name: "customer", Location: "customer", location: "customer", install_date: "customer",
  Install_device: "status", Installed_device: "status", "S/N Device": "status",
  SimCard_SN: "status", Activate_date: "status",
};
const ASSET_FIELD_GROUP_META = {
  product: { label: "ข้อมูลสินค้า/อุปกรณ์", order: 1 },
  customer: { label: "ลูกค้า/สถานที่ติดตั้ง", order: 2 },
  status: { label: "สถานะ/การเชื่อมต่อ", order: 3 },
  other: { label: "อื่นๆ/รหัสอ้างอิง", order: 4 },
};
// field ที่เก็บวันที่แบบข้อความรูปแบบ "วัน/เดือน/ปี" (เช่น "15/01/2025") — ใช้ตัวเลือกวันที่ของเบราว์เซอร์แทนพิมพ์เอง
const ASSET_DATE_FIELDS = new Set(["MFD", "install_date", "Activate_date"]);
// field ที่ควรกินพื้นที่เต็ม 2 คอลัมน์ในฟอร์ม (ข้อความมักยาว)
const ASSET_SPAN2_FIELDS = new Set(["Customer_name", "Linked_Accessories_Note"]);
// ป้ายภาษาไทยสำหรับ field ที่ไม่ได้อยู่ใน VIEW_CONFIG.columns (เช่นฟิลด์กรอกเองที่ไม่ได้โชว์เป็นคอลัมน์ตาราง)
const ASSET_FIELD_LABEL_OVERRIDES = {
  moisturlyzer: { Linked_Accessories_Note: "หมายเหตุอุปกรณ์ที่เชื่อมต่อ (กรอกเอง)" },
};

/** "15/01/2025" -> "2025-01-15" (สำหรับใส่ใน <input type="date">) — คืนค่า "" ถ้าไม่ตรงรูปแบบหรือว่าง (ให้ fallback
 * ไปใช้ช่องข้อความธรรมดาแทน กันข้อมูลเก่าที่อาจเก็บมาผิดรูปแบบหายไปโดยไม่รู้ตัว) */
function thaiDateToIso(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(str || "").trim());
  if (!m) return "";
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** "2025-01-15" -> "15/01/2025" (แปลงกลับก่อนบันทึกลงฐานข้อมูล ให้รูปแบบเดิมเป๊ะเหมือนที่ระบบอื่นๆ ในแอปคาดหวัง) */
function isoDateToThai(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || "").trim());
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

function getAssetFieldLabel(assetKey, cfg, field) {
  const override = (ASSET_FIELD_LABEL_OVERRIDES[assetKey] || {})[field];
  if (override) return override;
  const col = (cfg.columns || []).find((c) => c.field === field);
  return col ? col.label : field;
}

function getAssetFieldGroup(cfg, field) {
  if (field === cfg.serialField || field === "No") return "other";
  return ASSET_FIELD_GROUP[field] || "other";
}

function openEditAsset(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const row = (state.data[cfg.key] || []).find((r) => String(r[cfg.serialField]) === String(serial));
  if (!row) return;
  (EXTRA_EDITABLE_FIELDS[assetKey] || []).forEach((k) => { if (!(k in row)) row[k] = ""; });
  // Phase 21 (แก้บัค): เอกสารบางรายการ (เช่น Gateway ที่เพิ่มเข้าสต๊อกตรงๆ ไม่เคยผ่านการเบิกเลย) จะไม่มี field ที่
  // ระบุไว้ใน VIEW_CONFIG.columns ครบทุกตัวเก็บอยู่ใน Firestore จริง (เช่นไม่มี Customer_name/Location/
  // Activate_date/"S/N Device" เลยสักตัว) เพราะฟอร์มเดิมสร้างช่องกรอกจาก Object.keys(row) ตรงๆ — ฟิลด์ที่ไม่มีอยู่
  // จริงในเอกสารนั้นๆ จะไม่โผล่ในฟอร์มแก้ไขเลย ทำให้ Admin กรอกข้อมูลย้อนหลังไม่ได้ (ต้องมีฟิลด์นั้นอยู่แล้วถึงจะ
  // แก้ได้) เติมค่าว่างให้ทุก field ที่ระบุไว้เป็นคอลัมน์ของอุปกรณ์ประเภทนี้ก่อนเสมอ (ไม่นับ field เสมือนที่ขึ้นต้น
  // ด้วย "_" เพราะเป็นค่า compute ล้วนๆ ไม่ใช่ field จริงในฐานข้อมูล) เพื่อให้ช่องกรอกครบทุกครั้งไม่ว่าเอกสารเดิมจะมี
  // ข้อมูลอยู่ก่อนหรือไม่
  (cfg.columns || []).forEach((c) => {
    if (c.field.startsWith("_")) return;
    if (!(c.field in row)) row[c.field] = "";
  });

  const fields = Object.keys(row).filter((k) => !k.startsWith("_")).map((k) => {
    const rawVal = row[k];
    // ใช้ตัวเลือกวันที่ได้เฉพาะตอนค่าที่มีอยู่ว่างเปล่า หรือตรงรูปแบบ วัน/เดือน/ปี เป๊ะเท่านั้น — ถ้าข้อมูลเก่าเก็บ
    // มาผิดรูปแบบ (พิมพ์มือแบบอื่น) ให้ fallback เป็นช่องข้อความธรรมดาแทน กันข้อมูลเพี้ยน/หายตอนแปลงกลับไปมา
    const useDatePicker = ASSET_DATE_FIELDS.has(k) && (!rawVal || thaiDateToIso(rawVal));
    const locked = k === cfg.serialField || k === "No";
    return {
      key: k,
      label: getAssetFieldLabel(assetKey, cfg, k),
      value: useDatePicker ? thaiDateToIso(rawVal) : (rawVal === undefined || rawVal === null ? "" : rawVal),
      type: useDatePicker ? "date" : "text",
      group: getAssetFieldGroup(cfg, k),
      locked,
      span2: ASSET_SPAN2_FIELDS.has(k),
      hint: k === cfg.serialField ? "รหัสอ้างอิงหลัก — แก้ไขได้แต่ควรระวัง" : "",
      _isDateField: ASSET_DATE_FIELDS.has(k),
    };
  });

  openGenericFormModal(cfg.title, fields, async (values) => {
    const updates = {};
    fields.forEach((f, i) => {
      updates[f.key] = f.type === "date" ? isoDateToThai(values[i]) : values[i];
    });
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
  }, { groups: ASSET_FIELD_GROUP_META, serial });
}

// ============================================================
// ฟีเจอร์ "ย้าย/เคลม" — ย้ายอุปกรณ์ที่เบิกออกไปแล้วไปลูกค้า/สถานที่ใหม่ (ไม่ต้องคืนเข้า Stock ก่อน) หรือเคลม
// (ลูกค้าแจ้งเครื่องมีปัญหา ถอดออกจากลูกค้า เข้าสถานะ "อยู่ระหว่างเคลม" แล้วเบิกเครื่องทดแทนให้ทันที) ใช้เมนู/โมดัล
// เดียวกัน เปิดจากปุ่ม "ย้าย/เคลม" ในตารางอุปกรณ์ (Admin เท่านั้น เฉพาะแถวที่เบิกออกไปแล้ว)
// ============================================================
let transferClaimState = { assetKey: null, cfg: null, serial: null, row: null, tab: "transfer" };

function openTransferClaimModal(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const row = (state.data[cfg.key] || []).find((r) => String(r[cfg.serialField]) === String(serial));
  if (!row) return;
  transferClaimState = { assetKey, cfg, serial, row, tab: "transfer" };
  document.getElementById("transferClaimModalTitle").textContent = `ย้าย/เคลม — ${cfg.title} ${serial}`;
  renderTransferClaimModalBody();
  document.getElementById("transferClaimModal").style.display = "flex";
}

function closeTransferClaimModal() {
  document.getElementById("transferClaimModal").style.display = "none";
}

function switchTransferClaimTab(tab) {
  transferClaimState.tab = tab;
  renderTransferClaimModalBody();
}

/** ตัวเลือก Serial ที่ยังว่างอยู่ใน Stock ของประเภทเดียวกัน — ใช้เลือกเครื่องทดแทนตอนเคลม */
function getStockSerialsForAssetKey(assetKey) {
  const cfg = VIEW_CONFIG[assetKey];
  return (state.data[assetKey] || [])
    .filter((row) => isStockRow(row, cfg.stockField, cfg.stockRequiresField))
    .map((row) => String(row[cfg.serialField] || ""))
    .filter(Boolean)
    .sort();
}

function renderTransferClaimModalBody() {
  const { assetKey, serial, row, tab } = transferClaimState;
  const body = document.getElementById("transferClaimModalBody");
  const msgEl = document.getElementById("transferClaimModalMsg");
  msgEl.className = "form-msg";
  msgEl.textContent = "";

  const fromCustomer = String(row.Customer_name || "").trim();
  const fromLocation = String(row.Location || "").trim();

  const tabsHtml = `
    <div class="tc-tabs">
      <div class="tc-tab ${tab === "transfer" ? "active" : ""}" onclick="switchTransferClaimTab('transfer')">ย้ายอุปกรณ์</div>
      <div class="tc-tab ${tab === "claim" ? "active" : ""}" onclick="switchTransferClaimTab('claim')">เคลม (เปลี่ยนเครื่องให้ลูกค้า)</div>
    </div>`;

  let fieldsHtml = "";
  let submitLabel = "";

  const isAdmin = state.user.role === "Admin";
  // Staff ส่งได้แค่ "คำขอ" ที่ต้องรอ Admin อนุมัติก่อนถึงจะมีผลจริง — Admin ยังคงทำได้ทันทีเหมือนเดิม (ดู
  // submitTransferAsset/submitClaimAsset ด้านล่างที่แยกเรียก action คนละตัวตาม role)
  const roleNoticeHtml = isAdmin ? "" : `<div class="info-box">📋 คำขอนี้จะถูกส่งไปรออนุมัติจาก Admin ก่อน ยังไม่มีผลกับข้อมูลจนกว่าจะอนุมัติ</div>`;

  if (tab === "transfer") {
    submitLabel = isAdmin ? "ยืนยันย้าย" : "ส่งคำขอย้าย";
    let connectFieldHtml = "";
    if (assetKey === "gateway" && normalizeGatewayModel(row[GATEWAY_MODEL_FIELD]) === GATEWAY_MODEL_PANOLYZER) {
      // Gateway รุ่น EPG-001S ใช้กับ Panolyzer เท่านั้น — ให้เลือกเชื่อมกับเครื่อง Panolyzer ที่ "ยังไม่มี Gateway
      // ผูกอยู่" เท่านั้น (กันเลือกซ้ำเครื่องที่ผูกไปแล้ว) แทนที่จะโชว์ตัวเลือก MoisturLyzer แบบเดิม
      const options = (state.data.panolyzer || []).filter((p) => !p.linkedGatewaySerial);
      connectFieldHtml = `
        <div class="form-field">
          <label>เชื่อมต่อกับเครื่อง Panolyzer เครื่องไหน (ไม่บังคับ)</label>
          <select id="tc-connect" class="searchable-select">
            <option value="">ยังไม่ระบุตอนนี้</option>
            ${options.map((o) => {
              const s = String(o[PANOLYZER_SERIAL_FIELD] || "");
              const client = String(o["Client name"] || "").trim();
              return `<option value="${escapeAttr(s)}">${escapeHtml(s)}${client ? " — " + escapeHtml(client) : ""}</option>`;
            }).join("")}
          </select>
          ${!options.length ? `<div class="hint">ไม่มีเครื่อง Panolyzer ที่ยังไม่มี Gateway ผูกอยู่ในระบบตอนนี้</div>` : ""}
        </div>`;
    } else if (assetKey === "gateway") {
      const options = getLinkableIssuedMoisturlyzers();
      connectFieldHtml = `
        <div class="form-field">
          <label>เชื่อมต่อกับ MoisturLyzer เครื่องไหน (ไม่บังคับ)</label>
          <select id="tc-connect" class="searchable-select">
            <option value="">ยังไม่ระบุตอนนี้</option>
            ${options.map((o) => `<option value="${escapeAttr(o.serial)}">${escapeHtml(o.serial)}${o.customer ? " — " + escapeHtml(o.customer) : ""}</option>`).join("")}
          </select>
        </div>`;
    } else if (assetKey === "simcard") {
      const options = getLinkableIssuedGateways();
      connectFieldHtml = `
        <div class="form-field">
          <label>เชื่อมต่อกับ Gateway เครื่องไหน (ไม่บังคับ)</label>
          <select id="tc-connect" class="searchable-select">
            <option value="">ยังไม่ระบุตอนนี้</option>
            ${options.map((o) => `<option value="${escapeAttr(o.serial)}">${escapeHtml(o.serial)}${o.customer ? " — " + escapeHtml(o.customer) : ""}</option>`).join("")}
          </select>
        </div>`;
    }
    const linkedSim = assetKey === "gateway" ? String(row[GATEWAY_SIMCARD_FIELD] || "").trim() : "";
    const moveSimHtml = linkedSim
      ? `<div class="form-field checkbox-field">
           <label><input type="checkbox" id="tc-move-sim" checked> ย้าย SimCard ที่เสียบอยู่ (${escapeHtml(linkedSim)}) ไปด้วย</label>
         </div>`
      : "";
    fieldsHtml = `
      ${roleNoticeHtml}
      <div class="info-box">ย้ายจาก: <strong>${escapeHtml(fromCustomer || "-")}</strong> · ${escapeHtml(fromLocation || "-")}</div>
      <div class="form-field">
        <label>ลูกค้าใหม่ *</label>
        <input type="text" id="tc-customer" placeholder="ชื่อลูกค้าใหม่">
      </div>
      <div class="form-field">
        <label>สถานที่ใหม่</label>
        <input type="text" id="tc-location" placeholder="สถานที่ติดตั้งใหม่">
      </div>
      ${connectFieldHtml}
      ${moveSimHtml}
    `;
  } else {
    submitLabel = isAdmin ? "ยืนยันเคลม" : "ส่งคำขอเคลม";
    const stockOptions = getStockSerialsForAssetKey(assetKey).filter((s) => s !== serial);
    fieldsHtml = `
      ${roleNoticeHtml}
      <div class="info-box">ข้อมูลปัจจุบัน: <strong>${escapeHtml(fromCustomer || "-")}</strong> · ${escapeHtml(fromLocation || "-")}</div>
      <div class="form-field">
        <label>เหตุผลการเคลม (ไม่บังคับ)</label>
        <textarea id="tc-reason" placeholder="เช่น เชื่อมต่อหลุดบ่อย, จอไม่ติด"></textarea>
      </div>
      <div class="form-field">
        <label>เลือกเครื่องทดแทนจาก Stock</label>
        <select id="tc-replacement" class="searchable-select">
          ${!stockOptions.length ? `<option value="">ไม่มีเครื่องว่างใน Stock ตอนนี้</option>` : `<option value="">ไม่ระบุตอนนี้ (ถอดออกอย่างเดียวก่อน)</option>`}
          ${stockOptions.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join("")}
        </select>
        <div class="hint">ถ้าเลือกเครื่องทดแทน ระบบจะเบิกเครื่องนั้นให้ลูกค้าเดิมทันที ไม่ต้องกรอกข้อมูลลูกค้าซ้ำ</div>
      </div>
    `;
  }

  body.innerHTML = tabsHtml + fieldsHtml;
  enhanceSearchableSelects(body);

  const submitBtn = document.getElementById("transferClaimSubmitBtn");
  submitBtn.textContent = submitLabel;
  submitBtn.onclick = tab === "transfer" ? submitTransferAsset : submitClaimAsset;
}

async function submitTransferAsset() {
  const { cfg, serial } = transferClaimState;
  const msgEl = document.getElementById("transferClaimModalMsg");
  const newCustomer = (document.getElementById("tc-customer").value || "").trim();
  const newLocation = (document.getElementById("tc-location").value || "").trim();
  const connectEl = document.getElementById("tc-connect");
  const connectSerial = connectEl ? connectEl.value : "";
  const moveSimEl = document.getElementById("tc-move-sim");
  const moveLinkedSimCard = moveSimEl ? moveSimEl.checked : false;

  if (!newCustomer) {
    msgEl.className = "form-msg error";
    msgEl.textContent = "กรุณากรอกชื่อลูกค้าใหม่";
    return;
  }

  const isAdmin = state.user.role === "Admin";
  const action = isAdmin ? "transferAsset" : "requestTransfer";
  const confirmed = await showConfirm(
    isAdmin
      ? `ยืนยันย้าย ${cfg.title} ${serial} ไปที่ลูกค้า "${newCustomer}"?`
      : `ยืนยันส่งคำขอย้าย ${cfg.title} ${serial} ไปที่ลูกค้า "${newCustomer}"? คำขอนี้ต้องรอ Admin อนุมัติก่อนถึงจะมีผลจริง`
  );
  if (!confirmed) return;

  const submitBtn = document.getElementById("transferClaimSubmitBtn");
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true; submitBtn.textContent = isAdmin ? "กำลังย้าย..." : "กำลังส่งคำขอ...";
  try {
    const res = await apiPost({
      action, token: state.token, assetType: cfg.assetType, serialNo: serial,
      newCustomer, newLocation, connectSerial, moveLinkedSimCard,
    });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      throw new Error(transferClaimErrorMessage(res.error, res.conflicts));
    }
    await refreshInBackground(true);
    closeTransferClaimModal();
    renderCurrentView();
    if (!isAdmin) await showAlert("ส่งคำขอย้ายเรียบร้อยแล้ว รอ Admin อนุมัติ", "success");
  } catch (err) {
    msgEl.className = "form-msg error";
    msgEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = originalText;
  }
}

async function submitClaimAsset() {
  const { cfg, serial } = transferClaimState;
  const msgEl = document.getElementById("transferClaimModalMsg");
  const reason = (document.getElementById("tc-reason").value || "").trim();
  const replacementEl = document.getElementById("tc-replacement");
  const replacementSerialNo = replacementEl ? replacementEl.value : "";

  const isAdmin = state.user.role === "Admin";
  const action = isAdmin ? "claimAsset" : "requestClaim";
  const confirmMsg = isAdmin
    ? (replacementSerialNo
        ? `ยืนยันเคลม ${cfg.title} ${serial}? ระบบจะถอดเครื่องนี้ออก และเบิกเครื่องทดแทน ${replacementSerialNo} ให้ลูกค้าเดิมทันที`
        : `ยืนยันเคลม ${cfg.title} ${serial}? ระบบจะถอดเครื่องนี้ออกเป็นสถานะ "อยู่ระหว่างเคลม" (ยังไม่เลือกเครื่องทดแทน)`)
    : `ยืนยันส่งคำขอเคลม ${cfg.title} ${serial}? คำขอนี้ต้องรอ Admin อนุมัติก่อนถึงจะมีผลจริง`;
  const confirmed = await showConfirm(confirmMsg);
  if (!confirmed) return;

  const submitBtn = document.getElementById("transferClaimSubmitBtn");
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true; submitBtn.textContent = isAdmin ? "กำลังเคลม..." : "กำลังส่งคำขอ...";
  try {
    const res = await apiPost({
      action, token: state.token, assetType: cfg.assetType, serialNo: serial,
      reason, replacementSerialNo,
    });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      throw new Error(transferClaimErrorMessage(res.error, res.conflicts));
    }
    await refreshInBackground(true);
    closeTransferClaimModal();
    renderCurrentView();
    if (!isAdmin) await showAlert("ส่งคำขอเคลมเรียบร้อยแล้ว รอ Admin อนุมัติ", "success");
  } catch (err) {
    msgEl.className = "form-msg error";
    msgEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = originalText;
  }
}

/** ปิดเคสเคลม — คืนเข้าสต็อก (ซ่อมเสร็จ) หรือ ตัดจำหน่าย (ซ่อมไม่ได้) เรียกตรงจากปุ่มในตาราง ไม่ผ่านโมดัล */
// ============================================================
// Phase: หน้ารวม "รอเคลมจาก Supplier" (Admin เท่านั้น) — รวมทุกประเภทอุปกรณ์ (MoisturLyzer/Gateway/SimCard) ที่ถอด
// ออกจากลูกค้าไปเคลมแล้ว (สถานะ "Claim") ไว้ในตารางเดียวพร้อมคอลัมน์ "ประเภท" กำกับ แทนที่จะต้องไล่เปิดทีละหน้า
// เพื่อดูว่ามีอะไรค้างรอ Supplier อยู่บ้าง — ใช้กลไก resolveClaimAction เดิมทุกอย่าง (ไม่มี action ใหม่ฝั่ง backend)
// ============================================================
const SUPPLIER_CLAIM_TYPE_META = {
  moisturlyzer: { label: "MoisturLyzer", color: "#17A672" },
  gateway: { label: "Gateway", color: "#2f6fb0" },
  simcard: { label: "SimCard", color: "#8B5CF6" },
};

/** รวมแถวที่อยู่ระหว่างเคลม (isClaimedRow) จากทั้ง 3 ประเภทเข้าเป็นลิสต์เดียว เรียงตามที่รอนานสุดก่อน */
function getSupplierClaimRows() {
  const out = [];
  TRANSFER_CLAIM_ASSET_KEYS.forEach((assetKey) => {
    const cfg = VIEW_CONFIG[assetKey];
    (state.data[assetKey] || []).forEach((row) => {
      if (isClaimedRow(row, cfg)) {
        out.push({ assetKey, cfg, row, serial: String(row[cfg.serialField] || "") });
      }
    });
  });
  out.sort((a, b) => {
    const da = new Date(a.row.ClaimedAt || 0).getTime() || 0;
    const db = new Date(b.row.ClaimedAt || 0).getTime() || 0;
    return da - db; // เก่าสุด (รอนานสุด) ขึ้นก่อน
  });
  return out;
}

/** แปลงวันที่เคลม (ClaimedAt) เป็นจำนวนวันที่รอมาแล้ว — ให้ Admin เห็นเร็วๆ ว่ารายการไหนค้างนานผิดปกติ */
function daysWaitingLabel(dateStr) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "-";
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  return days === 0 ? "วันนี้" : `${days} วัน`;
}

function renderSupplierClaimView() {
  const content = document.getElementById("viewContent");
  if (state.user.role !== "Admin") {
    content.innerHTML = `<div class="empty-state">หน้านี้สำหรับ Admin เท่านั้น</div>`;
    return;
  }
  const items = getSupplierClaimRows();
  const mobile = isMobileViewport();

  content.innerHTML = `
    <div class="form-card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3 style="margin:0;">รอเคลมจาก Supplier</h3>
        <div class="cache-note">${items.length} รายการ — รวมทุกประเภทอุปกรณ์ที่ถอดออกจากลูกค้าไปเคลมแล้ว ยังรอผลจาก Supplier เรียงตามที่รอนานสุดก่อน</div>
      </div>
    </div>
    <div style="margin-top:14px;">
      ${!items.length
        ? `<div class="empty-state">ไม่มีรายการที่รอเคลมอยู่ในขณะนี้</div>`
        : mobile
          ? `<div id="scCards" class="mcard-list"></div>`
          : `<div class="table-card">
              <div class="table-scroll">
                <table>
                  <thead><tr><th>ประเภท</th><th>S/N</th><th>ลูกค้าเดิม</th><th>สถานที่เดิม</th><th>เหตุผลการเคลม</th><th>เคลมเมื่อ</th><th>รอมาแล้ว</th><th>จัดการ</th></tr></thead>
                  <tbody id="scTbody"></tbody>
                </table>
              </div>
            </div>`
      }
    </div>
  `;

  if (!items.length) return;
  if (mobile) renderSupplierClaimCards(items); else renderSupplierClaimTable(items);
}

function renderSupplierClaimTable(items) {
  const tbody = document.getElementById("scTbody");
  if (!tbody) return;
  tbody.innerHTML = items.map(({ assetKey, row, serial }) => {
    const meta = SUPPLIER_CLAIM_TYPE_META[assetKey];
    return `<tr>
      <td><span class="badge-linked" style="background:${meta.color}22; color:${meta.color};">${escapeHtml(meta.label)}</span></td>
      <td>${escapeHtml(serial)}</td>
      <td>${escapeHtml(row.ClaimedFromCustomer || "-")}</td>
      <td>${escapeHtml(row.ClaimedFromLocation || "-")}</td>
      <td>${escapeHtml(row.ClaimReason || "-")}</td>
      <td>${escapeHtml(formatDateTh(row.ClaimedAt))}</td>
      <td>${escapeHtml(daysWaitingLabel(row.ClaimedAt))}</td>
      <td class="no-wrap">
        <button class="btn-sm btn-primary" onclick="resolveClaimAction('${escapeAttr(assetKey)}', '${escapeAttr(serial)}', 'toStock')">คืนเข้าสต็อก</button>
        <button class="btn-sm btn-remove" onclick="resolveClaimAction('${escapeAttr(assetKey)}', '${escapeAttr(serial)}', 'writeOff')">ตัดจำหน่าย</button>
      </td>
    </tr>`;
  }).join("");
}

function renderSupplierClaimCards(items) {
  const wrap = document.getElementById("scCards");
  if (!wrap) return;
  wrap.innerHTML = items.map(({ assetKey, row, serial }) => {
    const meta = SUPPLIER_CLAIM_TYPE_META[assetKey];
    return `
      <div class="mcard">
        <div class="mcard-head">
          <div>
            <div class="mcard-title">${escapeHtml(serial)}</div>
            <div class="mcard-sub">${escapeHtml(meta.label)}</div>
          </div>
          <span class="mcard-pill claim">รอมา ${escapeHtml(daysWaitingLabel(row.ClaimedAt))}</span>
        </div>
        <div class="mcard-row"><div class="mcard-label">ลูกค้าเดิม</div><div class="mcard-val">${escapeHtml(row.ClaimedFromCustomer || "-")}</div></div>
        <div class="mcard-row"><div class="mcard-label">สถานที่เดิม</div><div class="mcard-val">${escapeHtml(row.ClaimedFromLocation || "-")}</div></div>
        <div class="mcard-row"><div class="mcard-label">เหตุผล</div><div class="mcard-val">${escapeHtml(row.ClaimReason || "-")}</div></div>
        <div class="mcard-row"><div class="mcard-label">เคลมเมื่อ</div><div class="mcard-val">${escapeHtml(formatDateTh(row.ClaimedAt))}</div></div>
        <div class="mcard-actions">
          <button class="btn-sm btn-primary" onclick="resolveClaimAction('${escapeAttr(assetKey)}', '${escapeAttr(serial)}', 'toStock')">คืนเข้าสต็อก</button>
          <button class="btn-sm btn-remove" onclick="resolveClaimAction('${escapeAttr(assetKey)}', '${escapeAttr(serial)}', 'writeOff')">ตัดจำหน่าย</button>
        </div>
      </div>`;
  }).join("");
}

async function resolveClaimAction(assetKey, serial, resolution) {
  const cfg = VIEW_CONFIG[assetKey];
  const label = resolution === "toStock" ? "คืนเข้าสต็อก" : "ตัดจำหน่าย";
  const confirmed = await showConfirm(`ยืนยัน "${label}" สำหรับ ${cfg.title} ${serial}?`, resolution === "writeOff" ? { type: "warning", danger: true } : {});
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "resolveClaim", token: state.token, assetType: cfg.assetType, serialNo: serial, resolution });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(transferClaimErrorMessage(res.error), "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

/** คืนเครื่องที่ "ตัดจำหน่ายแล้ว" กลับเข้าสต็อก (เผื่อกดตัดจำหน่ายผิด หรือซ่อมสำเร็จภายหลัง) เรียกตรงจากปุ่มในตาราง */
async function restoreWrittenOffAction(assetKey, serial) {
  const cfg = VIEW_CONFIG[assetKey];
  const confirmed = await showConfirm(`ยืนยันคืนเข้าสต็อก ${cfg.title} ${serial}? (เครื่องนี้เคยถูกตัดจำหน่ายไว้)`);
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "restoreWrittenOffAsset", token: state.token, assetType: cfg.assetType, serialNo: serial });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(transferClaimErrorMessage(res.error), "error");
      return;
    }
    await refreshInBackground(true);
    renderCurrentView();
  } catch (err) {
    await showAlert("เกิดข้อผิดพลาด: " + err.message, "error");
  }
}

/** Phase 15: เพิ่มสต๊อก MoisturLyzer/Gateway/SimCard ใหม่เข้าคลังทันที (Admin เท่านั้น) — แบบ "ตะกร้า" ฝังอยู่ในหน้า
 * "จัดการ Stock/อะไหล่" โดยตรง (ไม่ใช้โมดัลเหมือนเดิมอีกต่อไป เพราะย้ายมารวมกับหน้าเต็มหน้าแล้ว) เพราะบางครั้งรับของ
 * จริงเข้าคลังแค่ 1-2 ชิ้น แต่บางครั้งรับมาทีเดียว 10-20 ชิ้น กรอกฟิลด์ที่ใช้ร่วมกันทั้งล็อต (Products_Name/Model/
 * MFD/Lot_No. ของ MoisturLyzer, Model ของ Gateway, SimCard ไม่มีฟิลด์ร่วมเลย) แค่ครั้งเดียว แล้วเพิ่มทีละชิ้นลงตะกร้า
 * ได้เรื่อยๆ ก่อนกดบันทึกทั้งหมดพร้อมกัน (all-or-nothing — ถ้ามีชิ้นไหนซ้ำ เซิร์ฟเวอร์จะไม่บันทึกอะไรเลยสักแถว)
 * itemFields = ฟิลด์ที่ต่างกันต่อชิ้น (MoisturLyzer/Gateway มี 1 ฟิลด์ เช่น Product ID / S/N Gateway; SimCard มี 2
 * ฟิลด์คือ S/N ซิม + Mobile No. กรอกคู่กันเสมอเพราะทราบเบอร์ตั้งแต่รับซิมมาแล้ว — ไม่มีฟิลด์ Activate_date ในฟอร์มนี้
 * เลยตามที่ตั้งใจ ปล่อยว่างไว้จนกว่า AIS จะ Activate แล้วค่อยแก้ไขทีหลัง) */
const ADDSTOCK_ITEM_FIELD_DEFS = {
  moisturlyzer: [{ field: "Product ID", label: "Product ID" }],
  gateway: [{ field: "S/N Gateway", label: "S/N Gateway" }],
  simcard: [{ field: "S/N", label: "S/N ซิม" }, { field: "Mobile No.", label: "เบอร์โทร" }],
};

/** ดึงค่าที่เคยกรอกไว้แล้วของฟิลด์หนึ่งๆ จากข้อมูลที่โหลดไว้ในเครื่อง (state.data) มาทำเป็นรายการ dropdown แบบ
 * "เลือกจากของเดิม" — ไม่ต้องยิง request เพิ่ม เพราะ state.data โหลดมาแสดงตารางอยู่แล้ว เรียงค่าล่าสุดที่เคยกรอกไว้
 * ขึ้นก่อน (ไล่จากท้ายแถวย้อนขึ้นไป) สมมติว่าแถวใหม่ถูกเพิ่มต่อท้ายเรื่อยๆ ตามลำดับเวลา */
function getDistinctFieldValues(assetKey, field) {
  const rows = state.data[assetKey] || [];
  const seen = new Set();
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = String(rows[i][field] || "").trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

let addStockForm = { assetKey: null, cfg: null, commonFields: [], common: {}, itemFields: [], items: [] };

function renderAddStockInlineUI(area, assetKey) {
  const cfg = VIEW_CONFIG[assetKey];
  let commonFields;

  if (assetKey === "moisturlyzer") {
    const modelOptions = getDistinctFieldValues("moisturlyzer", "Model");
    const mfdOptions = getDistinctFieldValues("moisturlyzer", "MFD");
    commonFields = [
      { key: "Products_Name", label: "ชื่อสินค้า *", value: "MoisturLyzer" },
      { key: "Model", label: "รุ่น (Model) *", type: "combo", options: modelOptions, value: modelOptions[0] || "" },
      { key: "MFD", label: "MFD (วันที่ผลิต) — ใช้ค่าเดียวกันทั้งตะกร้า", type: "combo", options: mfdOptions, value: mfdOptions[0] || "" },
      { key: "Lot_No.", label: "Lot No. — ใช้ค่าเดียวกันทั้งตะกร้า", value: "" },
    ];
  } else if (assetKey === "gateway") {
    commonFields = [
      {
        key: "Model", label: "รุ่น (Model) * — ใช้รุ่นเดียวกันทั้งตะกร้า", type: "select", value: GATEWAY_MODEL_MOISTURLYZER,
        options: [
          { value: GATEWAY_MODEL_MOISTURLYZER, label: "EPG-001B — ใช้กับ MoisturLyzer (เลือกจากสต็อกได้ตอนเบิก)" },
          { value: GATEWAY_MODEL_PANOLYZER, label: "EPG-001S — ใช้กับ Panolyzer (นับสต็อกไว้เฉยๆ)" },
        ],
      },
    ];
  } else if (assetKey === "simcard") {
    commonFields = []; // SimCard ไม่มีฟิลด์ร่วม (ไม่มีแนวคิด Model/MFD เหมือน MoisturLyzer/Gateway)
  } else {
    return; // ไม่รองรับประเภทอื่น (อะไหล่ใช้ renderPartsSubUI แทน)
  }

  const itemFields = ADDSTOCK_ITEM_FIELD_DEFS[assetKey];
  addStockForm = {
    assetKey, cfg, commonFields, itemFields,
    common: Object.fromEntries(commonFields.map((f) => [f.key, f.value])),
    items: [],
  };

  const commonFieldsHtml = commonFields.map((f, i) => {
    if (f.type === "select") {
      return `<div class="form-field">
        <label>${escapeHtml(f.label)}</label>
        <select id="as-common-${i}">
          ${f.options.map((o) => `<option value="${escapeAttr(o.value)}" ${o.value === addStockForm.common[f.key] ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
        </select>
      </div>`;
    }
    if (f.type === "combo") {
      // dropdown จากค่าที่เคยกรอกไว้แล้ว + ตัวเลือก "อื่นๆ" ให้พิมพ์ค่าใหม่เอง (สำหรับกรอกผ่านมือถือได้เร็วขึ้น)
      const hasOpts = (f.options || []).length > 0;
      return `<div class="form-field">
        <label>${escapeHtml(f.label)}</label>
        <select id="as-common-${i}">
          ${(f.options || []).map((o) => `<option value="${escapeAttr(o)}" ${o === addStockForm.common[f.key] ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
          <option value="__other__" ${!hasOpts ? "selected" : ""}>+ อื่นๆ (ระบุใหม่)</option>
        </select>
        <input type="text" id="as-common-${i}-other" placeholder="พิมพ์ค่าใหม่" style="margin-top:8px; ${hasOpts ? "display:none;" : ""}">
      </div>`;
    }
    return `<div class="form-field">
      <label>${escapeHtml(f.label)}</label>
      <input type="text" id="as-common-${i}" value="${escapeAttr(addStockForm.common[f.key] || "")}">
    </div>`;
  }).join("");

  const itemInputsHtml = itemFields.map((f, i) => `
    <div class="form-field">
      <label>${escapeHtml(f.label)} *</label>
      <input type="text" id="as-item-${i}" placeholder="กรอก${escapeHtml(f.label)}">
    </div>
  `).join("");

  area.innerHTML = `
    ${commonFields.length ? `<div class="form-grid full">${commonFieldsHtml}</div>` : ""}
    <div class="picker-row" style="margin-top:2px; align-items:flex-end;">
      ${itemInputsHtml}
      <button type="button" class="btn-sm btn-add" id="as-addBtn">+ เพิ่ม</button>
    </div>
    <div class="table-card" style="margin-top:10px;">
      <div class="table-scroll">
        <table>
          <thead><tr><th>#</th>${itemFields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join("")}<th></th></tr></thead>
          <tbody id="as-basketBody"></tbody>
        </table>
      </div>
    </div>
    <div class="cache-note" id="as-countNote" style="margin-top:8px;"></div>
    <div class="form-msg" style="display:block; background:var(--green-light); color:var(--green-dark); margin-top:14px;">
      ${escapeHtml(cfg.title)}ทุกชิ้นที่เพิ่มจะเข้าสถานะ "Stock" ทันที — พร้อมให้เลือกเบิกได้เลยโดยไม่ต้องรออนุมัติ
    </div>
    ${assetKey === "gateway" ? `<div class="form-msg" id="as-gatewayWarn" style="display:none; background:#FFF4E5; color:#8a5300; margin-top:8px;">
      รุ่น EPG-001S ยังไม่ถูกดึงมาใช้ในขั้นตอนเบิก Panolyzer (ระบบเบิกยังใช้การกรอก S/N อิสระเหมือนเดิม) — เพิ่มไว้ก่อนเพื่อการนับสต็อกเท่านั้น
    </div>` : ""}
    ${assetKey === "simcard" ? `<div class="form-msg" style="display:block; background:#FFF4E5; color:#8a5300; margin-top:8px;">
      หมายเหตุ: ไม่ต้องกรอกวันที่เปิดใช้บริการ (Activate_date) ที่นี่ — ซิมจะเข้าสถานะ "Stock" แต่ยังเบิกไม่ได้จนกว่าจะแก้ไขวันที่ Activate ทีหลัง (หลัง AIS เปิดใช้งานจริง)
    </div>` : ""}
    <div id="as-msg" class="form-msg"></div>
    <button class="btn-primary" id="as-submitBtn" style="margin-top:12px;">บันทึกเข้าสต๊อก</button>
  `;

  commonFields.forEach((f, i) => {
    const el = document.getElementById(`as-common-${i}`);
    if (f.type === "combo") {
      const otherInput = document.getElementById(`as-common-${i}-other`);
      el.addEventListener("change", (e) => {
        if (e.target.value === "__other__") {
          otherInput.style.display = "block";
          otherInput.value = "";
          addStockForm.common[f.key] = "";
          otherInput.focus();
        } else {
          otherInput.style.display = "none";
          addStockForm.common[f.key] = e.target.value;
        }
      });
      otherInput.addEventListener("input", (e) => {
        addStockForm.common[f.key] = e.target.value;
      });
      return;
    }
    el.addEventListener(f.type === "select" ? "change" : "input", (e) => {
      addStockForm.common[f.key] = e.target.value;
      if (assetKey === "gateway" && f.key === "Model") syncGatewayAddStockWarn();
    });
  });

  itemFields.forEach((f, i) => {
    document.getElementById(`as-item-${i}`).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addItemToAddStockBasket(); }
    });
  });
  document.getElementById("as-addBtn").addEventListener("click", addItemToAddStockBasket);
  document.getElementById("as-submitBtn").addEventListener("click", submitAddStockBasket);

  if (assetKey === "gateway") syncGatewayAddStockWarn();
  renderAddStockBasketOnly();
}

function syncGatewayAddStockWarn() {
  const warn = document.getElementById("as-gatewayWarn");
  if (warn) warn.style.display = addStockForm.common.Model === GATEWAY_MODEL_PANOLYZER ? "block" : "none";
}

/** เพิ่ม 1 ชิ้นจากช่องกรอก (1 หรือ 2 ฟิลด์แล้วแต่ประเภท) ลงตะกร้า — เช็คซ้ำทั้งกับของที่มีอยู่แล้วในระบบ (cache ฝั่ง
 * client) และซ้ำกันเองในตะกร้า ก่อนเพิ่ม (ตอบไวไม่ต้องรอเซิร์ฟเวอร์) เช็คแยกอิสระต่อฟิลด์ (SimCard: S/N กับ Mobile No.
 * คนละชุด) ผลชี้ขาดจริงยังเช็คซ้ำอีกทีตอนกดบันทึกที่เซิร์ฟเวอร์เสมอ */
function addItemToAddStockBasket() {
  const { itemFields, items, assetKey } = addStockForm;
  const msg = document.getElementById("as-msg");
  msg.className = "form-msg";
  msg.textContent = "";

  const values = itemFields.map((f, i) => document.getElementById(`as-item-${i}`).value.trim());
  if (values.every((v) => !v)) return; // ยังไม่ได้กรอกอะไรเลยสักฟิลด์ — เงียบๆ ไม่ต้องขึ้น error
  if (values.some((v) => !v)) {
    msg.className = "form-msg error";
    msg.textContent = `กรุณากรอก ${itemFields.map((f) => f.label).join(" และ ")} ให้ครบทุกช่อง`;
    return;
  }

  const candidate = {};
  itemFields.forEach((f, i) => { candidate[f.field] = values[i]; });

  for (const f of itemFields) {
    const dupInBasket = items.some((it) => it[f.field].toLowerCase() === candidate[f.field].toLowerCase());
    if (dupInBasket) {
      msg.className = "form-msg error";
      msg.textContent = `"${candidate[f.field]}" (${f.label}) ถูกเพิ่มไว้ในตะกร้าแล้ว`;
      return;
    }
  }
  const existingRows = state.data[assetKey] || [];
  for (const f of itemFields) {
    const dupInSystem = existingRows.some((r) => String(r[f.field] || "").trim().toLowerCase() === candidate[f.field].toLowerCase());
    if (dupInSystem) {
      msg.className = "form-msg error";
      msg.textContent = `"${candidate[f.field]}" (${f.label}) มีอยู่ในระบบแล้ว กรุณาตรวจสอบอีกครั้ง`;
      return;
    }
  }

  items.push(candidate);
  itemFields.forEach((f, i) => { document.getElementById(`as-item-${i}`).value = ""; });
  renderAddStockBasketOnly();
  document.getElementById("as-item-0").focus();
}

function removeAddStockItem(index) {
  addStockForm.items.splice(index, 1);
  renderAddStockBasketOnly();
}

/** รีเรนเดอร์เฉพาะตารางตะกร้า + ตัวนับจำนวน + ข้อความปุ่มบันทึก (ไม่แตะฟิลด์ร่วมด้านบน กันเสียโฟกัสตอนพิมพ์) */
function renderAddStockBasketOnly() {
  const { items, itemFields } = addStockForm;
  const tbody = document.getElementById("as-basketBody");
  const colCount = itemFields.length + 2;
  tbody.innerHTML = items.length
    ? items.map((it, i) => `<tr><td>${i + 1}</td>${itemFields.map((f) => `<td>${escapeHtml(it[f.field])}</td>`).join("")}<td class="no-wrap"><button type="button" class="btn-sm btn-remove" onclick="removeAddStockItem(${i})">ลบ</button></td></tr>`).join("")
    : `<tr><td colspan="${colCount}" class="cache-note" style="text-align:center; padding:14px;">ยังไม่มีรายการ — กรอก${itemFields.map((f) => f.label).join("/")}แล้วกด "+ เพิ่ม"</td></tr>`;
  document.getElementById("as-countNote").textContent = `รวมทั้งหมด ${items.length} ชิ้น`;
  document.getElementById("as-submitBtn").textContent = items.length ? `บันทึกเข้าสต๊อกทั้งหมด (${items.length} ชิ้น)` : "บันทึกเข้าสต๊อก";
}

async function submitAddStockBasket() {
  const msg = document.getElementById("as-msg");
  const saveBtn = document.getElementById("as-submitBtn");
  msg.className = "form-msg";
  msg.textContent = "";
  const { cfg, commonFields, common, items } = addStockForm;

  const missingCommon = commonFields.some((f) => f.label.indexOf("*") !== -1 && !String(common[f.key] || "").trim());
  if (missingCommon) {
    msg.className = "form-msg error";
    msg.textContent = "กรุณากรอกข้อมูลในช่องที่มี * ให้ครบ";
    return;
  }
  if (!items.length) {
    msg.className = "form-msg error";
    msg.textContent = "กรุณาเพิ่มรายการอย่างน้อย 1 รายการลงตะกร้าก่อน";
    return;
  }

  const originalText = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = "กำลังบันทึก...";
  try {
    const res = await apiPost({ action: "addStock", token: state.token, assetType: cfg.assetType, common, items });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      const conflictMsg = res.conflicts ? " (" + res.conflicts.join(", ") + ")" : "";
      msg.className = "form-msg error";
      msg.textContent = assetErrorMessage(res.error) + conflictMsg;
      return;
    }
    await refreshInBackground(true);
    renderManagePartsView();
    const freshMsg = document.getElementById("as-msg");
    if (freshMsg) {
      freshMsg.className = "form-msg success";
      freshMsg.textContent = "บันทึกสำเร็จ";
    }
  } catch (err) {
    msg.className = "form-msg error";
    msg.textContent = err.message || "เกิดข้อผิดพลาด กรุณาลองใหม่";
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  }
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
    case "forbidden": return "การดำเนินการนี้สำหรับ Admin เท่านั้น";
    case "missing_fields": return "กรอกข้อมูลไม่ครบ";
    case "invalid_asset_type": return "ประเภทอุปกรณ์นี้ไม่รองรับการเพิ่มสต๊อกด้วยฟอร์มนี้";
    case "invalid_model": return "กรุณาเลือกรุ่น (Model) ให้ถูกต้อง";
    case "item_conflict": return "มีรายการที่ซ้ำในตะกร้า กรุณาตรวจสอบ";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

/** ข้อความ error สำหรับฟีเจอร์ "ย้าย/เคลม" */
function transferClaimErrorMessage(code, conflicts) {
  if (code === "item_conflict" && conflicts && conflicts.length) return conflicts.join("\n");
  switch (code) {
    case "not_issued": return "อุปกรณ์นี้ไม่ได้อยู่ในสถานะเบิกออกแล้ว (อาจเป็น Stock หรืออยู่ระหว่างเคลมอยู่แล้ว)";
    case "asset_claimed": return "อุปกรณ์นี้อยู่ระหว่างเคลมอยู่แล้ว";
    case "not_claimed": return "อุปกรณ์นี้ไม่ได้อยู่ในสถานะ \"อยู่ระหว่างเคลม\"";
    case "asset_written_off": return "อุปกรณ์นี้ถูกตัดจำหน่ายไปแล้ว ไม่สามารถย้าย/เคลมได้อีก";
    case "not_written_off": return "อุปกรณ์นี้ไม่ได้อยู่ในสถานะตัดจำหน่าย";
    case "target_not_found": return "ไม่พบเครื่องปลายทางที่เลือกในระบบ";
    case "replacement_not_found": return "ไม่พบเครื่องทดแทนที่เลือกในระบบ";
    case "replacement_not_in_stock": return "เครื่องทดแทนที่เลือกไม่ได้อยู่ในสต็อกแล้ว กรุณาเลือกเครื่องอื่น";
    case "missing_fields": return "กรอกข้อมูลไม่ครบ";
    case "not_found": return "ไม่พบอุปกรณ์นี้ในระบบ (อาจถูกลบไปแล้ว)";
    case "forbidden": return "การดำเนินการนี้สำหรับ Admin เท่านั้น";
    default: return "ดำเนินการไม่สำเร็จ กรุณาลองใหม่";
  }
}

/** ฟีเจอร์ "ยกเลิกรายการ" — ข้อความ error สำหรับการยกเลิกรายการที่ทำไปแล้ว (เบิก/ย้าย/เคลม) */
function cancelTransactionErrorMessage(code) {
  switch (code) {
    case "not_cancellable": return "ยกเลิกได้เฉพาะรายการที่มีสถานะ \"เบิกแล้ว\" เท่านั้น (ธุรกรรมนี้อาจถูกยกเลิก/คืนของไปแล้ว)";
    case "state_changed": return "ไม่สามารถยกเลิกได้ — มีการนำอุปกรณ์ในรายการนี้ไปทำรายการอื่นต่อแล้ว (ย้ายต่อ/เคลมต่อ/คืนของ/ปิดเคสเคลม) กรุณาตรวจสอบและแก้ไขข้อมูลอุปกรณ์โดยตรงแทน";
    case "item_not_found": return "ไม่พบรายการอุปกรณ์ของธุรกรรมนี้ (ข้อมูลอาจมีการเปลี่ยนแปลง)";
    case "unknown_asset_type": return "ประเภทอุปกรณ์ในธุรกรรมนี้ไม่รู้จัก ไม่สามารถยกเลิกอัตโนมัติได้";
    case "not_found": return "ไม่พบอุปกรณ์นี้ในระบบ (อาจถูกลบไปแล้ว)";
    case "forbidden": return "การดำเนินการนี้สำหรับ Admin เท่านั้น";
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
  const confirmed = await showConfirm(`ยืนยันลบรายการเบิก ${transactionId}? ใช้ได้เฉพาะรายการที่ถูกปฏิเสธ/คืนของ/ยกเลิกไปแล้วเท่านั้น และไม่สามารถย้อนกลับได้`, { type: "warning", okText: "ลบเลย", danger: true });
  if (!confirmed) return;
  try {
    const res = await apiPost({ action: "deleteIssuance", token: state.token, transactionId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      await showAlert(res.error === "not_deletable" ? "ลบได้เฉพาะรายการที่ถูกปฏิเสธ/คืนของ/ยกเลิกไปแล้วเท่านั้น" : "ดำเนินการไม่สำเร็จ กรุณาลองใหม่", "error");
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

/** เหมือน getAvailableItems() แต่เฉพาะ Panolyzer (ไม่ได้อยู่ใน VIEW_CONFIG — ดูหมายเหตุ PANOLYZER_KEY หัวไฟล์)
 * กรองเฉพาะ Status="Stock" ตามข้อมูลมิเรอร์ล่าสุด และไม่ซ้ำกับที่มีคำขออื่นค้างอยู่/อยู่ในตะกร้าแล้ว */
function getAvailablePanolyzerItems(search) {
  const pendingKeys = getPendingKeys();
  const basketKeys = new Set(issuanceForm.basket.map((b) => b.assetType + "||" + b.serialNo));
  const rows = state.data.panolyzer || [];
  return rows.filter((row) => {
    if (!isPanolyzerStockRow(row)) return false;
    const serial = String(row[PANOLYZER_SERIAL_FIELD] || "");
    const key = PANOLYZER_ASSET_TYPE + "||" + serial;
    if (pendingKeys.has(key) || basketKeys.has(key)) return false;
    if (search) {
      const s = search.toLowerCase();
      return [PANOLYZER_SERIAL_FIELD, "Client name", "Location", "Type", "Model", "Mode"].some((f) => String(row[f] || "").toLowerCase().includes(s));
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
      <div class="form-field">
        <div class="loan-field">
          <input type="checkbox" id="f-isLoan" ${issuanceForm.isLoan ? "checked" : ""}>
          <label for="f-isLoan"><strong>ลูกค้ายืมไปทดลอง</strong> (ไม่ใช่การเบิกขาย/ติดตั้งถาวร)</label>
        </div>
        <div class="loan-hint">ติ๊กแล้วใบเบิกนี้จะขึ้นป้าย "ยืม" กำกับสถานะไว้ ให้แยกจากการเบิกปกติ</div>
      </div>
    </div>

    <div class="form-card">
      <h3>2. เลือกอุปกรณ์ที่จะเบิก (แสดงเฉพาะรายการที่อยู่ในสถานะ Stock และไม่มีคำขออื่นค้างอยู่)</h3>
      <div class="picker-row">
        <select id="f-assetType">
          <option value="moisturlyzer">MoisturLyzer</option>
          <option value="gateway">Gateway</option>
          <option value="simcard">SimCard</option>
          <option value="panolyzer">Panolyzer</option>
          <option value="colorSorterParts">อะไหล่ Color Sorter</option>
          <option value="panolyzerParts">อะไหล่ Panolyzer</option>
          <option value="other">อื่นๆ (พิมพ์เอง)</option>
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
  document.getElementById("f-isLoan").addEventListener("change", (e) => { issuanceForm.isLoan = e.target.checked; });
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
  const searchInput = document.getElementById("f-itemSearch");
  const listEl = document.getElementById("pickerList");

  // Phase 11: ของนอกระบบ (พิมพ์ชื่อเอง) — ไม่มีสต๊อกให้เลือก แสดงฟอร์มพิมพ์เองแทนรายการสต๊อก
  if (assetKey === "other") {
    searchInput.disabled = true;
    searchInput.value = "";
    listEl.innerHTML = `
      <div class="other-entry-form">
        <div class="form-grid">
          <div class="form-field">
            <label>ชื่ออุปกรณ์ (พิมพ์เอง) *</label>
            <input type="text" id="f-otherItemName" placeholder="เช่น เคสทดลองแบบใหม่, สายไฟสำรอง">
          </div>
          <div class="form-field">
            <label>Serial / หมายเลข (ถ้ามี)</label>
            <input type="text" id="f-otherSerial" placeholder="ไม่บังคับ">
          </div>
        </div>
        <div class="form-grid" style="grid-template-columns: 140px 1fr;">
          <div class="form-field">
            <label>จำนวน</label>
            <input type="number" id="f-otherQty" min="1" value="1">
          </div>
          <div class="form-field" style="align-self:flex-end;">
            <button class="btn-sm btn-add" style="margin-top:22px;" onclick="addOtherToBasket()">+ เพิ่มลงตะกร้า</button>
          </div>
        </div>
        <div id="otherEntryMsg" class="cache-note" style="margin-top:8px;">ของประเภทนี้จะไม่ถูกตัดสต๊อกในระบบ — ใช้บันทึกไว้เป็นประวัติเท่านั้น</div>
      </div>`;
    return;
  }
  searchInput.disabled = false;

  // Panolyzer (เครื่อง — ไม่ใช่อะไหล่): ไม่ได้อยู่ใน VIEW_CONFIG (ดูหมายเหตุหัวไฟล์ตรง PANOLYZER_KEY) จึงต้องแยก
  // สาขาเฉพาะทาง ก่อนจะไปถึงจุดที่ดึง cfg จาก VIEW_CONFIG (จะได้ undefined ถ้าไม่ดักไว้ก่อน)
  if (assetKey === PANOLYZER_KEY) {
    const search = searchInput.value;
    const items = getAvailablePanolyzerItems(search);
    if (!items.length) {
      listEl.innerHTML = `<div class="picker-empty">ไม่พบเครื่อง Panolyzer ที่พร้อมเบิก (สถานะ Stock)</div>`;
      return;
    }
    listEl.innerHTML = items.slice(0, 50).map((row) => {
      const serial = String(row[PANOLYZER_SERIAL_FIELD] || "");
      const detailParts = [row.Type, row.Model, row.Mode].filter((v) => v && String(v).trim()).map((v) => escapeHtml(String(v)));
      const label = `Panolyzer — ${escapeHtml(serial)}${detailParts.length ? " (" + detailParts.join(" · ") + ")" : ""}`;
      return `
        <div class="picker-list-item">
          <span>${label}</span>
          <button class="btn-sm btn-add" onclick="addToBasket('${PANOLYZER_KEY}', '${escapeAttr(serial)}')">+ เพิ่ม</button>
        </div>`;
    }).join("");
    return;
  }

  const cfg = VIEW_CONFIG[assetKey];
  const search = searchInput.value;

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

/** Phase 11: เพิ่มของนอกระบบ (พิมพ์ชื่อเอง) ลงตะกร้า — ไม่มีสต๊อกจริง ไม่มี Gateway/SimCard/รุ่นเกี่ยวข้องใดๆ ทั้งสิ้น */
function addOtherToBasket() {
  const nameInput = document.getElementById("f-otherItemName");
  const serialInput = document.getElementById("f-otherSerial");
  const qtyInput = document.getElementById("f-otherQty");
  const msgEl = document.getElementById("otherEntryMsg");
  const itemName = nameInput.value.trim();
  if (!itemName) {
    msgEl.textContent = "กรุณากรอกชื่ออุปกรณ์ก่อน";
    msgEl.style.color = "var(--danger)";
    return;
  }
  const qty = Math.max(1, Math.floor(Number(qtyInput.value) || 1));
  issuanceForm.basket.push({ assetType: "Other", itemName, serialNo: serialInput.value.trim() || "-", quantity: qty });
  nameInput.value = "";
  serialInput.value = "";
  qtyInput.value = "1";
  msgEl.textContent = "ของประเภทนี้จะไม่ถูกตัดสต๊อกในระบบ — ใช้บันทึกไว้เป็นประวัติเท่านั้น";
  msgEl.style.color = "";
  renderBasket();
}

function addToBasket(assetKey, serial) {
  // Panolyzer: ไม่ได้อยู่ใน VIEW_CONFIG (ดูหมายเหตุ PANOLYZER_KEY หัวไฟล์) — สร้างรายการตะกร้ารูปแบบของตัวเอง
  // แยกจาก path ปกติด้านล่างทั้งหมด (linkedGatewaySerial/linkedSimSerial ใช้ชื่อเดียวกับ MoisturLyzer เพื่อ
  // ให้ renderBasket/renderBasketMobile/submitIssuanceRequest ขยายรายการ Gateway/SimCard คู่กันด้วย logic เดียวกัน)
  if (assetKey === PANOLYZER_KEY) {
    issuanceForm.basket.push({
      assetType: PANOLYZER_ASSET_TYPE, assetKey, serialNo: serial,
      connectTo: "", connectSerial: "", location: "",
      linkedGatewaySerial: "", linkedSimSerial: "",
    });
    renderPickerList();
    renderBasket();
    return;
  }

  const cfg = VIEW_CONFIG[assetKey];
  const item = {
    assetType: cfg.assetType, assetKey, serialNo: serial,
    connectTo: cfg.connectOptions ? cfg.connectOptions[0] : "",
    connectSerial: "",
    // Phase: สถานที่ติดตั้งเฉพาะจุด — ว่างไว้ = ใช้ "สถานที่ติดตั้ง/ไซต์งาน" รวมของทั้งคำขอ (พฤติกรรมเดิม)
    // กรอกแล้ว = override เฉพาะชิ้นนี้ ใช้กับกรณีเบิกหลายเครื่องให้ลูกค้าเจ้าเดียวกันแต่ไปติดตั้งคนละจุด
    location: "",
  };

  if (cfg.assetType === "MoisturLyzer") {
    // Phase 6: เบิก MoisturLyzer ต้องเลือก Gateway รุ่น EPG-001B และ SimCard ที่จะติดตั้งคู่กันเสมอ (บังคับ) — เลือกได้ในแถวเดียวกันเลย
    item.linkedGatewaySerial = "";
    item.linkedSimSerial = "";
  }

  if (cfg.assetType === "Gateway") {
    const row = (state.data.gateway || []).find((r) => String(r[cfg.serialField]) === String(serial));
    item.model = normalizeGatewayModel(row && row[GATEWAY_MODEL_FIELD]);
    if (item.model === GATEWAY_MODEL_MOISTURLYZER) {
      item.connectTo = "MoisturLyzer"; // รุ่นนี้ใช้กับ MoisturLyzer เท่านั้น
    }
    // Phase 6: เบิก Gateway (รุ่นใดก็ตาม) ต้องมี SimCard คู่กันเสมอ (บังคับ) — เลือกได้ในแถวเดียวกันเลย
    item.linkedSimSerial = "";
  }

  if (cfg.assetType === "SimCard") {
    // SimCard ใส่ได้เฉพาะใน Gateway เท่านั้นทางกายภาพ — ล็อก connectTo ไว้ตายตัว ไม่ให้เลือกเป็นอย่างอื่นได้เลย
    item.connectTo = "Gateway";
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
  // เปลี่ยนประเภทที่เชื่อมต่อแล้ว ค่า Serial เจาะจงเดิม (ถ้ามี) ใช้ไม่ได้แล้วเสมอ (คนละชุดตัวเลือกกัน) — เคลียร์ทิ้ง
  issuanceForm.basket[index].connectSerial = "";
  renderBasket();
}

function updateBasketConnectSerial(index, value) {
  issuanceForm.basket[index].connectSerial = value;
  refreshBasketNotice();
}

/** สถานที่เฉพาะจุด — ไม่ต้องวาดตะกร้าใหม่ (แค่พิมพ์ข้อความ ไม่กระทบ dropdown อื่น) แค่เก็บค่าไว้ใน state รอส่งตอนกดยืนยัน */
function updateBasketLocation(index, value) {
  issuanceForm.basket[index].location = value;
}

/** เบิก SimCard เชื่อมกับ Gateway ที่เบิกออกไปแล้ว — ก่อนบันทึกค่าเช็คก่อนว่า Gateway ตัวที่เลือกมี SimCard เดิม
 * ใส่อยู่แล้วหรือไม่ (ตามข้อมูล SimCard_SN ที่บันทึกไว้ในระบบ) ถ้ามีอยู่แล้วและไม่ใช่ซิมตัวเดียวกับที่กำลังเบิกนี้
 * ต้องบล็อกไว้ก่อน ไม่ให้เบิกทับข้อมูลเดิมโดยไม่ได้ตรวจสอบ ให้ไปแจ้ง Admin แก้ไขข้อมูลให้ตรงกับของจริงก่อน */
function updateSimConnectToGateway(index, value) {
  if (value) {
    const gwCfg = VIEW_CONFIG.gateway;
    const gwRow = (state.data.gateway || []).find((r) => String(r[gwCfg.serialField]) === String(value));
    const existingSim = String((gwRow && gwRow[GATEWAY_SIMCARD_FIELD]) || "").trim();
    if (existingSim && existingSim !== issuanceForm.basket[index].serialNo) {
      showAlert(
        `ไม่สามารถเลือก Gateway S/N ${value} ได้ เพราะตามข้อมูลในระบบมี SimCard เลข "${existingSim}" ใส่อยู่แล้ว ` +
          `กรุณาแจ้ง Admin ให้ตรวจสอบและปรับปรุงข้อมูล SimCard เดิมของเครื่องนี้ให้ตรงกับความเป็นจริงก่อน แล้วจึงลองเบิกใหม่อีกครั้ง`,
        "error"
      );
      renderBasket(); // สั่งวาดใหม่เพื่อดีดตัวเลือกใน dropdown กลับเป็นค่าเดิม (ยังไม่ได้บันทึกค่าใหม่ลง state)
      return;
    }
  }
  issuanceForm.basket[index].connectSerial = value;
  renderBasket();
}

/** รายการ Gateway ที่ "เบิกออกไปแล้ว" (ไม่ใช่ของว่างในสต๊อก) ทั้งหมดในระบบ — ใช้เป็นตัวเลือกตอนเบิก SimCard
 * เพื่อระบุว่าจะนำซิมนี้ไปใส่ใน Gateway เครื่องไหนที่ติดตั้งอยู่กับลูกค้าแล้ว (คนละกรณีกับการเบิก Gateway+SimCard
 * คู่กันใหม่ทั้งคู่ ซึ่งใช้ getAvailableGatewaysByModel/linkedSimSerial แทน) */
function getLinkableIssuedGateways() {
  const cfg = VIEW_CONFIG.gateway;
  return (state.data.gateway || [])
    .filter((row) => !isStockRow(row, cfg.stockField, cfg.stockRequiresField))
    .map((row) => ({
      serial: String(row[cfg.serialField] || ""),
      customer: String(row.Customer_name || "").trim(),
      location: String(row.Location || "").trim(),
    }))
    .filter((r) => r.serial)
    .sort((a, b) => a.serial.localeCompare(b.serial));
}

/** เหมือน getLinkableIssuedGateways() แต่เป็นฝั่ง MoisturLyzer — ใช้ตอน "ย้าย" Gateway ไปติดตั้งที่ลูกค้าใหม่
 * ให้เลือกได้ว่าจะไปเชื่อมกับเครื่อง MoisturLyzer เครื่องไหนที่ติดตั้งอยู่กับลูกค้านั้นอยู่แล้ว (ไม่รวมเครื่องที่ยัง
 * เป็น Stock ว่างอยู่ เพราะกรณีนี้คือย้ายไปหาเครื่องที่ติดตั้งอยู่แล้ว ไม่ใช่เบิกคู่กันใหม่) */
function getLinkableIssuedMoisturlyzers() {
  const cfg = VIEW_CONFIG.moisturlyzer;
  return (state.data.moisturlyzer || [])
    .filter((row) => !isStockRow(row, cfg.stockField, cfg.stockRequiresField) && !isClaimedRow(row, cfg) && !isWrittenOffRow(row, cfg))
    .map((row) => ({
      serial: String(row[cfg.serialField] || ""),
      customer: String(row.Customer_name || "").trim(),
      location: String(row.Location || "").trim(),
    }))
    .filter((r) => r.serial)
    .sort((a, b) => a.serial.localeCompare(b.serial));
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

/** เหมือน updateLinkedGateway() เป๊ะ แต่ใช้กับรายการ Panolyzer ในตะกร้า (แยกฟังก์ชันเพราะ item.assetType ต่างกัน
 * เอาไว้ให้ HTML onchange handler เรียกตรงๆ อ่านง่ายกว่าเช็ค assetType ข้างในฟังก์ชันเดียวรวมกัน) */
function updateLinkedGatewayForPanolyzer(index, value) {
  issuanceForm.basket[index].linkedGatewaySerial = value;
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
    if ((it.assetType === "MoisturLyzer" || it.assetType === "Panolyzer") && it.linkedGatewaySerial) used.add(it.linkedGatewaySerial);
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
    if ((it.assetType === "MoisturLyzer" || it.assetType === "Gateway" || it.assetType === "Panolyzer") && it.linkedSimSerial) used.add(it.linkedSimSerial);
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
      <thead><tr><th>ประเภท</th><th>Serial</th><th>เชื่อมต่อกับ / ใส่ใน</th><th>เครื่องที่เชื่อมต่อ (เจาะจง)</th><th>SimCard คู่กัน</th><th>สถานที่เฉพาะจุด</th><th></th></tr></thead>
      <tbody>
        ${issuanceForm.basket.map((item, idx) => {
          // Phase 12: ของนอกระบบ (พิมพ์ชื่อเอง) — ไม่มี cfg/รุ่น/การเชื่อมต่อใดๆ เกี่ยวข้อง แสดงชื่อ+serial+จำนวนที่พิมพ์มา
          // (เช็คก่อน item.quantity !== undefined ด้านล่าง เพราะของนอกระบบก็มี quantity เหมือนกันแล้ว)
          if (item.assetType === "Other") {
            return `<tr>
              <td>${escapeHtml(item.itemName)} <span class="cache-note">(นอกระบบ)</span></td>
              <td>${escapeHtml(item.serialNo)}</td>
              <td><input type="number" min="1" value="${escapeAttr(String(item.quantity != null ? item.quantity : 1))}" style="width:80px;" onchange="updateBasketQuantity(${idx}, this.value)"> ชิ้น</td>
              <td><span class="cache-note">-</span></td>
              <td><span class="cache-note">-</span></td>
              <td><span class="cache-note">-</span></td>
              <td><button class="btn-sm btn-remove" onclick="removeFromBasket(${idx})">ลบ</button></td>
            </tr>`;
          }

          // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N) — แถวของตัวเองแยกจากอุปกรณ์อื่นทั้งหมด ไม่มีเรื่อง Gateway/SimCard คู่กัน
          if (item.quantity !== undefined) {
            return `<tr>
              <td>${escapeHtml(item.partName)} <span class="cache-note">(นับจำนวน)</span></td>
              <td><span class="cache-note">-</span></td>
              <td><input type="number" min="1" value="${escapeAttr(String(item.quantity))}" style="width:80px;" onchange="updateBasketQuantity(${idx}, this.value)"> ชิ้น</td>
              <td><span class="cache-note">-</span></td>
              <td><span class="cache-note">-</span></td>
              <td><span class="cache-note">-</span></td>
              <td><button class="btn-sm btn-remove" onclick="removeFromBasket(${idx})">ลบ</button></td>
            </tr>`;
          }

          // Panolyzer: ไม่ได้อยู่ใน VIEW_CONFIG (ดูหมายเหตุ PANOLYZER_KEY หัวไฟล์) — แสดงแถวแบบเดียวกับ MoisturLyzer
          // เป๊ะ (เลือก Gateway EPG-001S คู่กันไม่บังคับ + SimCard คู่กันไม่บังคับถ้ามี Gateway แล้ว) แต่ไม่มี cfg
          // จาก VIEW_CONFIG ให้ใช้ จึงต้องเขียนแยกทั้งแถว แทนที่จะพึ่ง cfg.title/cfg.serialField ด้านล่าง
          if (item.assetType === "Panolyzer") {
            let panoSimCell = `<span class="cache-note">ไม่ต้องใช้ (ไม่ได้เบิก Gateway คู่กัน)</span>`;
            if (item.linkedGatewaySerial) {
              const availableSim = getAvailableSimCards(idx);
              const simCfg = VIEW_CONFIG.simcard;
              if (!availableSim.length && !item.linkedSimSerial) {
                panoSimCell = `<span class="cache-note">ไม่มี SimCard ว่างในสต๊อก (ไม่บังคับ)</span>`;
              } else {
                panoSimCell = `<select class="searchable-select" onchange="updateLinkedSim(${idx}, this.value)">
                  <option value="">-- ไม่เบิก SimCard คู่กัน (ไม่บังคับ) --</option>
                  ${availableSim.map((s) => `<option value="${escapeAttr(String(s[simCfg.serialField]))}" ${String(s[simCfg.serialField]) === item.linkedSimSerial ? "selected" : ""}>${escapeHtml(String(s[simCfg.serialField]))}</option>`).join("")}
                </select>`;
              }
            }
            const availableGw = getAvailableGatewaysByModel(GATEWAY_MODEL_PANOLYZER, idx);
            let panoSerialCell;
            if (!availableGw.length && !item.linkedGatewaySerial) {
              panoSerialCell = `<span class="cache-note">ไม่มี Gateway ${escapeHtml(GATEWAY_MODEL_PANOLYZER)} ว่างในสต๊อก</span>`;
            } else {
              const gwCfg = VIEW_CONFIG.gateway;
              panoSerialCell = `<select class="searchable-select" onchange="updateLinkedGatewayForPanolyzer(${idx}, this.value)">
                <option value="">-- ไม่เบิก Gateway คู่กัน (ไม่บังคับ) --</option>
                ${availableGw.map((g) => `<option value="${escapeAttr(String(g[gwCfg.serialField]))}" ${String(g[gwCfg.serialField]) === item.linkedGatewaySerial ? "selected" : ""}>${escapeHtml(String(g[gwCfg.serialField]))}</option>`).join("")}
              </select>`;
            }
            const panoLocationCell = `<input type="text" placeholder="ว่าง = ใช้ &quot;${escapeAttr(issuanceForm.siteLocation) || "สถานที่ด้านบน"}&quot;"
                value="${escapeAttr(item.location || "")}" oninput="updateBasketLocation(${idx}, this.value)">`;
            return `<tr>
              <td>Panolyzer</td>
              <td>${escapeHtml(item.serialNo)}</td>
              <td><span class="cache-note">Gateway (${escapeHtml(GATEWAY_MODEL_PANOLYZER)}) คู่กัน (ไม่บังคับ)</span></td>
              <td>${panoSerialCell}</td>
              <td>${panoSimCell}</td>
              <td>${panoLocationCell}</td>
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
              simCell = `<select class="searchable-select" onchange="updateLinkedSim(${idx}, this.value)">
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
              serialCell = `<select class="searchable-select" onchange="updateLinkedGateway(${idx}, this.value)">
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
              serialCell = `<select class="searchable-select" onchange="updateBasketConnectSerial(${idx}, this.value)">
                <option value="">-- ไม่ระบุเครื่องเจาะจง (ไม่บังคับ) --</option>
                ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
              </select>`;
            }
          } else if (item.assetType === "SimCard") {
            // SimCard ใส่ได้เฉพาะใน Gateway เท่านั้นทางกายภาพ (ใส่ตรงกับ MoisturLyzer/Panolyzer ไม่ได้) — ไม่ต้อง
            // มี dropdown ให้เลือกประเภทอื่นอีกต่อไป ล็อกไว้เป็น Gateway เสมอ แล้วให้เลือกเจาะจงจาก Gateway ที่
            // เบิกออกไปแล้วเท่านั้น พร้อมชื่อลูกค้า/สถานที่ติดตั้งช่วยระบุตัว
            connectCell = `<span class="cache-note">Gateway</span>`;
            const availableGw = getLinkableIssuedGateways();
            if (!availableGw.length) {
              serialCell = `<span class="cache-note">ไม่มี Gateway ที่เบิกออกไปแล้วในระบบ</span>`;
            } else {
              serialCell = `<select class="searchable-select" onchange="updateSimConnectToGateway(${idx}, this.value)">
                <option value="">-- ไม่ระบุ Gateway เจาะจง --</option>
                ${availableGw.map((g) => `<option value="${escapeAttr(g.serial)}" ${g.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(g.serial)} — ${escapeHtml(g.customer || "-")} / ${escapeHtml(g.location || "-")}</option>`).join("")}
              </select>`;
            }
          } else if (cfg.connectOptions) {
            // Gateway ที่ยังไม่ระบุรุ่น — คงพฤติกรรมเดิม (ไม่บังคับ)
            connectCell = `<select onchange="updateBasketConnectTo(${idx}, this.value)">
                 ${cfg.connectOptions.map((o) => `<option value="${escapeAttr(o)}" ${o === item.connectTo ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
               </select>`;
            if (item.connectTo === LINKABLE_TARGET_ASSET_TYPE) {
              if (!linkableTargets.length) {
                serialCell = `<span class="cache-note">ไม่มีเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} ในระบบ</span>`;
              } else {
                serialCell = `<select class="searchable-select" onchange="updateBasketConnectSerial(${idx}, this.value)">
                  <option value="">-- ไม่ระบุเครื่องเจาะจง --</option>
                  ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
                </select>`;
              }
            }
          }

          const locationCell = `<input type="text" placeholder="ว่าง = ใช้ &quot;${escapeAttr(issuanceForm.siteLocation) || "สถานที่ด้านบน"}&quot;"
              value="${escapeAttr(item.location || "")}" oninput="updateBasketLocation(${idx}, this.value)">`;

          return `<tr>
            <td>${escapeHtml(cfg.title)}</td>
            <td>${escapeHtml(item.serialNo)}</td>
            <td>${connectCell}</td>
            <td>${serialCell}</td>
            <td>${simCell}</td>
            <td>${locationCell}</td>
            <td><button class="btn-sm btn-remove" onclick="removeFromBasket(${idx})">ลบ</button></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <div class="cache-note" style="margin-top:8px;">หมายเหตุ: การเลือก "เครื่องที่เชื่อมต่อ (เจาะจง)" เป็นการบันทึกความสัมพันธ์เพื่อการติดตามเท่านั้น ไม่ได้ตัดสต๊อกของเครื่องที่เลือก (ยกเว้น Gateway ที่เลือกคู่กับ MoisturLyzer ซึ่งจะถูกเบิกออกจากสต๊อกจริง)</div>
    <div class="cache-note">"สถานที่เฉพาะจุด" ไม่บังคับกรอก — ถ้าปล่อยว่างจะใช้สถานที่ติดตั้ง/ไซต์งานรวมที่กรอกไว้ด้านบนของแบบฟอร์ม (ข้อ 1) ให้ทุกเครื่อง กรอกเฉพาะเครื่องที่ไปติดตั้งคนละจุดกับที่อื่น</div>
    <div id="basketRequirementNotice">${renderBasketRequirementNotice()}</div>
  `;
  enhanceSearchableSelects(area);
}

/** เวอร์ชันมือถือของตะกร้าเบิก — แต่ละชิ้นเป็นการ์ดแยก วางฟิลด์ซ้อนแนวตั้งเต็มความกว้างจอ แทนตารางแนวนอนที่ต้องเลื่อนซ้าย-ขวา (ลอจิกการเลือก Gateway/SimCard/เชื่อมต่อเหมือนกับเวอร์ชันคอมพิวเตอร์ทุกประการ ต่างแค่การจัดวาง) */
function renderBasketMobile(area) {
  const linkableTargets = getLinkableTargets();

  const cardsHtml = issuanceForm.basket.map((item, idx) => {
    // Phase 12: ของนอกระบบ (พิมพ์ชื่อเอง) — เช็คก่อน item.quantity !== undefined ด้านล่าง เพราะตอนนี้มี quantity เหมือนกัน
    if (item.assetType === "Other") {
      return `
        <div class="basket-card">
          <div class="basket-card-head">
            <div>
              <div class="basket-card-title">${escapeHtml(item.itemName)}</div>
              <div class="basket-card-serial">Serial: ${escapeHtml(item.serialNo)} (นอกระบบ)</div>
            </div>
            <button class="basket-card-remove" onclick="removeFromBasket(${idx})">ลบ</button>
          </div>
          <div class="basket-field">
            <label>จำนวนที่จะเบิก</label>
            <input type="number" min="1" value="${escapeAttr(String(item.quantity != null ? item.quantity : 1))}" onchange="updateBasketQuantity(${idx}, this.value)">
          </div>
        </div>`;
    }

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

    // Panolyzer: ไม่ได้อยู่ใน VIEW_CONFIG (ดูหมายเหตุ PANOLYZER_KEY หัวไฟล์) — การ์ดแบบเดียวกับ MoisturLyzer เป๊ะ
    // (เลือก Gateway EPG-001S คู่กันไม่บังคับ + SimCard คู่กันไม่บังคับถ้ามี Gateway แล้ว) เขียนแยกทั้งการ์ด
    if (item.assetType === "Panolyzer") {
      const availableGw = getAvailableGatewaysByModel(GATEWAY_MODEL_PANOLYZER, idx);
      const gwCfg = VIEW_CONFIG.gateway;
      let panoGwFieldHtml;
      if (!availableGw.length && !item.linkedGatewaySerial) {
        panoGwFieldHtml = `<span class="cache-note">ไม่มี Gateway ${escapeHtml(GATEWAY_MODEL_PANOLYZER)} ว่างในสต๊อก</span>`;
      } else {
        panoGwFieldHtml = `<select class="searchable-select" onchange="updateLinkedGatewayForPanolyzer(${idx}, this.value)">
          <option value="">-- ไม่เบิก Gateway คู่กัน (ไม่บังคับ) --</option>
          ${availableGw.map((g) => `<option value="${escapeAttr(String(g[gwCfg.serialField]))}" ${String(g[gwCfg.serialField]) === item.linkedGatewaySerial ? "selected" : ""}>${escapeHtml(String(g[gwCfg.serialField]))}</option>`).join("")}
        </select>`;
      }
      const panoFields = [{ label: `Gateway (${escapeHtml(GATEWAY_MODEL_PANOLYZER)}) คู่กัน (ไม่บังคับ)`, html: panoGwFieldHtml, req: false }];
      if (item.linkedGatewaySerial) {
        const availableSim = getAvailableSimCards(idx);
        const simCfg = VIEW_CONFIG.simcard;
        let panoSimFieldHtml;
        if (!availableSim.length && !item.linkedSimSerial) {
          panoSimFieldHtml = `<span class="warn-text">ไม่มี SimCard ว่างในสต๊อก (ไม่บังคับ)</span>`;
        } else {
          panoSimFieldHtml = `<select class="searchable-select" onchange="updateLinkedSim(${idx}, this.value)">
            <option value="">-- ไม่เบิก SimCard คู่กัน (ไม่บังคับ) --</option>
            ${availableSim.map((s) => `<option value="${escapeAttr(String(s[simCfg.serialField]))}" ${String(s[simCfg.serialField]) === item.linkedSimSerial ? "selected" : ""}>${escapeHtml(String(s[simCfg.serialField]))}</option>`).join("")}
          </select>`;
        }
        panoFields.push({ label: "SimCard คู่กัน (ไม่บังคับ)", html: panoSimFieldHtml, req: false });
      }
      panoFields.push({
        label: "สถานที่เฉพาะจุด (ไม่บังคับ)",
        html: `<input type="text" placeholder="ว่าง = ใช้ &quot;${escapeAttr(issuanceForm.siteLocation) || "สถานที่ด้านบน"}&quot;"
          value="${escapeAttr(item.location || "")}" oninput="updateBasketLocation(${idx}, this.value)">`,
        req: false,
      });
      const panoFieldsHtml = panoFields.map((f) => `
        <div class="basket-field">
          <label class="${f.req ? "req" : ""}">${f.label}</label>
          ${f.html}
        </div>`).join("");
      return `
        <div class="basket-card">
          <div class="basket-card-head">
            <div>
              <div class="basket-card-title">Panolyzer</div>
              <div class="basket-card-serial">S/N ${escapeHtml(item.serialNo)}</div>
            </div>
            <button class="basket-card-remove" onclick="removeFromBasket(${idx})">ลบ</button>
          </div>
          ${panoFieldsHtml}
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
        simFieldHtml = `<select class="searchable-select" onchange="updateLinkedSim(${idx}, this.value)">
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
        gwFieldHtml = `<select class="searchable-select" onchange="updateLinkedGateway(${idx}, this.value)">
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
        targetFieldHtml = `<select class="searchable-select" onchange="updateBasketConnectSerial(${idx}, this.value)">
          <option value="">-- ไม่ระบุเครื่องเจาะจง (ไม่บังคับ) --</option>
          ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
        </select>`;
      }
      fields.push({ label: `เชื่อมต่อกับเครื่อง ${escapeHtml(LINKABLE_TARGET_ASSET_TYPE)} (ไม่บังคับ)`, html: targetFieldHtml, req: false });
      fields.push({ label: "SimCard คู่กัน (ไม่บังคับ)", html: simFieldHtml, req: false });
    } else if (item.assetType === "SimCard") {
      // SimCard ใส่ได้เฉพาะใน Gateway เท่านั้นทางกายภาพ (ใส่ตรงกับ MoisturLyzer/Panolyzer ไม่ได้) — ไม่มี dropdown
      // ให้เลือกประเภทอื่นแล้ว ล็อกไว้เป็น Gateway เสมอ เลือกเจาะจงจาก Gateway ที่เบิกออกไปแล้วเท่านั้น
      const availableGw = getLinkableIssuedGateways();
      let targetFieldHtml;
      if (!availableGw.length) {
        targetFieldHtml = `<span class="warn-text">ไม่มี Gateway ที่เบิกออกไปแล้วในระบบ</span>`;
      } else {
        targetFieldHtml = `<select class="searchable-select" onchange="updateSimConnectToGateway(${idx}, this.value)">
          <option value="">-- ไม่ระบุ Gateway เจาะจง --</option>
          ${availableGw.map((g) => `<option value="${escapeAttr(g.serial)}" ${g.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(g.serial)} — ${escapeHtml(g.customer || "-")} / ${escapeHtml(g.location || "-")}</option>`).join("")}
        </select>`;
      }
      fields.push({ label: "เชื่อมต่อกับ / ใส่ใน", html: `<span class="cache-note">Gateway</span>`, req: false });
      fields.push({ label: "Gateway ที่จะใส่ซิม (เจาะจง)", html: targetFieldHtml, req: false });
    } else if (cfg.connectOptions) {
      // Gateway ที่ยังไม่ระบุรุ่น — dropdown ตัวเลือกเดิม
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
          targetFieldHtml = `<select class="searchable-select" onchange="updateBasketConnectSerial(${idx}, this.value)">
            <option value="">-- ไม่ระบุเครื่องเจาะจง --</option>
            ${linkableTargets.map((t) => `<option value="${escapeAttr(t.serial)}" ${t.serial === item.connectSerial ? "selected" : ""}>${escapeHtml(t.serial)}${t.stock ? " (ว่าง/Stock)" : t.customer ? " (ติดตั้งที่ " + escapeHtml(t.customer) + ")" : " (ใช้งานอยู่)"}</option>`).join("")}
          </select>`;
        }
        fields.push({ label: "เครื่องที่เชื่อมต่อ (เจาะจง)", html: targetFieldHtml, req: false });
      }
    }

    // Phase: สถานที่ติดตั้งเฉพาะจุด — ต่อท้ายฟิลด์อื่นๆ ของการ์ดเสมอ (ไม่บังคับ ว่างไว้ = ใช้สถานที่รวมของทั้งคำขอ)
    fields.push({
      label: `สถานที่เฉพาะจุด (ไม่บังคับ)`,
      html: `<input type="text" placeholder="ว่าง = ใช้ &quot;${escapeAttr(issuanceForm.siteLocation) || "สถานที่ด้านบน"}&quot;"
        value="${escapeAttr(item.location || "")}" oninput="updateBasketLocation(${idx}, this.value)">`,
      req: false,
    });

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
  enhanceSearchableSelects(area);
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
    // Phase 11: ของนอกระบบ (พิมพ์ชื่อเอง) — ไม่มีเรื่อง Gateway/SimCard/รุ่นใดๆ เกี่ยวข้อง ส่งแค่ชื่อ+serial ที่พิมพ์มา
    if (b.assetType === "Other") {
      items.push({ assetType: "Other", itemName: b.itemName, serialNo: b.serialNo, quantity: b.quantity || 1 });
      return;
    }
    // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N) — ส่ง quantity ไปด้วย ไม่มีเรื่อง Gateway/SimCard คู่กัน
    if (b.quantity !== undefined) {
      items.push({ assetType: b.assetType, serialNo: b.serialNo, quantity: b.quantity, connectTo: "", connectSerial: "" });
      return;
    }
    // Panolyzer: ไม่มี connectTo/connectSerial/รุ่นเกี่ยวข้อง (ดูหมายเหตุ PANOLYZER_KEY หัวไฟล์) — ส่งแค่ serial
    // + สถานที่เฉพาะจุด (ถ้ามี) แล้วขยาย Gateway/SimCard คู่กัน (ถ้าเลือกไว้) เป็นรายการพี่น้องด้วย logic เดียวกับ
    // MoisturLyzer ทุกประการ (ดูด้านล่าง — เพิ่ม "Panolyzer" เข้าเงื่อนไขเดิมแทนที่จะก็อปโค้ดซ้ำ)
    if (b.assetType === "Panolyzer") {
      const panoLocation = String(b.location || "").trim() || undefined;
      items.push({ assetType: "Panolyzer", serialNo: b.serialNo, newLocation: panoLocation });
      if (b.linkedGatewaySerial) {
        items.push({ assetType: "Gateway", serialNo: b.linkedGatewaySerial, connectTo: "Panolyzer", connectSerial: b.serialNo, newLocation: panoLocation });
      }
      if (b.linkedSimSerial) {
        items.push({ assetType: "SimCard", serialNo: b.linkedSimSerial, connectTo: "Panolyzer", connectSerial: b.serialNo, installedGatewaySerial: b.linkedGatewaySerial, newLocation: panoLocation });
      }
      return;
    }
    // installedGatewaySerial: แยกต่างหากจาก connectTo/connectSerial (ซึ่งใช้แสดงประวัติ "ใส่ในอุปกรณ์ปลายทางไหน"
    // มาแต่เดิม) — บอกเซิร์ฟเวอร์ตรงๆ ว่า SimCard ตัวนี้ไปอยู่ใน Gateway "ตัวไหน" (S/N Gateway จริง) เพื่ออัปเดต
    // ฟิลด์ SimCard_SN ของ Gateway ตัวนั้น ใช้กับ SimCard ที่เบิกเป็นรายการเดี่ยวเท่านั้น (ตอนนี้ล็อก connectTo ไว้
    // เป็น "Gateway" เสมอ ดู addToBasket) ค่า connectSerial ที่เลือกไว้ก็คือ S/N Gateway เป้าหมายอยู่แล้ว
    // สถานที่เฉพาะจุด (ไม่บังคับ) — ว่าง = ไม่ส่งค่านี้ไปเลย ให้เซิร์ฟเวอร์ใช้สถานที่รวมของทั้งคำขอ (payload.siteLocation)
    // ตามเดิมทุกประการ อุปกรณ์ที่เบิกคู่กัน (Gateway/SimCard ที่เลือกผูกไว้กับ MoisturLyzer/Gateway หลัก) ใช้สถานที่
    // เดียวกับตัวหลักเสมอ เพราะติดตั้งจุดเดียวกันจริงในทางกายภาพ
    const itemLocation = String(b.location || "").trim() || undefined;

    const simItem = { assetType: b.assetType, serialNo: b.serialNo, connectTo: b.connectTo, connectSerial: b.connectSerial || "", newLocation: itemLocation };
    if (b.assetType === "SimCard") simItem.installedGatewaySerial = b.connectSerial || "";
    items.push(simItem);
    if (b.assetType === "MoisturLyzer" && b.linkedGatewaySerial) {
      items.push({ assetType: "Gateway", serialNo: b.linkedGatewaySerial, connectTo: "MoisturLyzer", connectSerial: b.serialNo, newLocation: itemLocation });
    }
    if ((b.assetType === "MoisturLyzer" || b.assetType === "Gateway") && b.linkedSimSerial) {
      const simConnectTo = b.assetType === "MoisturLyzer" ? "MoisturLyzer" : (b.model === GATEWAY_MODEL_PANOLYZER ? "Panolyzer" : "MoisturLyzer");
      const simConnectSerial = b.assetType === "MoisturLyzer" ? b.serialNo : (b.connectSerial || "");
      // ต่างจาก simConnectSerial ด้านบน (อาจเป็น S/N MoisturLyzer/Panolyzer ปลายทาง ไม่ใช่ตัว Gateway เอง) —
      // installedGatewaySerial ต้องเป็น S/N ของ Gateway ที่ซิมนี้ใส่อยู่จริงเสมอ: ถ้าเบิกคู่กับ MoisturLyzer
      // ก็คือ Gateway ที่เลือกคู่กันไว้ (linkedGatewaySerial) ถ้าเบิก Gateway ตรงๆ ก็คือตัว Gateway นั้นเอง (b.serialNo)
      const installedGatewaySerial = b.assetType === "MoisturLyzer" ? b.linkedGatewaySerial : b.serialNo;
      items.push({ assetType: "SimCard", serialNo: b.linkedSimSerial, connectTo: simConnectTo, connectSerial: simConnectSerial, installedGatewaySerial, newLocation: itemLocation });
    }
  });

  const payload = {
    customerName: issuanceForm.customerName.trim(),
    siteLocation: issuanceForm.siteLocation.trim(),
    details: issuanceForm.details.trim(),
    items: items,
    isLoan: !!issuanceForm.isLoan,
  };

  // ---- ออฟไลน์: บันทึกลง Local cache แบบ Optimistic ทันที + เข้าคิวรอส่งเมื่อกลับมาออนไลน์ ----
  if (!navigator.onLine) {
    const tempTxnId = "TEMPTXN" + Date.now();
    applyOptimisticIssuance(tempTxnId, payload);
    state.offlineQueue.push({ label: `เบิก ${payload.customerName}`, body: { action: "requestIssuance", token: state.token, payload } });
    saveOfflineQueue();
    persistCache();
    issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [], isLoan: false };
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

    issuanceForm = { customerName: "", siteLocation: "", details: "", basket: [], isLoan: false };
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
    IssuanceType: payload.isLoan ? "ยืม" : "เบิก",
  });
  payload.items.forEach((item) => {
    state.data.issuanceItems.push({
      TransactionID: tempTxnId, AssetType: item.assetType, SerialNo: item.serialNo, ConnectTo: item.connectTo || "",
      ConnectSerial: item.connectSerial || "", PreviousStatus: "Stock", NewLocation: item.newLocation || payload.siteLocation,
      ItemName: item.itemName || "", Quantity: item.quantity || 1, _pendingSync: true,
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

/** Phase 11: ป้ายชื่อประเภทอุปกรณ์สำหรับแสดงในประวัติ/ใบเบิก — ของนอกระบบ (Other) แสดงชื่อที่พิมพ์เองแทน AssetType พร้อมกำกับ "(นอกระบบ)" */
/** แสดงชื่อประเภทอุปกรณ์ของรายการหนึ่ง — ถ้าเป็นของนอกระบบจะแสดงชื่อที่พิมพ์เองแทน AssetType
 * ส่ง opts.withQty = false เมื่อมีคอลัมน์ "จำนวน" แยกต่างหากอยู่แล้ว (เช่นตารางในใบเบิก) เพื่อไม่ให้จำนวนซ้ำกัน */
function formatItemLabel(item, opts) {
  const withQty = !opts || opts.withQty !== false;
  if (item.AssetType === "Other") {
    const qty = Number(item.Quantity) || 1;
    const qtyTag = withQty && qty > 1 ? ` <span class="cache-note">(จำนวน ${qty} ชิ้น)</span>` : "";
    return escapeHtml(item.ItemName || "อื่นๆ") + ` <span class="cache-note">(นอกระบบ)</span>` + qtyTag;
  }
  // Phase 8: อะไหล่แบบนับจำนวน (ไม่มี S/N) — SerialNo ในรายการนี้คือ PartID ภายในระบบ ไม่ใช่ชื่อที่อ่านรู้เรื่อง
  // จึงต้องใช้ ItemName (ชื่ออะไหล่จริงที่บันทึกไว้ตอนเบิก) พร้อมกำกับว่าเป็นอะไหล่ของอุปกรณ์ชนิดใด
  const deviceLabel = PART_QTY_DEVICE_LABEL[item.AssetType];
  if (deviceLabel) {
    const qty = Number(item.Quantity) || 1;
    const qtyTag = withQty && qty > 1 ? ` <span class="cache-note">(จำนวน ${qty} ชิ้น)</span>` : "";
    return escapeHtml(item.ItemName || "อะไหล่") + ` <span class="cache-note">(อะไหล่ ${deviceLabel})</span>` + qtyTag;
  }
  return escapeHtml(item.AssetType);
}

/** ข้อความแทน "Serial" สำหรับแสดงในประวัติ/ใบเบิก — อะไหล่แบบนับจำนวนไม่มี S/N จริง (SerialNo คือ PartID ภายใน
 * ไม่ควรโชว์ให้ผู้อ่านเห็น) จึงแสดงเป็นจำนวนที่เบิกแทน ส่วนประเภทอื่นยังคงแสดง Serial จริงตามปกติ */
function formatItemSerialLabel(item) {
  if (PART_QTY_DEVICE_LABEL[item.AssetType]) return "-";
  return escapeHtml(item.SerialNo);
}

/** ข้อความอธิบาย "เชื่อมต่อ/ติดตั้งอยู่กับอะไร" แบบข้อความล้วน (ไม่มีวงเล็บ/คำนำหน้า) ใช้เป็นแกนกลางให้ทั้ง
 * formatConnectInfo (ประวัติ) และ formatConnectColumn (ใบเบิกที่พิมพ์) เรียกใช้ร่วมกัน
 *
 * กรณีพิเศษ SimCard: ตอนเบิก SimCard คู่กับ MoisturLyzer/Gateway (เลือก "SimCard คู่กัน" ในแถวเดียวกันตอนเบิก)
 * ConnectTo/ConnectSerial ของรายการ SimCard นั้นจะถูกเซ็ตเป็น "อุปกรณ์ปลายทาง" (เช่น MoisturLyzer/Panolyzer)
 * ไม่ใช่ตัว Gateway ที่ซิมเสียบอยู่จริง (ดูที่มาใน handleSubmitIssuance) ทำให้ประวัติ/ใบเบิกเดิมไม่เคยโชว์ได้เลยว่า
 * ซิมตัวนี้ใส่อยู่ใน Gateway ตัวไหน ทั้งที่ระบบรู้ค่านี้อยู่แล้วใน InstalledGatewaySerial (เก็บคู่กันมาตั้งแต่ต้น
 * แต่ไม่เคยถูกดึงมาแสดงผล) จึงต้องโชว์ Gateway จริงจาก InstalledGatewaySerial เป็นหลักก่อนเสมอสำหรับ SimCard
 * แล้วค่อยกำกับอุปกรณ์ปลายทางต่อท้ายเป็นข้อมูลเสริมถ้ามี */
function describeItemConnection(item) {
  if (item.AssetType === "SimCard" && item.InstalledGatewaySerial) {
    let text = "Gateway — เครื่อง " + escapeHtml(item.InstalledGatewaySerial);
    if (item.ConnectTo && item.ConnectTo !== "Gateway") {
      text += ` (เชื่อมต่อ ${escapeHtml(item.ConnectTo)}${item.ConnectSerial ? " — เครื่อง " + escapeHtml(item.ConnectSerial) : ""})`;
    }
    return text;
  }
  if (!item.ConnectTo) return "";
  let text = escapeHtml(item.ConnectTo);
  if (item.ConnectSerial) text += " — เครื่อง " + escapeHtml(item.ConnectSerial);
  return text;
}

/** สร้างข้อความ "(เชื่อมกับ Gateway — เครื่อง MZ-002)" สำหรับแสดงในหน้าประวัติ/รายการในระบบ (ไม่ใช่ใบเบิกที่พิมพ์ —
 * ดู formatConnectColumn) — ใช้ describeItemConnection ที่โชว์ Gateway ตัวจริงของ SimCard ให้เต็มๆ ได้เพราะพื้นที่
 * แสดงผลบนจอไม่ตายตัวเหมือนตารางที่ต้องพิมพ์ลงกระดาษ */
function formatConnectInfo(item) {
  const text = describeItemConnection(item);
  return text ? ` (เชื่อมกับ ${text})` : "";
}

/** Phase: สถานที่เฉพาะจุด — โชว์ "→ สถานที่" ต่อท้ายรายการเฉพาะชิ้นที่สถานที่ติดตั้งต่างจากสถานที่รวมของทั้งคำขอ
 * (txn.SiteLocation) เท่านั้น ถ้าไม่ได้ระบุเฉพาะจุดไว้หรือค่าตรงกับสถานที่รวมอยู่แล้ว จะไม่โชว์อะไรเพิ่ม (เงียบเหมือนเดิม) —
 * ใช้ในหน้าอนุมัติการเบิก/ประวัติการเบิก-คืน (ไม่ใช่ใบเบิกที่พิมพ์ ซึ่งพื้นที่ตารางจำกัดกว่า) */
function formatItemLocationTag(item, txn) {
  const loc = String(item.NewLocation || "").trim();
  const txnLoc = String((txn && txn.SiteLocation) || "").trim();
  if (!loc || loc === txnLoc) return "";
  return ` <span class="loc-tag">→ ${escapeHtml(loc)}</span>`;
}

/** คอลัมน์ "นำไปใส่อุปกรณ์ไหน" ในใบเบิกที่พิมพ์ — ตั้งใจไม่ใช้ describeItemConnection (ซึ่งจะต่อข้อความอุปกรณ์
 * ปลายทางของ SimCard เพิ่มเข้ามาอีกก้อน) เพราะเซลล์ในตารางพิมพ์มีความกว้างจำกัด/ตายตัว ข้อความที่ยาวเกินจะดัน
 * ตารางทั้งใบล้นออกนอกหน้ากระดาษ จึงคงให้โชว์แค่ ConnectTo/ConnectSerial ตรงๆ แบบเดิม สั้นกระชับพอสำหรับพิมพ์
 * ส่วนรายละเอียด Gateway ตัวจริงของ SimCard ให้ไปดูที่หน้าประวัติในระบบแทน (ดู formatConnectInfo) */
function formatConnectColumn(item) {
  if (!item.ConnectTo) return "—";
  let text = escapeHtml(item.ConnectTo);
  if (item.ConnectSerial) text += " — เครื่อง " + escapeHtml(item.ConnectSerial);
  return text;
}

/** เครื่องที่ Issued อยู่ (ยังไม่คืน) เท่านั้นถือเป็นความสัมพันธ์ที่ "active" จริงในปัจจุบัน — ปกติคำนวณจากประวัติ
 * การเบิกที่มี ConnectSerial ตรงกับเครื่องนี้ (มีได้หลายรายการ) แต่เครื่องเก่าที่ย้ายมาจากระบบเดิมหลายเครื่องไม่มี
 * ประวัติการเบิกที่เชื่อมกันไว้ในระบบใหม่ (เบิก/ติดตั้งจริงไปแล้วตั้งแต่ก่อนย้ายระบบ) ทำให้ช่องนี้โชว์ "-" ทั้งที่จริง
 * มีเครื่องเชื่อมต่ออยู่ — Admin แก้ไขเพิ่มเติมเองได้ผ่านฟิลด์ Linked_Accessories_Note (ฟอร์มแก้ไขอุปกรณ์เดียวกับ
 * ที่แก้ Lot No.) ค่านี้จะโชว์ต่อท้ายรายการที่คำนวณได้จากประวัติเสมอ ไม่ได้แทนที่กัน (กันเผลอลบข้อมูลจริงที่ระบบ
 * ติดตามได้อยู่แล้วทิ้งไปโดยไม่ได้ตั้งใจ) */
/** ตัวช่วยแสดงผลร่วมกันสำหรับคอลัมน์ "computed" ทุกคอลัมน์ (เชื่อมต่อกับ/Gateway ที่เชื่อมต่อ/S/N อุปกรณ์ปลายทาง ฯลฯ)
 * รองรับ 2 รูปแบบ: string ธรรมดา (ค่ายืนยันแล้ว เช่น จากประวัติการเบิกหรือฟิลด์ที่กรอกไว้จริง) กับ object
 * { text, guessed: true } (ค่าที่ระบบเดาให้จากข้อมูลอื่น เช่น ลูกค้า/สถานที่ตรงกัน ยังไม่ได้ยืนยันจริง) —
 * แบบหลังจะได้ badge สีส้มขอบเส้นประ + เครื่องหมาย ? กำกับไว้ให้เห็นชัดว่าต่างจากค่าที่ยืนยันแล้ว */
function renderLinkedBadge(l) {
  const isObj = l && typeof l === "object";
  const guessed = isObj && l.guessed;
  const text = isObj ? l.text : l;
  // ลิงก์คลิกได้เฉพาะรายการที่รู้ viewKey/serial ปลายทางจริงๆ (ไม่ใช่ note ที่พิมพ์เอง หรือ Gateway ที่เชื่อมกับ "Other")
  const linkable = isObj && l.viewKey && l.serial;
  const guessTitle = guessed ? "เดาจากลูกค้า/สถานที่ที่ตรงกัน — ยังไม่ยืนยัน กดปุ่มแก้ไขเพื่อระบุให้ชัดเจน" : "";
  const clickTitle = linkable ? "คลิกเพื่อไปดูรายการนี้" : "";
  const titleText = guessTitle || clickTitle;
  const title = titleText ? ` title="${escapeAttr(titleText)}"` : "";
  const onclick = linkable ? ` onclick="goToLinkedAsset('${escapeAttr(l.viewKey)}', '${escapeAttr(l.serial)}')"` : "";
  const cls = `badge-linked${guessed ? " badge-guess" : ""}${linkable ? " badge-linkable" : ""}`;
  return `<span class="${cls}"${title}${onclick}>${escapeHtml(text)}${guessed ? " ?" : ""}</span>`;
}
function linkedItemToText(l) {
  const isObj = l && typeof l === "object";
  const guessed = isObj && l.guessed;
  const text = isObj ? l.text : l;
  return guessed ? `${text} (ยังไม่ยืนยัน)` : text;
}

function computeLinkedAccessories(row) {
  const serial = String(row[VIEW_CONFIG.moisturlyzer.serialField] || "");
  const issuedTxnIds = new Set(
    (state.data.issuanceLog || []).filter((r) => r.RequestStatus === "Issued").map((r) => r.TransactionID)
  );
  // แปลง AssetType (จากประวัติการเบิก) เป็น viewKey ของหน้ารายการที่ตรงกัน เพื่อให้กดคลิกลิงก์ไปหน้านั้นได้เลย
  const assetTypeToViewKey = { Gateway: "gateway", SimCard: "simcard", MoisturLyzer: "moisturlyzer", Panolyzer: "panolyzer" };
  const fromHistory = (state.data.issuanceItems || [])
    .filter((i) => i.ConnectSerial === serial && issuedTxnIds.has(i.TransactionID))
    .map((i) => ({ text: `${i.AssetType} ${i.SerialNo}`, viewKey: assetTypeToViewKey[i.AssetType] || null, serial: i.SerialNo }));
  const manual = String(row.Linked_Accessories_Note || "").trim();
  // manual เป็นข้อความที่ Admin พิมพ์เอง ไม่ใช่อุปกรณ์ที่ระบบติดตามจริง — ไม่มี viewKey จึงกดไม่ได้ (ตั้งใจ)
  return manual ? [...fromHistory, { text: manual }] : fromHistory;
}

/** หา Gateway ที่ซิมตัวนี้เสียบอยู่จริง "ตอนนี้" — reverse lookup จากฟิลด์ SimCard_SN ที่เก็บไว้บนตัวเอกสาร Gateway
 * เอง (ฟิลด์เดียวกับที่ระบบใช้เช็คกันเบิกซิมทับ Gateway เดิมอยู่แล้ว ดู updateSimConnectToGateway) จึงเป็นแหล่ง
 * ข้อมูลที่สดและแม่นที่สุดในระบบ ไม่ต้องพึ่งประวัติการเบิกเก่าเหมือน computeLinkedAccessories เพราะเอกสารซิมเอง
 * ไม่เคยเก็บ S/N ของ Gateway ไว้เลย (เก็บแค่ชื่อประเภทอุปกรณ์ปลายทางใน Installed_device) — คืนอาเรย์ว่างถ้าไม่เจอ
 * Gateway ตัวไหนที่ระบุว่ามีซิมนี้อยู่ (เช่น ยังไม่เคยผูกกับ Gateway ไหนเลย หรือเป็นข้อมูลเก่าก่อนหน้านี้) */
function computeSimInstalledGateway(row) {
  const simSerial = String(row[VIEW_CONFIG.simcard.serialField] || "").trim();
  if (!simSerial) return [];
  const gwCfg = VIEW_CONFIG.gateway;
  const gw = (state.data.gateway || []).find((g) => String(g[GATEWAY_SIMCARD_FIELD] || "").trim() === simSerial);
  if (!gw) return [];
  const gwSerial = String(gw[gwCfg.serialField] || "");
  return gwSerial ? [{ text: gwSerial, viewKey: "gateway", serial: gwSerial }] : [];
}

/** S/N ของ MoisturLyzer ปลายทางของ Gateway แถวนี้ — ถ้าฟิลด์ "S/N Device" มีค่าอยู่แล้ว (ยืนยันแล้ว ไม่ว่าจะพิมพ์
 * ไว้ตอนเบิก Panolyzer หรือเลือกเจาะจงไว้ตอนเบิก MoisturLyzer) คืนค่านั้นตรงๆ เหมือนเดิมทุกประการ — ถ้าว่างและ
 * Gateway แถวนี้เชื่อมต่อกับ "MoisturLyzer" (Install_device) ให้ลองเดาจากลูกค้า+สถานที่ที่ตรงกันเป๊ะกับ MoisturLyzer
 * ที่ติดตั้งอยู่จริง (ไม่ใช่ของใน Stock) เดาให้ก็ต่อเมื่อเจอ "พอดี 1 เครื่อง" เท่านั้น (กันเดาผิดถ้ามีมากกว่า 1 เครื่อง
 * ตรงกัน) ผลลัพธ์ที่เดาได้จะคืนเป็น { text, guessed: true } ให้ตัวแสดงผล (renderRowsAsTable/Cards) ใส่ badge แยก
 * ให้เห็นชัดว่ายังไม่ยืนยัน — ไม่เขียนกลับลงฐานข้อมูลเลย เป็นแค่การคำนวณตอนแสดงผลเท่านั้น */
function computeGatewayLinkedMoisturlyzer(row) {
  const cfg = VIEW_CONFIG.gateway;
  const confirmed = String(row[cfg.deviceSerialField] || "").trim();
  if (confirmed) {
    // "S/N Device" เป็นฟิลด์ text อิสระใช้ร่วมกันทั้ง MoisturLyzer/Panolyzer — ดู Install_device ถึงจะรู้ว่าเป็น
    // อุปกรณ์ประเภทไหน จะได้ลิงก์ไปหน้าที่ถูกต้อง ("Other"/ว่าง = ไม่มีปลายทางที่ระบบรู้จัก กดไม่ได้)
    const connectVal = String(row[cfg.connectField] || "").trim();
    const viewKey =
      connectVal === "Panolyzer (L)" || connectVal === "Panolyzer (RT)" ? "panolyzer" :
      connectVal === LINKABLE_TARGET_ASSET_TYPE ? "moisturlyzer" : null;
    return [{ text: confirmed, viewKey, serial: confirmed }];
  }

  if (String(row[cfg.connectField] || "").trim() !== LINKABLE_TARGET_ASSET_TYPE) return [];
  const customer = String(row.Customer_name || "").trim();
  if (!customer) return [];
  const location = String(row.Location || "").trim();

  const moistCfg = VIEW_CONFIG.moisturlyzer;
  const candidates = (state.data.moisturlyzer || []).filter((m) =>
    String(m.Customer_name || "").trim() === customer &&
    String(m.Location || "").trim() === location &&
    !isStockRow(m, moistCfg.stockField, moistCfg.stockRequiresField)
  );
  if (candidates.length !== 1) return [];
  const serial = String(candidates[0][moistCfg.serialField] || "").trim();
  return serial ? [{ text: serial, viewKey: "moisturlyzer", serial, guessed: true }] : [];
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
      { action: "approveAny", label: "อนุมัติ", cls: "btn-approve" },
      { action: "rejectIssuance", label: "ปฏิเสธ", cls: "btn-reject" },
    ])}
    ${pending.map((txn) => {
      const items = getItemsForTransaction(txn.TransactionID);
      const isTransfer = txn.MovementType === "Transfer";
      const isClaim = txn.MovementType === "Claim";
      const movementBadge = isTransfer
        ? `<span class="status-badge status-transfer">คำขอย้าย</span>`
        : isClaim
          ? `<span class="status-badge status-claim">คำขอเคลม</span>`
          : "";
      const requesterLine = (isTransfer || isClaim)
        ? `<div class="txn-meta">ผู้ขอ: ${escapeHtml(txn.IssuedBy)}${txn.FromCustomer ? ` · ลูกค้าเดิม: ${escapeHtml(txn.FromCustomer)}${txn.FromLocation ? " — " + escapeHtml(txn.FromLocation) : ""}` : ""}</div>`
        : "";
      // เคลม: โชว์ "เครื่องเดิม ⇄ เครื่องทดแทน" ให้ Admin เห็นชัดว่ากำลังจะเปลี่ยนเครื่องอะไรให้อะไร ก่อนกดอนุมัติ
      const claimSwapLine = isClaim
        ? `<div class="txn-meta">เครื่องที่เคลม: <b>${escapeHtml(txn.ClaimedSerial || "-")}</b>${txn.ReplacementSerial ? ` ⇄ เครื่องทดแทน: <b>${escapeHtml(txn.ReplacementSerial)}</b>` : " (ยังไม่เลือกเครื่องทดแทน)"}</div>`
        : "";
      return `
      <div class="txn-card">
        <div class="txn-card-head">
          ${txn._pendingSync ? "" : `<label class="txn-select"><input type="checkbox" class="bulk-approval-cb" data-txn-id="${escapeAttr(txn.TransactionID)}" onchange="toggleBulkSelect('${escapeAttr(txn.TransactionID)}', this.checked)"></label>`}
          <div>
            <div class="txn-title">${isTransfer ? "คำขอย้าย" : isClaim ? "คำขอเคลม" : escapeHtml(txn.CustomerName)} — ${escapeHtml(isClaim ? (txn.FromCustomer || txn.CustomerName || "") : txn.CustomerName)}${!isClaim && txn.SiteLocation ? " — " + escapeHtml(txn.SiteLocation) : ""}</div>
            <div class="txn-meta">เลขที่ ${escapeHtml(txn.TransactionID)} · ${formatDateTh(txn.Timestamp)}</div>
          </div>
          <span class="status-badge status-PendingApproval">รออนุมัติ</span>
          ${movementBadge}
          ${txn.IssuanceType === "ยืม" ? `<span class="status-badge status-loan">ยืม</span>` : ""}
        </div>
        ${requesterLine}
        ${claimSwapLine}
        ${txn.Details ? `<div class="txn-meta">${isClaim ? "เหตุผลที่เคลม" : "หมายเหตุ"}: ${escapeHtml(txn.Details)}</div>` : ""}
        ${!isClaim ? `<div class="txn-items">
          ${items.map((i) => `<div class="txn-item-row">${formatItemLabel(i)}${PART_QTY_DEVICE_LABEL[i.AssetType] ? "" : " — " + formatItemSerialLabel(i)}${formatConnectInfo(i)}${formatItemLocationTag(i, txn)}</div>`).join("")}
        </div>` : ""}
        ${txn._pendingSync
          ? `<div class="txn-meta">🔄 บันทึกไว้ตอนออฟไลน์ — รอซิงค์กับเซิร์ฟเวอร์ก่อนจึงจะอนุมัติได้</div>`
          : `<div class="txn-actions">
               <button class="btn-sm btn-approve" onclick="approveTxn('${escapeAttr(txn.TransactionID)}', this)">อนุมัติ${isTransfer ? "ย้าย" : isClaim ? "เคลม" : ""}</button>
               <button class="btn-sm btn-reject" onclick="rejectTxn('${escapeAttr(txn.TransactionID)}', this)">ปฏิเสธ</button>
             </div>`}
      </div>`;
    }).join("")}
  `;
}

// ============================================================
// เมนู "ย้าย/เคลม" แยกต่างหาก — ค้นหาเครื่องที่ต้องการย้าย/เคลมด้วย S/N ได้เลยทันทีที่เปิดเมนู ไม่ต้องเปิดตาราง
// อุปกรณ์แต่ละประเภทก่อนแล้วค่อยหาปุ่ม (ของเยอะเลื่อนหาลำบาก) ค้นหาข้ามได้ทั้ง MoisturLyzer/Gateway/SimCard ในช่อง
// เดียว ทุกแถวผลลัพธ์โชว์ S/N + ชื่อลูกค้า + Location กำกับไว้เสมอ กันเลือกผิดเครื่อง (ตามที่ขอมา)
// ============================================================
let transferClaimSearchTerm = "";

/** รวมแถวอุปกรณ์ที่ "เบิกออกไปแล้ว" (ไม่ใช่ Stock/กำลังเคลม/ตัดจำหน่าย) จากทั้ง 3 ประเภท มาเป็นรายการเดียวเพื่อค้นหา */
function getTransferClaimSearchableRows() {
  const rows = [];
  TRANSFER_CLAIM_ASSET_KEYS.forEach((assetKey) => {
    const cfg = VIEW_CONFIG[assetKey];
    (state.data[assetKey] || []).forEach((row) => {
      if (isStockRow(row, cfg.stockField, cfg.stockRequiresField) || isClaimedRow(row, cfg) || isWrittenOffRow(row, cfg)) return;
      rows.push({ assetKey, cfg, row, serial: String(row[cfg.serialField] || "") });
    });
  });
  return rows;
}

function renderTransferClaimSearchView() {
  const content = document.getElementById("viewContent");
  content.innerHTML = `
    <div class="tc-search-wrap">
      <input type="text" id="tcSearchInput" class="tc-search-input" placeholder="พิมพ์ S/N ที่ต้องการย้ายหรือเคลม (ค้นหาข้ามได้ทั้ง MoisturLyzer/Gateway/SimCard)" autocomplete="off">
      <div id="tcSearchResults"></div>
    </div>
  `;
  const input = document.getElementById("tcSearchInput");
  input.value = transferClaimSearchTerm;
  input.addEventListener("input", () => {
    transferClaimSearchTerm = input.value;
    renderTransferClaimSearchResults();
  });
  renderTransferClaimSearchResults();
  input.focus();
}

function renderTransferClaimSearchResults() {
  const resultsEl = document.getElementById("tcSearchResults");
  if (!resultsEl) return;
  const term = transferClaimSearchTerm.trim().toLowerCase();

  if (!term) {
    resultsEl.innerHTML = `<div class="empty-state">พิมพ์เลข S/N ด้านบนเพื่อเริ่มค้นหาเครื่องที่ต้องการย้าย/เคลม</div>`;
    return;
  }

  const matches = getTransferClaimSearchableRows()
    .filter((m) => m.serial.toLowerCase().includes(term))
    .sort((a, b) => a.serial.localeCompare(b.serial))
    .slice(0, 50); // กันรายการยาวเกินไปถ้าค้นด้วยคำสั้นๆ แล้วตรงกันเยอะมาก

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="empty-state">ไม่พบเครื่องนี้ในสถานะเบิกออกแล้ว — เครื่องอาจอยู่ใน Stock, กำลังเคลมอยู่, หรือถูกตัดจำหน่ายไปแล้ว</div>`;
    return;
  }

  resultsEl.innerHTML = matches.map((m) => {
    const customer = String(m.row.Customer_name || "").trim() || "-";
    const location = String(m.row.Location || "").trim() || "-";
    return `
      <div class="tc-result-row" onclick="openTransferClaimModal('${escapeAttr(m.assetKey)}', '${escapeAttr(m.serial)}')">
        <div class="tc-result-left">
          <div class="tc-result-sn">${highlightMatch(m.serial, term)}</div>
          <div class="tc-result-sub">ลูกค้า: <b>${escapeHtml(customer)}</b> &nbsp;·&nbsp; Location: <b>${escapeHtml(location)}</b></div>
        </div>
        <span class="tc-result-type">${escapeHtml(m.cfg.title)}</span>
      </div>`;
  }).join("");
}

/** ไฮไลต์ส่วนของ S/N ที่ตรงกับคำค้น (case-insensitive) ด้วย <mark> — ใช้ escapeHtml ครอบผลลัพธ์รวมอีกชั้นตอนแสดงผล
 * จึงต้อง escape ทีละท่อนเองในนี้ก่อนประกอบ <mark> ไม่งั้น escapeHtml ชั้นนอกจะ escape แท็ก <mark> ทิ้งไปด้วย */
function highlightMatch(text, term) {
  if (!term) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx), match = text.slice(idx, idx + term.length), after = text.slice(idx + term.length);
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

// ============================================================
// ฟีเจอร์ "ค้นหา S/N แบบพิมพ์หา" — แปลง <select class="searchable-select"> ธรรมดาให้กลายเป็นช่องพิมพ์ค้นหา
// (combobox) โดยไม่ต้องแก้โค้ดจุดที่ใช้งาน select เดิมเลยแม้แต่บรรทัดเดียว — ตัว <select> เดิมยังอยู่ใน DOM
// เหมือนเดิมทุกประการ (แค่ถูกซ่อนด้วย CSS) ทำหน้าที่เป็นค่าจริงที่โค้ดเดิมอ่าน .value / ฟัง onchange ได้ปกติ
// ใช้กับทุกจุดที่มี dropdown เลือก S/N อุปกรณ์ตามที่ผู้ใช้ขอ เพราะบางรายการมีเป็นร้อยตัว เลื่อนหาลำบากมาก
// ============================================================
function makeSearchableSelect(select) {
  if (!select || select.dataset.searchableInit) return;
  select.dataset.searchableInit = "1";

  const wrap = document.createElement("div");
  wrap.className = "ss-wrap";
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("ss-hidden-select");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ss-input";
  input.autocomplete = "off";
  input.placeholder = "พิมพ์เพื่อค้นหา...";
  const list = document.createElement("div");
  list.className = "ss-list";
  wrap.appendChild(input);
  wrap.appendChild(list);

  const optionsData = () => Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent, disabled: o.disabled }));
  const syncInputFromSelect = () => {
    const opt = select.options[select.selectedIndex];
    input.value = opt ? opt.textContent : "";
  };
  const renderList = (term) => {
    const t = (term || "").trim().toLowerCase();
    const opts = optionsData().filter((o) => !o.disabled && (!t || o.label.toLowerCase().includes(t)));
    list.innerHTML = !opts.length
      ? `<div class="ss-empty">ไม่พบรายการที่ตรงกัน</div>`
      : opts.slice(0, 300).map((o) => `<div class="ss-item${o.value === select.value ? " sel" : ""}" data-value="${escapeAttr(o.value)}">${highlightMatch(o.label, t)}</div>`).join("");
    list.classList.add("open");
  };
  input.addEventListener("focus", () => renderList(""));
  input.addEventListener("input", () => renderList(input.value));
  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 150));
  list.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".ss-item");
    if (!item) return;
    e.preventDefault();
    select.value = item.dataset.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncInputFromSelect();
    list.classList.remove("open");
    input.blur();
  });
  syncInputFromSelect();
}

/** เรียกหลังจาก render HTML ที่มี <select class="searchable-select"> เสร็จทุกครั้ง เพื่อแปลงเป็นช่องพิมพ์ค้นหา */
function enhanceSearchableSelects(root) {
  (root || document).querySelectorAll("select.searchable-select").forEach(makeSearchableSelect);
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
    // "approveAny" คือ sentinel พิเศษของปุ่มอนุมัติแบบกลุ่ม — ต้องดู MovementType ของแต่ละธุรกรรมเองแล้วเลือก action
    // ที่ถูกต้อง (approveIssuance/approveTransfer/approveClaim) เพราะเลือกได้หลายรายการปนกันในครั้งเดียว
    // ต่างจาก "rejectIssuance"/"returnTransaction" ที่เป็น action เดียวกันได้กับทุกประเภทธุรกรรมอยู่แล้ว
    const resolvedAction = action === "approveAny" ? resolveApprovalAction(ids[i]) : action;
    try {
      const res = await apiPost({ action: resolvedAction, token: state.token, transactionId: ids[i] });
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

/** ดูว่าธุรกรรมนี้เป็นคำขอเบิกปกติ/ย้าย/เคลม แล้วคืนชื่อ action ที่ถูกต้องสำหรับ "อนุมัติ" — ใช้ทั้งปุ่มอนุมัติเดี่ยว
 * และปุ่มอนุมัติแบบกลุ่ม (bulk) เพราะสามธุรกรรมนี้แต่ละแบบมีฟังก์ชันอนุมัติคนละตัวกัน (ดู functions/index.js) */
function resolveApprovalAction(transactionId) {
  const log = (state.data.issuanceLog || []).find((l) => l.TransactionID === transactionId);
  if (log && log.MovementType === "Transfer") return "approveTransfer";
  if (log && log.MovementType === "Claim") return "approveClaim";
  return "approveIssuance";
}

async function approveTxn(transactionId, btnEl) {
  await runTxnAction(resolveApprovalAction(transactionId), transactionId, btnEl, "กำลังอนุมัติ...");
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

/** ฟีเจอร์ "ยกเลิกรายการ" — Admin ยกเลิกรายการที่ "ทำไปแล้ว" (เบิก/ย้าย/เคลม สถานะ Issued) ระบบจะคืนสถานะของ
 * อุปกรณ์กลับไปเป็นก่อนหน้าทำรายการนี้ให้อัตโนมัติ (ต่างจาก "ปฏิเสธคำขอ" ที่ใช้กับคำขอที่ยังรออนุมัติอยู่เท่านั้น) */
async function cancelTxn(transactionId, btnEl) {
  const log = (state.data.issuanceLog || []).find((l) => l.TransactionID === transactionId);
  let warnText = "ยืนยันยกเลิกรายการนี้? ระบบจะคืนสถานะอุปกรณ์กลับไปเป็นก่อนหน้าทำรายการนี้ให้อัตโนมัติ";
  if (log && log.MovementType === "Transfer") {
    warnText = `ยืนยันยกเลิกการย้ายนี้? อุปกรณ์จะถูกย้ายกลับไปหาลูกค้าเดิม "${log.FromCustomer || "-"}" (${log.FromLocation || "-"}) ทันที`;
  } else if (log && log.MovementType === "Claim") {
    warnText = `ยืนยันยกเลิกการเคลมนี้? เครื่องที่เคลมออกไปจะกลับมาเป็น "เบิกอยู่" ให้ลูกค้าเดิมทันที${log.ReplacementSerial ? " และเครื่องทดแทนจะถูกดึงกลับเข้า Stock" : ""}`;
  } else {
    warnText = "ยืนยันยกเลิกรายการเบิกนี้? อุปกรณ์ทั้งหมดในรายการจะกลับเป็นสถานะ Stock ทันที (คล้ายกับปุ่ม \"คืนของ\" แต่บันทึกในประวัติว่าเป็นการยกเลิก ไม่ใช่การคืนของ)";
  }
  const confirmed = await showConfirm(warnText, { type: "warning" });
  if (!confirmed) return;
  await runTxnAction("cancelTransaction", transactionId, btnEl, "กำลังยกเลิก...", cancelTransactionErrorMessage);
}

async function runTxnAction(action, transactionId, btnEl, loadingText, errorMapper) {
  const originalText = btnEl ? btnEl.textContent : "";
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = loadingText; }
  try {
    const res = await apiPost({ action, token: state.token, transactionId });
    if (!res.ok) {
      if (res.error === "unauthorized") return handleUnauthorized();
      const conflictMsg = res.conflicts ? "\n" + res.conflicts.join("\n") : "";
      const msg = errorMapper ? errorMapper(res.error) : "ดำเนินการไม่สำเร็จ: " + (res.error || "unknown_error");
      await showAlert(msg + conflictMsg, "error");
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
    PendingApproval: "รออนุมัติ", Issued: "เบิกแล้ว", Rejected: "ถูกปฏิเสธ", Returned: "คืนแล้ว", Cancelled: "ยกเลิกแล้ว",
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
  // ไม่รวมรายการ "ย้าย"/"เคลม" (MovementType) เพราะ "คืนของ" ของปุ่มนี้ตั้งใจไว้สำหรับการเบิกปกติเท่านั้น — รายการ
  // เคลมโดยเฉพาะมีทั้งเครื่องที่เคลม (สถานะ "อยู่ระหว่างเคลม" อยู่แล้ว) และเครื่องทดแทนที่ยังใช้งานอยู่จริงปนกันอยู่
  // ในธุรกรรมเดียวกัน ถ้ากดคืนของจะไปรีเซ็ตทั้งคู่กลับเป็น Stock ผิดพลาด (เครื่องทดแทนที่ลูกค้ายังใช้อยู่จะหายไปด้วย)
  const returnableCount = isAdmin ? filtered.filter((t) => !t._pendingSync && t.RequestStatus === "Issued" && !t.MovementType).length : 0;
  if (bulkBarEl) {
    bulkBarEl.innerHTML = bulkActionBarHtml("bulk-return-cb", returnableCount, [
      { action: "returnTransaction", label: "คืนของ", cls: "btn-return" },
    ]);
  }

  listEl.innerHTML = filtered.map((txn) => {
    const items = getItemsForTransaction(txn.TransactionID);
    const canReturn = isAdmin && txn.RequestStatus === "Issued" && !txn.MovementType;
    // ฟีเจอร์ "ยกเลิกรายการ" — ใช้ได้กับทุกรายการที่สถานะ "เบิกแล้ว" (เบิกปกติ/ย้าย/เคลม) ต่างจาก "คืนของ" ที่ใช้ได้
    // เฉพาะเบิกปกติเท่านั้น (ดูหมายเหตุด้านบน) — สำหรับเบิกปกติจะมีทั้งสองปุ่มให้เลือกตามเจตนา (ลูกค้าคืนของจริง
    // ใช้ "คืนของ" / Admin ทำรายการผิดพลาดอยากลบล้างใช้ "ยกเลิกรายการ") ผลลัพธ์กับตัวอุปกรณ์เหมือนกันแต่บันทึก
    // ในประวัติต่างกัน ส่วนย้าย/เคลมมีแค่ "ยกเลิกรายการ" ทางเดียว
    const canCancel = isAdmin && txn.RequestStatus === "Issued" && !txn._pendingSync;
    const canPrint = !txn._pendingSync;
    const canEdit = isAdmin && !txn._pendingSync;
    const canDelete = isAdmin && !txn._pendingSync && (txn.RequestStatus === "Rejected" || txn.RequestStatus === "Returned" || txn.RequestStatus === "Cancelled");
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
            ${txn.CancelledAt ? `<div class="txn-meta">ยกเลิกโดย: ${escapeHtml(txn.CancelledBy)} เมื่อ ${formatDateTh(txn.CancelledAt)}</div>` : ""}
            ${txn._pendingSync ? `<div class="txn-meta">🔄 บันทึกไว้ตอนออฟไลน์ — รอซิงค์กับเซิร์ฟเวอร์</div>` : ""}
          </div>
          <span class="status-badge status-${txn.RequestStatus}">${escapeHtml(statusLabel[txn.RequestStatus] || txn.RequestStatus)}</span>
          ${txn.IssuanceType === "ยืม" ? `<span class="status-badge status-loan">ยืม</span>` : ""}
          ${txn.MovementType === "Transfer" ? `<span class="status-badge status-transfer">ย้าย</span>` : ""}
          ${txn.MovementType === "Claim" ? `<span class="status-badge status-claim">เคลม</span>` : ""}
        </div>
        ${txn.Details ? `<div class="txn-meta">หมายเหตุ: ${escapeHtml(txn.Details)}</div>` : ""}
        <div class="txn-items">
          ${items.map((i) => `<div class="txn-item-row">${formatItemLabel(i)}${PART_QTY_DEVICE_LABEL[i.AssetType] ? "" : " — " + formatItemSerialLabel(i)}${formatConnectInfo(i)}${formatItemLocationTag(i, txn)}</div>`).join("")}
        </div>
        <div class="txn-actions">
          ${canReturn ? `<button class="btn-sm btn-return" onclick="returnTxn('${escapeAttr(txn.TransactionID)}', this)">คืนของ</button>` : ""}
          ${canCancel ? `<button class="btn-sm btn-cancel-txn" onclick="cancelTxn('${escapeAttr(txn.TransactionID)}', this)">ยกเลิกรายการ</button>` : ""}
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
    case "invalid_current_password": return "รหัสผ่านปัจจุบันไม่ถูกต้อง";
    case "password_mismatch": return "รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน";
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

/** Phase 12: ให้ผู้ใช้ทุกคน (ไม่ว่า Admin/Staff) เปลี่ยนรหัสผ่านของตัวเองได้ — ใช้ตอนได้รับรหัสผ่านเริ่มต้น/รหัสที่ Admin สุ่มให้ แล้วอยากตั้งรหัสใหม่เอง */
function openChangePasswordModal() {
  openGenericFormModal(
    "เปลี่ยนรหัสผ่านของฉัน",
    [
      { label: "รหัสผ่านปัจจุบัน", type: "password" },
      { label: "รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร)", type: "password" },
      { label: "ยืนยันรหัสผ่านใหม่", type: "password" },
    ],
    async (values) => {
      const [currentPassword, newPassword, confirmPassword] = values;
      const msg = document.getElementById("genericFormModalMsg");
      msg.className = "form-msg";
      msg.textContent = "";

      if (!currentPassword || !newPassword || !confirmPassword) {
        msg.className = "form-msg error"; msg.textContent = "กรุณากรอกข้อมูลให้ครบทุกช่อง";
        return;
      }
      if (newPassword !== confirmPassword) {
        msg.className = "form-msg error"; msg.textContent = userErrorMessage("password_mismatch");
        return;
      }
      if (newPassword.length < 6) {
        msg.className = "form-msg error"; msg.textContent = userErrorMessage("password_too_short");
        return;
      }

      try {
        const res = await apiPost({ action: "changePassword", token: state.token, currentPassword, newPassword });
        if (!res.ok) {
          if (res.error === "unauthorized") return handleUnauthorized();
          msg.className = "form-msg error"; msg.textContent = userErrorMessage(res.error);
          return;
        }
        closeGenericFormModal();
        await showAlert("เปลี่ยนรหัสผ่านสำเร็จแล้ว ใช้รหัสผ่านใหม่ในการเข้าสู่ระบบครั้งถัดไป", "success");
      } catch (err) {
        msg.className = "form-msg error"; msg.textContent = "เกิดข้อผิดพลาด: " + err.message;
      }
    }
  );
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