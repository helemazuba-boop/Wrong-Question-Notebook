# WQN Problem Ingestion v1 — English prompt

Attach the source images in page order, then use all text under **Prompt** as
the model instruction. If the model supports a JSON response mode, enable it.

## Prompt

You are the recognition stage for WQN Problem Ingestion v1. Inspect every
attached test-paper, worksheet, exercise-book, or wrong-answer image and
transcribe its complete visible question structure.

Return exactly one JSON object conforming to `wqn.problem-ingestion.v1`.
Return no Markdown fence, explanation, or text before or after the JSON.

### Domain boundary

- Extract every independent question visible on every supplied page. Never
  arbitrarily select one, merge independent questions, or drop a usable
  partial question.
- WQN imports at most 20 independent questions in one batch. If the source has
  more than 20, do not merge or silently omit questions to fit the limit;
  return the faithful document so WQN can reject it with an instruction to
  split the source into smaller batches.
- A question may span pages and may have 1–10 parts sharing one stem. Keep the
  shared stem in `shared_stem`; keep each part's own prompt in that part's
  `content`.
- Classify each part only from the printed question structure. The allowed
  types are `single_choice`, `multi_choice`, `fill_blank`, `short_answer`, and
  `essay`. Student handwriting, answer length, or shown working must not
  change the printed type.
- `reference_answer` is only a visibly printed official answer or visibly
  printed official solution. Never solve, correct, or infer an answer. A
  student's answer, working, annotation, tick, cross, or a teacher's mark must
  go in `student_work`, never in `reference_answer`.
- Figures, graphs, geometry, tables, circuits, apparatus, and other non-text
  content are first-class regions. Link them to their owning question and part
  with `visual_region_ids`; do not reduce them to a boolean or invent a text
  substitute.

### Pages, regions, and coordinates

- Number supplied images as `page-1`, `page-2`, ... in input order;
  `image_index` is zero-based.
- Use `coordinate_space: "normalized_0_1"`. Every polygon has 4–16 points in
  reading order around the region. Every `x` and `y` is a number in `[0, 1]`
  relative to the image you inspected.
- Use document-local unique IDs such as `region-1`, `question-1`, `part-1-1`,
  and `work-1`. Every referenced ID must exist in the corresponding array.
- Allowed region roles are `question`, `shared_stem`, `part`, `option`,
  `printed_answer`, `printed_solution`, `student_answer`, `student_work`,
  `teacher_mark`, `figure`, `table`, `formula`, and `other`.
- Set `source_asset_id` to `null` unless the caller explicitly supplied a
  durable asset ID. Set source/provider width and height to actual positive
  pixel dimensions only when reliably known; otherwise use `null`. Do not
  guess dimensions.

### Text and mathematics

- Each content field is an ordered array of nodes. Use `text` for prose,
  `math_inline` for inline TeX, and `math_block` for display TeX.
- A math node's `value` contains TeX without `$` or `$$` delimiters. Escape a
  backslash only as required by valid JSON transport; the decoded value must
  contain the intended TeX, not literal JSON escape notation.
- Preserve the source language, spelling, symbols, option labels, and reading
  order. Do not paraphrase, translate, solve, autocorrect, or fill missing
  text.

### Missing and partial data

- Every property shown in the example is required on every object of that
  kind. Collections are always arrays: use `[]` when none exist. Never use
  `null` for a collection and never omit a required property.
- Use `null` only for an unavailable nullable scalar: page dimensions and
  rotation, region/question/part confidence, region text, question number and
  title, part label and marks, student-work part ID, or the whole
  `reference_answer`.
- Confidence is a number from 0 to 1 or `null`; never invent precision.
- Use top-level `status: "partial"`, `question.incomplete: true`, and specific
  `warnings` when a page is cut off, a continuation is missing, important text
  is unreadable, or the structure is uncertain. Keep all usable results.
- A document may have `questions: []` only when no question is recognizable;
  explain why in top-level `warnings`. Every recognized question must have at
  least one part.

### Answers, titles, and tags

- For a visible printed choice answer, put choice labels in
  `reference_answer.choice_ids`; for a printed textual or worked answer, put
  its transcription in `reference_answer.content`. Otherwise set the entire
  `reference_answer` to `null`.
- `title` and `suggested_tags` are normalization suggestions rather than OCR.
  A title is concise, at most 50 characters, and has no question number. Use
  `null` only when no safe title can be suggested. Suggest at most five short
  tags and preserve the source language.

### Schema-valid shape example

The following JSON is an example of the exact object shape, not content to
copy. Replace every value with evidence from the attached images while
preserving every required property.

```json
{
  "schema_version": "wqn.problem-ingestion.v1",
  "status": "complete",
  "pages": [
    {
      "page_id": "page-1",
      "image_index": 0,
      "source_asset_id": null,
      "coordinate_space": "normalized_0_1",
      "source_width": null,
      "source_height": null,
      "provider_width": null,
      "provider_height": null,
      "rotation_degrees": null
    }
  ],
  "regions": [
    {
      "region_id": "region-question-1",
      "page_id": "page-1",
      "role": "question",
      "polygon": [
        { "x": 0.1, "y": 0.1 },
        { "x": 0.9, "y": 0.1 },
        { "x": 0.9, "y": 0.8 },
        { "x": 0.1, "y": 0.8 }
      ],
      "text": "Solve for x.",
      "confidence": 0.96
    },
    {
      "region_id": "region-answer-1",
      "page_id": "page-1",
      "role": "printed_answer",
      "polygon": [
        { "x": 0.72, "y": 0.7 },
        { "x": 0.88, "y": 0.7 },
        { "x": 0.88, "y": 0.76 },
        { "x": 0.72, "y": 0.76 }
      ],
      "text": "42",
      "confidence": 0.94
    },
    {
      "region_id": "region-work-1",
      "page_id": "page-1",
      "role": "student_work",
      "polygon": [
        { "x": 0.2, "y": 0.5 },
        { "x": 0.6, "y": 0.5 },
        { "x": 0.6, "y": 0.65 },
        { "x": 0.2, "y": 0.65 }
      ],
      "text": "x = 41",
      "confidence": 0.78
    },
    {
      "region_id": "region-figure-1",
      "page_id": "page-1",
      "role": "figure",
      "polygon": [
        { "x": 0.62, "y": 0.22 },
        { "x": 0.88, "y": 0.22 },
        { "x": 0.88, "y": 0.48 },
        { "x": 0.62, "y": 0.48 }
      ],
      "text": null,
      "confidence": 0.9
    }
  ],
  "questions": [
    {
      "question_id": "question-1",
      "number_label": "8",
      "title": "Linear Equation",
      "shared_stem": [
        { "kind": "text", "value": "Given " },
        { "kind": "math_inline", "value": "2x=84" },
        { "kind": "text", "value": ", answer the question." }
      ],
      "parts": [
        {
          "part_id": "part-1-1",
          "index": 1,
          "label": null,
          "type": "single_choice",
          "content": [
            { "kind": "text", "value": "Which option gives the value of " },
            { "kind": "math_inline", "value": "x" },
            { "kind": "text", "value": "?" }
          ],
          "full_marks": null,
          "choices": [
            {
              "id": "A",
              "content": [{ "kind": "math_inline", "value": "41" }],
              "region_ids": []
            },
            {
              "id": "B",
              "content": [{ "kind": "math_inline", "value": "42" }],
              "region_ids": []
            }
          ],
          "reference_answer": {
            "kind": "printed_answer",
            "choice_ids": ["B"],
            "content": [],
            "confidence": 0.94,
            "region_ids": ["region-answer-1"]
          },
          "region_ids": ["region-question-1"],
          "visual_region_ids": ["region-figure-1"],
          "confidence": 0.96,
          "warnings": []
        }
      ],
      "region_ids": ["region-question-1"],
      "visual_region_ids": ["region-figure-1"],
      "student_work": [
        {
          "work_id": "work-1",
          "part_id": "part-1-1",
          "kind": "working",
          "content": [{ "kind": "math_inline", "value": "x=41" }],
          "region_ids": ["region-work-1"],
          "confidence": 0.78
        }
      ],
      "suggested_tags": ["algebra"],
      "confidence": 0.96,
      "incomplete": false,
      "warnings": []
    }
  ],
  "warnings": []
}
```

Now inspect all attached images and output only the actual JSON object.
