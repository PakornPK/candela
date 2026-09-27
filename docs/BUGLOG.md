# BUG LOG — candela

**ไฟล์นี้คือทะเบียนบั๊กที่มีชีวิต** ต่างจาก `docs/reviews/2026-09-27-main-ts-review.md` (snapshot ณ HEAD `bbb9b8d`) และต่างจาก `docs/SEQUENCE.md` (ลำดับงาน) — ไฟล์นี้ตอบคำถามเดียวคือ **"ตอนนี้บั๊กไหนปิดแล้ว บั๊กไหนยังเปิด และปิดด้วย commit ไหน"**

**กฎบังคับ:** ทุกขั้น (X/M/U) ที่ปิดหรือเปิด finding **ต้องอัปเดตไฟล์นี้ใน commit เดียวกัน** ห้ามปล่อยค้าง (SEQUENCE กฎข้อ 12)

**สรุป ณ 2026-09-27:** ปิด **3** · เปิด **39** · candidate ใหม่ที่ยังไม่ได้ยืนยัน **1**
แหล่งที่มา: prod-grade review ของ `src/main.ts` (whole-file, medium effort, 413 model calls / 98 นาที / 13 agent runs) → 42 findings (Critical 20 / Suggestion 16 / Nice-to-have 6) + review **reject** 5 ข้อ (ดูท้ายไฟล์)

---

## 🔴 Critical (20) — ปิด 3, เปิด 17

| ID | ตำแหน่ง | อาการ | สถานะ | ปิดโดย | หน่วย | conf | พยาน |
|---|---|---|---|---|---|---|---|
| **R1-3** | `main.ts:2885`, `4524` | **XSS** — 2 ใน 2 จุดที่ assign `innerHTML` interpolate ข้อมูลที่ attacker คุมได้ (`smart.name` ที่ restore ตรงจาก catalog backup, `file.name` + EXIF make/model) → รันใน origin ที่มี IndexedDB + `FileSystemFileHandle` grant `readwrite` = exfiltrate/ลบโฟลเดอร์รูปได้ | ✅ **ปิดแล้ว** | `cd0405d` | X1 | h | ✅ รันจริง — payload `window.__pwned=1`/`=2` ทำงานจริงทั้งสองทาง และทาง smart-collection รันซ้ำทุก boot |
| **R1-14** | `main.ts:1495` | dismissal ของ device-loss recovery เรียก `errorEl.remove()` ลบ `#error` ทั้งโหนด แต่ `#error-message`/`#error-detail` เป็นลูกและคือ binding ที่ `showError` ทั้ง **51 จุด**เขียน → หลัง recovery หนึ่งครั้ง error channel ตายตลอด session | ✅ **ปิดแล้ว** | `f396568` | X2 | h | ⚠️ static pin (ขับ device loss จริงจาก harness ไม่ได้) + behavioural guard |
| **R1-18** | `main.ts:5207` | Contact sheet "previous" decrement index แล้ว**ไม่ทำอะไรเลย** (บรรทัดว่างตรงที่ `renderContactSheet()` ควรอยู่) → label ค้าง "Sheet 2 / 3", sheet 1 เข้าไม่ถึงโดย paging, export ตั้งชื่อไฟล์ตาม index ใหม่แต่ rasterize DOM เก่า | ✅ **ปิดแล้ว** | `16e9807` | X3 | h | ✅ รันจริง — frame ids `128…93` vs `92…57`, nums `01-36` vs `37-72` |
| R1-1 | `catalog/editsStore.ts:113` | `isValidOp` bound lightleak pattern แค่ `-1..1` ทั้งที่ vocabulary คือ `-1..3` (`lightleak.ts:26`/`:43`) → Set C/D ทำให้ `isValidEditRow` fail ทั้ง row → `loadEditState` คืน state ว่าง = **edit หายถาวรเงียบ ๆ** + หลุด Edited filter | 🔴 เปิด | — | **U1** | h | ✅ รันจริง (vitest probe) |
| R1-2 | `main.ts:2075` | `orderedVisibleIds` กรอง 2 จาก 9 scope terms ที่ `rebuildGrid` ใช้ → shift-click กวาดทั้ง catalog; "4712 selected" ที่มองไม่เห็น → กด 5 = rate รูปที่ไม่ได้เห็น, กด Delete → "Delete from disk" = **trash ไฟล์ที่ไม่ได้เลือก** | 🔴 เปิด | — | U13 | h | 📖 static |
| R1-4 | `main.ts:1699` | `decodeFilterValue` เดา type ด้วย `/^\d+$/ → Number()` ทุกคอลัมน์ ทั้งที่ encode เป็น `String(v)` → keyword "2024" กลายเป็น number → `numberMatches` default คืน false → **grid ว่างทั้งที่ chip สว่าง** และ keyword ชื่อ "none" ไปกรอง "ไม่มี keyword" | 🔴 เปิด | — | U15 | h | ✅ รันจริง (vitest probe) |
| R1-5 | `main.ts:4119` | batch export ตั้งชื่อจาก basename ไม่มี uniquifier + `getFileHandle(create:true)` + `createWritable()` truncate → **RAW+JPEG คู่กันเขียนทับ ไฟล์แรกกู้ไม่ได้** แต่รายงาน "Completed 4/4" | 🔴 เปิด | — | U5 | h | ✅ รันจริง (`node -e`) |
| R1-6 | `main.ts:1047` | point-curve bump ระหว่าง anchor 4 ตัวมองไม่เห็นต่อ `fitRegionParams` (sample แค่ x=0.88/0.60/0.40/0.12) → Point→Region fit ได้ `{0,0,0,0}` → **edit หายและ persist เป็น history row ใหม่** ทั้งที่ dropdown นี้คอมเมนต์เรียกว่า "a view switch, not an edit" | 🔴 เปิด | — | U9 | h | ✅ รันจริง (vitest probe) |
| R1-7 | `main.ts:730` | `clampCurveX` แยกจุดที่ x=1 ไม่ได้ (nudge ได้ 1.02 → clamp กลับ 1) → x ซ้ำ → `buildToneCurveLut` dedupe ทิ้งหนึ่งจุด → **white endpoint หลุดจาก (1,1) highlight เปลี่ยนทั้งแถบ และลากแยกไม่ได้อีก** | 🔴 เปิด | — | U9 | h | ✅ รันจริง (vitest probe) |
| R1-8 | `main.ts:976` | `syncDodgeMaskToGPU` ไม่ reconcile dims; `setDodgeMask` guard แค่ `bytes.length !== w*h` → **dims กลับด้านมีผลคูณเท่ากันพอดี = เขียนลง texture ที่ transposed เส้น brush ลายทั้งรูปและถูก bake ลง export**; ถ้าผลคูณไม่เท่าก็ drop เงียบแต่ clear `dodgeMaskDirty` อยู่ดี → ไม่ retry | 🔴 เปิด | — | U8 (owner ตัดสิน: แก้ที่ **GPU contract**) | h | ✅ รันจริง (`node -e`) |
| R1-9 | `main.ts:4105` | batch export ไม่เขียน `loadedFileId` → restore short-circuit ที่ 3279 → **loupe แสดงรูปสุดท้ายของ batch ภายใต้ slider ของรูปปัจจุบัน และ Export ครั้งถัดไปเขียนพิกเซลนั้นลงชื่อไฟล์ผิด**; selection 50 รูปยุบเหลือ 1; dodge/burn หายทุกไฟล์ที่ export; grain seed ใช้ของรูปปัจจุบันทั้ง batch | 🔴 เปิด | — | U5 | h | ✅ รันจริง (grep sweep) |
| R1-10 | `main.ts:2416` | `gpuExclusive` mutex ที่คอมเมนต์ `:2341` สัญญาไว้**ไม่มีอยู่จริง** — identifier เจอ 1 ที่ทั้ง repo และเป็นคอมเมนต์บรรทัดนั้น → batch export กับ thumbnail drain แย่ง pipeline → **thumbnail ถูกเขียนใต้ id+digest ผิด แล้ว digest match ทำให้ `needsEditedThumbnail` รับรองของผิดว่า fresh ไม่หายเอง** | 🔴 เปิด | — | U5 | h | ✅ รันจริง (grep: 1 hit ทั้ง repo) |
| R1-11 | `main.ts:4921` | Compare สร้าง `Pipeline` ต่อรูปใส่ local const ที่ไม่หลุด scope → **`destroy()` ไม่ได้ ever** และ `renderCompareView` ถูกเรียกจาก `refreshCullDependents` (ทุก cull write) → เข้า-ออก 5 รอบ × 4 รูป = **20 GPUDevices ~1.7GB/pipeline** → Chrome evict context ที่เก่าที่สุด คือ loupe ของ Develop; `Pipeline.destroy()` ก็ไม่เรียก `device.destroy()` | 🔴 เปิด | — | U12 | h | ✅ รันจริง (grep sweep) |
| R1-12 | `main.ts:4266` | wheel-zoom / dblclick / middle-pan ส่งพิกัด **box** เข้า `imagePointUnderCursor` ที่ต้องการพิกัด **image** โดยไม่แก้ letterbox (`#canvas` เป็น `object-fit:contain`) → portrait 4000×6000 ในกล่อง 1200×700: **zoom anchor เพี้ยนถึง 116.7px, pan แกน x ช้ากว่าจริง 2.571 เท่า** (แกน y ถูกเป๊ะ → ลากเฉียงแล้วภาพบิด) · math ที่ถูกมีอยู่แล้วในไฟล์เดียวกันและ `containBox` import ไว้แล้ว | 🔴 เปิด | — | U10 | h | ✅ รันจริง (`node -e`) |
| R1-13 | `main.ts:1478` | device-loss recovery เป็น **no-op แน่นอน** สองทางปิดกันเอง: (a) ไม่ clear `loadedFileId` → `loadIntoPipeline` return ที่ 3279 (b) ส่ง `Date.now()` (~1.77e12) เป็น requestId ทั้งที่ทุก staleness check เทียบ `openRequestId` (เริ่ม 0) → 3291 ยิงทิ้งเสมอ = **loupe ดำ แล้ว 3 วิต่อมาบอก "Recovered from GPU device loss."** | 🔴 เปิด | — | U6 | h | ✅ รันจริง (grep sweep) |
| R1-15 | `main.ts:6580` | **keydown dispatcher ตัวที่สองระดับ document อ้อม `keyToAction()`** จึงอ้อม `isEditable()` (ซึ่ง `shortcuts.test.ts` pin ไว้ 3 เคส และถูก copy inline ครั้งที่สามที่ `:5566`); ไม่ตรวจ target/module/dialog/`e.repeat` → **พิมพ์ "fujifilm" ในช่อง Search = 'f' แรกสลับแอปเข้า fullscreen แล้ว 'f' ถัดไปสลับออก** · `isEditable` ไม่ถูก export จึง import มาใช้ไม่ได้ด้วย | 🔴 เปิด | — | U7 | h | 📖 static — **ตอนนี้ขับจริงได้แล้วด้วย `typeText` จาก A1** |
| R1-16 | `main.ts:5578` | guard "modal เปิดอยู่ อย่ารับ shortcut" ตรวจแค่ `removeDialog.open` ไม่ตรวจ `syncDialog`/`smartDialog` และ `isEditable` ไม่ครอบ `<button>` ที่ได้ focus → ระหว่าง Sync batch รัน (yield ต่อรูป dialog จึงค้างเปิด) **กด x = reject ทั้ง selection เบื้องหลัง dialog; กด Delete = stack modal ที่สองแล้วลบจากดิสก์ได้; กด g/e = สลับ module ทิ้ง dialog ค้าง** | 🔴 เปิด | — | U7 | h | 📖 static — **ขับจริงได้แล้วด้วย `pressKey` จาก A1** |
| R1-17 | `main.ts:1968` | search เขียน inline ไม่ผ่าน engine ที่มี test: (a) ไม่ค้น keyword และ `FilterState.text` **ไม่เคยถูก assign ที่ไหนเลย** → `textMatches` เป็น dead code (b) `appendFolderRow` reset collection/PI แต่ไม่ reset `searchQuery` และ search arm อยู่ด้านบน → **query ค้างทับทุกการคลิก folder/Previous Import** ตรงกับที่คอมเมนต์ของตัวเองบอกว่า reset มีไว้กัน (c) `.active` + badge ไม่ repaint → grid ขยายเป็นทั้ง catalog ขณะที่ sidebar ยัง highlight collection เดิม | 🔴 เปิด | — | U13 | h | ✅ รันจริง (grep sweep) |
| R1-19 | `main.ts:4898` | Compare render ลง canvas **800×600 hard-code** ไม่เรียก `setCanvasRect`; `blit.wgsl` ไม่มี aspect term / letterbox branch / min() fit และ `cropFrac` เป็น identity → **ทุกภาพถูกยืดเป็น 4:3 ใน view ที่หน้าที่ของมันคือตัดสิน framing** (3:2 ถูกบีบ ~11% แนวนอน, 4:5 แย่กว่ามาก) · `object-fit:contain` ของ wrapper ได้แค่ letterbox bitmap ที่บิดไปแล้ว | 🔴 เปิด | — | U12 | h | 📖 static (shader source + draw call ชัดเจนโดยไม่ต้องรัน) |
| R1-20 | `main.ts:4316` | middle-pan เป็น **drag เดียวใน 5 ตัวที่ไม่มี `pointercancel`** (crop/tone-curve/brush/navigator มีครบ) และใช้ `setPointerCapture` โดยไม่มี `lostpointercapture` release; move handler gate แค่ `if (!panStart) return;` ไม่ดู `e.buttons` → หลัง notification/autoscroll แยงกลางคัน `panStart` ค้างตลอด = **เลื่อนเมาส์เปล่า ๆ ก็ลากรูปไปมาและ dispatch renderOps ทุก mousemove** | 🔴 เปิด | — | U11 | h | ✅ รันจริง (grep: 22 hits tabulated) — **ตอนนี้ขับจริงได้ด้วย `dragEl` จาก A1** |

---

## 🟡 Suggestion (16) — เปิดทั้งหมด

| ID | ตำแหน่ง | อาการโดยย่อ | หน่วย | conf |
|---|---|---|---|---|
| R1-21 | `main.ts:902` (+3639, +3663) | `dispScale` เป็น width-only ratio ซ้ำ **byte-identical 3 ที่** ทั้งที่ `eventToBufferPt:947` คำนวณถูกแล้ว → crop frame + thirds grid เป็น sub-pixel **มองไม่เห็นบนภาพ portrait ทุกรูป** (hit test ตรงกับ drawing จึงไม่ใช่ ungrabbable) | U10 | h |
| R1-22 | `main.ts:1303` | `opsToLabel` map lightleak pattern แค่ 0/1 → Set C/D ตกไปอยู่ arm เดียวกับ Auto → **สอง edit ที่ต่างกันแยกไม่ออกใน History/preset**; `types.ts:127` comment ก็รู้แค่ 2 ค่า; R1-1 ไม่ครอบข้อนี้ | U1 | h |
| R1-23 | `main.ts:2013` | **dead code 28 บรรทัด** (2013-2040) เข้าไม่ถึงเพราะสอง arm ด้านบน return หมด; tsc ไม่ flag เพราะไม่มี `allowUnreachableCode:false`; block ที่ตายมี `tallyScope`/`stackVisibleFiles` ordering **ต่างจาก** branch ที่มีชีวิต | U14 | h |
| R1-24 | `main.ts:1999` | default folder branch รัน **สอง full filter pass ต่อโฟลเดอร์**; `rebuildGrid` ถูกเรียกทุก cull write → catalog 100k/1000 โฟลเดอร์ ≈ 200M predicate ต่อ keypress (มาตรฐาน scale ของโปรเจกต์เอง pin ไว้ที่ `filters.test.ts:447-476`) | U14 | h |
| R1-25 | `main.ts:2249` | badge pass เป็น `s.fileIds.find(id => files.some(...))` = O(members × files) แล้วตามด้วย `stackCountFor` ที่**พิสูจน์ได้ว่า redundant** (invariant "a photo lives in AT MOST ONE stack" ที่ `stacks.ts:130-133`) | U14 | h |
| R1-26 | `main.ts:5686` | cull batch `try` ครอบทั้ง loop + `refreshCullDependents` → ถ้า IDB abort กลางคัน UI ไม่ repaint; ใน Survey ไม่มี virtualizer onChange ช่วย → **mark ที่ commit แล้วมองไม่เห็น**; catch รายงานไม่มี count ไม่มี ids | U16 | h |
| R1-27 | `main.ts:6593` | 4 step ที่ paint UI ตอนท้าย `init()` เป็น **bare await** + `init();` เปล่า และ**ไม่มี global error/rejection handler ทั้ง repo** → boot ตายเงียบ เห็น grid ว่าง + sidebar ว่าง แยกไม่ออกกับ catalog ว่าง (backup validate แค่ envelope ไม่ validate row shape) | U4 | h |
| R1-28 | `main.ts:5449` | delete-from-disk ที่ล้มเหลวทั้งหมดก็ยัง **flash เขียว "✓ 0 files moved to the system trash"** ข้าง banner แดง; สองครึ่งของประโยคนับคนละอย่าง (`report.deleted` vs `deletedIds.length`) และ clear selection ทำให้ retry ไม่ได้ | U16 | h |
| R1-29 | `catalog/remove.ts:52` | คำสัญญา "moved to the system trash (recoverable)" เป็น **tested contract** (`remove.test.ts:46-50` assert คำว่า 'trash') ใน 6 ที่ แต่ `lib.dom.d.ts:14752-14766` ประกาศ `FileSystemFileHandle` มีแค่ `createWritable()`/`getFile()` — **ไม่มี `remove()`** = non-standard; ถ้า Chrome unlink ถาวรคือ test suite รับรองคำโกหก | U18 (ต้อง verify platform ก่อน) | **l** |
| R1-30 | `main.ts:4326` (+4571) | handler 'z' กับ '\' ไม่มี `isEditable` guard และ `preventDefault()` → ผ่าน dialog path ได้; **Shift+Z ยิง zoom** (ที่เดียวในไฟล์ที่ capital letter ไม่มี modifier แล้ว trigger command); 'z' ไม่ตรวจ `e.repeat` ทั้งที่ sibling ตรวจ | U7 | h |
| R1-31 | `main.ts:1971` (+`smartCollections.ts:103,107`) | `(f as any).cameraModel` ทั้งที่ `types.ts:34-40` ประกาศ field และ comment ระบุเองว่า main.ts search เป็น reader → **rename field แล้ว tsc เขียวแต่ search ตายเงียบ**; `filters.ts:47-49` comment "stores no IPTC yet" ก็ stale แล้ว | U13 | h |
| R1-32 | `main.ts:5528` | `pasteSettingsFromClipboard` ตรวจแค่ `Array.isArray` แล้ว `JSON.parse(text) as Op[]` → **เขียน unvalidated ops ลง IDB ทุก target** → reload แล้ว `isValidEditRow` fail ทั้ง row = history หายเงียบ ๆ (failure mode เดียวกับ R1-1 คนละ boundary) | U1 | **l** |
| R1-33 | `main.ts:1103` | `applyOpsToSliders`/`currentOpsFromSliders` **ไม่มี test เลยสักตัว** และ QA ไม่มี check undo/redo/history/preset → emit list กับ restore list เป็นสอง enumeration ที่ maintain แยกกันโดยไม่มีอะไร pin ว่าตรงกัน (เพิ่ม op kind ที่ 15 แล้วลืม restore = หายเงียบ 790 tests ยังเขียว) | U17 | **l** |
| R1-34 | `main.ts:942` (+988) | letterbox inverse-map ซ้ำ 2 ที่ (`eventToBufferPt`/`eventToMaskPt`) ต่าง compute contain scale เอง ทั้งที่ `containBox` export ไว้และมี test 3 เคส pin; สองสำเนา diverge แล้ว (margin param vs hardcode 0) → **ต้นตอของสำเนาที่สามใน R1-21** | U10 | **l** |
| R1-35 | `main.ts:4049` | **batch export loop ไม่มี coverage เลย** — check 'export:' export ไฟล์เดียว และ `#batch-export-row` gate ที่ `selectedIds.length > 1` จึงไม่เคยโผล่; นี่คือเหตุผลที่ R1-5/R1-9 ship; `allFiles.find(...)!` ไม่ earned, per-file fail เป็น console-only, ไม่เรียก `ensureReadPermission` | U5 | **l** |
| R1-36 | `main.ts:2387` | QA check ชื่อ `'restore: … click re-renders'` **ไม่ตรวจ re-render** — assert แค่ banner hidden กับ `reqLog` มี 'grant'; อ่าน `#footer-counts` ใส่ตัวแปรแต่ไม่ throw; `probeThumbs` มีอยู่แล้วที่ `:1040` | U17 | **l** |

---

## 🟢 Nice to have (6) — เปิดทั้งหมด

| ID | ตำแหน่ง | อาการโดยย่อ | หน่วย |
|---|---|---|---|
| R1-37 | `main.ts:2264` | `counts[6]` ถูก fill จาก scope แล้ว**ไม่เคยถูกอ่าน** (chip ใช้ `scopeRating`/`scopeTotal`) — เดิน 100k records สองครั้งต่อ keypress แล้วทิ้งหนึ่งผล และเป็นกับดักเพราะ `counts` เป็น post-cull ขณะที่ `scopeRating` จงใจเป็น pre-cull | U14 |
| R1-38 | `main.ts:3982` | `perfMarks.decodeStart/decodeEnd` **ไม่เคยถูก assign** แต่ `logPerformance()` ลบมัน → Ctrl+Shift+P รายงาน "decode: 0.0ms" = **เครื่องมือวัดโกหกในทิศที่ทำให้สืบผิดทาง** | U18 |
| R1-39 | `main.ts:4887` | branch `grid-1x4` เข้าไม่ถึง (`count = Math.min(selectedIds.length, 4)`) → บังข้อเท็จจริงว่า selection เกิน 4 ถูก drop เงียบ ๆ | U12 |
| R1-40 | `main.ts:4408` | `fillStyle='#000'`+`fillRect` แล้วตามด้วย `clearRect` rect เดิมทันที — letterband ดำเพราะ CSS `background:#000` โชว์ผ่าน ไม่ใช่เพราะ fill; และ scratch canvas+context ถูกสร้างใหม่ทุก repaint ใน `do…while` loop | U18 |
| R1-41 | `main.ts:374` | `showError` ไม่เคยแตะ `<details>` wrapper → **7 call site ที่ไม่ส่ง detail แสดง "See detail" ที่ขยายมาเป็นกล่องว่าง** และ state open ค้างข้าม error | U2 |
| R1-42 | `main.ts:3781` | string ภาษาไทยหนึ่งเดียวที่ user-visible ในไฟล์ที่ copy อื่นเป็นอังกฤษหมด — ตรงกรณี popup blocker ซึ่งเป็นเคสที่ข้อความคือเบาะแสเดียว | U18 |

---

## 🆕 Candidate ใหม่ที่ยังไม่ได้ยืนยัน (ไม่อยู่ใน review)

| ID | ค้นพบโดย | อาการ | สถานะ |
|---|---|---|---|
| **N1** | A1 (`58636c2`) — ค้นพบเพราะ A1 ทำให้ harness ยิง **trusted key** ได้เป็นครั้งแรก | `pressKey('Escape')` **ครั้งเดียว**สร้าง keydown ~2,000 ครั้งในหน้าภายใน 250ms และโตเกิน **88,000** · ทำซ้ำได้ทั้ง `rawKeyDown` และ `keyDown` · ขณะที่ `ArrowRight`/`ArrowUp` ด้วย event shape เหมือนกันทุกประการ**สะอาด** · `e.key` เป็น `"Escape"` แล้วกลายเป็น `"Unidentified"` | ⚠️ **ยังแยกสาเหตุไม่ได้** — เป็นได้ทั้ง CDP auto-repeat ฝั่ง harness หรือ app-side runaway handler · **ถ้าเป็นฝั่งแอปอาจเป็น Critical ใหม่** · review ไม่มีทางเจอเพราะมันไม่มีวิธียิง trusted key · **มอบให้ U7 พิสูจน์ก่อน แล้วค่อยเลื่อนระดับเป็น finding — ห้ามเดา** |

---

## ข้อที่ review ตรวจแล้ว **reject** (บันทึกกันเสนอซ้ำ)

| ข้อกล่าวหา | เหตุที่ reject |
|---|---|
| `opsToLabel` index `FILM_STOCKS`/`BW_TONES` ด้วย id ที่ไม่ validate | `isValidOp` validate ทั้งคู่ (`editsStore.ts:59-62` ผ่าน `isFilmStockId` ที่ derive จาก `Object.keys(FILM_STOCKS)` จึง drift ไม่ได้; `:96-102` สำหรับ BW tones) และทุก route ผ่านมันรวม `parsePreset` — residual คือ BW list maintain แยกจาก `bw.ts` (Nice-to-have) |
| batch export ข้าม display-orientation correction | orientation ถูก apply ใน `Pipeline.load`'s normalize pass (`pipeline.ts:293`) ไม่ใช่โดย main.ts และ `exportImage` อ่าน texture ที่ flip แล้ว (`pipeline.ts:271-278` document ไว้) |
| device-loss recovery ทำ dodge mask หาย และ `currentEditState!` throw | `pipeline.load()` เข้าไม่ถึงบน path นั้น (abort ที่ `main.ts:3291`); `currentFileId`/`currentEditState` ถูก assign ติดกัน ไม่มี await คั่นและไม่เคยถูก set null — ทั้งคู่ถูก subsume โดย R1-13 |
| Sync Settings ไม่ copy control ที่ source clear เป็น neutral | เป็น **documented, tested, deliberate** contract ของ commit `a6cba69` — `syncOps.ts:4-6`/`:52-54` ระบุ, `index.html:2762`/`2773` บอกผู้ใช้, 6 เคสใน `syncOps.test.ts` pin ไว้; ข้ออ้าง "✓ synced ขัดกัน" ก็ถูกโต้ — message นับ**รูป**ไม่ใช control |
| `main.ts:4813` เรียก `getContext('2d')!` บน `#canvas` ที่ `pipeline.ts:222` ถือเป็น `'webgpu'` | `canvas` ที่ 4813 คือ block-local `document.createElement('canvas')` ใน `exportContactSheet` เป็น element ใหม่ที่ไม่เคยมี webgpu context → `!` sound; การ shadow ด้วย local สองตัว (4810, 4898) เป็น readability hazard ควร rename เท่านั้น |

---

## ช่องที่ review ปิดไม่ได้ (ห้ามเอาไปสรุปเอง)

- พฤติกรรมจริงของ `FileSystemFileHandle.remove()` — trash หรือ unlink (ทำให้ R1-29 confidence **low** และความรุนแรงขึ้นอยู่กับคำตอบนี้)
- GC-reclaimability ของ `GPUDevice` (R1-11) — verdict พึ่งข้อเท็จจริงว่า `destroy()` ไม่เคยถูกเรียก และ `destroy()` ไม่เรียก `device.destroy()` ไม่ใช่การวัด leak จริง
- `catch` block **46 จาก 58** แห่งใน `main.ts` ยังไม่ได้อ่านรายตัว
- `scripts/qa-loop.mjs` ช่วง 1115-1660 และ 1840-2095 ยังไม่ได้อ่านเต็ม
- perf threshold ของ R1-24/R1-25 **ยังไม่เคยวัดจริงใน browser** — นี่คือเหตุผลที่ทั้งสองเป็น Suggestion ไม่ใช่ Critical
- ยังไม่ประเมิน: `isValidOp` validate `toneCurve.points` ที่ restore มาไหม (odd-length/NaN ผ่าน `isLinearCurve`), `renderSurvey` re-tile ตอน resize ไหม, `createBackupModule` options เทียบ interface ของ `catalog/backup.ts`, ผู้เขียน `getState().selectedIds` รายอื่นนอกจาก `pruneSelectionToVisible`
