/**
 * C2 LOOP — Service Worker
 * จุดประสงค์หลัก: ทำให้เบราว์เซอร์มองว่าแอปนี้ "ติดตั้งได้" (installable) สำหรับปุ่ม
 * "เพิ่มไปยังหน้าจอโฮม / ติดตั้งแอป" — ไม่ได้ทำ offline-cache เต็มรูปแบบ เพราะแอปนี้พึ่งพา
 * ข้อมูลสดจาก Apps Script อยู่แล้ว (มีระบบ cache-first + offline queue ของตัวเองใน script.js อยู่แล้ว)
 * จึงตั้งใจให้ service worker นี้ "บาง" ที่สุด แค่พอให้ผ่านเงื่อนไข PWA ของเบราว์เซอร์
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// pass-through fetch handler — จำเป็นต้องมี event listener นี้อย่างน้อย 1 ตัว
// เพื่อให้ Chrome/Android นับว่าเป็น PWA ที่ติดตั้งได้ (ไม่ได้ intercept/cache อะไรเป็นพิเศษ)
//
// สำคัญ: intercept เฉพาะ request แบบ GET เท่านั้น! request แบบ POST/PUT ที่มี body แนบ (เช่น การเบิก/บันทึก/
// อัปโหลดรูปอะไหล่ทุกครั้งที่คุยกับ Apps Script) ถ้าเอา event.request (ที่มี body ค้างอยู่) ไป fetch() ซ้ำผ่าน
// Service Worker แบบนี้ จะพังบน iOS Safari/PWA (เจอปัญหาจริง: POST ที่มีรูปแนบไปด้วยได้ HTTP 404 กลับมา
// ทั้งที่ request ไม่ถึงสคริปต์เลยด้วยซ้ำ — เช็คจาก Executions log ใน Apps Script ไม่เห็น doPost วิ่งเลย)
// ปล่อย request ที่ไม่ใช่ GET ให้เบราว์เซอร์จัดการเองตามปกติ ไม่ต้องผ่าน SW
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request));
});