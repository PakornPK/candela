# Catalog Gap Analysis — Candela vs Lightroom Classic

**Date:** 2026-09-22
**Scope:** Library/catalog data layer เท่านั้น (ไม่รวม Develop tools, print, export pipeline)
**วิธีทำ:** (1) audit โค้ดจริงใน `src/catalog/*`, `src/app/*`, `src/main.ts`, `native/libraw-wrapper/wrapper.cpp`
(2) research ฟีเจอร์ catalog ของ LrC จาก Adobe help docs (helpx.adobe.com) 2 ชุดขนานกัน:
Library metadata layer + Catalog/file-integrity layer
(3) จัดอันดับด้วยเกณฑ์เดียว = positioning ใน CLAUDE.md: **ชนะที่ "cull + develop RAW เร็วบน catalog หลักหมื่นรูป"**
ไม่ใช่ feature parity

**หลักฐานฝั่งเรา:** ทุกข้อ "มีแล้ว/ไม่มี" ตรวจด้วย grep ทั้ง repo + อ่าน source, ไม่ใช่การเดา
(เช่น `(f as any).cameraModel` ที่ main.ts:1526 = field ที่ไม่มีใครเขียนลง DB เลย = search กล้องตาย)

---

## Executive summary

| ระดับ | จำนวน | คืออะไร |
|---|---|---|
| **บัคที่พังอยู่ตอนนี้** | 2 | search/smart-collection ตามกล้อง-เลนส์ตายสนิท, `backup.ts` เป็นไฟล์ตาย |
| **P0 — Critical (บล็อก daily use)** | 6 | EXIF ที่ import, catalog backup/eviction, missing-file, Remove vs Delete, Metadata filter bar, keywords |
| **P1 — Important** | 8 | standard preview tier, stacks, painter, target collection, survey, XMP read, IPTC, duplicate detection |
| **P2 — Nice-to-have / Reject** | 7 | smart previews, virtual copies, rename/move ในแอป, DNG convert, AI culling, collection sets, synonyms |

### Implementation status (อัปเดต 2026-09-23)

| ข้อ | สถานะ | หลักฐาน |
|---|---|---|
| บัค 1: search กล้อง/เลนส์ตาย | ✅ แก้แล้ว | identify() ใน wrapper.cpp + exif.ts + import.ts เขียน cameraModel/lensModel/dateTaken/iso/focalLength ลง DB จริง; QA loop C11: search 'X100V' = 1 cell (เดิม 0), DB row = 'Fujifilm X100V' iso 320 focal 23 dateTaken = EXIF wall-clock |
| บัค 2: backup.ts ไฟล์ตาย | ✅ เขียนใหม่ | serialize/parse round-trip + base64 typed-array masks + wireCatalogBackup; 49 unit tests |
| P0-1 EXIF ที่ import | ✅ | wasm rebuild 736,317→740,641B; identify-only path (~ms ต่อไฟล์ ไม่ unpack Bayer); shouldIdentify gate ไม่อ่านไฟล์ที่ไม่เปลี่ยน; re-import คง rating/keywords (tested) |
| P0-2 backup/restore + persist() | ✅ | Export/Restore catalog ปุ่มใน Library aside, requestStoragePersistence() ตอน boot, #backup-status แสดง verdict; v5→v6 upgrade ทดสอบกับ DB เก่าจริง (rating/keywords รอด) |
| P0-3 missing-file + relink | ✅ wire แล้ว (wave 3) | QA loop C17: ลบไฟล์จาก OPFS → click → badge '!' + DB missing=true + banner ไม่เด้ง (classifier ถูก) → reload badge ค้างที่ boot → locate-missing relink หายครบ |
| P0-4 Remove vs Delete | ✅ wire แล้ว (wave 3) | QA loop C18: Delete → dialog เปิดที่ safe verb → row+edits+thumbnails หาย ไฟล์อยู่บนดิสก์ครบ; ใน collection = membership-only ไม่มี dialog |
| P0-5 filter bar | ✅ wire แล้ว (wave 2) | QA loop C14: columns derive จาก catalog, preset unrated กรอง + Clear คืนครบ |
| P0-6 keywords | ✅ wire แล้ว | QA loop C12: add→tally→click filter→DB merge โดย EXIF ไม่หาย |
| P1-2 stacks | ✅ wire แล้ว (wave 2) | QA loop C16: auto-stack collapse → badge → expand → ungroup |
| P1-5 survey | ✅ wire แล้ว (wave 2) | QA loop C15: tiles layout, arrows wrap, x non-destructive (rating คงเดิม) |
| P1-7 IPTC | ✅ wire แล้ว | QA loop C13: apply-to-selection เขียนลง DB, merge ไม่ทับ keywords |
| P1-4 target/quick collection | ✅ wire แล้ว (wave 3) + แก้ engine bug | createCollection ไม่เคยเขียน quick:true → tray ถูก mint ซ้ำทุก ensure (วัดได้ 1→3→5 แถว) แก้ที่ root ใน collections.ts + IDB tests 4 ตัว; QA loop C19: B toggle, tray=1 ข้าม boot, Cmd+B เปิด view |
| P1-8 duplicate detection | ✅ wire แล้ว (wave 3) + แก้บัค gate | gate เคย key ฝั่ง existing แบบ dated แต่ incoming undated เสมอ (gate ทำงานก่อน identify) → RAW duplicate ไม่เคย match; แก้เป็น name+size ทั้งสองฝั่ง + unit test; QA loop C20: second-copy import rows คงเดิม |
| Print geometry (นอก scope เดิม แต่เจอระหว่างทาง) | ✅ แก้แล้ว | PDF content stream: แผ่นเคยถูกวาดที่ x=220 y=33 โดน clip + พื้น #121213 เต็มหน้า → 1 หน้า พื้นขาว รูปที่ margin 10mm; QA loop C5/C6 |

QA loop: `npm run qa` (เต็ม ~4 นาที, 21 checks, รวม RAF 58MB) / `npm run qa:fast` (~30 วิ) — 21/21 PASS ณ จุดที่ wave 3 ลงครบ
Gates: tsc clean, vitest 755/755 (จาก 428 เดิม), build green

### Plan A — "Working set ชัด" (อนุมัติ 2026-09-23, ✅ ลงครบ)

ที่มา: คำถาม dogfood "import แล้วแต่งโดยไม่สร้าง collection จะเป็นยังไง" — คำตอบเชิงโครงสร้าง:
ไม่พัง (edits key ด้วย fileId แยกจาก collections พิสูจน์ E2E แล้ว) แต่ปัญหาจริงคือ
**แต่งแล้วมองไม่เห็น working set** ว่าอยู่ในชุดงานไหน Proposal เดิมคือ hard gate
"ต้องมี collection ก่อนถึงจะเข้า Develop" — research แล้ว **LrC ไม่ได้ทำแบบนั้น**
(Adobe doc: "Select a photo in the Library module and press D"; collections = optional
organizer) และ CLAUDE.md วาง positioning ว่า cull+develop เร็ว/no friction — เจ้าของโปรเจกต์
เลือกแผน A: ไม่ gate แต่ทำให้ working set มองเห็นและเก็บได้ในหนึ่งปุ่ม

รายการ (engine → wiring → QA):
1. **Previous Import source** (LrC มี เราไม่มี): `importBatch?: number` บน FileRecord —
   stamp เฉพาะแถว NEW ต่อหนึ่ง import run (merge คง stamp เดิม = semantics "photos ADDED
   by the most recent import"); Library folder list เพิ่มแถว "Previous Import" (batch ล่าสุด)
   เป็น view selector ที่สามรองจาก folder/collection
2. **Filter bar คอลัมน์ 'edited'**: truth อยู่ที่ edits store (currentOps ไม่ว่าง) —
   `listEditedFileIds(db)` getAll ทีเดียว; applyFilters รับ ctx `{editedIds?}` (ไม่มี ctx =
   คอลัมน์ถูกละเว้น ไม่ใช่ grid ว่าง); vocabulary 'edited'|'unedited'
3. **Nudge สอนปุ่ม B**: `collectionNudge(pickedCount, trayMemberCount, alreadyNudged)` —
   picked ≥ 20 + tray ว่าง + ยังไม่เคยเตือน (ต่อ session) → flash "กด B เก็บลง Quick
   Collection" หนึ่งครั้ง ไม่บังคับ ไม่ถามซ้ำ
4. **Smart collection จาก selection**: มีอยู่แล้ว (`smart-scope=selected` → criteria.fileIds
   ใน smart dialog) — ไม่ต้องสร้างใหม่ เพิ่มแค่ QA check

Engine (disjoint files): filters.ts + editsStore.ts + import.ts + types.ts + collections.ts
(nudge helper) พร้อม unit tests; wiring agent ถือ main.ts/index.html; QA loop เพิ่ม checks
previous-import / edited-chip / nudge / smart-from-selection แล้วรันยาว (full, ไม่ใช่ fast)

ผลลงจริง: engine +32 tests (790/790), wiring main.ts +196/-7 + index.html CSS,
QA checks ใหม่ C21-C24 (group planA) — พิสูจน์ในเบราว์เซอร์จริง:
edited chip แยก E1/E2 ถูกหลัง Develop commit, Previous Import = batch ล่าสุดเท่านั้น
(+1 ไฟล์ → PI=1), nudge fired ครั้งเดียวต่อ session + tray-non-empty suppress,
smart-from-selection scope ถูก 20→3. บัคที่เจอระหว่าง wiring แล้วแก้: 'All folders'
double-lit ตอน PI active, PI view ค้างหลัง import ใหม่ (retire เมื่อ imported>0 ตาม
LrC semantics). Contact sheet จงใจไม่รองรับ PI (ไม่ใช่ film roll — comment ในโค้ด)

**Top 3 moves ที่ควรทำก่อน (impact ต่อ core workflow ต่อหน่วย effort):**

1. **EXIF ที่ import** (capture date, camera, lens, ISO, focal) — ฟีเจอร์เดียวที่ปลดล็อก 5 อย่าง:
   แก้บัค search, ทำให้ smart collection dateRange/camera ทำงานจริง, เปิดทาง metadata filter,
   stacks-by-capture-time, และ sort ตามวันที่ถ่ายจริง (ตอนนี้ใช้ `lastModified` = วันที่ก๊อปไฟล์ลงดิสก์)
   LibRaw มีข้อมูลนี้อยู่แล้ว (`imgdata.imgdata.idata.datetime_original`, `lens`, `iso_speed`) —
   wrapper แค่ยังไม่ expose
2. **Catalog backup/restore จริง + `navigator.storage.persist()`** — ตอนนี้ ratings/edits/collections
   ทั้งหมดมีอยู่**ที่เดียวคือ IndexedDB** ซึ่ง Chrome evict ได้ และไม่มีใครเรียก `persist()` เลย
   (grep = 0 hits) LrC เตือนเรื่องนี้ชัดว่า catalog = ผลงานจริง ไม่ใช่รูป — เราเสี่ยงกว่า LrC
   เพราะไม่มี `.lrcat` ให้ Time Machine เจอด้วยซ้ำ
3. **Standard preview tier (~2048px)** — ปมสถาปัตยกรรมที่แท้จริงของการ cull:
   เปิดรูปใน Loupe วันนี้จ่ายเต็มเสมอ (อ่าน 58MB + LibRaw decode ~1.6s) LrC แยก 3 cache
   (Standard preview / 1:1 / Camera Raw cache) ด้วยเหตุผลนี้เป๊ะ เรามีแค่ camera JPEG (320px thumbnail)
   กับ full decode — ขาดชั้นกลางที่ทำให้ arrow-key culling ลื่นทันที

**สิ่งที่ไม่ได้ครอบคลุม:** ไม่ได้ benchmark catalog 50k/100k จริง (ROADMAP 4.2 ยังไม่ได้ทำ),
ไม่ได้วัดว่า virtualized grid + IDB cursor รับ row count เท่าไหร่ได้ก่อนพัง — ควรทำก่อนลงมือ P0 ข้อใหญ่

---

## มีอยู่แล้ว (ยืนยันจาก source — ไม่ต้องทำซ้ำ)

| ความสามารถ | อยู่ที่ไหน | เทียบ LrC |
|---|---|---|
| Catalog = IndexedDB (folders/files/edits/thumbnails/editedThumbnails/presets/collections/smartCollections), v5 | `src/catalog/db.ts` | ตรงกับ model ของ LrC: catalog เป็น index DB, รูปไม่เข้า DB |
| Folder-based import (picker + drag&drop), upsert ไม่ซ้ำ row | `src/catalog/import.ts`, `main.ts:5050` | = "Add" ของ LrC (index in place, ไม่ copy) |
| Rating 1-5, pick/reject flag, color label 1-4 (คีย์ 6-9), U = clear | `src/catalog/culling.ts`, `src/app/shortcuts.ts` | ครบตาม LrC attribute state |
| Auto-advance after rating | `#auto-advance` checkbox | = Auto Advance / Caps Lock ของ LrC |
| Collections (manual) + Smart Collections (rating/flag/camera/lens/date/folder) | `collections.ts`, `smartCollections.ts` | มีโครง แต่ criteria engine พังบางข้อ (ดูบัค) |
| Compare (2-4 รูป), Contact sheet, Print | `src/app/`, modules | Compare ตรง LrC; **Survey ยังไม่มี** |
| Sync Settings (module dialog + delta semantics), copy/paste settings | `syncOps.ts`, `main.ts` | ตรง LrC Sync |
| Second monitor, tethered capture | `secondMonitor.ts`, `tetheredCapture.ts` | มีแล้ว (LrC: Important/Nice) |
| Virtualized grid + filmstrip, strip = กระจกของ grid | `main.ts`, `filmstrip.ts` | ตรง pattern LrC |
| Developed-thumbnail cache + digest freshness + restore-access banner | `thumbnails.ts`, `offscreenRenderer.ts` | ไม่มีใน LrC ตรงๆ — นี่คือ "Standard preview" ของเราที่ 320px |
| Search bar (filename) | `main.ts:1521` | มี แต่ scope แคบ + พังครึ่งหนึ่ง (ดูบัค) |

---

## 🔴 บัคที่เจอระหว่าง audit (แก้ก่อนเลย — ไม่ใช่ gap)

### BUG-1: `cameraModel`/`lensModel` ไม่มีใครเขียนลง DB → search + smart collection ตามกล้องตาย

**หลักฐาน:** `main.ts:1526-1527` ค้น `(f as any).cameraModel` / `lensModel`,
`smartCollections.ts:103,107` filter ด้วย field เดียวกัน — แต่ `FileRecord` (`types.ts:8-21`) ไม่มี field นี้,
`import.ts` ไม่ extract EXIF ใดๆ, grep ทั้ง repo ไม่พบการเขียน field นี้เลย
**ผลจริง:** smart collection "camera contains X100V" (ตัวอย่างใน ROADMAP 2.1 เอง) คืนค่าว่างเสมอ,
ค้นชื่อกล้องใน search bar ไม่เจอ — เงียบๆ ไม่มี error
**ทำไมสำคัญ:** ผู้ใช้หนีมาจาก LrC จะตั้ง smart collection ด้วยกล้อง/เลนส์เป็นนิสัยแรก
**แก้:** = ข้อ P0-1 (EXIF ที่ import) — root cause เดียวกัน อย่าแก้ที่ symptom (เช่น hardcode จาก filename)
**Effort:** M (แก้ wrapper.cpp ให้ expose idata fields → decode.ts → import.ts → types.ts + migration)
**Roadmap:** แก้ P0-1 แล้วข้อนี้หายไปด้วย

### BUG-2: `src/catalog/backup.ts` เป็นไฟล์ตาย + ชื่อทำให้เข้าใจผิดว่ามี backup

**หลักฐาน:** `grep -rn "from './backup'\|catalog/backup" src/` = **0 hits** — ไม่มีใคร import
ข้างในเขียน `localStorage` backup ของ `Map<number, EditState>` (JSON.stringify Map = `"{}"` ด้วยซ้ำ — ผิดตั้งแต่หลักการ)
ส่วน `startBackupSystem()` ที่มีชีวิตจริง (`main.ts:3239`) ทำแค่ auto-save ไฟล์**ที่เปิดอยู่**ทุก 30 วิ — ไม่ใช่ backup
**ผลจริง:** ไม่มี backup ใดๆ ทั้งสิ้น แต่ชื่อไฟล์บอกว่ามี → กับดักสำหรับ dev คนถัดไป
**แก้:** ลบไฟล์ทิ้ง แล้วทำข้อ P0-2 แทน (backup จริง = export/import ทั้ง catalog)
**Effort:** S (ลบ) + M (ทำของจริง)

---

## P0 — Critical (บล็อกการเป็น daily driver)

### P0-1. EXIF metadata ที่ import (capture date, camera, lens, ISO, focal length)
- **LrC ทำอะไร:** อ่าน EXIF ตอน import เข้า catalog; ใช้เป็น metadata filter columns, smart collection criteria
  (Camera/Serial/Lens/Focal/Shutter/Aperture/ISO/Capture Date), sort ตามวันที่ถ่าย, auto-stack by capture time
  ([smart criteria](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/smart-collections-criteria-in-lightroom-classic.html),
  [metadata basics](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/metadata-basics-actions.html))
- **เรามีอะไร:** `lastModified` เท่านั้น — และโค้ดเราเขียนยอมรับไว้ตรงๆ (`smartCollections.ts:111`:
  *"There is no EXIF capture date yet"*) Metadata panel ใน Develop อ่านจาก `lastDecoded.cameraMeta`
  = ต้อง decode ก่อนถึงจะเห็น EXIF → **Library มองไม่เห็น EXIF เลย**
- **ทำไม critical สำหรับเรา:** sort "รูปวันนี้" ผิด (lastModified = วันที่ copy ลงดิสก์ ไม่ใช่่วันถ่าย),
  smart collection dateRange/camera/lens ใช้ไม่ได้จริง, filter bar (P0-5) ไม่มีข้อมูลให้กรอง
- **ทางแก้ที่ตรงกับสถาปัตยกรรม:** LibRaw parse นี้อยู่แล้วตอน identify() — เพิ่ม getter ใน `wrapper.cpp`
  (`decode_result_datetime_original`, `_lens`, `_iso`, `_focal`) แบบเดียวกับที่เพิ่งทำกับ `flip`,
  แล้ว**เรียก LibRaw identify ตอน import** (ไม่ต้อง decode bayer — `open_buffer` เฉยๆ เร็วกว่ามาก)
  หรือทางที่ถูกกว่า: อ่าน EXIF จาก embedded JPEG ที่ extract อยู่แล้ว (มี Exif ในนั้น) เพื่อไม่ต้องแตะไฟล์ RAW ทั้งไฟล์ตอน import
- **Effort:** M · **Roadmap:** ขยาย 2.2 (Advanced Search & Filters) — ของเดิมเขียนแค่ "SQL LIKE on camera_model"
  โดยไม่ได้สังเกตว่า field นั้นไม่มีจริง

### P0-2. Catalog backup / restore + ขอ storage persistence
- **LrC ทำอะไร:** backup อัตโนมัติตอนออกจากโปรแกรม (Next Exit / Every Exit / Daily / Weekly / Monthly),
  มี "Test Integrity Before Backing Up", restore = เปิดไฟล์ `.lrcat` ที่ backup ไว้;
  Adobe เตือนชัดว่า **backup มีแต่ catalog ไม่มีรูป** และ catalog = ผลงานจริงทั้งหมด
  ([back up catalog](https://helpx.adobe.com/lightroom-classic/help/back-catalog.html))
- **เรามีอะไร:** ไม่มีเลย (BUG-2) — ratings/edits/collections/keywords ทั้งหมดอยู่ใน IndexedDB ก้อนเดียว
- **ทำไม critical กว่าใน LrC:** Chrome **evict origin storage ได้** เมื่อ disk ตึง และเรายังไม่เคยเรียก
  `navigator.storage.persist()` (grep = 0 hits) → ผู้ใช้ cull รูป 10,000 ใบทิ้งไว้ แล้วกลับมาเจอ catalog ว่าง
  โดยไม่มี warning ใดๆ นี่คือความเสี่ยง data-loss อันดับหนึ่งของ product ตอนนี้
- **ทางแก้ (3 ชั้น, เรียงตามความถูก):**
  1. `navigator.storage.persist()` ตอน boot + อ่าน `navigator.storage.estimate()`
     แล้วบอกผู้ใช้เมื่อ quota เหลือน้อย / เมื่อ persist ถูกปฏิเสธ (S)
  2. Export catalog เป็นไฟล์ JSON ที่ผู้ใช้ดาวน์โหลด (edits + ratings + flags + labels + collections +
     smart collection rules + keyword — **ไม่รวม thumbnail blob**) + Import กลับ (M)
     → ตรงกับ model ของ LrC เป๊ะ: backup = metadata เท่านั้น
  3. Auto-backup ตอนปิดแท็บไป OPFS/โฟลเดอร์ที่ grant ไว้ (L — ค่อยทำ)
- **Effort:** S+M · **Roadmap:** แทนที่ 4.3 (Edit State Backup) ที่เขียนไว้คลุมเครือและ implement เป็นไฟล์ตาย

### P0-3. Missing-file detection + relink
- **LrC ทำอะไร:** badge `!` บน cell, `Library > Find All Missing Photos`, Locate dialog พร้อม
  **"Find nearby missing photos"** (relink ทั้งโฟลเดอร์ในครั้งเดียว), folder ที่ volume หาย = `?` + greyed,
  **edits ยังอยู่** เพราะอยู่ใน catalog record ([locate missing](https://helpx.adobe.com/lightroom-classic/help/locate-missing-photos.html))
- **เรามีอะไร:** ไม่มี — grep `NotFoundError|file missing|relink` = 0 hits
  ที่ใกล้เคียงที่สุดคือ restore-access banner (เพิ่งทำ) ซึ่งจัดการกรณี *permission หาย* ไม่ใช่ *ไฟล์หายจริง*
- **ทำไม critical สำหรับเรา:** กลุ่มเป้าหมายมี RAW อยู่บน external drive หลายลูก — สลับดิสก์/ย้ายโฟลเดอร์
  เป็นเรื่องปกติ และเราเป็น browser app: handle ที่ persist ไว้ใน IDB อาจชี้ไฟล์ที่ถูกย้าย/ลบไปแล้ว
  ตอนนี้ถ้าไฟล์หาย ผู้ใช้เห็นแค่ thumbnail ค้าง + error toast ตอนคลิก ไม่มีทางรู้ว่าอันไหนพังหรือแก้ยังไง
- **ข้อได้เปรียบของเรา:** edit อยู่รอดอยู่แล้ว (catalog-first เหมือน LrC) — เหลือแค่ *ทำให้มอง* ให้เห็น
- **ทางแก้:** ตรวจ `handle.getFile()` ล้มเหลว → mark record ว่า missing → badge `!` บน cell +
  filter chip "Missing" + ปุ่ม relink (เปิด picker ให้ชี้ไฟล์ใหม่ แล้ว update handle ใน record)
  ต่อยอดจาก `ensureReadPermission`/`failedRenderIds` pattern ที่มีอยู่
- **Effort:** M · **Roadmap:** ใหม่ (ไม่มีใน ROADMAP เลย)

### P0-4. Remove vs Delete-from-disk (ลบรูปอย่างปลอดภัย)
- **LrC ทำอะไร:** Delete key → dialog แยก **Remove** (ออกจาก catalog, ไฟล์ยังอยู่) กับ
  **Delete From Disk** (ลง Trash); ใน collection = remove membership เฉยๆ ไม่มี dialog;
  โฟลเดอร์: ไม่มี delete-from-disk เลยโดยเจตนา (safety-by-limitation)
  ([manage photos](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/photos.html))
- **เรามีอะไร:** ไม่มีทางลบไฟล์/ลบ row ออกจาก catalog เลย (grep `deleteFile|removeFile` = 0 hits)
- **ทำไม critical:** การ cull คือการ**คัดออก** — LrC user กด X (reject) แล้วลบ reject ทิ้งเป็นร้อยๆ ไฟล์ต่อ shoot
  ถ้าไม่มี verb นี้ ผู้ใช้ต้องออกไปลบใน Finder แล้ว catalog จะ desync (กลายเป็น P0-3 ทันที)
  และนี่เป็น trust-boundary ที่ต้องมี confirm ชัดเจน: ลบจาก catalog ≠ ลบจากดิสก์
- **ทางแก้:** verb แยกกันชัดเจนตาม LrC + `showDirectoryPicker({mode:'readwrite'})` ที่เราใช้อยู่แล้ว
  ทำให้ลบไฟล์จริงได้ (ต้องยืนยัน 2 ชั้น + บอกจำนวน + ไม่ให้ undo)
- **Effort:** M · **Roadmap:** ใหม่

### P0-5. Metadata filter bar (หลายคอลัมน์, intra-column OR / inter-column AND)
- **LrC ทำอะไร:** Filter bar 4 โหมด (Text/Attribute/Metadata/None), Shift+click เพื่อซ้อนโหมด,
  Metadata ได้ถึง 8 คอลัมน์ (Date, Camera, Lens, Label, Rating, Flag, Keywords, "No Keywords", Metadata Status…),
  คอลัมน์ AND กัน / ค่าในคอลัมน์เดียวกัน OR กัน, filter presets ("Rated"/"Unrated"),
  lock filters + จำ filter ต่อ source ([finding photos](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/finding-photos-catalog.html))
- **เรามีอะไร:** rating chips (exactly N) + Min rating dropdown + folder filter + text search — AND กัน
  แต่**ไม่มีมิติ camera/lens/date/label/flag** เลย (และ label/flag ไม่มี UI กรองใน Library)
- **ทำไม critical:** นี่คือเครื่องมือที่เปลี่ยน catalog 100k ให้เป็น "unrated backlog ของกล้องตัวนี้"
  ในคลิกเดียว — เป็นหัวใจของ workflow cull แบบหลายรอบ (pass 1: reject, pass 2: rate, pass 3: label)
- **ทางแก้:** ต่อยอด `matchesCullFilter` ที่ AND กันอยู่แล้ว → เพิ่มคอลัมน์ (ต้องพึ่ง P0-1 ก่อนสำหรับ camera/lens/date)
  รักษา semantics ให้ตรง LrC: ค่าในคอลัมน์เดียวกัน OR, ข้ามคอลัมน์ AND
- **Effort:** M-L · **Roadmap:** ขยาย 2.2

### P0-6. Keywords (ระบบ keyword ขั้นต่ำ)
- **LrC ทำอะไร:** Keyword List panel (registry ทั้ง catalog + นับรูปต่อ keyword), Keywording panel
  (พิมพ์ comma-separated ลง selection), hierarchical (`animals|dogs|Border Collie`), synonyms,
  keyword sets, suggestions (จากรูปที่ถ่ายใกล้เวลากัน), Painter spray, keyword ตอน import,
  badge บน thumbnail, คลิก keyword = filter ทั้ง Grid+Filmstrip
  ([keywords](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/keywords.html))
- **เรามีอะไร:** ไม่มีเลย — grep `keyword` ทั้ง repo = **0 hits**
- **ทำไม critical:** เป็นแกน organization ที่สาม (นอกจาก folder กับ collection) และเป็นแกนที่ scale ดีที่สุด
  ที่ 10k-100k รูป — LrC refugees จะหาเป็นอย่างแรก; และเป็น field ที่ smart collection/search ต้องกรองได้
- **MVP ที่คุ้ม effort (ไม่ต้องเอา hierarchy/synonyms รอบแรก):**
  flat keyword ต่อรูป (store: `keywords` + index), Keywording panel ใน Library sidebar,
  badge บน cell, filter/search ตาม keyword, เพิ่ม keyword ตอน import
  → hierarchy/synonyms/sets/suggestions ค่อยเพิ่มทีหลังบนโครงเดียวกัน
- **Effort:** M (MVP) · **Roadmap:** ใหม่ — ใหญ่กว่าที่ ROADMAP เคยประเมินไว้ (ไม่มี mention เลย)

---

## P1 — Important (ทำให้เร็วขึ้น/ลื่นขึ้น แต่ไม่บล็อก)

### P1-1. Standard preview tier (~2048px developed render) ← **ปมสถาปัตยกรรมที่สำคัญที่สุด**
- **LrC ทำอะไร:** 3 cache แยกกัน — Standard preview (ขนาดจอ, ใช้ใน Grid/Loupe-fit),
  1:1 preview (ใช้ตอน zoom 100%), Camera Raw cache (ใช้ตอนแก้像素ใน Develop);
  Adobe เองบอกว่า preview strategy = คานงัดความเร็วที่รู้สึกได้อันดับ 1,
  "golden rule: always create Standard or 1:1 previews [on import]"
  ([optimize performance](https://helpx.adobe.com/lightroom-classic/help/optimize-performance-lightroom.html))
- **เรามีอะไร:** 2 ชั้นเท่านั้น — camera JPEG (embedded, สี/โทนอาจไม่ตรง เช่น Fuji B&W film-sim)
  และ developed render **320px** สำหรับ thumbnail ส่วน Loupe จ่ายเต็มทุกครั้ง (อ่าน 58MB + decode ~1.6s)
- **ทำไม important ต่อ core win:** cull ด้วย arrow keys ใน Loupe วันนี้ = 1.6s ต่อรูป
  ที่ 2,000 รูปต่อ shoot = ชั่วโมงของการรอ ทั้งที่เรามี GPU pipeline ที่ render 320px ได้เร็วอยู่แล้ว
- **ทางแก้:** เพิ่ม tier ~2048px ใน `OffscreenRenderer` (developed, สีตรง, crop แล้ว) —
  Loupe โชว์ tier นี้ทันที แล้ว decode full-res เบื้องหลังเพื่อ 1:1 (เหมือน LrC เป๊ะ)
  + **สร้างตอน import แบบ background พร้อม progress/pause** ไม่ใช่ lazy ตอน scroll
- **⚠️ ข้อค้นพบเรื่อง scale ที่ต้องตัดสินใจก่อน:** developed thumbnail ของ RAW เป็น *mandatory* แล้ว
  (ทุก RAW ต้อง render — เพราะ camera JPEG ไม่ตรงกับ pipeline) และ render ไล่ serial ผ่าน offscreen pipeline ตัวเดียว
  ที่ต้อง decode ไฟล์ 58MB ทุกครั้ง → **10,000 RAW ≈ ชั่วโมงของการ decode**
  ต้องมี: import-time build พร้อม progress + budget/pause, priority queue (cell ที่เห็นก่อน),
  และตอบให้ได้ว่า tier 2048px จะคูณต้นทุนนี้เท่าไหร่ (อาจเก็บแค่ 320px + สร้าง 2048px on-demand ต่อรูปที่เปิด)
- **Effort:** L · **Roadmap:** ใหม่ (4.2 Large Catalog Performance เขียนไว้แต่เรื่อง grid virtualization)

### P1-2. Stacks + auto-stack by capture time
- LrC: Group Into Stack, collapse/expand (badge นับ), top-of-stack เป็นตัวแทน, Auto-Stack By Capture Time (gap 0s-1h),
  stack ต่อ folder/collection ([stacks](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/grouping-photos-stacks.html))
- เรา: ไม่มี (grep `stack` เจอแต่ GPU/JS stack)
- ทำไม: burst/bracket ทำให้ grid รกตอน cull — Fuji user ยิง burst เป็นนิสัย
- ต้องพึ่ง P0-1 (capture date) ก่อน · **Effort:** M

### P1-3. Painter tool (spray rating/flag/label/keyword)
- LrC: เปิด Painter, เลือกสิ่งที่พ่น, ลากผ่าน grid cells, Alt = ลบ ([keywords](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/keywords.html))
- เรา: ไม่มี · ทำไม: attribute pass ทีละหลายร้อย thumb โดยไม่ต้อง select ทีละอัน
- ต่อยอด `setCull` ที่มีอยู่ได้เลย (merge-write ต่อไฟล์อยู่แล้ว) · **Effort:** S-M

### P1-4. Target collection / Quick Collection (B, Shift+B)
- LrC: Quick Collection = ถาดชั่วคราวระหว่าง cull รอบแรก, `B` เพิ่ม/ลบจากทุกโมดูล, `Shift+B` เพิ่ม+เลื่อน,
  `Cmd+Alt+B` แปลงเป็น collection จริง; collection ใดก็ตามตั้งเป็น target ได้
  ([collections](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/photo-collections.html))
- เรา: มี collections แต่**ไม่มี target concept** (grep = 0) · ทำไม: เป็น workflow ที่ใกล้ universal ที่สุดของ LrC
- ต่อยอด `collections.ts` + `shortcuts.ts` ที่มีการ map คีย์อยู่แล้ว · **Effort:** S

### P1-5. Survey view (N) + remove-from-survey
- LrC: tile preview ของทุก selection, ขอบขาว = active, ปุ่ม × เอา tile ออกจากการพิจารณา (ไม่แก้ rating),
  rate/flag/label ใต้ทุก tile ([browse-compare](https://helpx.adobe.com/lightroom-classic/desktop/viewing-photos/browse-compare-photos.html))
- เรา: มี Compare (2-4 รูป, select/candidate ไม่ชัด) แต่ไม่มี Survey
- ทำไม: Survey = จอ cull เร็วของจริง (ตัด 20-40 frame ต่อจอ); "remove from survey" = reject แบบไม่ทำลาย
- **Effort:** M · **Roadmap:** 3.2 เขียนเป็น Compare อย่างเดียว — ควรแยกเป็น 2 view ตาม LrC

### P1-6. อ่าน XMP sidecar (migration path จาก LrC)
- LrC: RAW proprietary → `.xmp` ข้างไฟล์ (ไม่เคยเขียนเข้า RAW), JPEG/TIFF/DNG → ฝังในไฟล์;
  ในนั้นมี keywords, IPTC, rating, และตั้งแต่ v13.2 มี pick/reject flag ด้วย
  ([sidecar/ACR](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/create-xmp-acr-files.html))
- เรา: **ไม่มี** (เคยมี write-back path แต่ตัดออกตามการตัดสินใจของผู้ใช้ 2026-09-19: export = download เท่านั้น)
- ทำไม important: คนที่หนีมาจาก LrC มี rating/keyword/label อยู่ใน sidecar **แล้วเป็นหมื่นไฟล์** —
  อ่านเข้า = migration killer feature ที่ทำให้ switching cost ใกล้ศูนย์
- ⚠️ **เขียน sidecar: แนะนำ Reject/defer** — เราเพิ่งตัด write-back ออกเพราะ permission pain (mode read → escalate ไม่ได้เลย)
  และ CLAUDE.md บอกชัดว่าไม่แตะ color profile/DCP; การเขียนทับไฟล์ผู้ใช้เป็น risk ที่ไม่คุ้มในระยะนี้
- **Effort:** M (read only) · **Roadmap:** ใหม่

### P1-7. IPTC metadata แก้ได้ (title/caption/copyright/creator) + metadata preset ตอน import
- LrC: metadata presets (Edit → Save Current Settings as New Preset) คือกลไก "ทุก shoot ใหม่ได้ copyright ของเรา",
  Sync/Auto Sync metadata, copy/paste metadata ([advanced metadata](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/advanced-metadata-actions.html))
- เรา: ไม่มี (grep `IPTC|caption|copyright` = 0) · ทำไม: semi-pro ส่งงานต้องมี copyright/caption;
  และเป็น field ที่ search/filter ต้องเข้าถึง (LrC: "Title/Caption is empty" เป็น smart criterion)
- เก็บใน record เหมือน culling marks (schemaless, ไม่ต้อง bump DB version) · **Effort:** M

### P1-8. Duplicate detection ตอน import
- LrC: "Don't Import Suspected Duplicates" — เทียบ **original filename + EXIF capture time + file size**
  ([import options](https://helpx.adobe.com/lightroom-classic/help/photo-video-import-options.html))
- เรา: `upsertFile` กันซ้ำด้วย `[folderId, path]` เท่านั้น → import โฟลเดอร์เดิมที่ copy ไว้สองที่ = row ซ้ำ,
  cull count เพี้ยน (grep `duplicate` ใน import path = 0)
- **Effort:** S (มี size+name แล้ว; เพิ่ม capture time เมื่อ P0-1 ลง)

---

## P2 — Nice-to-have / แนะนำ Reject หรือ Defer

| Feature | LrC | คำแนะนำสำหรับเรา + เหตุผล |
|---|---|---|
| **Smart Previews** (proxy แก้ได้ตอน drive offline) | Critical ใน LrC | **Defer** — เราไม่มีทาง export/print จาก proxy ได้จริง (ต้องอ่าน RAW) และ browser storage ไม่พอเก็บ proxy หลักหมื่นไฟล์; tier 2048px (P1-1) ครอบคลุมความต้องการ "ดูเร็ว" ไปแล้ว 80% |
| **Virtual copies** (1 RAW หลาย look) | Important | **Defer** — edit history + presets ของเราให้ผลใกล้เคียงในระดับ cull; ทำเมื่อ Develop workflow โตกว่านี้ (เป็น op-graph branch = งานสถาปัตยกรรมใหญ่) |
| **Rename / move ไฟล์ในแอป** | Critical ใน LrC | **Defer + caveat** — LrC จำเป็นต้องมีเพราะ catalog ชี้ด้วย path; เราชี้ด้วย **handle** ซึ่งทนต่อการ rename ภายนอกดีกว่าโดยธรรมชาติ → ความเจ็บปวดต้นทางน้อยกว่ามาก ถ้าจะทำ เริ่มที่ rename (handle.move ใกล้เคียง) ก่อน move ข้ามโฟลเดอร์ |
| **Convert to DNG / lossy DNG** | Important | **Reject** — ต้อง encode ไฟล์master ของผู้ใช้ = risk สูง, ขัด "ไม่แตะไฟล์ต้นทาง" และเป็นงานหนักที่ไม่มีผลต่อ cull speed |
| **Assisted Culling (AI focus/similar badges)** | ใหม่ใน v14+ | **Reject** — CLAUDE.md: "Do not add any AI features" ชัดเจน |
| **Face recognition, Maps, Publish Services** | มีใน LrC | **Reject** — นอก scope เดียวกัน |
| **Collection sets, keyword synonyms/sets/suggestions, Edit Capture Time, Optimize Catalog** | Important/Nice | **Defer** — synonyms/sets/suggestions ต้องมี keywords ก่อน (P0-6); Optimize Catalog ไม่มี analogue (IndexedDB ไม่มี VACUUM ให้เรียก) |
| **Multiple catalogs / merge / export as catalog** | Important ใน LrC | **Reject** — Adobe เองบอก "try to work with just one"; 1 origin = 1 catalog ของเราสอดคล้องกัน |

---

## ข้อเท็จจริงเรื่อง scale ที่ควรจำไว้เวลาตัดสินใจ (จาก research)

- Adobe: catalog **ไม่มีเพดานจำนวนรูป**; มีเคสที่ documented ว่า catalog เดียว跑 288,889 รูป และ 500,000+ รูป
  (PetaPixel, sproul.photography) — ความเชื่อ "catalog ตายที่ 50k-100k" เป็น myth, คอขวดจริงคือ
  **preview generation, 1:1 cache size, auto-XMP write churn, disk I/O** ไม่ใช่จำนวน row
  → 10k-100k ของกลุ่มเป้าหมายเราคือพื้นที่สบายๆ *ถ้า* จัดการ cache ถูก
- Adobe: catalog ต้องอยู่บน local disk, รูปอยู่บน network drive ได้ → **ตรงกับสถาปัตยกรรมเราเป๊ะ**
  (IndexedDB local + File System Access handles)
- Adobe: auto-write XMP "can significantly degrade performance"; เวอร์ชันใหม่เขียนแบบ batch (ทุก ~10s ต่อรูป active)
  → ยืนยันว่าตัดสินใจถูกที่ตัด sidecar write ออก
- Adobe: Smart preview ≈ 3% ของขนาด RAW (500 RAW = 14GB → preview 400MB) → ตัวเลขอ้างอิงถ้าจะทำ tier กลาง

---

## ลำดับที่แนะนำ (เรียงตาม impact ต่อ core win / effort)

1. **BUG-1 + P0-1** EXIF ที่ import (M) — ปลดล็อก 5 อย่าง sekaligus
2. **P0-2** persist() + export/import catalog (S+M) — ปิดความเสี่ยง data-loss อันดับหนึ่ง
3. **BUG-2** ลบ `backup.ts` ตาย (S)
4. **P0-4** Remove vs Delete-from-disk (M) — verb ที่ cull workflow ต้องการ
5. **P0-3** missing-file badge + relink (M) — ต่อยอด restore-banner pattern ที่เพิ่งทำ
6. **P0-5 + P0-6** filter bar หลายคอลัมน์ + keywords MVP (M+M) — ต้องมี P0-1 ก่อน
7. **P1-1** standard preview tier + import-time build (L) — ใหญ่สุด แต่คือ core win; **benchmark 50k ก่อนลงมือ**
8. **P1-4, P1-3, P1-2** target collection (S), painter (S-M), stacks (M)
9. **P1-5** Survey (M), **P1-6** XMP read (M), **P1-7** IPTC (M), **P1-8** duplicates (S)

**ก่อนเริ่มข้อ 7:** ทำ benchmark ที่ ROADMAP 4.2 ค้างไว้ (mock 50k files, วัด grid rebuild + IDB query + render queue throughput)
เพราะคำตอบจะบอกว่าต้องเปลี่ยนสถาปัตยกรรม render queue หรือแค่เพิ่ม tier

---

## Sources

งาน research เต็ม (ทั้งสองชุด, พร้อมตารางฟีเจอร์รายข้อ + URL ทุกบรรทัด) เก็บไว้ที่:
- `/Users/pakorn/.hermes/cache/delegation/subagent-summary-0-20260922_230254_561901.txt` — Library catalog data + metadata
- `/Users/pakorn/.hermes/cache/delegation/subagent-summary-1-20260922_230254_567963.txt` — Catalog + file management / integrity

แหล่งหลักที่อ้างในเอกสารนี้ (Adobe official help):
[lightroom-catalog-basics](https://helpx.adobe.com/lightroom-classic/help/lightroom-catalog-basics.html) ·
[catalog-faq](https://helpx.adobe.com/lightroom-classic/kb/catalog-faq-lightroom.html) ·
[create-catalogs](https://helpx.adobe.com/lightroom-classic/help/create-catalogs.html) ·
[optimize-performance](https://helpx.adobe.com/lightroom-classic/help/optimize-performance-lightroom.html) ·
[import-options](https://helpx.adobe.com/lightroom-classic/help/photo-video-import-options.html) ·
[locate-missing-photos](https://helpx.adobe.com/lightroom-classic/help/locate-missing-photos.html) ·
[back-catalog](https://helpx.adobe.com/lightroom-classic/help/back-catalog.html) ·
[photos (manage)](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/photos.html) ·
[create-folders](https://helpx.adobe.com/lightroom-classic/desktop/manage-catalogs-and-files/create-folders.html) ·
[keywords](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/keywords.html) ·
[metadata-basics](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/metadata-basics-actions.html) ·
[advanced-metadata](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/advanced-metadata-actions.html) ·
[xmp-acr sidecars](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/create-xmp-acr-files.html) ·
[flag-label-rate](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/flag-label-rate-photos.html) ·
[collections](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/photo-collections.html) ·
[smart-criteria](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/smart-collections-criteria-in-lightroom-classic.html) ·
[finding-photos](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/finding-photos-catalog.html) ·
[metadata-filters](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/metadata-filters-in-lightroom-classic.html) ·
[browse-compare](https://helpx.adobe.com/lightroom-classic/desktop/viewing-photos/browse-compare-photos.html) ·
[view-options](https://helpx.adobe.com/lightroom-classic/desktop/viewing-photos/setting-library-view-options.html) ·
[stacks](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/grouping-photos-stacks.html) ·
[smart-previews](https://helpx.adobe.com/lightroom-classic/help/smart-previews.html) ·
[quick-develop](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/using-quick-develop-panel.html) ·
[duplicates](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/find-and-manage-duplicate-photos.html)

แหล่งรอง: [PetaPixel 288k catalog](https://petapixel.com/2015-10-28/lightroom-slow-try-setting-a-huge-cache-size/) ·
[PetaPixel rebuild previews](https://petapixel.com/2020-05-23/how-to-rebuild-lightroom-previews-to-optimize-speed-space-and-integrity/) ·
[sproul.photography single catalog](https://sproul.photography/post/single-lightroom-catalog-vs-multiple)

**หมายเหตุด้านคุณภาพแหล่งข้อมูล:** subagent ตัดเลขจาก `frameandfocal.com` (มีร่องรอย fabricated citations)
และ `imagen-ai.com` (SEO content) ออกทั้งหมด; หน้า Adobe help ถูก bot-wall จากเครื่องนี้จึงอ่านผ่าน
Wayback snapshot (Aug/Sep 2026) ของ URL canonical เดียวกัน

**Ambiguity ที่ research flag ไว้ (อย่าเชื่อ folklore):**
1. ไอคอน "ลูกศรขึ้น/ลง" ของ metadata — docs Adobe นิยามเป็น **3 สถานะ** (Needs Update / Changed Externally / Error)
   ไม่เคยบอกว่าเป็นลูกศรทิศไหน → ให้ model ตาม state machine ไม่ใช่ glyph
2. Auto Advance — อยู่ที่หน้า shortcuts, หน้า flag/rate พูดถึงแค่ `Shift+N` = ตั้ง+เลื่อน; ถือเป็นฟีเจอร์เดียวกัน
3. Rating ตอน import — ไม่มี field เฉพาะ ต้องใส่ใน metadata preset; Adobe ไม่บอกว่า precedence เป็นยังไงเมื่อชนกับ rating ในไฟล์
4. "Refine (Shift+click)" — docs ปัจจุบันนิยาม Shift+click ว่าเป็นการเปิดหลาย filter mode / เลือกหลายค่าในคอลัมน์;
   "refine" เป็นศัพท์ชุมชนหมายถึงพฤติกรรม AND ข้ามคอลัมน์
5. v15.0 (Oct 2025) เพิ่ม sidecar `.acr` แยก "heavy edits" (masks, Super Resolution, Denoise) ออกจาก `.xmp`
   — หน้า help เก่ายังพูดถึงแค่ `.xmp` → คาดว่าเอกสารใน corpus ไม่สอดคล้องกัน
