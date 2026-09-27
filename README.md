# codex-imagegen-concurrent

A portable Codex skill and dependency-free Node runner for prepared image prompts. A main agent prepares and reviews; local `gpt-6-luna` workers relay prompts and actual reference attachments to Codex's built-in image generation tool. No image API SDK or separate API key is used.

Requires Node.js 20+, Codex CLI installed and authenticated, and access to `gpt-6-luna` with built-in image generation. This project does not imply free usage; your Codex account's limits apply. Default concurrency is 16 local processes, adjustable up to 64; this is not a measured service limit.

## Install

Clone this repository into `~/.codex/skills/codex-imagegen-concurrent` (Windows: `%USERPROFILE%\.codex\skills\codex-imagegen-concurrent`), or copy the repository there. If `CODEX_HOME` is customized, use its `skills` directory. Restart Codex or start a fresh session, then invoke `$codex-imagegen-concurrent`. No npm install is required.

Installation does not change your model, global settings, or other image skills. To route all raster generation through this workflow, explicitly add that preference to your own Codex instructions, including the worker-marker exemption in `SKILL.md` to prevent recursion. Public users can also choose it per task.

## Run

```sh
node scripts/run.mjs --probe --root /absolute/project
node scripts/run.mjs --jobs /absolute/project/private/jobs.json --root /absolute/project --concurrency 16
npm test
```

On Windows pass an absolute project path and, if CLI resolution fails, `--codex "C:\path\to\codex.exe"`. See [job schema](references/jobs.md), [failure handling](references/debugging.md), and [agent instructions](SKILL.md).

The main agent supplies prompt files and actual reference files. Brand-new images can have no references. Edits require an original edit target. Successful images are copied into the chosen project directory with hashes and pending visual review; no publishing occurs. Results are resumable and individual failures are retained. Private jobs, prompts, references, generated images, and logs belong in ignored directories, not in this public repository.

The tests use mocked Codex processes to check worker bounds, exact prompt forwarding, references, false output rejection, resume, and partial failures. These tests do not establish live high-concurrency capacity. Use a real single-image smoke test to verify your account and CLI.
