# Main.ts Hardening Plan — fix-by-extraction with TDD + QA + BDD

**Date:** 2026-09-27
**สถานะ:** ร่าง **rev.2** รอ owner approve — ยังไม่ลงมือ
**Rev.2 (2026-09-27):** เพิ่ม §1.5 (DI + Dependency Inversion บังคับทุกชั้น) · เปลี่ยน §4 เป็นเรียงเข้มงวด A0 → A1 → U1 → U18 ไม่ข้ามไม่รุม · เพิ่ม §3.5 (ช่องโหว่ trusted input ใน QA + unit A1 ที่ปิดมัน) · แก้ §2.2 เป็นลำดับ 4 commit ต่อหน่วย — ตาม directive 4 ข้อของ owner
**Input:** prod-grade review ของ `src/main.ts` (whole-file, medium effort, HEAD `bbb9b8d`)
ผล: **42 findings — Critical 20 / Suggestion 16 / Nice-to-have 6** · confidence high 35, low 7
ต้นทุน review: 413 model calls · 28.4M input (94% cached) · 548k output · 98 นาที · 13 agent runs
รายงานเต็ม (949 บรรทัด): **`docs/reviews/2026-09-27-main-ts-review.md`** (tracked) · cost ledger: `docs/reviews/2026-09-27-main-ts-review-cost-ledger.json`
— ต้นฉบับที่ CLI เขียนอยู่ที่ `.qwen/reviews/2026-09-27-182009-src_main.ts.md` ซึ่ง gitignored; owner ตัดสินใจ 2026-09-27 ให้ copy เข้า `docs/` แล้ว **ภาคผนวก ก ของเอกสารนี้คือ findings register ที่ self-contained** เพื่อให้อ่านแผนได้โดยไม่ต้องเปิดรายงาน

**Feature freeze:** เจ้าของโปรเจกต์ประกาศ cut off feature แล้ว (2026-09-27) งานทั้งหมดในแผนนี้คือ hardening + decoupling เท่านั้น ไม่มีฟีเจอร์ใหม่

---

## 1. หลักการ: สามอย่างนี้ไม่ใช่งานขนานกัน

Owner ขอ (1) ค่อย ๆ decoupling ให้ loosely coupled / clean / readable / maintain ต่ำ (2) TDD ทุกอย่าง (3) QA คุมระหว่างทำ (4) BDD ตรวจจบส่งงาน

มันไม่ใช่สี่งานขนาน แต่เป็นห่วงโซ่ dependency เดียว:

```
decouple (ย้าย logic ออกจาก main.ts)
  → importable ใน vitest
    → TDD เป็นไปได้จริง (เขียน test แดงก่อน แล้วค่อยแก้)
      → QA check ยืนยันพฤติกรรม end-to-end ในเบราว์เซอร์จริง
        → BDD scenario = สัญญาส่งงานที่คนอ่านรู้เรื่อง
```

### ตัวบล็อกที่ทำให้ต้องเรียงลำดับแบบนี้ (หลักฐาน ไม่ใช่การคาดเดา)

Review พิสูจน์เองใน R1-2:

> *"not run — it closes over module-level allFiles/folderFilter inside main.ts, **which executes `document.querySelector(...)!` at import time and cannot load under vitest's node environment**"*

ประกอบกับที่ Agent 7 ยืนยันว่า **`src/main.test.ts` ไม่มีอยู่** — main.ts ถูกครอบแค่โดย typechecker กับ bundler ขณะที่เพื่อนบ้านมี test ครบ: `src/app/` 10 ไฟล์, `src/catalog/` 17, `src/gpu/` 16, `src/raw/` 4

**สรุป: Critical ทั้ง 20 ตัวอยู่ในไฟล์ที่ import เข้า test ไม่ได้** → "TDD ทุกอย่าง" กับ "แก้ใน main.ts" เป็นไปไม่ได้พร้อมกัน การ decouple จึงไม่ใช่ความสวยงาม แต่เป็น**เงื่อนไขตั้งต้นของ TDD**

R1-33 ระบุรากเดียวกันในเชิง coverage: `currentOpsFromSliders` (emit list) กับ `applyOpsToSliders` (restore list) เป็น **สอง enumeration ที่ maintain ด้วยมือแยกกัน โดยไม่มีอะไร assert ว่าตรงกัน** — และนั่นคือช่องที่ R1-1 กับ R1-22 ตกลงมา

### สองทางที่ดูสมเหตุสมผลแต่พัง — และไม่ทำ

- ❌ **แก้ 20 Critical ให้ครบก่อน แล้วค่อย refactor** → ต้องแก้โดยไม่มี test (ขัดข้อกำหนด TDD), แล้วพอ move โค้ดก็เสี่ยงพังซ้ำ, และ fix witness ของ review เองเรียกร้อง test ที่เขียนใน main.ts ไม่ได้
- ❌ **refactor ให้เสร็จก่อน แล้วค่อยแก้** → R1-3 (XSS ที่มี readwrite directory grant) กับ R1-1 (edit หายถาวร) ค้างเป็นสัปดาห์

### ทางที่ทำ: **fix-by-extraction**

แต่ละ step = แยก module ที่เล็กที่สุดซึ่งเป็นเจ้าของหนึ่ง finding (หรือหนึ่ง cluster แน่น) → TDD finding นั้นในบ้านใหม่ → wire → gate

ผลคือ monolith เล็กลง**ในฐานะ side effect ของการแก้บั๊ก** — ไม่มี step ไหนเป็น "refactor ล้วนไร้ค่าต่อผู้ใช้" หรือ "fix ล้วนที่ไม่ได้อะไรเชิงโครงสร้าง"

---

## 1.5 สถาปัตยกรรมบังคับ — Dependency Injection + Dependency Inversion

*(owner directive 2026-09-27 ข้อ 1-2: "ป้องกันชั้นใน" และ "main.ts ไม่อม business logic")*

rev.1 เสนอแค่ "ย้ายโค้ดออกเป็น module" ซึ่งยังไม่พอ — module ที่ได้ยังเป็นเจ้าของ DOM เอง จึง test โดยไม่มี browser ไม่ได้ **rev.2 บังคับแบ่งชั้นจริง** เพราะนี่คือทางเดียวที่ทำให้ TDD เป็นไปได้ตามที่ §1 พิสูจน์ว่าจำเป็น

### ชั้น และการพึ่งพา

```
  ┌──────────────────────────────────────────────────────────┐
  │ adapters/   DOM · WebGPU · IndexedDB · File System Access │  implement ports
  ├──────────────────────────────────────────────────────────┤
  │ app/        use-cases = orchestration ล้วน                │  import ได้แค่ domain/
  ├──────────────────────────────────────────────────────────┤
  │ domain/     business rules + ports (interfaces)           │  ห้าม import ชั้นนอกใด ๆ
  └──────────────────────────────────────────────────────────┘
              ▲ composition root (bootstrap) เป็นผู้ wire ทั้งหมด
```

**กฎเหล็ก — dependency ชี้เข้าในเท่านั้น:**

- `domain/` **ห้าม** import จาก `app/`, `adapters/`, `main.ts`, หรือแตะ `document` / `window` / `indexedDB` / `navigator` / WebGPU ใด ๆ ทั้งสิ้น ตรวจได้ด้วย grep และเป็นเงื่อนไขใน Definition of Done
- `app/` (use-case) import ได้แค่ `domain/` — รวมถึง port interfaces ที่ domain เป็นเจ้าของ
- `adapters/` implement port ที่ **domain ประกาศ** — นี่คือ Dependency Inversion: ชั้นในเป็นเจ้าของสัญญา ชั้นนอกเป็นผู้ปฏิบัติ ไม่ใช่กลับกัน
- **ผลโดยตรง:** business logic ทุกชิ้น unit-test ได้ด้วย fake adapter ในหน่วยความจำ ไม่ต้องมี jsdom ไม่ต้องมี browser ไม่ต้องมี GPU — ซึ่งปิดตัวบล็อกที่ §1 ระบุ

### รูปธรรม (ใช้ชื่อนี้จริงในโค้ด)

```
src/domain/ports/editStore.ts     interface EditStore { load(id): Promise<EditState>; persist(id, s): Promise<void> }
src/adapters/idbEditStore.ts      class IdbEditStore implements EditStore  ← IndexedDB
src/app/syncSettings.ts           export function syncSettings(deps: { store: EditStore; ... })  ← orchestration ล้วน
src/app/syncSettings.test.ts      ใช้ InMemoryEditStore fake — ไม่แตะ browser
```

### ห้ามใช้ DI container

คง **zero runtime dependency** ไว้ (ปัจจุบัน repo มี runtime dep ศูนย์ตัวจาก npm — `libraw-wasm` ชี้ไป `./vendor/` ผ่าน git submodule) ใช้ constructor/factory injection ธรรมดากับ TypeScript interface ตาม pattern ที่มีอยู่แล้ว (`createFilmstrip(opts)`, `createPrintModule(opts)`, `secondMonitor.ts`)

เหตุผลที่ไม่เอา tsyringe/inversify: (ก) เป็น runtime dep ตัวแรกของ repo (ข) ขัด spirit ของ CLAUDE.md ที่ว่า *"WebGPU API directly, no wrapper"* (ค) decorator-based DI ต้องการ experimental flag ใน tsconfig ซึ่งตอนนี้ตั้ง `strict` + `noUnusedLocals` + `noUnusedParameters`

### Boundary rule — อะไร **ไม่** ต้องเป็น interface

DIP กับทุกอย่าง = over-abstraction กฎที่ใช้ตัดสินแต่ละก้อน:

| ถ้ามี... | อยู่ชั้น | ทดสอบด้วย |
|---|---|---|
| decision / calculation / state transition | `domain/` | unit test + fake adapter |
| ลำดับขั้นการเรียกหลาย domain (workflow) | `app/` | unit test + fake adapter |
| แตะ pixel / attribute / layout / event binding | `adapters/` | QA check ในเบราว์เซอร์จริง |

ตัวอย่างที่ตัดสินแล้ว: *"op ไหนควร sync"* = domain (`syncableOps` อยู่ถูกที่แล้ว · มี test แล้ว) · *"วาด badge ที่พิกัดไหน"* = adapter (ห้ามทำ interface ให้มัน)

### main.ts end-state = composition root

เป้าหมายสุดท้ายที่ owner ระบุ: **main.ts เป็นตัวเรียก business logic ของแต่ละเรื่อง ไม่มี tech logic**

- `src/bootstrap.ts` = composition root ตัวจริง — อ่าน app props (DOM refs, config), สร้าง adapters, inject เข้า use-case modules, ลงทะเบียน wiring (event → use-case)
- `src/main.ts` = entry บาง ๆ ที่ `import { boot } from './bootstrap'; void boot();`
  — ยังชื่อ `main.ts` เพราะมันเป็น vite entry จริง (`index.html:2863` ตามที่ Agent 7 ของ review ยืนยัน) จึงไม่ต้องแก้ `index.html`
- **Definition of Done ของทั้งโปรแกรม:** `main.ts` + `bootstrap.ts` รวมกันไม่มี `if` ที่เป็น business rule, ไม่มี loop ที่คำนวณ, ไม่มี math — มีแค่การสร้าง object และการต่อสาย

### แผนนี้ formalize ของเดิม ไม่ได้ประดิษฐ์ใหม่

`src/catalog/*` กับ `src/gpu/*` ส่วนใหญ่ pure + tested อยู่แล้ว (47 test files, 790 tests) และ `src/app/*` มี pure logic (`filters.ts`, `stacks.ts`, `survey.ts`, `navigator.ts`, `viewState.ts`) ปนกับ DOM factory (`filmstrip.ts`, `secondMonitor.ts`, `printModule.ts`) สิ่งที่ขาดมีสามอย่าง และแผนนี้เพิ่มให้: (ก) ชั้น `domain/` ที่แยกจริง (ข) ports ที่ชั้นในเป็นเจ้าของ (ค) composition root ที่ไม่อม logic

---

## 2. Method บังคับ (ทุก unit ไม่มีข้อยกเว้น)

### 2.1 TDD loop ต่อหนึ่ง finding

Review เขียนสเปคมาให้แล้วทุกข้อ — ช่อง `Fix witness (acceptance criterion)` คือ test ที่ต้องเขียน และช่อง `Fix constraint` คือ invariant ที่ห้ามพัง Plan นี้แปลงสองช่องนั้นเป็นสเปคให้ worker:

1. **เขียน acceptance test ก่อน** ใน module ที่ logic จะไปอยู่ (ไม่ใช่ใน main.ts)
2. **รันและโชว์ว่าแดง** — ต้อง paste output ที่ fail จริง ห้ามบอกว่า "น่าจะแดง"
3. **แก้ขั้นต่ำที่สุดให้เขียว** โดยเคารพ `Fix constraint` ของข้อนั้น
4. **เพิ่ม/ขยาย QA check** ที่พิสูจน์พฤติกรรมระดับผู้ใช้ในเบราว์เซอร์จริง
5. **gate ครบสามตัว:** `npm test` + `npm run build` + `npm run qa` เขียวทั้งหมด
6. **mutation check:** revert fix → test ต้องแดง → restore → เขียว
   — ตรงกับถ้อยคำที่ review เขียนไว้ทุกข้อว่า *"must go red if reverted"* นี่คือสิ่งที่แยก test จริงออกจาก tautology **บังคับทำและบังคับรายงาน**

### 2.2 ลำดับ 4 commit ต่อหนึ่งหน่วย (rev.2 — บังคับ)

แต่ละหน่วยแยกเป็น 4 commit ที่ revert ได้ทีละก้อน **ห้ามรวมขั้น** เพราะถ้ารวม test ที่แดงจะแยกไม่ออกว่า "โครงสร้างพัง" หรือ "fix ผิด" — หลักเดียวกับที่ใช้กับ `printModule.ts` (commit `bbb9b8d`) แล้วได้ผล

| # | commit | เนื้อหา | gate |
|---|---|---|---|
| 1 | `refactor:` **structure** | ประกาศ port ใน `domain/`, ย้าย business logic เข้า `domain/`, สร้าง adapter ใน `adapters/`, สร้าง use-case ใน `app/` — **behavior-preserving ล้วน ไม่เปลี่ยนพฤติกรรม ไม่เพิ่ม test** | test + build + qa เขียว โดยตัวเลข QA ต้อง**เหมือนเดิมทุกหลัก** |
| 2 | `test:` **red** | เขียน acceptance test ใน `domain/` หรือ `app/` ด้วย fake adapter — แปลงจาก `Fix witness` ของ review ตรง ๆ | **ต้องแดง** และ worker ต้อง paste output ที่แดงจริง |
| 3 | `fix:` **green** | แก้ขั้นต่ำที่สุดให้เขียว โดยเคารพ `Fix constraint` ของข้อนั้น + **mutation check** (revert → แดง → restore → เขียว) | test + build + qa เขียว |
| 4 | `test(qa):` **acceptance** | เพิ่ม Gherkin scenario ใน `docs/acceptance/` + QA check ที่พิสูจน์พฤติกรรมในเบราว์เซอร์จริง | qa เขียว และ check ใหม่ต้อง PASS |

หน่วยที่เป็น Class C (แก้ 1-2 บรรทัดในที่เดิม) ใช้ลำดับย่อ: **ข้าม commit 1** และเอา QA check ที่แดงขึ้นก่อน (commit 2 = `test(qa):` red) แล้วค่อย commit 3

หน่วยที่มีหลาย finding ให้ทำทีละ finding ครบทั้ง 4 commit แล้วค่อยไป finding ถัดไป — **ห้ามแก้หลาย finding ใน commit เดียว**

### 2.3 Class ของ finding = วิธี test

| Class | คืออะไร | วิธี |
|---|---|---|
| **A** | logic ล้วน ย้ายเข้า pure module ได้ | TDD เต็มรูป (unit test ใน module ใหม่) |
| **B** | defect ที่เกิดเพราะโค้ดอยู่ใน main.ts | extract เป็น factory `createXxx(opts)` ตาม pattern `filmstrip.ts` / `secondMonitor.ts` / `printModule.ts` แล้ว TDD unit + QA คุม wiring |
| **C** | แก้ 1-2 บรรทัดในที่เดิมได้ แต่ test ได้แค่ระดับ browser | **QA check คือ test** — เขียน check ให้แดงก่อน แล้วค่อยแก้ |

### 2.4 Definition of Done ต่อหนึ่ง unit

- [ ] ครบลำดับ 4 commit ของ §2.2 (หรือลำดับย่อของ Class C) และแต่ละ commit revert ได้เดี่ยว ๆ
- [ ] ทุก finding มี test แดงก่อนแก้ (หรือ QA check แดงก่อนแก้ สำหรับ Class C) และ worker **paste output ที่แดงจริง** ไม่ใช่บอกว่า "น่าจะแดง"
- [ ] mutation check ผ่าน — revert แล้วแดง, restore แล้วเขียว
- [ ] `npm test`, `npm run build`, `npm run qa` เขียวครบ และตัวเลข QA เดิม**ไม่ขยับ**
- [ ] **กฎชั้น (§1.5) ตรวจด้วย grep:** `src/domain/**` ไม่ import จาก `app/`/`adapters/`/`main.ts` และไม่ปรากฏ `document`/`window`/`indexedDB`/`navigator` เลย · `src/app/**` import แค่ `domain/`
- [ ] business logic ที่ย้ายออกมามี unit test ที่รันได้**โดยไม่มี browser** (ใช้ fake adapter ไม่ใช่ jsdom)
- [ ] Gherkin scenario อยู่ใน `docs/acceptance/` และ tag `@qa` map ไปชื่อ QA check ที่เขียวแล้ว
- [ ] `main.ts` เหลือแค่ wiring สำหรับเรื่องนั้น — ไม่มี decision / calculation / state transition ค้างอยู่
- [ ] ไม่มี `as any` ใหม่ · ไม่มี math ที่ซ้ำซ้อนใหม่ (ของเก่าดู R1-21 / R1-34 / R1-31)
- [ ] worker รายงาน verbatim; **owner เป็นคนตัดสินใจปิด finding** — worker ปิดเองไม่ได้

### 2.5 มาตรฐาน maintainability ที่แผนนี้ตั้งเพิ่ม (ถาวร ไม่ใช่ต่อ unit)

- **`"allowUnreachableCode": false` ใน `tsconfig.json`** — R1-23 พบ dead code 28 บรรทัดใน `rebuildGrid` (2013-2040) ที่ tsc ไม่ flag เพราะ tsconfig มี `strict`/`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` แต่**ไม่มี** `allowUnreachableCode:false` เปิดแล้ว build จะแดงที่ 2013 จนกว่าจะลบ dead block → กันทั้งคลาสไม่ให้กลับมาเงียบ ๆ
- **vocabulary มีเจ้าของเดียว** — R1-1 + R1-22 มีรากเดียวกัน: lightleak pattern set ถูกประกาศใน `gpu/lightleak.ts` แต่ถูก hardcode ซ้ำโดย 4 consumers (validator, label, type comment, UI) แก้ที่ราก = export map เดียวแล้ว derive ทุกฝ่าย
- **math ซ้ำต้องมีบ้านเดียว** — R1-21 พบ `dispScale` expression เหมือนกัน byte-for-byte 3 ที่ (902, 3639, 3663) และ R1-34 พบ letterbox inverse-map ซ้ำ 2 ที่ ทั้งที่ `containBox` ที่ถูกต้องมีอยู่แล้วใน `app/navigator.ts` พร้อม test 3 เคส
- **ไม่มี dispatcher ซ้ำ** — R1-15 พบ keydown dispatcher ระดับ document ตัวที่สองที่อ้อม `keyToAction()` และ R1-30 พบอีก 2 handler ที่ไม่มี guard ขณะที่ `isEditable` ถูก copy inline ครั้งที่สามที่ 5566 → รวมเหลือทางเดียว และ export `isEditable` จาก `app/shortcuts.ts` (ตอนนี้ module-private จึง import ไม่ได้)

---

## 3. BDD layer — Gherkin เป็นเอกสาร, map ไป qa-loop

**ข้อเท็จจริงที่ต้องยอมรับก่อน:** repo ไม่มี Gherkin runner (devDeps มีแค่ `@types/node`, `playwright-core`, `typescript`, `vite`, `vitest`) และ owner เลือกแล้วว่าจะ**ไม่เพิ่ม dependency** — ใช้ Gherkin เป็น spec-of-record แล้ว map ไป check ที่มีอยู่

### สิ่งที่มีอยู่แล้วและคือ acceptance layer จริง

`scripts/qa-loop.mjs` (27 checks) ขับ Chrome จริงผ่าน CDP แล้ว assert ผลที่ผู้ใช้เห็น — มันคือ BDD runner อยู่แล้ว ขาดแค่ (ก) ภาษาที่เป็น user story และ (ข) traceability

### Convention ที่จะใช้

- ไฟล์: `docs/acceptance/<unit-slug>.feature` — Gherkin จริง (`Feature:` / `Scenario:` / `Given-When-Then`) แต่**ไม่ถูก execute**
- ทุก `Scenario:` ต้องมี tag `@qa <check-name>` ที่ชี้ไปชื่อ check ใน `qa-loop.mjs` แบบ 1:1
- ทุก `Scenario:` ต้องมี tag `@finding R1-<n>` เพื่อโยงกลับไปยัง register
- **ชื่อ QA check ต้องเป็นประโยคพฤติกรรมที่ผู้ใช้สังเกตได้** ไม่ใช่ภาษา implementation
  - ❌ `retryFailedEditRenders re-queues`
  - ✅ `a photo whose preview failed to render is re-rendered after Restore access`
- `docs/acceptance/README.md` เป็นตาราง traceability: `R1-n → scenario → qa check → unit test file`

### ตัวอย่าง (U1 — op validation boundary)

```gherkin
Feature: A photo's edits survive being saved and reopened

  @finding R1-1 @qa lightleak: Set C/D edits survive a reload
  Scenario: Light leak Set C survives reload
    Given a photo in the catalog
    When I set Light leak amount to 40 and Pattern to "Set C - punchy"
    And I reload the page
    And I open that photo in Develop
    Then every edit I made is still there
    And the photo still appears in the Edited filter

  @finding R1-32 @qa paste: invalid clipboard settings are refused, not written
  Scenario: Pasting foreign JSON does not destroy edits
    Given 20 photos are selected
    And the system clipboard holds an unrelated JSON array
    When I paste settings
    Then no photo loses its edit history
    And I am told the clipboard does not hold valid Candela settings
```

### ทำไม R1-33 และ R1-36 อยู่ในแผนทั้งที่เป็น "coverage finding"

ทั้งสองคือกรณีที่ **QA check มีอยู่แต่ไม่ได้ assert สิ่งที่ชื่อมันสัญญา** — ซึ่งเป็นความล้มเหลวของ BDD layer ตรง ๆ:

- **R1-33:** ไม่มี test หรือ QA check ใดแตะ `applyOpsToSliders`/`currentOpsFromSliders`; check ที่เขียน op ('edited filter', 'sync') assert แค่แถวใน IndexedDB และ**ไม่เคยเปิดรูปซ้ำ**; 'stability: 4 sequential opens' เปิดแต่ไฟล์**ที่ไม่ได้แก้** → round-trip จึงถูกวิ่ง end-to-end เฉพาะกับ op set ว่าง/As-Shot เสนอ: check เดียวที่ขยับทุก control ในทุก module → commit → reload → เปิดซ้ำ → assert ค่า DOM กลับมาครบ ซึ่งทำให้ emit list กับ restore list ตรงกัน by construction
- **R1-36:** check ชื่อ `'restore: banner appears after reload, click re-renders'` assert แค่ banner หายกับ `reqLog` มี `grant` — อ่าน `#footer-counts` ใส่ตัวแปรแต่**ไม่ throw** และไม่เคย probe thumbnail ซ้ำ ทั้งที่ `probeThumbs` มีอยู่แล้วที่ `:1040` → check ที่สัญญาว่า "re-renders" ไม่ได้ตรวจ re-render แก้ ~3 บรรทัด ไม่ต้องแก้ source

---

## 3.5 QA กดจริงแค่ไหน — คำตอบต่อ owner directive ข้อ 4

**คำตอบสั้น: กดจริงอยู่แล้ว และมากกว่า "ดู code/response" มาก — แต่มีช่องโหว่ 2 ข้อที่ต้องปิดก่อน**

### สิ่งที่ harness ทำอยู่ (ยืนยันจากการอ่านโค้ด ไม่ใช่ความจำ)

- spawn Chrome จริง `--headless=new --remote-debugging-port=…` (`qa-loop.mjs:2024-2026`) แล้วคุย raw CDP ผ่าน global `WebSocket` ของ Node 26 — **ศูนย์ dependency** (คอมเมนต์ที่ `:31` ระบุเจตนานี้ไว้ชัด)
- `clickEl()` (`:208-236`) คือ **คลิกจริงแบบ trusted**: `scrollIntoView` → เปิด `<details>` ที่พับอยู่ → คำนวณจุดกึ่งกลางจริง → **assert hit test ด้วย `document.elementFromPoint`** (ถ้า overlay คร่อมอยู่จะ throw ทันที — คอมเมนต์บันทึกว่าเคยมี check ตายปริศนาสองตัวเพราะเหตุนี้) → `Input.dispatchMouseEvent` type `mousePressed` + `mouseReleased` ที่พิกัดจริง = `isTrusted: true` แยกจาก synthetic event ไม่ออกในระดับ DOM
- assert ผลที่ผู้ใช้สังเกตได้จริง ไม่ใช่ return value: แถวใน IndexedDB, PDF content stream + `/MediaBox`, พิกเซล canvas ผ่าน `getImageData`, ไบต์ของไฟล์ที่ดาวน์โหลด, สถานะ DOM, ข้อความ footer
- WebGPU render จริง, LibRaw WASM decode จริง, `Page.printToPDF` ออก PDF จริง

### ช่องโหว่ที่ต้องปิด — และมันอธิบายว่าทำไมบาง finding ไม่มี witness

| ช่อง | หลักฐาน | ผลที่ตามมา |
|---|---|---|
| **1. คีย์บอร์ดเป็น untrusted** | ทุก key press ใช้ `cdp.evaluate(... dispatchEvent(new KeyboardEvent('keydown', {...})))` — grep `Input.dispatchKeyEvent` ทั้งไฟล์ = **0 hits** | อะไรที่ gate ด้วย `isTrusted` จะไม่ทำงานเหมือนคนกดจริง · นี่คือเหตุผลที่ R1-15 / R1-16 / R1-30 (findings เรื่อง shortcut **ทั้งหมด**) มี witness เป็น 📖 static analysis ล้วน ไม่มีตัวไหนรันจริง |
| **2. ลาก (drag) ทำไม่ได้เลย** | grep `mouseMoved` ทั้งไฟล์ = **0 hits** | crop drag, tone-curve drag, dodge/burn brush stroke, middle-pan, navigator drag **ไม่เคยถูกวิ่งเป็น gesture เลยแม้แต่ครั้งเดียว** → อธิบายตรง ๆ ว่าทำไม R1-12, R1-20, R1-21, R1-34 (pointer geometry ทั้งสี่ตัว) ไม่มี executed witness; R1-34 ระบุเองว่า check crop *"asserts overlay PIXELS … and never dispatches a pointer event"* |
| **3. trusted input ถูกเลี่ยงโดยเจตนาใน export/PDF** | คอมเมนต์ใน C5: *"CDP synthesized input is trusted (isTrusted=true) and Chrome pops a real 'Save PDF' dialog that hangs headless automation"* | **ถูกต้องแล้วที่ต้องเลี่ยง** — แต่นั่นแปลว่า export path ถูก test ผ่าน hook ไม่ใช่ผ่าน UI จริง |

### หน่วย A1 จะปิดช่อง 1 กับ 2 (ช่อง 3 จงใจคงไว้)

- `pressKey(cdp, key, modifiers)` → `Input.dispatchKeyEvent` ครบ `rawKeyDown` / `char` / `keyUp` = trusted
- `dragEl(cdp, fromSelector, toX, toY, { steps })` → `mousePressed` → N × `mouseMoved` → `mouseReleased` ที่พิกัดจริง = trusted drag (ใช้ hit-test assertion แบบเดียวกับ `clickEl` ก่อนกด)
- `typeText(cdp, text)` → trusted typing สำหรับช่อง search / keyword / IPTC / smart-collection name
- **ศูนย์ dependency ใหม่** — ใช้ CDP primitive ชุดเดียวกับ `clickEl` ที่มีอยู่แล้ว ผ่าน WebSocket ตัวเดิม
- **ผล:** U10 / U11 / U12 (geometry + gesture) จะ verify ด้วยการ**ลากจริง** ไม่ใช่แค่ unit test + assert pixels และ Gherkin จะเขียน scenario แบบ `When I drag the curve point to the right edge` ได้จริงแทนที่จะเลี่ยงไปพูดอ้อม

### ข้อจำกัดที่ยังเหลือและยอมรับ

headless ไม่มีคนดู จึงตัดสินเรื่องความสวยงาม/ความรู้สึกไม่ได้ · และ API ที่ต้องทั้ง trusted gesture **และ** user activation (`showDirectoryPicker`, `showOpenFilePicker`, `requestFullscreen`, `clipboard.readText`) ยังต้อง hook ต่อไป — harness มี `__qa.hooked` นับจำนวนการเรียกอยู่แล้ว จึงรู้ตัวว่ากำลังทดสอบผ่าน hook

---

## 4. Work units — หน่วยมูลฐาน 2 หน่วย (A0, A1) + 18 หน่วยครอบ 42 findings

| Unit | Module boundary ที่สร้าง/ย้าย | Findings | Class | Testable วันนี้? |
|---|---|---|---|---|
| **U1** op-validation boundary | `gpu/lightleak.ts` export vocabulary; `catalog/editsStore.ts` validate ราย op แทนทิ้งทั้ง row; paste validate ก่อน persist | R1-1(C), R1-22(S), R1-32(S) | A | ✅ **ทันที** — `editsStore.ts` เป็น pure module มี test ครบ |
| **U2** error banner | ใหม่ `app/errorBanner.ts` — เป็นเจ้าของ `#error`/`#error-message`/`#error-detail`/`<details>`, expose `showError`/`clearError` | R1-14(C), R1-41(N) | B | หลัง extract |
| **U3** untrusted-string rendering | `renderSmartCollections` + info overlay → `createElement`+`textContent`; `catalog/backup.ts` validate row shape | R1-3(C) | C + A | QA check (C) + backup unit test (A) |
| **U4** boot resilience | `init()` tail → ตาราง `[name, fn]` + try/catch ต่อ step; `init().catch(...)` | R1-27(S) | B | หลัง extract; ต้องไม่กลืน path `openCatalogDb` ที่ return |
| **U5** batch export | ใหม่ `app/exportNaming.ts` (pure) + `app/batchExport.ts` (factory); สร้าง `prepareForExport()` ร่วมกับ `loadIntoPipeline` | R1-5(C), R1-9(C), R1-10(C), R1-35(S) | A + B | หลัง extract |
| **U6** GPU device-loss recovery | ใหม่ `app/gpuRecovery.ts` — injectable `create` + hooks | R1-13(C) | B | หลัง extract |
| **U7** shortcuts | `app/shortcuts.ts` export `isEditable`; รวม dispatcher เหลือตัวเดียว; guard ทุก dialog | R1-15(C), R1-16(C), R1-30(S) | A + B | บางส่วน — `shortcuts.test.ts` มีอยู่แล้ว |
| **U8** dodge mask contract | `gpu/dodge.ts` + `Pipeline.setDodgeMask` คืน boolean; `syncDodgeMaskToGPU` ตรวจ dims กับ `maskDims(canvas)` ก่อน upload และ clear `dodgeMaskDirty` เฉพาะเมื่อสำเร็จ — **owner ตัดสิน 2026-09-27: แก้ที่ GPU contract ไม่ใช่ที่ `syncableOps`** (ดู §8.2) | R1-8(C) | A | ✅ `gpu/` มี 16 test files |
| **U9** curve model | ใหม่ `app/curveModel.ts` (pure) จาก main.ts ~700-760 | R1-6(C), R1-7(C) | A | หลัง extract |
| **U10** letterbox geometry | `app/navigator.ts` เพิ่ม `letterboxPoint()` + `displayScale()` — รวม 5 สำเนาที่กระจัดกระจาย | R1-12(C), R1-21(S), R1-34(S) | A | ✅ `navigator.test.ts` pin `containBox` อยู่แล้ว |
| **U11** loupe gestures | ใหม่ `app/loupeGesture.ts` — pointer lifecycle ครบ (down/move/up/cancel/leave/lostpointercapture) | R1-20(C) | B | หลัง extract; **พึ่ง U10** |
| **U12** compare + contact views | ใหม่ `app/compareView.ts` (factory, มี lifecycle ของ Pipeline ตัวเอง) + contact sheet wiring | R1-11(C), R1-18(C), R1-19(C), R1-39(N) | B + C | หลัง extract |
| **U13** scope & selection | ใหม่ `app/selectionScope.ts` (pure) + route search ผ่าน `app/filters.ts`; ลบ `(f as any)` | R1-2(C), R1-17(C), R1-31(S) | A | หลัง extract |
| **U14** grid hot path | `rebuildGrid`/`collectVisibleFiles` → pure helpers ใน `app/gridScope.ts`; เปิด `allowUnreachableCode:false` | R1-23(S), R1-24(S), R1-25(S), R1-37(N) | A | หลัง extract |
| **U15** filter codec | ใหม่ `app/filterCodec.ts` — column-aware, round-trip ไม่เสีย type | R1-4(C) | A | หลัง extract |
| **U16** cull batch reporting | batch error handling: แยก write ออกจาก repaint, นับให้ตรง, ไม่ flash เขียวเมื่อล้มเหลวทั้งหมด | R1-26(S), R1-28(S) | B | QA check |
| **U17** round-trip pins | **QA check ล้วน ไม่แก้ source** | R1-33(S), R1-36(S) | C | ✅ ทันที |
| **U18** trivia + copy | copy ไทย→อังกฤษ, dead instrumentation, navigator scratch canvas | R1-29(S), R1-38(N), R1-40(N), R1-42(N) | C | ⚠️ R1-29 ต้อง verify platform ก่อน |

### ลำดับ — rev.2: เรียงลงมาทีละหน่วย ไม่รุม ไม่ข้าม (owner directive ข้อ 3)

**`A0 → A1 → U1 → U2 → U3 → … → U18`**

- **ทำทีละหน่วยเดียว** จนครบลำดับ 4 commit (§2.2) + gate เขียว + Gherkin map ครบ แล้วจึงไปหน่วยถัดไป
- **ห้ามขนานเด็ดขาด** — เกือบทุกหน่วยแตะ `main.ts` จึงชน write scope กันอยู่แล้ว และ owner ระบุชัดว่า "ไม่รุม"
- **ไม่กังวลเรื่องเวลานาน** (owner: "ไม่ต้องกังวลเรื่องนานช้า ขอคุณภาพ") — หนึ่งหน่วยอาจกินหลาย session และนั่นยอมรับได้
- ตรวจแล้วว่าการเรียงตามเลข**ไม่มี dependency ขัดกัน**: U2 (errorBanner) ก่อน U4 (boot resilience ซึ่งเรียก `showError`) · U10 (letterbox math) ก่อน U11 (gestures ซึ่งใช้ math นั้น) · U5 (batch export / pipeline mutex) ก่อน U12 (Compare pipeline lifecycle)

**rev.1 เคยเสนอจัดเป็น 6 wave ตาม severity — ยกเลิกแล้ว** เพราะ owner สั่งเรียงตาม list ตรง ๆ ข้อดีของการเรียงตามเลขคือคาดเดาได้และตรวจทานง่าย; ข้อเสียที่ owner รับทราบและยอมรับคือ Critical บางตัวจะรอนาน (R1-11 GPU leak อยู่ที่ U12, R1-2 shift-click อยู่ที่ U13)

### หน่วยมูลฐาน (ต้องเสร็จก่อน U1)

| ลำดับ | หน่วย | Findings | เนื้อหา |
|---|---|---|---|
| **1** | **A0** สถาปัตยกรรม | — | เขียน ADR `docs/adr/0001-layered-architecture.md`: ชั้นทั้งสาม + กฎ import + naming ของ port/adapter + boundary rule (§1.5) + รูป composition root + ข้อความยืนยันว่าจะ**ไม่**ใช้ DI container · สร้าง `src/domain/`, `src/domain/ports/`, `src/adapters/` · **แล้วทำ U1 ต่อท้ายทันทีเป็น reference implementation** เพื่อให้ pattern เป็นโค้ดจริงก่อนถูกทำซ้ำอีก 17 ครั้ง — ห้ามให้ worker 18 ตัวประดิษฐ์ pattern เอง 18 แบบ |
| **2** | **A1** QA trusted input | — | เพิ่ม `pressKey` / `dragEl` / `typeText` ใน `scripts/qa-loop.mjs` ตาม §3.5 (ศูนย์ dependency ใหม่ — ใช้ CDP primitive ชุดเดียวกับ `clickEl`) + ใช้มันเขียน check ใหม่ 1 ตัวที่**ลาก crop overlay จริง** เพื่อพิสูจน์ว่า primitive ใช้ได้ก่อนที่ U10-U12 จะพึ่งมัน |
| **3-20** | **U1 … U18** | 42 findings | ตามตาราง U1-U18 **ด้านบน** ทีละหน่วย ไม่ข้าม |

U17 ไม่แก้ source จึงทำแทรกได้ทุกจังหวะ — แต่ owner สั่งเรียงเข้มงวด **จึงคงไว้ที่ลำดับ 17** (rev.1 เคยเสนอให้ทำคู่ U5 เพราะ R1-35 คือ check ที่ pin U5 พอดี — บันทึกไว้เผื่อ owner อยากยกเว้น)

---

## 5. การแบ่งบทบาท (thinker/worker ตามกติกาที่มีอยู่)

| Thinker (โมเดลแข็งแรงสุด) | Worker (โมเดลถูกกว่า, subagent) |
|---|---|
| จำแนก finding / Class A-B-C | เขียน test แดง → **โชว์ output ที่แดง** |
| ออกแบบ module boundary + รายการ dependency ที่จะ inject | แก้ขั้นต่ำสุดให้เขียวตาม `Fix constraint` |
| เขียน test spec จาก `Fix witness` + `Fix constraint` ของ review | รัน gate ครบสามตัว |
| review ทุก diff ด้วยตัวเองก่อน commit | mutation check (revert → แดง → restore → เขียว) |
| ตัดสินว่า finding ไหนปิดแล้ว | รายงาน verbatim |
| เขียน/อนุมัติ Gherkin scenario | **ห้ามตัดสินใจ scope เอง — ติดอะไรให้หยุดแล้วถาม** |

- **ทีละ worker, ห้ามขนานบน `main.ts`** (write scope ชนกัน) — unit ที่ disjoint ไฟล์กันจริงเท่านั้นถึงขนานได้
- worker ทุกตัวต้อง **verify anchor เองก่อนลงมือ** แล้วหยุดรายงานถ้าไม่ตรง — บทเรียนจาก `printModule.ts` รอบแรกที่สเปคเขียนจากการอ่านไฟล์ที่ได้เนื้อหาผิดมา

---

## 6. Non-goals (จงใจไม่ทำในแผนนี้)

- ❌ ไม่เพิ่ม feature ใด ๆ (feature freeze)
- ❌ ไม่เพิ่ม dependency — รวม BDD framework (owner ตัดสินแล้ว)
- ❌ ไม่แตะ `src/gpu/pipeline.ts` ทั้งก้อน, `src/catalog/*` ที่เหลือ, `src/raw/*` — **review ยังไม่ครอบ** และควรรอให้แยกออกจาก main.ts ก่อน เพราะรีวิว module เล็กถูกกว่าและ findings ลงมือได้ทันที
- ❌ ไม่แก้ Develop core (`openFile`/`loadIntoPipeline`/sliders/undo-redo ~430 บรรทัด) เป็น unit เดียว — มันพันกับ mutable state มากสุด (`lastDecoded`, `asShotWB`, `requestId`, `viewState`) ให้ค่อย ๆ ถูกดึงออกโดย U5/U6/U9/U10 แทน
- ❌ ไม่ทำ performance optimization ที่ยังไม่ได้วัด — R1-24/R1-25 ถูกจัดเป็น Suggestion ไม่ใช่ Critical **เพราะไม่มี browser run วัด hang จริง** ถ้าจะยกระดับต้องมีตัวเลขก่อน
- ❌ ไม่เปลี่ยน semantics ที่ owner ตัดสินแล้ว (Sync = absolute + intent-only, commit `a6cba69`) — review **reject** ข้อกล่าวหานี้เองว่า *"documented, tested, deliberate"*

---

## 7. สิ่งที่ต้องบอกตรง ๆ

1. **นี่เป็นงานระดับหลายสัปดาห์ ไม่ใช่ session เดียว** — 18 units, แต่ละ unit มี TDD + extraction + QA check + mutation gate เสนอให้รันเป็น **standing loop: หนึ่ง unit ต่อหนึ่งรอบทำงาน จบเขียวและ commit ทุกครั้ง**
2. **4 จาก 20 Critical ยังไม่ได้ยืนยันด้วยการรัน** — report ระบุเองว่า "not run": R1-2, R1-19, R1-16, R1-15 พึ่ง static analysis จากโค้ดที่ quote มา **ต้อง verify ด้วยการรันก่อนแก้** (เป็นงานแรกของ unit นั้น ไม่ใช่การตั้งสมมติฐาน)
3. **owner spot-check แล้ว 3 ข้อและตรงทุกข้อ** — R1-1 (`lightleak.ts:26`/`:43` ยัน vocabulary 0..3 ขณะที่ `editsStore.ts:113` bound แค่ -1..1), R1-10 (`gpuExclusive` เจอ 1 ที่ทั้ง repo และเป็นคอมเมนต์), R1-3 (`innerHTML =` มี 2 จุดพอดี) — ที่เหลือ relay ตาม report
4. **verdict ของ review โดน cap เป็น `Comment` ด้วยเหตุผลเชิงขั้นตอน** ไม่ใช่เพราะ findings อ่อน: plan ไม่มี `chunks[]` (ไฟล์ไม่มี diff) → coverage gate ไม่มี range ให้ intersect และ `agent-prompt --role verify` ต้องการ plan ที่มี chunks → verifier ทั้ง 3 ถูก brief ด้วยมือจึงไม่มี recorded prompt ให้ gate match. report ระบุ: *"The 20 Criticals below are verified findings with executed witnesses; only the machine-certification of that fact is missing."*
5. **`emit-workflow` ปฏิเสธ plan นี้** (`agent-prompt: the plan has no chunks[]`) → fan-out ถูก dispatch ด้วยมือ: 7 territory agents ตามช่วงบรรทัดต่อเนื่อง (1-560, 561-1105, 1106-1960, 1961-3120, 3121-4260, 4261-5310, 5311-6625) + 3 whole-file lenses (cross-module tracer, test coverage, build & test) = 10 finders ตรง roster ของ medium สำหรับ file target
6. **ช่องที่ review ปิดไม่ได้** (ต้อง not take เป็นข้อสรุป): พฤติกรรมจริงของ `FileSystemFileHandle.remove()` (trash หรือ unlink — ทำให้ R1-29 confidence low และความรุนแรงขึ้นอยู่กับคำตอบนี้), GC-reclaimability ของ GPUDevice (R1-11), `catch` block 46 จาก 58 แห่งใน main.ts ที่ยังไม่ได้อ่านรายตัว, `qa-loop.mjs` ช่วง 1115-1660 กับ 1840-2095 ที่ยังไม่ได้อ่านเต็ม, perf threshold ที่ยังไม่เคยวัด

---

## 8. คำถามที่ต้องได้คำตอบก่อนเริ่ม — ข้อ 1-4 ปิดแล้ว · **เหลือข้อ 5 และ 6** (2026-09-27)

1. ✅ **ตัดสินแล้ว (owner, 2026-09-27):** เรียงเข้มงวดตามลำดับ `A0 → A1 → U1 → … → U18` ทีละหน่วย ไม่รุม ไม่ข้าม ไม่ต้องกังวลเรื่องเวลานาน (§4) คำถามเดิมของ rev.1 ("approve ลำดับคลื่น / จับ U17 คู่ U5") เป็น**โมฆะ** เพราะ wave ถูกยกเลิกแล้ว · **ที่เหลือคือรอ owner อ่านแผน rev.2 แล้วสั่งเริ่ม A0**
2. ✅ **ตัดสินแล้ว (owner, 2026-09-27) — R1-8 แก้ที่ GPU contract:** `Pipeline.setDodgeMask` คืน boolean, `syncDodgeMaskToGPU` ตรวจ dims กับ `maskDims(canvas.width, canvas.height)` ก่อน upload, และ clear `dodgeMaskDirty` เฉพาะเมื่อ upload สำเร็จ — `syncableOps` **ไม่ต้องแตะ** เหตุผลที่เลือกชั้นนี้: กันได้**ทุก**เส้นทางที่ส่ง mask dims ไม่ตรง ไม่ใช่แค่ Sync (รวม preset apply และ backup restore) การที่ `dodgeBurn` ผ่าน intent filter นั้นถูกต้องแล้ว (op มีเฉพาะตอน painted จริง); trigger ที่เห็นคือ Sync portrait→landscape แต่รากคือการขาด dim contract ที่ GPU boundary
3. ✅ **ตัดสินแล้ว (thinker, 2026-09-27; owner ไม่คัดค้าน) — `allowUnreachableCode: false` เปิดใน commit ของ U14 เอง** ไม่เปิดก่อน เพราะเปิดปุ๊บ `npm run build` จะแดงที่ `main.ts:2013` ทันทีจนกว่าจะลบ dead block 28 บรรทัดที่ R1-23 พบ การเปิดมันจึงเป็นส่วนหนึ่งของงาน U14 ไม่ใช่งานแยก
4. ✅ **ทำแล้ว (2026-09-27):** รายงาน 949 บรรทัด + cost ledger ถูก copy เข้า `docs/reviews/` แล้ว จึง tracked และอ้างจากแผนนี้ได้
5. ⚠️ **ยังไม่ได้คำตอบ — คำถาม scope ที่ใหญ่ที่สุดของ rev.2:** ต้องย้าย `src/catalog/*` (22 ไฟล์ 4,037 บรรทัด) กับ `src/gpu/*` (17 ไฟล์ 4,122 บรรทัด) เข้า `src/domain/` / `src/adapters/` ด้วยไหม
   - **ทางที่ thinker แนะนำ: ไม่ย้าย** — ประกาศใน ADR ให้ `src/catalog/` = *legacy domain* และ `src/gpu/` = *legacy adapters* โดย convention, โค้ดใหม่ที่แยกออกจาก main.ts เข้า `src/domain/` + `src/adapters/`, และไฟล์เก่าจะถูกย้าย**เฉพาะเมื่อมีหน่วยไหนไปแตะมัน**
   - เหตุผล: การย้ายสองชั้นนั้น = import path เปลี่ยนใน 47 test files + งานอีกราว 8,000 บรรทัดที่**ไม่ได้ปิด finding สักข้อ** และเพิ่มโอกาสทำ behavior เปลี่ยนโดยไม่ได้แก้บั๊ก
   - ข้อเสียที่ต้องยอมรับและเขียนลงใน ADR: ระหว่างทางจะมีบ้านสองหลังของ domain code (`catalog/` กับ `domain/`) ต้องระบุให้ชัดว่าอะไรใหม่ไปอยู่ไหน
6. ⚠️ **ยังไม่ได้คำตอบ — `src/app/` ปัจจุบันปนสองชั้น:** มีทั้ง pure logic (`filters.ts`, `stacks.ts`, `survey.ts`, `navigator.ts`, `viewState.ts`) และ DOM adapter (`filmstrip.ts`, `secondMonitor.ts`, `printModule.ts`) ภายใต้กฎ §1.5 กลุ่มแรกควรเป็น `domain/` และกลุ่มหลังควรเป็น `adapters/` — ใช้กฎ "ย้ายเมื่อถูกแตะ" เหมือนข้อ 5 หรือไม่ (thinker แนะนำ: ใช่)

---

## ภาคผนวก ก — Findings register (self-contained)

C = Critical, S = Suggestion, N = Nice-to-have · conf h = high, l = low
"witness" = ✅ รันจริง (vitest/node probe/grep exhaustive) · 📖 static analysis จากโค้ดที่ quote

### Critical (20)

| ID | ตำแหน่ง | สรุป | conf | witness | Unit |
|---|---|---|---|---|---|
| R1-1 | `catalog/editsStore.ts:113` | `isValidOp` bound lightleak pattern แค่ -1..1 ทั้งที่ vocabulary คือ -1..3 → Set C/D ทำให้ `isValidEditRow` fail ทั้ง row → `loadEditState` คืน state ว่าง = **edit หายถาวรเงียบ ๆ** + หลุด Edited filter | h | ✅ | U1 |
| R1-2 | `main.ts:2075` | `orderedVisibleIds` กรอง 2 จาก 9 scope terms → shift-click กวาดทั้ง catalog; "4712 selected" ที่มองไม่เห็น → กด Delete from disk = **trash ไฟล์ที่ไม่ได้เลือก** | h | 📖 | U13 |
| R1-3 | `main.ts:2885`, `4524` | **XSS 2 ใน 2 จุดที่ assign `innerHTML`**: `smart.name` (restore ตรงจาก backup โดยไม่ sanitize) และ `file.name`+EXIF make/model → รันใน origin ที่มี IDB + `FileSystemFileHandle` grant `readwrite` | h | ✅ | U3 |
| R1-4 | `main.ts:1699` | `decodeFilterValue` เดา type ด้วย `/^\d+$/` ทุกคอลัมน์ → keyword "2024" กลายเป็น number → `numberMatches` default คืน false → **grid ว่างทั้งที่ chip สว่าง** | h | ✅ | U15 |
| R1-5 | `main.ts:4119` | batch export ตั้งชื่อจาก basename ไม่มี uniquifier + `createWritable()` truncate → **RAW+JPEG คู่กันเขียนทับ ไฟล์แรกกู้ไม่ได้** แต่รายงาน "Completed 4/4" | h | ✅ | U5 |
| R1-6 | `main.ts:1047` | point-curve bump ระหว่าง anchor 4 ตัว มองไม่เห็นต่อ `fitRegionParams` (sample แค่ x=0.88/0.60/0.40/0.12) → Point→Region fit ได้ `{0,0,0,0}` → **edit หายและ persist เป็น history row ใหม่** | h | ✅ | U9 |
| R1-7 | `main.ts:730` | `clampCurveX` แยกจุดที่ x=1 ไม่ได้ → x ซ้ำ → LUT dedupe ทิ้งหนึ่งจุด → **white endpoint หลุดจาก (1,1) highlight เปลี่ยนทั้งแถบ และลากแยกไม่ได้อีก** | h | ✅ | U9 |
| R1-8 | `main.ts:976` | `syncDodgeMaskToGPU` ไม่ reconcile dims; guard แค่ `bytes.length !== w*h` → **dims กลับด้านผลคูณเท่ากัน = เขียนลง texture transposed เส้น brush ลายและถูก bake ลง export**; ถ้าผลคูณไม่เท่าก็ drop เงียบแต่ clear dirty flag | h | ✅ | U8 |
| R1-9 | `main.ts:4105` | batch export ไม่เขียน `loadedFileId` → restore short-circuit → **loupe แสดงรูปสุดท้ายของ batch ภายใต้ slider รูปปัจจุบัน และ Export ครั้งถัดไปเขียนพิกเซลนั้นลงชื่อไฟล์ผิด**; selection ยุบ; dodge/burn หายทุกไฟล์; grain seed ใช้ของรูปปัจจุบันทั้ง batch | h | ✅ | U5 |
| R1-10 | `main.ts:2416` | `gpuExclusive` mutex ที่คอมเมนต์สัญญา **ไม่มีอยู่จริง** (เจอ 1 ที่ทั้ง repo = คอมเมนต์) → batch export กับ thumbnail drain แย่ง pipeline → **thumbnail ถูกเขียนใต้ id+digest ผิด แล้ว digest match ทำให้รับรองของผิดว่า fresh ไม่หายเอง** | h | ✅ | U5 |
| R1-11 | `main.ts:4921` | Compare สร้าง `Pipeline` ต่อรูปใน local const ที่ไม่หลุด scope → **destroy() ไม่ได้ ever**; ถูกเรียกจาก `refreshCullDependents` (ทุก cull write) → เข้า-ออก 5 รอบ × 4 รูป = **20 GPUDevices ~1.7GB/pipeline** → Chrome evict context ของ loupe | h | ✅ | U12 |
| R1-12 | `main.ts:4266` | wheel/dblclick/middle-pan ส่งพิกัด **box** เข้า `imagePointUnderCursor` ที่ต้องการพิกัด **image** ไม่แก้ letterbox → **zoom anchor เพี้ยนถึง 116.7px, pan แกน x ช้า 2.571 เท่า** (math ที่ถูกมีอยู่แล้วในไฟล์เดียวกัน) | h | ✅ | U10 |
| R1-13 | `main.ts:1478` | device-loss recovery เป็น **no-op แน่นอน** สองทางปิดกันเอง: ไม่ clear `loadedFileId` (short-circuit ที่ 3279) + ส่ง `Date.now()` เป็น requestId ทั้งที่ทุก check เทียบ `openRequestId` → **loupe ดำ แล้วบอกว่า "Recovered"** | h | ✅ | U6 |
| R1-14 | `main.ts:1495` | dismissal เรียก `errorEl.remove()` ลบ `#error` ทั้งโหนด แต่ `#error-message`/`#error-detail` เป็นลูกและคือ binding ที่ `showError` เขียน → **หลัง recovery หนึ่งครั้ง `showError` ทั้ง 51 จุด render ไม่ติดตลอด session** | h | ✅ | U2 |
| R1-15 | `main.ts:6580` | **keydown dispatcher ตัวที่สองระดับ document อ้อม `keyToAction()`** จึงอ้อม `isEditable()`; ไม่ตรวจ target/module/dialog/repeat → **พิมพ์ "fujifilm" ในช่อง Search = 'f' แรกสลับเข้า fullscreen 'f' ถัดไปสลับออก** | h | 📖 | U7 |
| R1-16 | `main.ts:5578` | guard "modal เปิดอยู่" ตรวจแค่ `removeDialog.open` ไม่ตรวจ `syncDialog`/`smartDialog` → ระหว่าง Sync batch รัน **กด x = reject ทั้ง selection เบื้องหลัง dialog; กด Delete = stack modal แล้วลบจากดิสก์ได้; กด g/e = สลับ module ทิ้ง dialog ค้าง** | h | 📖 | U7 |
| R1-17 | `main.ts:1968` | search เขียน inline ไม่ผ่าน engine ที่มี test: ไม่ค้น keyword และ `FilterState.text` **ไม่เคยถูก assign** (`textMatches` = dead code); folder click ไม่ reset `searchQuery` → **query ค้างทับทุกการคลิก**; `.active`+badge ไม่ repaint | h | ✅ | U13 |
| R1-18 | `main.ts:5207` | Contact sheet "previous" decrement index แล้ว**ไม่ทำอะไรเลย** (ขาด `renderContactSheet()`; `contactNext` 3 บรรทัดถัดไปมี) → sheet 1 เข้าไม่ถึง, label ค้าง, **export ตั้งชื่อไฟล์ตาม index ใหม่แต่ rasterize DOM เก่า** | h | ✅ | U12 |
| R1-19 | `main.ts:4898` | Compare render ลง canvas **800×600 hard-code** ไม่เรียก `setCanvasRect`; `blit.wgsl` ไม่มี aspect term/letterbox/min() fit → **ทุกภาพยืดเป็น 4:3 ใน view ที่หน้าที่คือตัดสิน framing** | h | 📖 | U12 |
| R1-20 | `main.ts:4316` | middle-pan เป็น **drag เดียวใน 5 ตัวที่ไม่มี `pointercancel`** และใช้ `setPointerCapture` โดยไม่มี `lostpointercapture` → หลัง notification แยง `panStart` ค้างตลอด = **เลื่อนเมาส์เปล่า ๆ ก็ลากรูปและ render ทุก mousemove** | h | ✅ | U11 |

### Suggestion (16)

| ID | ตำแหน่ง | สรุป | conf | witness | Unit |
|---|---|---|---|---|---|
| R1-21 | `main.ts:902` (+3639, +3663) | `dispScale` เป็น width-only ratio ซ้ำ **byte-identical 3 ที่** ทั้งที่ `eventToBufferPt:947` คำนวณถูกแล้ว → crop frame + thirds grid เป็น sub-pixel **มองไม่เห็นบนภาพ portrait ทุกรูป** (hit test ตรงกับ drawing จึงไม่ใช่ ungrabbable) | h | ✅ | U10 |
| R1-22 | `main.ts:1303` | `opsToLabel` map lightleak pattern แค่ 0/1 → Set C/D ตกไปอยู่ arm เดียวกับ Auto → **สอง edit ที่ต่างกันแยกไม่ออกใน History/preset**; `types.ts:127` comment ก็รู้แค่ 2 ค่า; R1-1 ไม่ครอบข้อนี้ | h | 📖 | U1 |
| R1-23 | `main.ts:2013` | **dead code 28 บรรทัด** (2013-2040) เข้าไม่ถึงเพราะสอง arm ด้านบน return หมด; tsc ไม่ flag เพราะไม่มี `allowUnreachableCode:false`; block ที่ตายมี `tallyScope`/`stackVisibleFiles` ordering **ต่างจาก** branch ที่มีชีวิต | h | ✅ | U14 |
| R1-24 | `main.ts:1999` | default folder branch รัน **สอง full filter pass ต่อโฟลเดอร์**; `rebuildGrid` ถูกเรียกทุก cull write → catalog 100k/1000 โฟลเดอร์ = ~200M predicate ต่อ keypress (มาตรฐาน scale ของโปรเจกต์เอง pin ไว้ที่ `filters.test.ts:447-476`) | h | 📖 | U14 |
| R1-25 | `main.ts:2249` | badge pass เป็น `s.fileIds.find(id => files.some(...))` = O(members × files) แล้วตามด้วย `stackCountFor` ที่ **พิสูจน์ได้ว่า redundant** (invariant "a photo lives in AT MOST ONE stack" ที่ `stacks.ts:130-133`) | h | 📖 | U14 |
| R1-26 | `main.ts:5686` | cull batch try ครอบทั้ง loop + `refreshCullDependents` → ถ้า ID abort กลางคัน UI ไม่ repaint; ใน Survey ไม่มี virtualizer onChange ช่วย → **mark ที่ commit แล้วมองไม่เห็น**; catch รายงานไม่มี count ไม่มี ids | h | 📖 | U16 |
| R1-27 | `main.ts:6593` | 4 step ที่ paint UI ตอนท้าย `init()` เป็น **bare await** + `init();` เปล่า และ**ไม่มี global error/rejection handler ทั้ง repo** → boot ตายเงียบ เห็น grid ว่าง + sidebar ว่าง แยกไม่ออกกับ catalog ว่าง (backup validate แค่ envelope ไม่ validate row shape) | h | ✅ | U4 |
| R1-28 | `main.ts:5449` | delete-from-disk ที่ล้มเหลวทั้งหมดก็ยัง **flash เขียว "✓ 0 files moved to the system trash"** ข้าง banner แดง และสองครึ่งของประโยคนับคนละอย่าง (`report.deleted` vs `deletedIds.length`) + clear selection ทำให้ retry ไม่ได้ | h | 📖 | U16 |
| R1-29 | `catalog/remove.ts:52` | คำสัญญา "moved to the system trash (recoverable)" เป็น **tested contract** (`remove.test.ts:46-50` assert คำว่า 'trash') ใน 6 ที่ แต่ `lib.dom.d.ts:14752-14766` ประกาศ `FileSystemFileHandle` มีแค่ `createWritable()`/`getFile()` — **ไม่มี `remove()`** = non-standard; ถ้า Chrome unlink ถาวรคือ test suite รับรองคำโกหก | **l** | 📖 | U18 |
| R1-30 | `main.ts:4326` (+4571) | handler 'z' กับ '\' ไม่มี `isEditable` guard และ `preventDefault()` → ผ่าน dialog path ได้; Shift+Z ยิง zoom (ที่เดียวในไฟล์ที่ capital letter ไม่มี modifier แล้ว trigger command); 'z' ไม่ตรวจ `e.repeat` ทั้งที่ sibling ตรวจ | h | ✅ | U7 |
| R1-31 | `main.ts:1971` (+`smartCollections.ts:103,107`) | `(f as any).cameraModel` ทั้งที่ `types.ts:34-40` ประกาศ field และ comment ระบุเองว่า main.ts search เป็น reader → **rename field แล้ว tsc เขียวแต่ search ตายเงียบ**; `filters.ts:47-49` comment "stores no IPTC yet" ก็ stale แล้ว | h | 📖 | U13 |
| R1-32 | `main.ts:5528` | `pasteSettingsFromClipboard` ตรวจแค่ `Array.isArray` แล้ว `JSON.parse(text) as Op[]` → **เขียน unvalidated ops ลง IDB ทุก target** → reload แล้ว `isValidEditRow` fail ทั้ง row = history หายเงียบ ๆ (failure mode เดียวกับ R1-1 คนละ boundary) | **l** | 📖 | U1 |
| R1-33 | `main.ts:1103` | `applyOpsToSliders`/`currentOpsFromSliders` **ไม่มี test เลยสักตัว** และ QA ไม่มี check undo/redo/history/preset → emit list กับ restore list เป็นสอง enumeration ที่ maintain แยกกันโดยไม่มีอะไร pin ว่าตรงกัน (เพิ่ม op kind ที่ 15 แล้วลืม restore = หายเงียบ 790 tests ยังเขียว) | **l** | 📖 | U17 |
| R1-34 | `main.ts:942` (+988) | letterbox inverse-map ซ้ำ 2 ที่ (`eventToBufferPt`/`eventToMaskPt`) ต่าง compute contain scale เอง ทั้งที่ `containBox` export ไว้และมี test 3 เคส pin; สองสำเนา diverge แล้ว (margin param vs hardcode 0) → **ต้นตอของสำเนาที่สามใน R1-21** | **l** | 📖 | U10 |
| R1-35 | `main.ts:4049` | **batch export loop ไม่มี coverage เลย** — check 'export:' export ไฟล์เดียว และ `#batch-export-row` gate ที่ `selectedIds.length > 1` จึงไม่เคยโผล่; นี่คือเหตุผลที่ R1-5/R1-9 ship; `allFiles.find(...)!` ไม่ earned, per-file fail เป็น console-only, ไม่เรียก `ensureReadPermission` | **l** | 📖 | U5 |
| R1-36 | `main.ts:2387` | QA check ชื่อ `'restore: ... click re-renders'` **ไม่ตรวจ re-render** — assert แค่ banner hidden กับ `reqLog` มี 'grant'; อ่าน `#footer-counts` ใส่ตัวแปรแต่ไม่ throw; `probeThumbs` มีอยู่แล้วที่ `:1040` | **l** | 📖 | U17 |

### Nice to have (6)

| ID | ตำแหน่ง | สรุป | conf | Unit |
|---|---|---|---|---|
| R1-37 | `main.ts:2264` | `counts[6]` ถูก fill จาก scope แล้ว**ไม่เคยถูกอ่าน** (chip ใช้ `scopeRating`/`scopeTotal`) — เดิน 100k records สองครั้งต่อ keypress แล้วทิ้งหนึ่งผล และเป็นกับดักเพราะ `counts` เป็น post-cull ขณะที่ `scopeRating` จงใจเป็น pre-cull | h | U14 |
| R1-38 | `main.ts:3982` | `perfMarks.decodeStart/decodeEnd` **ไม่เคยถูก assign** แต่ `logPerformance()` ลบมัน → Ctrl+Shift+P รายงาน "decode: 0.0ms" = **เครื่องมือวัดโกหกในทิศที่ทำให้สืบผิดทาง** | h | U18 |
| R1-39 | `main.ts:4887` | branch `grid-1x4` เข้าไม่ถึง (`count = Math.min(selectedIds.length, 4)`) → บังข้อเท็จจริงว่า selection เกิน 4 ถูก drop เงียบ ๆ | h | U12 |
| R1-40 | `main.ts:4408` | `fillStyle='#000'`+`fillRect` แล้วตามด้วย `clearRect` rect เดิมทันที — letterband ดำเพราะ CSS `background:#000` โชว์ผ่าน ไม่ใช่เพราะ fill; และ scratch canvas+context ถูกสร้างใหม่ทุก repaint ใน `do…while` loop | h | U18 |
| R1-41 | `main.ts:374` | `showError` ไม่เคยแตะ `<details>` wrapper → **7 call site ที่ไม่ส่ง detail แสดง "See detail" ที่ขยายมาเป็นกล่องว่าง** และ state open ค้างข้าม error | h | U2 |
| R1-42 | `main.ts:3781` | string ภาษาไทยหนึ่งเดียวที่ user-visible ในไฟล์ที่ copy อื่นเป็นอังกฤษหมด — ตรงกรณี popup blocker ซึ่งเป็นเคสที่ข้อความคือเบาะแสเดียว | **l** | U18 |

### ข้อที่ review **reject** (บันทึกไว้กันทำซ้ำ)

| ข้อกล่าวหา | เหตุที่ reject |
|---|---|
| `opsToLabel` index `FILM_STOCKS`/`BW_TONES` ด้วย id ที่ไม่ validate | `isValidOp` validate ทั้งคู่ (`editsStore.ts:59-62` ผ่าน `isFilmStockId` ที่ derive จาก `Object.keys(FILM_STOCKS)` จึง drift ไม่ได้; `:96-102` สำหรับ BW tones) และทุก route ผ่านมันรวมถึง `parsePreset` — residual คือ BW list maintain แยกจาก `bw.ts` (N) |
| batch export ข้าม display-orientation correction | orientation ถูก apply ใน `Pipeline.load`'s normalize pass (`pipeline.ts:293`) ไม่ใช่โดย main.ts และ `exportImage` อ่าน texture ที่ flip แล้ว (`pipeline.ts:271-278` document ไว้) |
| device-loss recovery ทำ dodge mask หาย และ `currentEditState!` throw | `pipeline.load()` เข้าไม่ถึงบน path นั้น (abort ที่ `main.ts:3291`); `currentFileId`/`currentEditState` ถูก assign ติดกันที่ 3148-3149 ไม่มี await คั่นและไม่เคยถูก set null — ทั้งคู่ถูก subsume โดย R1-13 |
| Sync Settings ไม่ copy control ที่ source clear เป็น neutral | เป็น **documented, tested, deliberate** contract ของ commit `a6cba69` — `syncOps.ts:4-6`/`:52-54` ระบุ, `index.html:2762`/`2773` บอกผู้ใช้, 6 เคสใน `syncOps.test.ts` pin ไว้; ข้ออ้าง "✓ synced ขัดกัน" ก็ถูกโต้ — message นับ**รูป**ไม่ใช control (`main.ts:5918`) |
| `main.ts:4813` เรียก `getContext('2d')!` บน `#canvas` ที่ `pipeline.ts:222` ถือเป็น `'webgpu'` | `canvas` ที่ 4813 คือ block-local `document.createElement('canvas')` ที่ประกาศที่ 4810 ใน `exportContactSheet` เป็น element ใหม่ที่ไม่เคยมี webgpu context → `!` sound; การ shadow module-level `canvas` ด้วย local สองตัว (4810, 4898) เป็น readability hazard ควร rename เท่านั้น |
