# Photography presentation course

A complete, model-based demonstration course: **Clinical Photography: From First Frame to Portfolio**.

- Six modules, twelve required rich-text lessons and one optional PDF resource.
- Original worked decisions, practice tasks and formative checks in each lesson.
- Sixteen-page illustrated field guide/workbook, six practice labs and a portfolio rubric.
- Sixteen-question knowledge assessment, 80% threshold and three initial attempts.
- Four free previews: the two opening lessons, workbook and kit/setup lesson.
- Demo display price INR 2,499; 180-day access; zero approved education credits.
- Dedicated fictional presentation learner, complimentary access and assigned demo faculty.

This is an opt-in presentation edition. It is never installed by production startup, migrations,
seed or the build. It does not replace either academy's existing course/draft. Faculty must review
content, local policy and clinical delivery before using it with patients. Activities use models;
no patient imagery, clinical diagnosis, treatment recommendation or competence grading is included.
The portfolio remains with the learner and is self-reviewed, not uploaded or graded by the app.

## Local review

The separate Icode site consumes the course through the existing APIs. Its published course slug
and IDs are recorded in the task's `work/photography-showcase-installed.json`. The course is open
locally in both academies; no hosted deployment or production data installation was performed.

Open `http://127.0.0.1:5173/learn/icode` and use fictional mobile **+12025550164**. The local OTP
appears on screen. This is a sample account with no clinical credential or real payment. In staff
Online courses, select this course to review its curriculum, assessment and preview settings.

A useful presentation path:

1. Start on its Icode website page and explain the learner outcome and module outline.
2. Open a free text lesson and the workbook without signing in.
3. Switch to the prepared learner and open the full lesson player.
4. Show the worked examples, workbook page navigation, practice labs and portfolio rubric.
5. Open Post-test to show the scenarios, threshold and remaining attempts. Both the required
   lessons and a passed post-test are needed for completion; the test can be viewed earlier.
6. Return to the builder to show the same content and free-preview choices.

## Rebuild or install deliberately

`prepare-content.py` creates the curated JSON from the existing complete photography review
course, with new worked examples, edited copy, module structure, source reading and catalog page.
The workbook generator uses ReportLab and the repository's DejaVu fonts. Generated output is
`output/pdf/photography-portfolio-workbook.pdf`; its identical packaged copy is committed under
`assets/courses/` for upload through the existing verified private-media API.

```sh
python3 content/photography-showcase/prepare-content.py
python3 content/photography-showcase/build-workbook.py
node --import tsx scripts/install-showcase-course.ts
```

The installer uses only authenticated HTTP APIs on the fixed local development origin and
checks development mode before writing. Sign-in codes/cookies stay in memory. It matches the
course and lessons before adding missing items and uses stable media/grant IDs. Reopening
keeps existing text, assessment and preview settings. Workbook bytes are content-addressed;
changed packaged bytes need explicit `--refresh-workbook`, which resets reading progress for
that optional PDF. `--refresh-lessons` and `--refresh-catalog` deliberately replace the new
showcase's corresponding content; do not use these after academy editing without reviewing it.
The catalog refresh makes the offering inherit its program's details. Auth rate limits apply,
so avoid repeated setup runs or use the existing browser session for routine review.

## Verification — October 20, 2026

Production build and all 233 regression tests passed. Authenticated checks with assigned demo
faculty and fictional learners confirmed 13 lessons, six modules, four preview flags and 16
questions in each academy; learner payloads exclude answer keys, staff builders are inaccessible
to learners, and completion/certificate requirements remain pending. The configured Icode
website's public API returned only free lesson bodies and rejected the nine locked lessons.
Both workbook downloads matched the packaged PDF hash and contained 16 pages. The separate
website remains configured only for Icode; no Skillodontics website key was reconfigured.

Browser review verified the final catalog copy, public workbook opening, full learner curriculum,
lesson structure, scenario questions and PDF page navigation. All 16 generated PDF pages were
rendered and inspected; the final cover was re-rendered after its footer contrast adjustment.
No quiz attempt, fabricated completion, certificate, real booking or payment was submitted.
Existing review courses, lessons and other sample records remain intact.

Sources are linked in the lessons and workbook. Nikon references support basic camera concepts;
GDC reading provides UK professional context, not local policy approval. Diagrams and scenarios
are original conceptual training material. This edition uses reading/PDF teaching, with no
unconfigured or fabricated video lessons.
