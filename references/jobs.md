# Job inputs

The jobs file is a nonempty JSON array; a portable [JSON Schema](jobs.schema.json) is included for editors. The runner also checks files, hashes, duplicate IDs, and edit targets before spawning workers. Example (store under an ignored `private/` directory):

```json
[
  {
    "id": "lantern",
    "mode": "generate",
    "prompt_file": "private/lantern.txt",
    "reference_images": [],
    "output_dir": "output/images"
  },
  {
    "id": "lantern-edit",
    "mode": "edit",
    "prompt_file": "private/lantern-edit.txt",
    "reference_images": [
      { "path": "output/images/lantern.png", "role": "edit_target" },
      { "path": "private/style.png", "role": "style", "sha256": "<64 hexadecimal characters>" }
    ],
    "output_dir": "output/images"
  }
]
```

Pass an explicit absolute `--root` for the project. Relative prompt, reference, and output paths resolve against this root; the jobs-file argument resolves against the invocation directory. Absolute paths are accepted. Inputs must exist. IDs contain only ASCII letters, digits, underscores, and hyphens, begin with a letter or digit, and are at most 80 characters. Duplicate IDs are rejected. Mode is `generate` or `edit`. Every reference has a nonempty role; an edit must have at least one `edit_target`. A supplied SHA-256 is checked before any workers start.

Prepare UTF-8 prompt files. Their exact bytes are retained and hashed; the relay instructions carry the decoded prompt as an unchanged suffix. Include intended roles and invariants in that prompt, and pass image files in the same order as `reference_images`. For a genuinely new image use an empty array. Generation with optional style/composition references is supported.

Each job gets a directory `<output_dir>/<id>/<fingerprint>/`. The runner copies a validated generated PNG to `image.png`, stores `receipt.json`, and keeps attempt-specific prompts, event logs, stderr, schemas, and model results under `attempts/`. Jobs with a verified existing receipt and matching prompt/reference fingerprint are skipped. Changed jobs use a separate fingerprint directory to avoid overwriting a previously generated asset. Failure receipts remain resumable; no automatic retry is performed.

The batch summary is written in a new timestamped directory under `--log-dir` (default `<root>/output/imagegen-runs`). These files can contain private prompts, file paths, and images; keep them out of version control.
