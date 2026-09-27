---
name: codex-imagegen-concurrent
description: Generate or edit raster images through local Codex CLI gpt-6-luna low relay workers using the built-in image_gen tool. Use for one image or concurrent image batches with prepared prompts and actual reference attachments; keep preparation, visual review, and publishing in the main agent.
---

# Codex image generation relay

Use this local CLI orchestration path when selected by the user or local routing instructions. It uses the authenticated Codex session and built-in `image_gen`, not the separately billed image API or `image_gen.py`.

The main agent prepares complete prompts, inspects edit targets, assigns reference roles, and reads [references/jobs.md](references/jobs.md) to write the jobs file. Actual reference images must be attached, not merely mentioned. New images need no references; edits require the actual original with role `edit_target`. Preserve the prepared prompt exactly during relay. Do not invent project-specific policy fields.

Run `node scripts/run.mjs --jobs <file> --root <project> --concurrency 16` from this skill directory (or use the script's absolute path). Concurrency is a local worker count, configurable from 1 to 64, not a service capacity guarantee. One job uses the same path. `--probe --root <project>` checks tool exposure without generating an image; it is not a throughput test.

Workers use `gpt-6-luna` with low reasoning and only generate. They do not research, modify project files, publish, or approve images. Do not change the main agent's model or global settings. If you see `IMAGEGEN_RELAY_WORKER` or `CODEX_IMAGEGEN_WORKER=1`, act as the terminal relay: call the built-in image tool directly and never launch another worker.

The runner records prompts, input hashes, logs, output hashes, failures, and review status. Its `generated` status confirms a verified local PNG and generation evidence; it does not mean visual acceptance. The main agent views every intended deliverable, checks the user's requirements, and handles any integration or authorized publishing. Outputs remain review-pending until that review.

Read [references/debugging.md](references/debugging.md) on unavailable tools, failed jobs, or resume behavior. Stop and report actual failures; do not silently switch models, request an API key, or use another image API.
