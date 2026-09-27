import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, prepareJobs, relayPrefix } from '../scripts/run.mjs';

const mock = fileURLToPath(new URL('./mock-codex.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options: { root, codex: process.execPath, prefixArgs: [mock], concurrency: 2 } };
}
function job(root, id, prompt, refs = [], mode = 'generate') {
  const prompt_file = `${id}.txt`; fs.writeFileSync(path.join(root, prompt_file), prompt);
  return { id, mode, prompt_file, reference_images: refs, output_dir: 'output' };
}
function calls(root) { return fs.readdirSync(path.join(root, 'calls')).map(file => JSON.parse(fs.readFileSync(path.join(root, 'calls', file)))); }

test('worker bound, exact UTF-8 prompt suffix, ordered actual references, and fixed relay model', async t => {
  const { root, options } = fixture(t);
  fs.writeFileSync(path.join(root, 'original.png'), 'attachment one'); fs.writeFileSync(path.join(root, 'style.png'), 'attachment two');
  const exact = '\uFEFFAn image: 灯笼\r\n Keep two spaces.  \n';
  const refs = [{ path: 'original.png', role: 'edit_target' }, { path: 'style.png', role: 'style' }];
  const jobs = [job(root, 'edit', exact, refs, 'edit'), ...Array.from({ length: 5 }, (_, i) => job(root, `new-${i}`, `new image ${i}`))];
  const results = await runBatch(jobs, options);
  assert.equal(results.filter(r => r.status === 'generated').length, 6);
  const records = calls(root), edit = records.find(r => r.input === relayPrefix + exact);
  assert.ok(edit); assert.equal(edit.worker, '1');
  assert.deepEqual(edit.args.flatMap((arg, i) => arg === '--image' ? [edit.args[i + 1]] : []), refs.map(ref => path.join(root, ref.path)));
  for (const call of records) { assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-6-luna'); assert.ok(call.args.includes('model_reasoning_effort=low')); }
  const timeline = fs.readFileSync(path.join(root, 'timeline.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let active = 0, peak = 0; for (const event of timeline) { active += event.kind === 'start' ? 1 : -1; peak = Math.max(peak, active); assert.ok(active <= 2); }
  assert.equal(active, 0); assert.equal(peak, 2);
  assert.equal(records.filter(record => record.args.includes('--image')).length, 1);
});

test('resume verifies output hash and starts no workers for matching generated inputs', async t => {
  const { root, options } = fixture(t), jobs = [job(root, 'one', 'simple image')];
  const first = await runBatch(jobs, options); assert.equal(first[0].status, 'generated');
  const second = await runBatch(jobs, options); assert.equal(second[0].skipped, true); assert.equal(calls(root).length, 1);
  fs.writeFileSync(first[0].output_png, 'tampered');
  const third = await runBatch(jobs, options); assert.equal(third[0].status, 'generated'); assert.equal(calls(root).length, 2);
  fs.writeFileSync(path.join(root, 'one.txt'), 'changed prompt');
  const changed = await runBatch(jobs, options); assert.notEqual(changed[0].output_png, first[0].output_png); assert.ok(fs.existsSync(first[0].output_png));
});

test('copied project resumes relative receipts on another root without generation', async t => {
  const { root, options } = fixture(t), jobs = [job(root, 'portable', 'portable image')];
  const [first] = await runBatch(jobs, options);
  const receiptFile = path.join(path.dirname(first.output_png), 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ ...first, output_png: path.relative(root, first.output_png), attempt: path.relative(root, first.attempt) }));
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-moved-'));
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.cpSync(root, moved, { recursive: true });
  const [resumed] = await runBatch(jobs, { ...options, root: moved });
  assert.equal(resumed.skipped, true);
  assert.ok(resumed.output_png.startsWith(moved));
  assert.equal(calls(moved).length, 1);
});

test('false PNGs, absent tool evidence, failed/nonzero workers stay failed while other jobs finish', async t => {
  const { root, options } = fixture(t);
  const results = await runBatch(['FALSE_PNG', 'NO_TOOL_EVENT', 'FAIL_JOB', 'NONZERO_EXIT', 'ordinary'].map((p, i) => job(root, `job-${i}`, p)), options);
  assert.deepEqual(results.map(r => r.status), ['failed', 'failed', 'failed', 'failed', 'generated']);
  for (const result of results.slice(0, 4)) { assert.equal(result.output_png, null); assert.ok(result.error); assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(result.attempt), '..', 'receipt.json'))).status, 'failed'); }
  const retried = await runBatch([job(root, 'job-2', 'FAIL_JOB')], options); assert.equal(retried[0].status, 'failed'); assert.equal(calls(root).length, 6);
});

test('rejects reference output substitution and unsafe/missing job inputs', async t => {
  const { root, options } = fixture(t);
  const generated = await runBatch([job(root, 'original', 'simple image')], options);
  const refs = [{ path: generated[0].output_png, role: 'edit_target' }];
  const replaced = await runBatch([job(root, 'edit', 'REFERENCE_AS_OUTPUT', refs, 'edit')], options); assert.equal(replaced[0].status, 'failed');
  for (const id of ['../escape', 'a/b', 'a\\b', '', '.']) assert.throws(() => prepareJobs([job(root, 'safe', 'x'), { id, mode: 'generate' }], root));
  assert.throws(() => prepareJobs([job(root, 'missing-target', 'x', [], 'edit')], root), /edit_target/);
  assert.throws(() => prepareJobs([job(root, 'bad-hash', 'x', [{ ...refs[0], sha256: '0'.repeat(64) }])], root), /SHA-256/);
  await assert.rejects(() => runBatch([job(root, 'limit', 'x')], { ...options, concurrency: 65 }), /Concurrency/);
});

test('recovers an actual new built-in thread PNG when CLI hides tool events and file path', async t => {
  const { root, options } = fixture(t);
  options.env = { CODEX_HOME: path.join(root, 'codex-home') };
  const results = await runBatch([job(root, 'hidden', 'HIDDEN_BUILTIN_ARTIFACT NO_TOOL_EVENT')], options);
  assert.equal(results[0].status, 'generated');
  assert.equal(results[0].model_report.status, 'unavailable');
  assert.equal(results[0].generation_evidence, 'new_builtin_png_in_worker_thread_directory');
  assert.ok(fs.existsSync(results[0].output_png));
  const rejected = await runBatch(['OLD_ARTIFACT', 'MULTIPLE_ARTIFACTS'].map((marker, i) => job(root, `bad-${i}`, `HIDDEN_BUILTIN_ARTIFACT NO_TOOL_EVENT ${marker}`)), options);
  assert.deepEqual(rejected.map(result => result.status), ['unavailable', 'failed']);
});

test('cancellation and explicit tool errors fail even with a real new thread PNG', async t => {
  const { root, options } = fixture(t);
  options.env = { CODEX_HOME: path.join(root, 'codex-home') };
  const markers = ['CANCELLED_TOOL', 'ABORTED_TOOL', 'ERROR_FLAG_TOOL', 'INNER_FAILED_TOOL'];
  const results = await runBatch(markers.map((marker, i) => job(root, `tool-${i}`, `${marker} HIDDEN_BUILTIN_ARTIFACT`)), options);
  assert.deepEqual(results.map(result => result.status), markers.map(() => 'failed'));
  for (const result of results) { assert.equal(result.output_png, null); assert.match(result.error, /cancellation or failure/); }
  const ambiguous = await runBatch([job(root, 'ambiguous', 'AMBIGUOUS_TOOL')], options);
  assert.equal(ambiguous[0].status, 'failed');
  const resumeJobs = [job(root, 'old-receipt', 'normal generation')];
  const initial = await runBatch(resumeJobs, options);
  fs.writeFileSync(path.join(initial[0].attempt, 'events.jsonl'), JSON.stringify({ type: 'item.completed', item: { type: 'image_generation', status: 'cancelled' } }) + '\n');
  const resumed = await runBatch(resumeJobs, options);
  assert.equal(resumed[0].status, 'generated');
  assert.notEqual(resumed[0].attempt, initial[0].attempt);
  assert.notEqual(resumed[0].skipped, true);
});

test('rejects valid-checksum PNGs with incomplete pixels or invalid IHDR/filter values', async t => {
  const { root, options } = fixture(t);
  const markers = ['SHORT_SCANLINE', 'INVALID_PNG_COLOR', 'INVALID_PNG_DEPTH', 'INVALID_PNG_METHOD', 'INVALID_SCANLINE_FILTER', 'ADAM7_PNG', 'MISSING_PNG_PALETTE'];
  const results = await runBatch(markers.map((marker, i) => job(root, `png-${i}`, marker)), options);
  assert.deepEqual(results.map(result => result.status), markers.map(() => 'failed'));
  for (const result of results) { assert.equal(result.output_png, null); assert.ok(result.error); }
});
