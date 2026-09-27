# ADR 0001 — สถาปัตยกรรมแบบแบ่งชั้นพร้อม Dependency Inversion

**สถานะ:** 🟢 **Accepted — owner approve 2026-09-27** (§8 ปิดครบทั้งสี่ข้อ)
**ผู้ตัดสินใจ:** owner ( directive 4 ข้อ, 2026-09-27)
**เกี่ยวโยง:** `docs/superpowers/plans/2026-09-27-main-ts-hardening-plan.md` (rev.2 §1.5, §4) · `docs/reviews/2026-09-27-main-ts-review.md`
**แทนที่:** บางส่วนของ `CLAUDE.md` (ดู §9)

---

## 1. Context

### 1.1 ปัญหาที่เป็นต้นเรื่อง

`src/main.ts` คือ closure `init()` ก้อนเดียวยาว 6,625 บรรทัด มีฟังก์ชันข้างใน ~117 ตัวแชร์ mutable state ร่วมกัน (`allFiles`, `currentFileId`, `loadedFileId`, `pipeline`, `lastDecoded`, `asShotWB`, `viewState`, `openRequestId`, `filterState`, `folderFilter`, …)

ผลที่วัดได้แล้ว ไม่ใช่การคาดเดา:

- **import เข้า vitest ไม่ได้** — top-level `document.querySelector(...)!` ทำงานทันทีที่ import (main.ts:239-252 และช่วง 100-400) จึงไม่มี environment ใดโหลดมันได้นอกจาก browser
- **`src/main.test.ts` ไม่มีอยู่** — main.ts ถูกครอบแค่โดย typechecker กับ bundler ขณะที่ชั้นเพื่อนบ้านมี test ครบ: `app/` 10 ไฟล์, `catalog/` 17, `gpu/` 16, `raw/` 4 (รวม 47 test files, 790 tests)
- **Critical ทั้ง 20 ตัวจาก review อยู่ที่ไฟล์นี้** — review ระบุเองใน R1-2 ว่า *"closes over module-level allFiles/folderFilter inside main.ts, which … cannot load under vitest's node environment"* จึงต้องตัดสินหลายข้อด้วย static analysis แทนการรันจริง
- **R1-33 คือรอยรั่วเชิงโครงสร้าง:** `currentOpsFromSliders` (emit list) กับ `applyOpsToSliders` (restore list) เป็นสอง enumeration ที่ maintain ด้วยมือแยกกันโดยไม่มีอะไร pin ว่าตรงกัน — เพิ่ม op kind ที่ 15 แล้วลืม restore = edit หายเงียบโดย 790 tests ยังเขียว

### 1.2 สิ่งที่ owner สั่ง (2026-09-27)

1. Dependency Injection + Dependency Inversion เพื่อ "ป้องกันชั้นใน"
2. `main.ts` (หรือสิ่งที่แยกออกมา) เป็นได้แค่ **orchestration** — เรียก business logic ของแต่ละเรื่อง ไม่มี tech logic; ideal คือเหลือแค่ app props กับ wiring
3. ทำเรียงลงมา step by step, module by module, ไม่รุม ไม่ข้าม — **ไม่ต้องกังวลเรื่องนานช้า ขอคุณภาพ**
4. QA ต้องดูเบราว์เซอร์จริง กดจริง ไม่ใช่ดู code/response → ตอบแล้วในแผน rev.2 §3.5 และหน่วย A1
5. (§8.5) **ย้ายของเดิมให้หมดทุกชั้น** — ไม่คง `catalog/`/`gpu/` ไว้เป็น legacy

### 1.3 Inventory ที่ต้องจัด (วัดจริง 2026-09-27)

| ชั้นปัจจุบัน | ไฟล์ | บรรทัด | test files | ลักษณะ |
|---|---|---|---|---|
| `src/main.ts` | 1 | 6,625 | **0** | monolith — ปิดด้วยหน่วย U1-U18 ของแผน hardening |
| `src/catalog/` | 22 | 4,037 | 17 | domain rules ปน IDB/FS access ในไฟล์เดียวเป็นส่วนใหญ่ |
| `src/gpu/` | 17 (+19 `.wgsl`) | 4,122 | 16 | **pure math ปน device code** — ไม่ใช่ adapter ล้วน |
| `src/app/` | 13 | 1,717 | 10 | pure logic ปน DOM factory |
| `src/raw/` | 5 | 705 | 4 | adapter ล้วน (LibRaw WASM / decode) |
| **รวม** | **58** | **17,206** | **47** | |

---

## 2. Decision

### 2.1 โครงสร้างปลายทาง

```
src/
  domain/              ← business rules + ports; ห้ามพึ่งชั้นนอกใด ๆ
    types.ts           ← FileRecord, Op, ProfileKind, EditState (vocabulary ของ product)
    ports/             ← interface ที่ domain เป็นเจ้าของ
    <area>/            ← rules ล้วน: filters, stacks, survey, curveModel, syncOps, …
  app/                 ← use-cases = orchestration; import ได้แค่ domain/
  adapters/            ← implement ports ของ domain
    dom/  idb/  gpu/  fs/  raw/
  bootstrap.ts         ← composition root: สร้าง adapters, inject, wire
  main.ts              ← entry บาง ๆ (vite entry ที่ index.html:2863 ชี้)
  architecture.test.ts ← กฎชั้นแบบ executable (§5)
```

### 2.2 กฎเหล็ก — dependency ชี้เข้าในเท่านั้น

| ชั้น | import ได้ | ห้าม |
|---|---|---|
| `domain/` | `domain/` เท่านั้น | `app/`, `adapters/`, `bootstrap`, `main` · และห้ามปรากฏ identifier `document` `window` `indexedDB` `navigator` `GPUDevice` `requestAdapter` `fetch` |
| `app/` | `domain/` | `adapters/`, `bootstrap`, `main`, DOM/GPU/IDB API ตรง ๆ |
| `adapters/` | `domain/` (เพื่อ implement port), เทคโนโลยีของตัวเอง | `app/` (adapter ต้องไม่รู้ว่า use-case คืออะไร) |
| `bootstrap.ts` | ทุกชั้น | — (เป็นที่เดียวที่รู้ทั้งหมด) |

**นี่คือ Dependency Inversion ที่แท้จริง:** port ถูกประกาศโดยชั้นใน (`domain/ports/editStore.ts`) และชั้นนอกเป็นผู้ปฏิบัติ (`adapters/idb/idbEditStore.ts`) — ไม่ใช่ชั้นนอกรับ interface จากชั้นใน

### 2.3 Injection แบบ plain — ห้ามใช้ DI container

คง **zero npm runtime dependency** (ปัจจุบันมี `libraw-wasm` ตัวเดียวและชี้ไป `./vendor/` ผ่าน git submodule) ใช้ constructor/factory injection กับ TypeScript interface ตาม pattern ที่มีอยู่แล้วและพิสูจน์แล้ว: `createFilmstrip(opts)`, `createPrintModule(opts)`, `openControlsWindow(options)`

เหตุผลที่ไม่เอา tsyringe / inversify / awilix:
- เป็น npm runtime dependency ตัวแรกของ repo
- ขัด spirit ของ `CLAUDE.md`: *"WebGPU API directly, no wrapper"*
- decorator-based DI ต้องการ experimental flag ใน tsconfig ซึ่งตอนนี้ตั้ง `strict` + `noUnusedLocals` + `noUnusedParameters` (และจะเพิ่ม `allowUnreachableCode: false` ใน U14)

### 2.4 Naming convention (บังคับ — เพื่อไม่ให้ 18 หน่วยประดิษฐ์ 18 แบบ)

| สิ่งที่สร้าง | ที่อยู่ | ชื่อ | ตัวอย่าง |
|---|---|---|---|
| port | `src/domain/ports/<name>.ts` | `interface <Name>` | `interface EditStore` |
| adapter | `src/adapters/<tech>/<tech><Name>.ts` | `class <Tech><Name> implements <Name>` หรือ `create<Name>(deps)` | `class IdbEditStore implements EditStore` |
| use-case | `src/app/<verb><Noun>.ts` | `export async function <verb><Noun>(deps)` | `syncSettings(deps)` |
| fake สำหรับ test | ในไฟล์ test | `InMemory<Name>` / `Fake<Name>` | `InMemoryEditStore` |
| domain rule | `src/domain/<area>/<noun>.ts` | pure exported function | `syncableOps(ops, defaultProfile)` |

**กฎ deps object:** use-case รับ deps เป็น object เดียว (`deps: { store: EditStore; clock: () => number; …}`) ไม่รับ positional args เกิน 3 ตัว — เพื่อให้ fake ใน test สร้างง่ายและเพิ่ม port ได้โดยไม่พัง call site

### 2.5 Boundary rule — อะไร **ไม่** ต้องเป็น port

DIP กับทุกก้อน = over-abstraction ที่แพงและอ่านยาก กฎตัดสิน:

| ถ้าก้อนนั้นมี… | อยู่ชั้น | ทดสอบด้วย |
|---|---|---|
| decision / calculation / state transition | `domain/` | unit test + fake adapter (ไม่มี browser) |
| ลำดับการเรียกหลาย domain (workflow) | `app/` | unit test + fake adapter |
| แค่แตะ pixel / attribute / layout / event binding | `adapters/dom/` | QA check ในเบราว์เซอร์จริง |

ตัวอย่างที่ตัดสินแล้ว: *"op ไหนควร sync"* = domain (`syncableOps` อยู่ถูกที่และมี test แล้ว) · *"วาด badge ที่พิกัดไหน"* = adapter และ**ห้าม**ทำ interface ให้มัน

### 2.6 `main.ts` end-state

- `src/bootstrap.ts` = composition root ตัวจริง: อ่าน app props (DOM refs, config), สร้าง adapters, inject เข้า use-cases, ลงทะเบียน wiring (event → use-case)
- `src/main.ts` = `import { boot } from './bootstrap'; void boot();` + top-level DOM refs เท่าที่ bootstrap ต้องใช้
  — ยังชื่อ `main.ts` เพราะเป็น vite entry จริง (`index.html:2863` ยืนยันโดย Agent 7 ของ review) จึง**ไม่ต้องแก้ `index.html`**
- **Definition of Done ของทั้งโปรแกรม:** `main.ts` + `bootstrap.ts` รวมกันไม่มี `if` ที่เป็น business rule, ไม่มี loop ที่คำนวณ, ไม่มี math — มีแค่การสร้าง object กับการต่อสาย

### 2.7 ทำไม composition root ถึง import ทุกชั้นได้ (คำถามที่ต้องถูกถามแน่)

§2.2 เขียนว่า `bootstrap.ts` import ทุกชั้นได้ — ดูขัดกับกฎที่เพิ่งตั้ง จึงต้องให้เหตุผลไว้ตรงนี้

**เพราะ coupling วัดที่ "ใครพังแล้วใครพังตาม" ไม่ใช่ "ใคร import ใคร"**

```
domain/  ◄──  app/  ◄──  adapters/
                    ◄──  bootstrap.ts  ◄──  main.ts
```

`bootstrap.ts` เป็น **leaf ของกราฟ ไม่ใช่ hub** — นอกจาก `main.ts` บรรทัดเดียวแล้วไม่มีใคร import มันเลย นี่คือเส้นแบ่งระหว่าง composition root กับ god object:

| | god object (แย่) | composition root (ดี) |
|---|---|---|
| ใครพึ่งมัน | ทุกคน | **ไม่มีใคร** (entry 1 บรรทัด) |
| มันพัง = | พังทั้งระบบ | ประกอบใหม่ไม่ได้ แต่ logic ทุกชิ้นยัง test ได้ตามปกติ |
| มันรู้ | พฤติกรรม + business rule | **แค่ชื่อ class กับ constructor args** |
| เปลี่ยนมัน = | กระทบทุก caller | กระทบศูนย์ |

มันรู้ว่า "implementation ของ `EditStore` คือ `IdbEditStore`" ซึ่งเป็น**ความรู้เรื่องการประกอบ** ไม่ใช่ความรู้ว่า "sync ต้องข้ามค่าที่ผู้ใช้ไม่ได้แตะ" — ความรู้อยู่หลังยังอยู่ที่ `domain/sync/` พร้อม test ของตัวเอง

**ทางเลือกอื่นแย่กว่าทั้งหมด:** ถ้า bootstrap ห้ามรู้ทุกชั้น ความรู้นั้นต้องไปอยู่ที่ใดที่หนึ่ง ซึ่งเหลือแค่ (1) domain import adapter เอง = พัง DIP ทั้งหมดที่ทำมา (2) ใช้ DI container / service locator = dependency graph ถูก**ซ่อน**แทนที่จะเปิดเผย + เพิ่ม npm runtime dep ตัวแรก + ขัด `CLAUDE.md` (*"WebGPU API directly, no wrapper"*) (3) สภาพปัจจุบัน = ความรู้นี้กระจายใน 6,625 บรรทัดของ main.ts ปนกับ business logic ซึ่งเป็นเหตุผลตรง ๆ ที่ main.ts import เข้า test ไม่ได้

ดังนั้น **รวมความรู้เรื่องการประกอบไว้ไฟล์เดียวที่ไม่มีอย่างอื่นเลย = coupling รวมของระบบลดลง** (ศัพท์วิชาการ: *composition root* — hexagonal เรียก wiring layer, Clean Architecture วางไว้นอกวงนอกสุด หลักการเดียวกัน: เป็นโมดูลเดียวที่อ้าง concrete type ได้)

**ทำไมไม่ต้อง unit-test มัน:** use-case รับ deps เป็นพารามิเตอร์ test จึงสร้าง use-case ตรง ๆ ด้วย fake แล้วข้าม bootstrap ไปเลย — ตัวมันถูกครอบโดย QA check `boot` ที่มีอยู่แล้ว (`gpu=true adapter=true gateHidden=true secure=true cells=0 errors=0`) ถ้าประกอบผิด แอปไม่ขึ้นและ check แดง

**กันมันเน่า:** เพดาน 800 บรรทัด (§8.3) pin ด้วย QA static check · `architecture.test.ts` (§5) **ยกเว้น bootstrap โดยเจตนา** เพราะมันไม่อยู่ในสามชั้นนั้น · ถ้าเกินเพดานให้แยกตามพื้นที่ (`bootstrap/develop.ts`, `bootstrap/library.ts`) ซึ่งแต่ละไฟล์ยังเป็น composition root ของพื้นที่ตัวเอง — **ไม่ใช่**ยัด logic กลับเข้าไป · กฎ "ไม่มี business `if` / loop คำนวณ / math" บังคับด้วย code review ตอน M12 (automate ไม่ได้ จึงไม่อ้างว่าจะทำได้)

**ทำไมต้องเป็น M12:** เขียน composition root ไม่ได้จนกว่าจะรู้ว่า use-case ทั้งหมดคืออะไร ซึ่งต้องรอ U1-U18 ดึง logic ออกจาก main.ts ก่อน ระหว่าง M1-M11 ตัว wiring ยังค้างใน `main.ts` ที่เดิม (แค่ import path เปลี่ยน) แล้วค่อยถูกรวบเข้า bootstrap ครั้งเดียวตอนจบ

---

## 3. Migration mapping (ตารางนี้คือแผน ไม่ใช่การประมาณ)

⚠️ **`move` = `git mv` ล้วน (history ตามได้) · `split` = ต้องแยกไฟล์ เพราะปนสองชั้น** — split แพงกว่า move มาก และต้องทำทีละไฟล์พร้อม gate

### 3.1 `src/app/` (13 ไฟล์ 1,717 บรรทัด)

| ไฟล์ | บรรทัด | เป้าหมาย | ชนิด |
|---|---|---|---|
| `contactSheet.ts` | 38 | `domain/contactSheet/` | move |
| `filters.ts` | 414 | `domain/filters/` | move |
| `navigator.ts` | 67 | `domain/geometry/` | move |
| `stacks.ts` | 165 | `domain/stacks/` | move |
| `survey.ts` | 112 | `domain/survey/` | move |
| `viewState.ts` | 76 | `domain/geometry/` | move |
| `shortcuts.ts` | 107 | `domain/shortcuts/` (`keyToAction`) + `adapters/dom/isEditable.ts` | **split** |
| `state.ts` | 43 | `app/state.ts` (คงที่ — เป็น app-level reactive store, ไม่มี DOM) | move |
| `modules.ts` | 37 | `adapters/dom/` | move |
| `filmstrip.ts` | 199 | `adapters/dom/` | move |
| `printModule.ts` | 142 | `adapters/dom/` | move |
| `secondMonitor.ts` | 261 | `adapters/dom/` | move |
| `tetheredCapture.ts` | 56 | `adapters/fs/` | move |

### 3.2 `src/catalog/` (22 ไฟล์ 4,037 บรรทัด)

| ไฟล์ | บรรทัด | เป้าหมาย | ชนิด |
|---|---|---|---|
| `types.ts` | 211 | `domain/types.ts` | move — **ทำก่อนทุกไฟล์** เพราะทุกชั้นอ้างมัน |
| `paths.ts` | 22 | `domain/paths/` | move |
| `editHistory.ts` | 29 | `domain/edits/` | move |
| `syncOps.ts` | 53 | `domain/sync/` | move |
| `duplicates.ts` | 72 | `domain/import/` | move |
| `sidecar.ts` | 31 | `domain/export/` | move |
| `presetFiles.ts` | 61 | `domain/presets/` | move |
| `smartCollections.ts` | 235 | `domain/collections/` (พร้อมแก้ `(f as any)` ของ R1-31) | move |
| `culling.ts` | 44 | `domain/culling/` + adapter ถ้ามีการเขียน IDB | **verify ก่อน** |
| `editsStore.ts` | 187 | `domain/edits/validate.ts` (`isValidOp`/`isValidEditRow`) + `adapters/idb/idbEditStore.ts` | **split** ← U1 |
| `collections.ts` | 309 | `domain/collections/rules.ts` + `adapters/idb/idbCollections.ts` | **split** |
| `backup.ts` | 626 | `domain/backup/` (envelope/serialize/parse/row-shape validation) + `adapters/fs/` (download/read) | **split** |
| `import.ts` | 365 | `domain/import/` (merge/upsert rules) + `adapters/fs/` + `adapters/idb/` | **split** |
| `iptc.ts` | 271 | `domain/iptc/` + adapter | **split (verify)** |
| `keywords.ts` | 500 | `domain/keywords/` + adapter | **split (verify)** |
| `missing.ts` | 343 | `domain/missing/` (classifier) + `adapters/fs/` (probe/relink) | **split** |
| `remove.ts` | 205 | `domain/remove/` (verb decision + ordering) + `adapters/fs/` + `adapters/idb/` | **split** |
| `thumbnails.ts` | 282 | `adapters/idb/` (+ scheduling rules ออก `domain/` ถ้ามี) | **split (verify)** |
| `db.ts` | 63 | `adapters/idb/` | move |
| `query.ts` | 43 | `adapters/idb/` | move |
| `presetsStore.ts` | 55 | `adapters/idb/` | move |
| `permissions.ts` | 30 | `adapters/fs/` | move |

### 3.3 `src/gpu/` (17 ไฟล์ 4,122 บรรทัด + 19 `.wgsl`) — **ชั้นที่เสี่ยงที่สุด**

`gpu/` ไม่ใช่ adapter ล้วน: หลายไฟล์มี **pure math ที่เป็น color science ของ product** ปนกับการ pack uniform

| ไฟล์ | บรรทัด | เป้าหมาย | ชนิด |
|---|---|---|---|
| `uniforms.ts` | 364 | `domain/color/` (`WB_NEUTRAL_KELVIN`, `gainsToKelvin`, `gainsToTint`, `cameraCalibrationKey`) + `adapters/gpu/` (ส่วน pack uniform) | **split** |
| `tone.ts` | 482 | `domain/curve/` (`buildToneCurveLut`, `fitRegionParams`, PCHIP, `isNeutralTone`) + `adapters/gpu/` | **split** ← U9 พึ่ง |
| `dodge.ts` | 182 | `domain/mask/` (`maskDims`, `maskToOp`/`opToMask`) + `adapters/gpu/` | **split** ← U8 พึ่ง |
| `crop.ts` | 293 | `domain/crop/` + `adapters/gpu/` | **split (verify)** |
| `ops.ts` | 336 | `domain/ops/` (op → param mapping) + `adapters/gpu/` (buffer layout) | **split (verify)** |
| `grain.ts` `film.ts` `bw.ts` `lightleak.ts` `frame.ts` `geometry.ts` `presence.ts` `vignette.ts` `orient.ts` | 1,090 รวม | แต่ละไฟล์: vocabulary/defaults/clamp → `domain/<area>/`; uniform packing → `adapters/gpu/` | **split (verify รายไฟล์)** ← `lightleak.ts` คือ U1 (vocabulary ที่เป็นรากของ R1-1/R1-22) |
| `pipeline.ts` | 1,180 | `adapters/gpu/` | move (ใหญ่ — อาจต้องแยกเป็นหลายไฟล์ในชั้นเดิมทีหลัง) |
| `offscreenRenderer.ts` | 90 | `adapters/gpu/` | move |
| `exportEncode.ts` | 108 | `adapters/gpu/` | move |
| `*.wgsl` × 19 | — | `adapters/gpu/shaders/` | move |

### 3.4 `src/raw/` (5 ไฟล์ 705 บรรทัด)

ทั้งหมด → `adapters/raw/` : `decode.ts`, `exif.ts`, `imageDecode.ts`, `librawModule.ts`, `thumbnail.ts` — **move ล้วน**

### 3.5 สรุปรวม

- **move ล้วน:** ~33 ไฟล์
- **split (ปนสองชั้น):** ~15 ไฟล์ — `shortcuts`, `editsStore`, `collections`, `backup`, `import`, `iptc`, `keywords`, `missing`, `remove`, `thumbnails`, `culling`, `uniforms`, `tone`, `dodge`, `crop`, `ops` + กลุ่ม param เล็ก ๆ ใน `gpu/`
- **import path เปลี่ยนใน 47 test files** — ต้องตามแก้ทุกไฟล์ และห้ามทำให้ test อ่อนลงเพื่อผ่าน
- รายการที่กำกับ **(verify)** = ผมจำแนกจากชื่อและจากที่อ่านในเซสชันนี้ **ยังไม่ได้เปิดอ่านทีละไฟล์** → A0 ต้องยืนยันก่อน move ทุกไฟล์ และถ้าจำแนกผิดให้แก้ตารางนี้ก่อน ไม่ใช่แก้ตอน move

### 3.6 ✅ ผลการ verify (2026-09-27) — **ตารางนี้ override แถวที่กำกับ (verify) ใน §3.2/§3.3**

ทำตาม §8.2 แล้ว: เปิดอ่านครบทั้ง 15 ไฟล์ (2,813 บรรทัด) หลักฐานรายไฟล์พร้อม line range อยู่ที่ **`docs/adr/0001-layer-survey-evidence.md`** (278 บรรทัด) ADR นี้ไม่แก้แถวเดิมแต่ append คำตัดสินที่ตรวจแล้ว เพราะ ADR เป็นบันทึกการตัดสินใจ ไม่ใช่เอกสารที่เขียนทับเงียบ ๆ

**owner คาดการณ์ถูก — naming ทำให้ผมจำแนกผิด 7 จุด:**

| ไฟล์ | บรรทัด | ผมเดาไว้ | **ตรวจแล้ว** | ทำไมผิด |
|---|---|---|---|---|
| `gpu/film.ts` | 246 | split | **move → `domain/film/`** | ไม่มี device API เลย ไม่มี `pack*` ไม่มี `Float32Array` — pure ทั้งไฟล์ (`PORTRA_400`…`FILM_STOCKS`, `filmDensity`, `filmExposureScale` bisection 45 รอบ) |
| `gpu/orient.ts` | 121 | split | **move → `domain/orientation/`** | ไม่มี uniform packing เลย (`Uint8Array(36)` :101 เป็น CPU array ธรรมดา) — แต่⚠️ มัน encode ความรู้ vendor สองอย่าง (LibRaw flip code + ลำดับบรรทัดของ `unpack.wgsl`) → **ต้องตัดสิน §8.5** |
| `gpu/ops.ts` | 336 | `domain/ops/` + adapter | **~95% `adapters/gpu/`** + domain แค่ `MANDATORY_KINDS`/`presentOpIndices` (:331-336) กับ neutral-default literal 9 ตัว (:155,180,211,225,244,259,274,291,305) | **ชื่อหลอกที่สุด** — ไม่มี op vocabulary เลย (`Op` union + guard 15 ตัวอยู่ที่ `catalog/types`) ของจริงคือ render-pass registry (14 `.wgsl?raw` + byte size) **บวก module-level mutable cache** ของ camera matrix/As-Shot gains/image size (:37,56,70,79) · ⚠️ **split แบบ line-range ไม่ได้** — `packParams` closure ทั้ง 14 ตัวปนสองชั้นใน function เดียว ต้อง**เปลี่ยน shape ของ `OpRenderer`** |
| `gpu/lightleak.ts` | 130 | "vocabulary ที่เป็นรากของ R1-1/R1-22" | **ไม่มี vocabulary นั้นอยู่ในไฟล์นี้** | `pattern` เป็น `number` เปล่า ๆ ชื่อ Set A-D มีแค่ในคอมเมนต์ (:26,:39) string จริงถูกสร้างที่ `main.ts:1303` และ numeric contract ถูกลอกไว้ที่ `types.ts:127` → **U1 ต้อง *สร้าง* map ไม่ใช่ export ของเดิม** และเป้าหมายของ U1 เปลี่ยน (ดู §8.9) |
| `catalog/thumbnails.ts` | 282 | `adapters/idb` (+domain ถ้ามี) | **4 ปลายทาง ไม่ใช่ 2** | domain: `opDigest`+`RENDER_DIGEST_VERSION` (:68-121 — กฎ invalidate cache ทั้ง pipeline), `developedRenderNeeded` (:169-177) · **app**: `getThumbnailBlob` (:205-217), `needsEditedThumbnail` (:181-194) — orchestration ที่ inline I/O ใน `try` เดียว · adapters/idb · **adapters/dom**: rasteriser `createImageBitmap`/`OffscreenCanvas`/`convertToBlob` (:261-282) · แถมเรียก FS (:234) กับ LibRaw (:241) |
| `catalog/culling.ts` | 45 | domain + adapter "ถ้ามีเขียน IDB" | **split แต่ domain เหลือ 11 บรรทัด** | IDB คือส่วนใหญ่ของไฟล์ (:14,15,27) domain ได้แค่กฎ normalise (:22-26) + `applyCullResult` (:40-45) · ⚠️ **interleaved** — กฎ normalise อยู่**ใน** `request.onsuccess` closure |
| `catalog/iptc.ts` | 271 | `domain/iptc/` + adapter | split ยืนยัน แต่ **ครึ่งไฟล์ไม่ใช่ IPTC** | `MetadataPreset` (:40-44), `METADATA_PRESET_STORE` (:46), `isValidPresetRow` (:113-117), preset CRUD (:219-271) = generic preset store · และ `mergeIptc` (:189-196) เป็น pure code ที่**วางผิด section header** (อยู่ใต้ header IDB :119) |
| `gpu/geometry.ts` | 76 | `domain/geometry/` | split ยืนยัน แต่ **ชื่อ area ชนกัน** | §3.1 ยก `domain/geometry/` ให้ `navigator.ts`+`viewState.ts` ไปแล้ว (viewport geometry) ขณะที่ไฟล์นี้คือ LrC **Transform** panel → เสนอ `domain/transform/` (§8.6) |

**แถวที่ยืนยันว่าถูก:** `keywords.ts` (500) split **สะอาดที่สุด** — boundary ตรงกับ section header ของตัวเองพอดี (pure 19-267 / IDB 269-500, header `// ---- IndexedDB layer ----` ที่ :269) · `crop.ts` (293) split แต่ฝั่ง adapter มีแค่ **4 บรรทัด** (:251-254) · `grain.ts` `bw.ts` `frame.ts` `presence.ts` `vignette.ts` split แบบ "pack island" 3-12 บรรทัด

**ตัวเลขที่แก้:** 9 ไฟล์กลุ่ม `gpu/` param รวม **1,087** บรรทัด ไม่ใช่ 1,090 (§3.3)

**ต้นทุน import churn ที่วัดได้จริง:** 15 ไฟล์นี้กระทบ **17 จาก 47 test files**, รวม **18 import edges** · `grain.ts` กระทบมากสุด (3 test files: `grain`, `lightleak`, `ops`)

**สรุป move vs split ของ 15 ไฟล์:** move ทั้งไฟล์ **2 ไฟล์ 367 บรรทัด** (`film`, `orient`) · split **13 ไฟล์ 2,447 บรรทัด** — แต่ใน 13 นั้น **8 ไฟล์ฝั่ง adapter รวมกันแค่ 54 บรรทัด** (crop 4, bw 8, geometry 12, grain 4, lightleak 9, frame 3, presence 3, vignette 3) → ฉลาก "split" **ประเมินงานเกินจริง** สำหรับ 8 ไฟล์นั้น ของแพงจริงมีแค่ `ops.ts` (336, interleaved) กับไฟล์ IDB ฝั่ง catalog (culling 26, iptc 116, keywords 232, thumbnails ~215)

### 3.7 สิ่งที่ survey เจอแล้ว ADR ยังไม่มีแถวให้

- **`public/frames/*.png`** — `frame.ts` (:32-39) ระบุว่าผลภาพจริงมาจาก vendored PNG 3 ไฟล์นอก `src/` · §3 ไม่มีแถวสำหรับ `public/*` เลย → ต้องตัดสินใจ (§8.8)
- **neutral default ของ 4 op kinds ไม่มีบ้าน** — `geometry`, `vignette`, `presence`, `dodgeBurn` **ไม่มี `*_DEFAULTS` export** ค่า neutral อยู่แค่ inline literal ที่ `ops.ts:225/:274/:211/:291` → ถ้าย้าย vocabulary ไป `domain/<area>/` โดยไม่ยก literal เหล่านั้นไปด้วย จะได้ **domain area ที่มี default ของตัวเองค้างอยู่ใน adapter** (§8.7)
- **helper ซ้ำ 3 ชุด** — `mix01`/`smoothstep01`/`clamp01` มีสำเนาใน `grain.ts:165-175`, `lightleak.ts:120-130`, `vignette.ts:29-31` → ต้อง reconcile ตอนย้าย ไม่ใช่ย้ายสำเนาไปสามบ้าน
- **~~`iptc.ts:14-20` ระบุว่า `db.ts` ต้องมี v6 upgrade~~ → ตรวจแล้ว **ไม่จริง** :** `iptc.ts:11-17` มีคอมเมนต์ `PARENT ACTION REQUIRED: src/catalog/db.ts must create the preset store … and bump DB_VERSION from 5 to 6` แต่ **`db.ts` ทำไปแล้วทั้งคู่** — `DB_VERSION = 6` (:2) และ `if (event.oldVersion < 6) { db.createObjectStore('metadataPresets', { keyPath: 'id' }); }` (:48-52) · ดังนั้น store **มีอยู่จริง** และ preset persist ได้ · **สิ่งที่ค้างคือคอมเมนต์ stale ที่บอกผู้อ่านคนถัดไปว่า preset ยังไม่ persist** → จัดเป็น doc defect ให้ U18 (worker ที่ survey อ่านคอมเมนต์นี้เป็นสถานะปัจจุบัน แล้วผมเกือบบันทึกเป็นข้อเรียกร้องผิด ๆ ลง ADR — จับได้เพราะเปิด `db.ts` ดู)

### 3.8 pattern ที่โผล่ซ้ำ 3 ครั้งในเซสชันเดียว — คอมเมนต์อ้าง invariant ที่โค้ดไม่ได้ทำตาม

นี่ไม่ใช่เรื่องเล็ก เพราะมันคือกลไกที่ทำให้บั๊กรอด review:

| คอมเมนต์อ้าง | ความจริงในโค้ด | ผล |
|---|---|---|
| `main.ts:2341` *"gpuExclusive is set while a batch export / compare render is using the same offscreen textures"* | identifier `gpuExclusive` เจอ **1 ที่ทั้ง repo = คอมเมนต์บรรทัดนั้น** ไม่มี declaration ไม่มี read ไม่มี write | **R1-10 (Critical)** — thumbnail ถูกเขียนใต้ id+digest ผิดแล้วไม่หายเอง |
| `syncOps.ts:10` (เดิม) *"the reference's baseline is its history[0] snapshot (as-imported)"* | `createEditState()` คืน `{ history: [[]], cursor: 0 }` — index 0 คือ **array ว่าง** เสมอ | บั๊ก Sync delta ทั้งก้อนที่ทำให้ owner รายงาน "sync แล้วไม่ตรง" |
| `iptc.ts:11-17` *"PARENT ACTION REQUIRED … Until that lands, listMetadataPresets() returns []"* | `db.ts` ทำไปแล้วตั้งแต่ v6 | ผู้อ่านเข้าใจว่า preset ไม่ persist |

**กฎที่ควรเพิ่มใน Definition of Done (§2.4):** คอมเมนต์ที่อ้าง invariant ("X is always…", "Y is set while…", "this can never…") ต้องมี **test ที่ pin invariant นั้น** หรือต้องลบคอมเมนต์ — ห้ามปล่อยให้มีข้อความอ้างสัญญาที่ไม่มีใครบังคับ ระหว่าง M1-M12 จะเจอคอมเมนต์พวกนี้อีกมาก ให้จดลง list แล้วตัดสินทีละตัว ห้ามแก้เงียบ ๆ

---

## 4. ลำดับการย้าย (owner สั่ง "module by module ไม่รุมไม่ข้าม")

**หลักการ: innermost ก่อน** — ไฟล์ที่ไม่มี dependency ออกนอก ย้ายได้โดยไม่มีอะไรพังตาม

```
M1  domain/types.ts                     ← ทุกชั้นอ้าง ต้องไปก่อน
M2  domain/paths, editHistory, syncOps, duplicates, sidecar, presetFiles
M3  domain/filters, stacks, survey, navigator, viewState, contactSheet, smartCollections, shortcuts(rules)
M4  domain/color (uniforms math), domain/curve (tone math), domain/mask (dodge math)
M5  domain/<area> ที่ split จาก catalog: edits/validate, collections/rules, backup, import, iptc, keywords, missing, remove
M6  adapters/idb  (db, query, presetsStore, editsStore-store, collections-store, thumbnails)
M7  adapters/fs   (permissions, tetheredCapture, backup-io, missing-probe, remove-io)
M8  adapters/raw  (ทั้ง 5 ไฟล์)
M9  adapters/gpu  (pipeline, offscreenRenderer, exportEncode, shaders, ส่วน pack ของทุกไฟล์ที่ split)
M10 adapters/dom  (modules, filmstrip, printModule, secondMonitor, isEditable)
M11 app/          (state + use-cases ที่ดึงออกจาก main.ts ระหว่าง U1-U18)
M12 bootstrap.ts + main.ts บางลง        ← ทำท้ายสุด เพราะต้องรู้ว่า use-case ทั้งหมดคืออะไร
```

**แต่ละ M = หลาย commit, หนึ่งไฟล์ (หรือหนึ่ง split) ต่อหนึ่ง commit, gate ครบสามตัวเขียวทุก commit, และตัวเลข QA ต้องไม่ขยับ**

### 4.1 ความตึงเครียดที่ต้องให้ owner ตัดสิน (ยังไม่ปิด)

"ย้ายทุกชั้น" + "ไม่ข้าม" + "แก้ 20 Critical" ทำพร้อมกันให้ดีที่สุดไม่ได้:

- **Option A (thinker แนะนำ):** ทำ M1-M12 ให้เสร็จก่อน แล้วค่อย U1-U18 — โครงสร้างสะอาดก่อน ทำให้ทุก U เป็นการใส่ logic เข้าบ้านที่ถูกต้องตั้งแต่ต้น ไม่ต้องย้ายซ้ำ
  **ข้อยกเว้นที่ขอ:** ดึง **R1-3 (XSS), R1-14 (error channel ตาย), R1-18 (contactPrev)** มาแก้ก่อน M1 — ทั้งสามเป็น Class C (1-2 บรรทัด + QA check) ไม่มีบ้านเชิงโครงสร้างให้รอ และ R1-14 คือช่องทางที่จะรายงาน R1-1/R1-9/R1-10
- **Option B:** แทรกกันไป — แต่ละ U ย้าย module ที่มันแตะ แล้วค่อย fix — ได้ Critical ตัวแรกเร็วกว่า แต่ tree อยู่ในสภาพครึ่ง ๆ นานกว่า และ import churn จะปนอยู่ใน commit ที่แก้บั๊ก

### 4.2 ข้อกำหนดการย้ายที่ห้ามละเมิด

- **move ต้องเป็น `git mv`** เพื่อให้ `git log --follow` ตามประวัติได้
- **ห้ามย้ายพร้อมแก้** — ถ้าเจอสิ่งที่อยากแก้ระหว่างย้าย ให้จดไว้แล้วทำใน commit แยก (หลักเดียวกับ §2.2 ของแผน hardening)
- **ห้ามทำให้ test อ่อนลงเพื่อให้ผ่าน** — ถ้า test ไหนพังเพราะ path เปลี่ยน ให้แก้ path ไม่ใช่แก้ assertion
- `tsconfig.json` `include: ["src"]` ครอบทั้งต้นใหม่อยู่แล้ว จึงไม่ต้องแก้ (ยืนยันแล้ว) — แต่ถ้าจะเพิ่ม `paths` alias ให้เสนอมาก่อน อย่าใส่เอง

---

## 5. การบังคับกฎแบบ executable

กฎใน §2.2 จะเสื่อมถ้าพึ่งแต่ความจำของคน จึงทำเป็น **`src/architecture.test.ts`** ที่รันใน `npm test` (เร็ว ไม่ต้องมี browser):

1. walk `src/domain/**` → assert ไม่มี import จาก `app/`, `adapters/`, `bootstrap`, `main`
2. walk `src/domain/**` → assert ไม่ปรากฏ identifier `document`, `window`, `indexedDB`, `navigator`, `GPUDevice`, `requestAdapter`, `fetch`
3. walk `src/app/**` → assert ไม่มี import จาก `adapters/`
4. walk `src/adapters/**` → assert ทุกไฟล์ที่ `implements` port จะ import port นั้นจาก `domain/ports/`
5. walk `src/**` → assert ไม่มี `as any` ใหม่ (baseline: นับจำนวนปัจจุบันแล้ว pin ไว้ ห้ามเพิ่ม)

test ตัวนี้คือ **fitness function** ของสถาปัตยกรรม — เขียนก่อนใน M1 ให้แดง แล้วค่อย ๆ เขียวลงเมื่อแต่ละชั้นย้ายเข้าที่ (ซึ่งคือ TDD ของตัวโครงสร้างเอง)

เพิ่ม QA static check หนึ่งตัวที่ assert `main.ts` + `bootstrap.ts` ไม่โตเกินเพดานที่ตั้งไว้ (กัน monolith งอกกลับ)

---

## 6. Consequences

### ได้

- business logic ทุกชิ้น unit-test ได้ด้วย fake adapter — **ปิดตัวบล็อกที่ทำให้ TDD เป็นไปไม่ได้** (§1.1)
- R1-33 (emit list vs restore list ไม่มีอะไร pin) แก้ได้จริง: เมื่อทั้งสองเป็น domain function จะเขียน round-trip test ที่ครอบคลุมทุก op kind ได้โดยไม่ต้องมี browser
- `main.ts` เลิกเป็นจุดรวมบั๊ก — review รอบนี้พบ Critical 20 ตัวที่นั่นเพราะมันเป็นที่เดียวที่ logic อยู่
- dependency ชี้ทิศเดียว → เปลี่ยน adapter (เช่น IDB → OPFS, หรือ WebGPU → wgpu-native ตามที่ `CLAUDE.md` วางทางยาวไว้) โดยไม่แตะ domain
- อ่านง่าย: เปิด `domain/sync/` แล้วรู้ทันทีว่ากฎ sync คืออะไร ไม่ต้องไถ 6,625 บรรทัด

### เสีย / ความเสี่ยง (ต้องยอมรับอย่างเปิดเผย)

- **งานใหญ่:** ~10,600 บรรทัดนอก main.ts ต้องจำแนก, ~15 ไฟล์ต้อง **split** ไม่ใช่ move, import path เปลี่ยนใน 47 test files
- **`gpu/` คือจุดเสี่ยงสุด** — การแยก pure math ออกจาก device code แตะโค้ดที่ performance-critical ที่สุดของ product (`CLAUDE.md`: *"The 50ms number is the single most important metric"*) ต้องมี perf gate กำกับ ไม่ใช่แค่ unit test
- **ระหว่างทางจะมีบ้านสองหลังชั่วคราว** (`catalog/` กับ `domain/`) จนกว่า M5 จะจบ — owner เลือกทางนี้โดยรับทราบ (§8.5)
- **Critical บางตัวรอนาน** ถ้าใช้ Option A: R1-11 (GPU leak 20 devices) และ R1-2 (shift-click → trash ไฟล์ที่ไม่ได้เลือก) จะรอจนจบ M-series
- risk ที่การย้ายทำพฤติกรรมเปลี่ยนโดยไม่รู้ตัว → ป้องกันด้วย "ห้ามย้ายพร้อมแก้" + gate ทุก commit + ตัวเลข QA ต้องนิ่ง

### เป็นกลาง

- ไม่มี runtime dependency เพิ่ม
- ไม่เปลี่ยนพฤติกรรมผู้ใช้ใด ๆ ทั้งสิ้นจนจบ M12 — ผู้ใช้จะไม่เห็นอะไรต่างไปเลยตลอด phase นี้

---

## 7. Alternatives ที่พิจารณาแล้วปฏิเสธ

| ทางเลือก | เหตุที่ปฏิเสธ |
|---|---|
| คง `catalog/`+`gpu/` เป็น legacy layer, ย้ายเฉพาะโค้ดใหม่ | thinker แนะนำทางนี้ (ถูกกว่ามาก) แต่ **owner ปฏิเสธ** — ไม่ต้องการบ้านสองหลังของ domain code (§8.5) |
| ใช้ DI container (tsyringe/inversify) | เพิ่ม npm runtime dep ตัวแรก, ขัด spirit `CLAUDE.md`, ต้องเปิด decorator flag |
| ย้ายเฉพาะ `src/app/` (1,717 บรรทัด) | เป็นทางกลางที่เสนอ แต่ owner เลือกย้ายหมด |
| React / Nest | ปฏิเสธไปแล้ว 2026-09-27 — ดูเหตุผลในบันทึกเซสชัน: Nest ขัด "no backend, no network" ที่เป็น selling point; React เสี่ยงต่อ perf profile ของแอป (virtualized grid 10k+, slider→GPU <50ms, brush stroke) และต้อง rewrite 17,206 บรรทัดโดยผู้ใช้ไม่เห็นผล |
| แก้ 20 Critical ก่อนแล้วค่อยจัดชั้น | ต้องแก้ในโค้ดที่ test ไม่ได้ (ขัด TDD) แล้วพอ move ก็เสี่ยงพังซ้ำ และ fix witness ของ review เรียกร้อง test ที่เขียนใน main.ts ไม่ได้ |

---

## 8. คำตัดสินของ owner — ปิดครบทั้งสี่ข้อ (2026-09-27)

1. ✅ **Option A** (§4.1) — ทำ **M1-M12 ให้เสร็จก่อน แล้วค่อย U1-U18**
   · *ข้อยกเว้น:* thinker เสนอดึง **R1-3 (XSS), R1-14 (error channel ตาย), R1-18 (contactPrev)** มาแก้ก่อน M1 เพราะเป็น Class C (1-2 บรรทัด + QA check) ไม่มีบ้านเชิงโครงสร้างให้รอ และ R1-14 คือช่องทางที่จะรายงาน R1-1/R1-9/R1-10 — owner ตอบ "A" โดยไม่ระบุข้อยกเว้นนี้ **thinker จึงตีความว่ารวม และบันทึกไว้ให้ veto ได้**: ถ้าไม่เอา ให้บอกก่อนเริ่ม step แรก
2. ✅ **อ่านก่อนย้าย** — owner ให้เหตุผลตรง ๆ ว่า *"บางทีอาจจะมั่ว naming"* ซึ่งถูกต้อง: รายการ **(verify)** ใน §3 จำแนกจากชื่อไฟล์และบริบทที่อ่านในเซสชันนี้ **ยังไม่ได้เปิดอ่านทีละไฟล์** → **งานแรกของ M1 = เปิดอ่านไฟล์เหล่านั้นทุกไฟล์ แล้วแก้ตาราง §3 ให้ถูกก่อน จึงจะเริ่ม move** · **ห้าม move ก่อนแก้ตาราง**
   ไฟล์ที่ต้องอ่านก่อน: `catalog/` — `culling.ts`, `iptc.ts`, `keywords.ts`, `thumbnails.ts` · `gpu/` — `crop.ts`, `ops.ts`, `grain.ts`, `film.ts`, `bw.ts`, `lightleak.ts`, `frame.ts`, `geometry.ts`, `presence.ts`, `vignette.ts`, `orient.ts`
3. ✅ **เพดาน 800 บรรทัด** สำหรับ `main.ts` + `bootstrap.ts` รวมกัน ณ จุดจบโปรแกรม — pin ด้วย QA static check (§5)
4. ✅ **ไม่เพิ่ม `paths` alias ใน tsconfig** — ใช้ relative path ตามเดิม

### คำถามชุดใหม่ที่เกิดจากผล verify (§3.6-§3.8) — ปิดแล้วข้อ 5 กับ 10 · ข้อ 6-9 และ 11 thinker ใช้ข้อเสนอของตัวเองเว้นแต่ owner ค้าน

5. ✅ **ตัดสินแล้ว (owner, 2026-09-27): `domain/` เก็บความรู้ vendor ได้** — ใช้ทาง (a) พร้อมกฎกำกับสามข้อ: (i) อ้าง contract ภายนอกในคอมเมนต์ได้ (ii) encode มันเป็น pure function ได้ (iii) **ห้าม import จาก adapter** และ header ต้องชื่อไฟล์คู่ขา (`.wgsl` ที่ต้อง sync ด้วย / path ของ LibRaw source) เพื่อให้ภาระ sync ค้นเจอ — `orient.ts` กับ `presence.ts` ทำแบบนี้อยู่แล้วจึงเป็นแบบที่ให้ทำตาม **ไม่เพิ่มชั้น `src/contracts/`**
6. **ชื่อ `domain/geometry/` ชนกัน** — §3.1 ยกให้ `navigator.ts`+`viewState.ts` (viewport/scroll geometry) ขณะที่ `gpu/geometry.ts` คือ LrC **Transform** panel · **เสนอ:** viewport → `domain/viewport/`, Transform op → `domain/transform/` และเลิกใช้คำว่า "geometry" เป็นชื่อ area เลยเพื่อกำจัดความกำกวม
7. **neutral default ของ 4 op kinds ที่ไม่มีบ้าน** (`geometry`, `vignette`, `presence`, `dodgeBurn` — อยู่แค่ inline literal ที่ `ops.ts:225/:274/:211/:291`) — ยก literal พวกนี้ขึ้นเป็น `*_DEFAULTS` ใน `domain/<area>/` ตอน M4 แล้วให้ `ops.ts` import กลับไหม? **เสนอ: ต้องทำ** ไม่งั้นจะได้ domain area ที่มี default ของตัวเองค้างอยู่ใน adapter และ `isNeutralX` กับค่าที่ packer ใช้จะ drift ได้อีก (รากเดียวกับ R1-1)
8. **`public/*` ไม่มีแถวใน §3** — `public/frames/{135,120,print}-strip.png` และ `public/leaks/*.png` เป็นส่วนหนึ่งของ feature จริง · **เสนอ:** `public/` อยู่ที่เดิม (เป็น vite static root ย้ายแล้ว build พัง) เพิ่มแถวใน §3 ระบุว่า "อยู่ที่เดิม โดยเจตนา" + กฎว่า domain area ที่พฤติกรรมขึ้นกับ asset ภายนอกต้องชื่อ asset นั้นใน header (`frame.ts`/`lightleak.ts` ทำอยู่แล้ว)
9. **เป้าหมายของ U1 เปลี่ยนไปเพราะผล verify** — vocabulary ของ lightleak pattern **ไม่มีอยู่ที่ไหนเป็น map** มันเป็น numeric convention ในคอมเมนต์ 4 ที่ (`lightleak.ts:26`/`:39`, `main.ts:1303` สร้าง string, `types.ts:127` ลอก contract, `editsStore.ts:113` bound) → U1 ต้อง **สร้าง** `LIGHTLEAK_PATTERNS` ใน `domain/lightleak/` แล้วให้ทั้งสี่ฝ่ายอ่านมัน (ไม่ใช่ export ของเดิมอย่างที่แผน rev.2 เขียน) · ภายใต้ Option A เรื่องนี้**ง่ายขึ้น** เพราะ M4 จะสร้าง `domain/lightleak/` ไว้ก่อนแล้ว U1 แค่เพิ่ม map กับแก้ consumer
10. ✅ **ตัดสินแล้ว (owner, 2026-09-27): split `ops.ts` จริง พร้อม perf gate** — ไม่ใช้ทางที่ thinker แนะนำ (ยกทั้งไฟล์ไป adapter) ดังนั้นต้อง reshape `OpRenderer` แยก `shader`+`uniformSize` (adapter) ออกจากกฎการเลือก op / ค่า default / การแปลงค่า (domain) · งานนี้อยู่ใน **M9** และมีเงื่อนไขบังคับเพิ่มด้านล่าง

    **⚠️ ผลตามมาที่ต้องรู้: perf gate ที่ว่าจะต้องถูก *สร้าง* ก่อน — มันยังไม่มีอยู่** repo นี้ไม่มี automated measurement ของ slider→frame เลย ที่มีคือ (ก) `perfMarks.renderStart`/`renderEnd` (`main.ts:2499`/`2543`) ซึ่งพิมพ์ออกทาง Ctrl+Shift+P เท่านั้น และ `decodeStart`/`decodeEnd` ไม่เคยถูก assign (R1-38) (ข) wall-clock assertion เดียวของ repo คือ `filters.test.ts` เรื่อง `applyFilters` ซึ่ง**เป็น flake ที่รู้จักกันแล้ว** (ดู memory: `filters-test-timing-flake`) จึงพิสูจน์ว่า wall-clock gate ใน repo นี้เชื่อถือไม่ได้

    **perf gate ที่ thinker เสนอให้ใช้ (ต้อง approve ก่อน M9):**
    - **ตัวชี้วัดหลัก = deterministic, ไม่ใช่เวลา:** นับจำนวน GPU pass ที่ dispatch ต่อหนึ่ง render (`presentOpIndices().length`) และจำนวน `writeBuffer` ต่อ render — pin ค่า baseline ก่อน reshape แล้ว assert เท่าเดิมหลัง reshape · ถ้า reshape ทำให้ pass เพิ่มหรือ buffer write เพิ่ม นั่นคือ regression จริงที่วัดได้โดยไม่มี noise
    - **ตัวชี้วัดรอง = wall-clock แบบ report-only:** วัด `renderStart`→`renderEnd` median over N frames แล้ว**พิมพ์เทียบ baseline แต่ไม่ fail** (ยกเว้นเกิน 2× baseline ซึ่ง fail) — เลี่ยง flake แบบ `filters.test.ts`
    - ต้องรัน gate นี้**ก่อน**แตะ `ops.ts` เพื่อบันทึก baseline ไม่ใช่รันหลังแก้เสร็จแล้วค่อยหาค่าอ้างอิง
    - `OpRenderer` shape ใหม่ต้องเสนอให้ owner ดูก่อนลงมือ เพราะมันคือ contract ของ render chain ทั้งเส้น
11. **กฎใหม่จาก §3.8 ต้องเพิ่มใน plan §2.4 (Definition of Done):** คอมเมนต์ที่อ้าง invariant ต้องมี test pin หรือถูกลบ — thinker จะ mirror กฎนี้เข้าแผน hardening ถ้า owner เห็นด้วย

---

## 9. ความสัมพันธ์กับ `CLAUDE.md`

`CLAUDE.md` เขียนเป็น **spike brief 2 สัปดาห์** และหลายข้อใน "Do not do these in this spike" ถูกทำไปแล้วอย่างจงใจ (catalog/DB/thumbnail cache, masking, export presets, op graph สำหรับ undo/history, device-loss handling)

ADR นี้คือการทำตาม *"Refactor later"* ที่ `CLAUDE.md` อนุญาตไว้ตรง ๆ ในข้อ *"Do not design a clean op graph. Hardcode the shader chain. Refactor later."*

ข้อของ `CLAUDE.md` ที่ **ยังมีผลและ ADR นี้ไม่แตะ:**
- No backend, no network calls of any kind
- GPU-first, WASM decode แล้วขึ้น texture ทันที ไม่ readback ยกเว้นตอน export
- Chromium-only เป็นการตัดสินใจที่รับไว้แล้ว
- ไม่แตะ DCP / camera color profiles
- ไม่ทำ AI features
- ไม่ทำ plugin API จนกว่าจะมีผู้ใช้หลักหมื่น

**งานค้างที่ ADR นี้สร้าง:** `CLAUDE.md` และ `ROADMAP.md` ล้าหลังทั้งคู่ (ROADMAP บอกว่า `main.ts` 2,951 บรรทัด ทั้งที่จริง 6,625 และบอกว่า device-loss ยังไม่ทำทั้งที่ทำแล้วที่ `pipeline.ts:102-109`) — ต้องเขียนใหม่หลัง M12 ไม่ใช่ก่อน เพราะ path ทั้งหมดจะเปลี่ยน
