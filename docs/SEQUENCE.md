# SEQUENCE — ลำดับงาน canonical ของโปรแกรม hardening

**ไฟล์นี้คือ state ของ loop** — อ่านมันก่อนทุก tick และอัปเดต `[x]` + บรรทัด "ตำแหน่งปัจจุบัน" ทันทีที่งานหนึ่งขั้นจบ
เอกสารอ้างอิง: **`docs/BUGLOG.md`** (ทะเบียนบั๊กที่มีชีวิต — ปิด/เปิดอะไร ด้วย commit ไหน) · `docs/adr/0001-layered-architecture.md` (Accepted) · `docs/superpowers/plans/2026-09-27-main-ts-hardening-plan.md` (rev.2) · `docs/reviews/2026-09-27-main-ts-review.md` (42 findings, snapshot ณ `bbb9b8d`)

**ตำแหน่งปัจจุบัน:** M1 (architecture.test.ts + negative control + `git mv catalog/paths.ts → domain/paths.ts`) — ยังไม่เริ่ม · **A0′ ถูกยุบเข้ากับ M1 แล้ว** (ดูเหตุผลในขั้นที่ 1)
**commit ล่าสุดที่ push แล้ว:** `58636c2` (A1 = QA trusted input · QA 31/31 · src/ ไม่ถูกแตะ) · ก่อนหน้า `16e9807` (X3 = R1-18), `97ec626`, `f396568` (X2 = R1-14), `cd0405d` (X1 = R1-3), `87902be`, `9538ef9` — **exception trio จบ · findings ปิด 3/42 (Critical 3/20) · QA 27 → 31 checks**
**⚠️ loop chain ของ session ก่อนชนเพดาน 24 ชม. แล้ว** — จะเดินต่อให้สั่ง `/loop ทำให้หมดเลยตามแผน` ใน session ใหม่ ไฟล์นี้คือ state ที่ใช้อ่านต่อได้ทันที
*(convention: อัปเดตสองบรรทัดนี้ตอน**เริ่ม** tick ถัดไป ไม่ใช่ท้าย tick เดียวกัน — commit เขียน hash ของตัวเองไม่ได้)*

---

## กฎที่ต้องทำตามทุกขั้น (ห้ามข้าม)

1. **ทีละขั้น ไม่รุม ไม่ข้าม** (owner directive) — ห้ามขนานงานที่แตะ `main.ts`
2. **Class C** (แก้ 1-2 บรรทัด): เขียน QA check → รันให้**แดง** → บันทึก output แดงไว้ verbatim → แก้ → รันให้เขียว → mutation check → **commit เดียวที่มีทั้ง check และ fix** (ทุก commit บน main ต้องเขียว; หลักฐาน "แดงก่อน" อยู่ใน commit body)
3. **Class A/B**: 4 commit ต่อหน่วย — `refactor:` structure → `test:` red → `fix:` green → `test(qa):` acceptance
4. **gate ครบสามตัวทุก commit:** `npm test` · `npm run build` · `npm run qa` (ตัวเลข QA เดิมต้องไม่ขยับ)
5. **mutation check ทุก fix:** revert → แดง → restore → เขียว · รายงาน verbatim
6. **flake ที่รู้จัก:** `filters.test.ts > scale — 10k rows … ~linear` — ถ้าเด้ง ให้รันแยกไฟล์ยืนยันแล้ว rerun ห้ามแก้/ข้ามเทสต์
7. **ห้าม background งานยาวแล้วจบ turn** — รัน foreground, timeout 600000ms (บทเรียนจาก `bg_b90b190e` และ `bg_0f8e4c4e`)
8. **thinker วางแผน/ตรวจ diff, worker ลงมือ** — worker ติดอะไรให้หยุดแล้วรายงาน ห้ามเดา
9. commit แยกตามขั้น · push เมื่อจบหนึ่งหน่วย · `git status` ต้องสะอาดก่อนขึ้นขั้นถัดไป
10. **หา anchor ด้วยเนื้อหา ไม่ใช่เลขบรรทัด** — `src/main.ts` เหลือ 6,637 บรรทัด (จาก 6,625 ตอน review) และจะขยับทุก step ดังนั้นเลขบรรทัดใน `docs/reviews/…` และในไฟล์นี้**คลาดได้ ±10** เสมอ บังคับกับ worker ทุกตัว
11. **ห้ามแทรกขั้นที่อยู่นอกไฟล์นี้โดยไม่ถาม owner ก่อน** — *(เพิ่ม 2026-09-27 หลัง owner สับสน)* บทเรียน: thinker เสนอ "exception trio" (X1-X3) แล้วเขียนใน ADR §8.1 ว่า "veto ได้ก่อนเริ่ม step แรก" แต่**เริ่ม step แรกในรอบเดียวกัน** = เปิดหน้าต่าง veto แล้วปิดเองทันที และ A1 ก็ถูกยกมาไว้ก่อน M1 โดยไม่ได้ถามเลย ทั้งที่ ADR Option A เขียนว่า `M1-M12 → U1-U18` · **กฎใหม่: ถ้าจะเพิ่ม/สลับ/เลื่อนขั้นใด ๆ ต้องถาม owner ก่อนลงมือทุกครั้ง แม้จะดูเล็กหรือดูปลอดภัย** ถ้า owner ไม่ตอบให้รอ ไม่ใช่ตีความว่าเห็นชอบ
12. **ทุกขั้นที่ปิดหรือเปิด finding ต้องอัปเดต `docs/BUGLOG.md` ใน commit เดียวกัน** — ไฟล์นั้นคือทะเบียนบั๊กที่มีชีวิต (ตอบว่า "บั๊กไหนปิดแล้ว ด้วย commit ไหน") ต่างจาก `docs/reviews/…` ที่เป็น snapshot ณ HEAD `bbb9b8d` ห้ามปล่อยให้ค้าง

---

## บันทึกค้าง — residual ที่จงใจเลื่อน (ห้ามหาย ห้ามทำเงียบ ๆ)

| จากขั้น | residual | เลื่อนไป | เหตุผล |
|---|---|---|---|
| X2 (R1-14) | `setTimeout(clearError, 3000)` **ยังไม่กัน timer stale** — ถ้ามี error ใหม่โผล่ภายใน 3 วิหลังข้อความ recovery ตัวจับเวลาจะ clear error ใหม่นั้นแทน (review เสนอ guard `if (errorMessageEl.textContent === 'Recovered from GPU device loss.') clearError()`) | **U2** | X2 เป็น Class C ขอบเขตขั้นต่ำ และการ compare string เปราะ — U2 จะทำ `app/errorBanner.ts` ที่มี auto-dismiss semantics ถูกต้อง (generation counter) ซึ่งแก้เรื่องนี้เป็นธรรมชาติ |
| X1 (R1-3) | `secondMonitor.ts:88` มี `document.write` (template ไม่มี interpolation จึงไม่อันตรายวันนี้) แต่ static pin ของ X1 ครอบเฉพาะ `src/main.ts` | **M10** | ตอนย้าย `secondMonitor.ts` เข้า `adapters/dom/` ให้ขยาย static pin ครอบทั้ง `src/` ไม่ใช่แค่ entry |
| X1 (R1-3) | `backup.ts` restore row ตรง ๆ โดยไม่ validate shape ต่อ field (เป็นอีกครึ่งของ R1-3 และโยงกับ R1-27) | **U3 / M5** | ตามแผนเดิม |
| X2 (R1-14) | static pin (a) ของ QA check เป็นของชั่วคราว — มันสแกนข้อความในไฟล์ ไม่ใช่พฤติกรรม | **U2** | ต้องแทนด้วย unit test จริงบน `app/errorBanner.ts` ที่ extract แล้ว |
| A1 (QA trusted input) | check `harness: trusted key, drag and type reach the app as real input` **ไม่ assert crop geometry ตรง ๆ** — assert แค่ "มี trusted `pointerdown` + `pointermove` ≥1 + `pointerup`" กับ "crop op ใน `edits` เปลี่ยนตามทิศที่ลาก" (x 0.5 → 0.6071) และลากจาก**จุดกึ่งกลาง** `#crop-overlay` (mode `move`) ไม่ใช่ handle มุม เพราะ `dragEl` ตามสเปกให้ start point = center ของ element เท่านั้น (วัดแล้ว: nw handle อยู่ CSS (397,57), hit-test = `crop-overlay` → มุม**ลากได้**ถ้า drag รับพิกัด) | **U10** (geometry) · **U11** (corner/edge resize) | R1-12 + R1-21 ยังไม่แก้ — assert เลขเป๊ะจะแดงด้วยบั๊กของคนอื่น · U10 ปิด letterbox math แล้วกลับมา tightening เป็น "frame หลังลาก == pointer delta จริง" และเพิ่ม variant ของ `dragEl` ที่รับพิกัด เพื่อเป็น witness ของ resize จริง |
| A1 (QA trusted input) | `Input.dispatchKeyEvent` ที่กด **Escape** ทิ้ง keydown flood ไว้ในเพจ: ~2,000 events ภายใน 250ms จากการกดครั้งเดียว โตเกิน 88,000, ทุกตัว `isTrusted=true`, `e.key` เป็น `"Escape"` แล้วตามด้วย `"Unidentified"` จำนวนมาก · เกิดทั้งแบบ `rawKeyDown` และ `keyDown` بينما ArrowRight/ArrowUp รูปแบบเดียวกันสะอาด (1 event) →เป็นเรื่องเฉพาะ Escape ยังไม่ได้หาสาเหตุ | **U7** | U7 เป็นเจ้าของ shortcut ซึ่งต้องมี Escape (R1-16/R1-30) — ต้องเข้าใจ flood นี้ก่อน drive Escape จาก check ไม่งั้นการนับ event ในเทสต์เชื่อถือไม่ได้ · check ของ A1 ไม่กด Escape จึงไม่โดน |

---

## ขั้นที่ 0 — exception trio (owner อนุมัติ Option A พร้อมข้อยกเว้น)

Class C ทั้งหมด ทำก่อน M-series เพราะไม่มีบ้านเชิงโครงสร้างให้รอ

- [x] **X1 = R1-3** XSS: `main.ts:2885` (`row.innerHTML` ใน `renderSmartCollections` interpolate `smart.name`) + `main.ts:4524` (`infoOverlay.innerHTML = info` interpolate `file.name` + `lastDecoded.make/model`) → `createElement` + `textContent` ตามแบบ `renderCollections` (:2807 ใช้ `name.textContent`) · QA check: `security: untrusted strings render as text, never as HTML` · acceptance: `docs/acceptance/untrusted-strings.feature`
- [x] **X2 = R1-14** `main.ts:1495` `errorEl.remove()` → `clearError()` (`hidden = true`) เพราะ `#error-message`/`#error-detail` เป็นลูกของ `#error` และคือ binding ที่ `showError` ทั้ง 51 จุดเขียน · QA check: `stability: the error banner survives dismissal and keeps reporting` · acceptance: `docs/acceptance/error-banner.feature`
      *(หมายเหตุ: ครึ่ง **(a)** ของ QA check นั้นเป็น **static pin ชั่วคราว** — สแกน `src/main.ts` จากดิสก์หา `errorEl.remove()` / `document.querySelector('#error')` เพราะ device-loss จริงไม่สามารถขับเคลื่อนจาก harness ได้ · **U2 ต้องแทนมันด้วย unit test จริง** บน `app/errorBanner.ts` ที่แยกออกมาแล้ว ส่วน (b) เป็นแค่ guard ว่าการ dismissal/ใช้ซ้ำไม่พัง — มันเขียวแม้ตอนมีบั๊ก)*
- [x] **X3 = R1-18** `main.ts:5207` `contactPrev` decrement แล้วไม่เรียก `renderContactSheet()` (ดู `contactNext` 3 บรรทัดถัดไปเป็นแบบ) · QA check: `contact sheet: Prev returns to the previous sheet's frames and label` · acceptance: `docs/acceptance/contact-sheet.feature`
      *(แดงก่อนแก้: check ใหม่ FAIL เดียว — label="Sheet 2 / 3" + frame ids + frame numbers + `contactPrev.disabled=false` ครบทั้งสี่ · ลบเส้นที่เพิ่ม → แดงอีก (mutation check) · restore → เขียว 30/30 · X3's own hash is recorded by the next commit — a commit cannot carry its own hash)*

## ขั้นที่ 1 — มูลฐาน

- [x] **A1** QA trusted input ใน `scripts/qa-loop.mjs`: `pressKey` (`Input.dispatchKeyEvent` rawKeyDown/char/keyUp), `dragEl` (`mousePressed` → N×`mouseMoved` → `mouseReleased`, hit-test ก่อนกดแบบ `clickEl`), `typeText` + check พิสูจน์ 1 ตัวที่ลาก crop overlay จริง · zero dependency ใหม่ · **ไม่แตะ `src/`**
      *(helpers ทั้งสามอยู่ถัดจาก `clickEl`: `pressKey(cdp, key, {ctrl,meta,alt,shift,text})` · `typeText(cdp, text)` ทีละตัวอักษร (จงใจไม่ใช้ `Input.insertText`) · `dragEl(cdp, fromSelector, toX, toY, {steps=8,button='left',holdMs=0})` — `clickEl` ถูก extract ใช้ helper รวม `targetCentre()` (พฤติกรรม/ข้อความ error เดิมทุกตัวอักษร, check เดิมผ่านครบ 30/30) · check: `harness: trusted key, drag and type reach the app as real input` (group `stability`, วางต่อจาก check ของ X3) ลาก `#crop-overlay` ผ่าน pointer-capture จริง และวัด `isTrusted` ด้วย capture-phase listener ที่ติดตั้งจาก harness · QA 31/31 · unit 790 เท่าเดิม · ไม่มี "แดงก่อน" เพราะ A1 เป็น capability proof ไม่ใช่ bug fix — ใช้ **negative control** แทน: สลับ `pressKey` กลับไป `dispatchEvent` → check แดงที่ `pressKey: 1 UNTRUSTED event(s) recorded` · check ยัง **coarse โดยเจตนา** ดูบันทึกค้าง-row ของ A1 ด้านล่าง)*
- [~] **A0′ — ยุบเข้ากับ M1 แล้ว (thinker ตัดสิน 2026-09-27 หลัง A1 จบ)** เหตุผล: A0′ เดิมจะสร้าง `src/domain/`, `src/domain/ports/`, `src/adapters/` เปล่า ๆ ซึ่ง (ก) git ไม่ track directory ว่าง จึง commit ไม่ได้ (ข) `architecture.test.ts` จะเขียวแบบ **vacuous** เพราะไม่มีไฟล์ใน `domain/` ให้ตรวจ — จึงไม่มีสถานะ "แดงก่อน" ที่มีความหมาย และขัดกฎ TDD ของแผน → **ให้เริ่มจากการย้ายของจริงชิ้นเล็กสุดแทน** (ดู M1 ด้านล่าง) · A0 ดั้งเดิมของแผน rev.2 (เขียน ADR + ทำ U1 เป็น reference implementation) ก็หมดความหมายไปแล้ว เพราะ ADR เขียนเสร็จ และ Option A เลื่อน U1 ไปหลัง M-series

## ขั้นที่ 2 — M1-M12 (ย้ายชั้น, ไม่แก้บั๊กสักตัว)

**ใช้ตาราง ADR §3.6/§3.7 ที่ verify แล้ว ไม่ใช่ §3.2/§3.3 เดิม** · หลักฐานรายไฟล์: `docs/adr/0001-layer-survey-evidence.md`

- [ ] **M1** *(ปรับใหม่ — รับ A0′ ที่ยุบแล้วเข้ามา) สามขั้น:*
      **(1)** สร้าง `src/architecture.test.ts` = fitness function ตาม ADR §5 ทั้ง 5 ข้อ (domain ห้าม import `app/`/`adapters/`/`bootstrap`/`main` · domain ห้ามมี identifier `document`/`window`/`indexedDB`/`navigator`/`GPUDevice`/`requestAdapter`/`fetch` · app ห้าม import `adapters/` · adapters ที่ implement port ต้อง import port จาก `domain/ports/` · pin จำนวน `as any` ทั้ง repo เป็น baseline แล้วห้ามเพิ่ม) — walk ต้นไม้ด้วย `node:fs`, รันใน `npm test`, ไม่ต้องมี browser
      **(2)** พิสูจน์ว่ามันไม่ใช่ tautology ด้วย **negative control** (นี่คือ "แดงก่อน" ของ guard ไม่ใช่ของ fix): สร้าง `src/domain/__probe.ts` ชั่วคราวที่ import จาก `../app/state` หรืออ้าง `document` → `npm test` ต้อง**แดง** → บันทึก verbatim → ลบ probe → เขียว
      **(3)** `git mv src/catalog/paths.ts src/domain/paths.ts` (22 บรรทัด, 1 test file — เล็กสุดในตาราง จึงใช้พิสูจน์กลไกทั้งเส้น: `git mv` + ตามแก้ทุก importer + gate ครบสาม) แล้วค่อยสร้าง `src/domain/ports/` เมื่อมี port ตัวแรกจริง · **ต้องเป็น `git mv`** เพื่อรักษา history ตาม ADR §4.2
- [ ] **M1b** `git mv src/catalog/types.ts src/domain/types.ts` (211 บรรทัด — **ทุกชั้นอ้างมัน** จึงกระทบ importer มากที่สุด · จงใจแยก commit จาก M1 เพราะถ้าพังจะแยกสาเหตุไม่ออก)
- [ ] **M2** `domain/` ← `editHistory`, `syncOps`, `duplicates`, `sidecar`, `presetFiles` *(ตัด `paths` ออกเพราะ M1 ย้ายไปแล้ว)*
- [ ] **M3** `domain/` ← `filters`, `stacks`, `survey`, `navigator`, `viewState`, `contactSheet`, `smartCollections`, `shortcuts`(rules) · ใช้ชื่อ `domain/viewport/` (ADR §8.6)
- [ ] **M4** `domain/color` (uniforms math), `domain/curve` (tone math), `domain/mask` (dodge math), `domain/film` ← `film.ts` **move ทั้งไฟล์**, `domain/orientation` ← `orient.ts` **move ทั้งไฟล์**, `domain/transform` ← `geometry.ts` · **รวมยก `*_DEFAULTS` ของ geometry/vignette/presence/dodgeBurn จาก literal ที่ `ops.ts:225/:274/:211/:291` ขึ้น domain (ADR §8.7)** · reconcile `mix01`/`smoothstep01`/`clamp01` ที่ซ้ำใน grain/lightleak/vignette
- [ ] **M5** split ฝั่ง catalog → domain: `editsStore`(validate), `collections`(rules), `backup`, `import`, `iptc`(+ แยก metadata-preset store ออกจาก IPTC), `keywords`(clean ที่ :267/269), `missing`, `remove`, `culling`(interleaved)
- [ ] **M6** `adapters/idb/` ← `db`, `query`, `presetsStore`, editsStore-store, collections-store, `thumbnails`(idb ส่วน)
- [ ] **M7** `adapters/fs/` ← `permissions`, `tetheredCapture`, backup-io, missing-probe, remove-io
- [ ] **M8** `adapters/raw/` ← ทั้ง 5 ไฟล์ของ `src/raw/`
- [ ] **M9** `adapters/gpu/` ← `pipeline`, `offscreenRenderer`, `exportEncode`, 19 `.wgsl`, ส่วน pack ของทุกไฟล์ที่ split ใน M4, `adapters/dom/` rasteriser ของ thumbnails (:261-282) · **⚠️ `ops.ts` ต้อง split จริงตาม ADR §8.10 — สร้าง perf gate ก่อน (baseline: นับ GPU pass + `writeBuffer` ต่อ render, wall-clock report-only) และเสนอ `OpRenderer` shape ใหม่ให้ owner ดูก่อนลงมือ**
- [ ] **M10** `adapters/dom/` ← `modules`, `filmstrip`, `printModule`, `secondMonitor`, `isEditable`
- [ ] **M11** `app/` ← `state` + use-cases + orchestrator ของ thumbnails (`getThumbnailBlob`, `needsEditedThumbnail`)
- [ ] **M12** `bootstrap.ts` + `main.ts` บางลง (≤800 บรรทัดรวมกัน) · ทำท้ายสุดเพราะต้องรู้ use-case ทั้งหมดก่อน

## ขั้นที่ 3 — U1-U18 (แก้ 42 findings, เรียงเลข ไม่ข้าม)

- [ ] **U1** op-validation boundary — R1-1(C), R1-22(S), R1-32(S) · ⚠️ **ต้อง *สร้าง* `LIGHTLEAK_PATTERNS` ใน `domain/lightleak/`** เพราะ vocabulary นี้ไม่มีอยู่ที่ไหน (ADR §8.9) แล้วให้ 4 consumer อ่านมัน: validator (`editsStore.ts:113` bound -1..1 → derive จาก map), label (`main.ts:1303`), `types.ts:127` comment, UI options
- [ ] **U2** error banner → `app/errorBanner.ts` — R1-14(C ถ้า X2 ยังไม่ปิด), R1-41(N)
- [ ] **U3** untrusted-string rendering + `backup.ts` row-shape validation — R1-3(C ถ้า X1 ยังไม่ปิด)
- [ ] **U4** boot resilience — R1-27(S)
- [ ] **U5** batch export → `app/exportNaming.ts` + `app/batchExport.ts` + `prepareForExport()` — R1-5(C), R1-9(C), R1-10(C), R1-35(S)
- [ ] **U6** GPU device-loss recovery → `app/gpuRecovery.ts` — R1-13(C)
- [ ] **U7** shortcuts: export `isEditable`, รวม dispatcher เหลือตัวเดียว — R1-15(C), R1-16(C), R1-30(S)
- [ ] **U8** dodge mask contract (owner ตัดสิน: **แก้ที่ GPU contract** ไม่ใช่ `syncableOps`) — R1-8(C)
- [ ] **U9** curve model → `app/curveModel.ts` — R1-6(C), R1-7(C)
- [ ] **U10** letterbox geometry → `domain/viewport/` `letterboxPoint()` + `displayScale()` — R1-12(C), R1-21(S), R1-34(S)
- [ ] **U11** loupe gestures → `app/loupeGesture.ts` — R1-20(C) · พึ่ง U10
- [ ] **U12** compare + contact views → `app/compareView.ts` — R1-11(C), R1-18(C ถ้า X3 ยังไม่ปิด), R1-19(C), R1-39(N)
- [ ] **U13** scope & selection → `app/selectionScope.ts` + route search ผ่าน filters — R1-2(C), R1-17(C), R1-31(S)
- [ ] **U14** grid hot path + เปิด `allowUnreachableCode:false` — R1-23(S), R1-24(S), R1-25(S), R1-37(N)
- [ ] **U15** filter codec → `app/filterCodec.ts` column-aware — R1-4(C)
- [ ] **U16** cull batch reporting — R1-26(S), R1-28(S)
- [ ] **U17** round-trip pins (QA check ล้วน ไม่แก้ source) — R1-33(S), R1-36(S)
- [ ] **U18** trivia + copy — R1-29(S ต้อง verify `FileSystemFileHandle.remove()` ก่อน), R1-38(N), R1-40(N), R1-42(N) + คอมเมนต์ stale `iptc.ts:11-17` (ADR §3.7)

## ขั้นที่ 4 — ปิดโปรแกรม

- [ ] เขียน `ROADMAP.md` ใหม่จากสถานะจริง (ของเดิมบอก main.ts 2,951 บรรทัด และบอกว่า device-loss ยังไม่ทำ — ทั้งที่จริง 6,625 และทำแล้วที่ `pipeline.ts:102-109`)
- [ ] อัปเดต `CLAUDE.md` (spike brief ที่หลายข้อถูกทำไปแล้ว)
- [ ] review `gpu/` `catalog/` `raw/` ที่ยังไม่เคยถูก review — **ทำหลังแยกชั้นแล้ว** เพราะรีวิว module เล็กถูกกว่าและ findings ลงมือได้ทันที
