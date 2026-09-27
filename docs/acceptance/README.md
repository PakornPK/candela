# Acceptance spec of record

These `.feature` files are the acceptance spec of record for the `main.ts`
hardening programme. **They are not executed** — the repo has no Gherkin runner
and adding one is a non-goal (plan §3). Every scenario is mapped 1:1 to a check
in `scripts/qa-loop.mjs` by its `@qa <exact check name>` tag, and back to the
review finding by `@finding R1-<n>`. The QA loop is the executable layer: it
drives real Chrome over CDP and asserts what the user would actually see.

| Finding | Scenario | QA check | Status |
| --- | --- | --- | --- |
| R1-3 | `untrusted-strings.feature` — smart-collection name, name restored after a reload, loupe info read-out | `security: untrusted strings render as text, never as HTML` | green (X1) |
| R1-14 | `error-banner.feature` — a dismissed warning leaves the banner able to warn again | `stability: the error banner survives dismissal and keeps reporting` | green (X2) |
| R1-18 | `contact-sheet.feature` — paging back restores the frames and numbers of the sheet the header names; previous on the first sheet changes nothing | `contact sheet: Prev returns to the previous sheet's frames and label` | green (X3) |

Later units append rows here, one row per finding, and add a
`docs/acceptance/<slug>.feature` beside them.
