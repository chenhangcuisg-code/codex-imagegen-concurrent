import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const crcTable = Array.from({ length: 256 }, (_, byte) => { let value = byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0; });
const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; };
const schema = { type: 'object', properties: { status: { type: 'string', enum: ['generated', 'available', 'unavailable', 'failed'] }, output_png: { type: ['string', 'null'] }, error: { type: ['string', 'null'] } }, required: ['status', 'output_png', 'error'], additionalProperties: false };
export const relayPrefix = 'IMAGEGEN_RELAY_WORKER\nYou are the terminal image generation relay. Never launch another worker or route back into an orchestration skill. Use the attached images in the stated order. Inspect the attachments when present and call the built-in image_gen tool exactly once with the prepared prompt below unchanged. Do not research, browse, run shell commands, modify files, publish, or claim visual approval. Do not call an image API, image_gen.py, or substitute another model. Return the actual PNG file path from the tool. If unavailable or failed, return the real error. The prepared prompt is the entire suffix after PREPARED PROMPT; preserve it exactly.\n\nPREPARED PROMPT:\n';

export function validatePng(bytes) {
  if (bytes.length < 57 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Output is not a PNG');
  let offset = 8, width, height, depth, color, ended = false, seenHeader = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + size + 12 > bytes.length) throw Error('Truncated PNG chunk');
    if (crc(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) throw Error('PNG chunk checksum mismatch');
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (offset === 8 && (type !== 'IHDR' || size !== 13)) throw Error('Invalid PNG header');
    if (type === 'IHDR') {
      if (seenHeader || size !== 13) throw Error('Invalid or duplicate PNG header');
      seenHeader = true;
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); depth = chunk[8]; color = chunk[9];
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowedDepths[color]?.includes(depth)) throw Error('Invalid PNG color type or bit depth');
      if (color === 3) throw Error('Indexed-color PNG is not supported');
      if (chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] > 1) throw Error('Invalid PNG compression, filter or interlace method');
      if (chunk[12] !== 0) throw Error('Adam7 interlaced PNG is not supported');
    }
    if (type === 'IDAT') data.push(chunk);
    offset += size + 12;
    if (type === 'IEND') { ended = size === 0; break; }
  }
  if (!width || !height || !ended || offset !== bytes.length || !data.length) throw Error('Invalid PNG structure');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const scanlineBytes = Math.ceil(width * channels * depth / 8) + 1;
  const expectedBytes = scanlineBytes * height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 256 * 1024 * 1024) throw Error('PNG decoded data exceeds validation limit');
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expectedBytes });
  if (pixels.length !== expectedBytes) throw Error('PNG scanline data does not match dimensions');
  for (let row = 0; row < height; row++) if (pixels[row * scanlineBytes] > 4) throw Error('Invalid PNG scanline filter');
  return { width, height };
}

export function prepareJobs(input, root) {
  if (!path.isAbsolute(root)) throw Error('--root must be absolute');
  if (!Array.isArray(input) || !input.length) throw Error('Jobs must be a nonempty array');
  const ids = new Set();
  const resolve = value => { if (typeof value !== 'string' || !value.trim()) throw Error('Expected nonempty path'); return path.resolve(root, value); };
  return input.map(job => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(job.id ?? '') || ids.has(job.id)) throw Error('Invalid or duplicate job id');
    ids.add(job.id);
    if (!['generate', 'edit'].includes(job.mode)) throw Error('Job mode must be generate or edit');
    if (!Array.isArray(job.reference_images)) throw Error('reference_images must be an array');
    const promptBytes = fs.readFileSync(resolve(job.prompt_file));
    const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(promptBytes);
    if (!prompt.trim()) throw Error('Prompt must not be empty');
    const refs = job.reference_images.map(ref => {
      if (typeof ref.role !== 'string' || !ref.role.trim()) throw Error('Every reference requires a role');
      const file = resolve(ref.path), digest = sha(fs.readFileSync(file));
      if (ref.sha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(ref.sha256) || digest !== ref.sha256.toLowerCase())) throw Error('Reference SHA-256 mismatch');
      return { path: file, role: ref.role, sha256: digest };
    });
    if (job.mode === 'edit' && !refs.some(ref => ref.role === 'edit_target')) throw Error('Edit requires an actual edit_target reference');
    const prompt_sha256 = sha(promptBytes);
    const fingerprint = sha(JSON.stringify({ mode: job.mode, prompt_sha256, refs: refs.map(({ role, sha256 }) => ({ role, sha256 })), model: 'gpt-6-luna', reasoning: 'low', relay_version: 1 }));
    return { id: job.id, mode: job.mode, prompt, promptBytes, prompt_sha256, refs, fingerprint, directory: path.join(resolve(job.output_dir), job.id, fingerprint.slice(0, 16)) };
  });
}

function imageToolEvidence(file) {
  const evidence = { completed: false, failed: false };
  const hasFailure = value => {
    if (!value || typeof value !== 'object') return false;
    if (value.isError === true || value.success === false || ['cancelled', 'canceled', 'aborted', 'error', 'failed'].includes(value.status)) return true;
    return Object.values(value).some(child => child && typeof child === 'object' && hasFailure(child));
  };
  const hasSuccess = value => value && typeof value === 'object' && (value.success === true || ['completed', 'succeeded'].includes(value.status) || Object.values(value).some(child => child && typeof child === 'object' && hasSuccess(child)));
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line), item = event.item;
      if (!item || !['image_generation', 'mcp_tool_call', 'tool_call'].includes(item.type)) continue;
      const tool = [item.tool, item.name, item.tool_name, item.server].filter(value => typeof value === 'string').join(' ');
      if (item.type !== 'image_generation' && !/(?:^|[ ._])image_?gen(?:eration)?(?:$|[ ._])/i.test(tool)) continue;
      if (hasFailure(item)) evidence.failed = true;
      if (event.type === 'item.completed' && hasSuccess(item) && !hasFailure(item)) evidence.completed = true;
    } catch { /* Ignore unrelated malformed event lines. */ }
  }
  return evidence;
}

function threadArtifacts(eventFile, started, options) {
  const events = fs.readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const thread = events.find(event => event.type === 'thread.started')?.thread_id;
  if (typeof thread !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(thread)) return [];
  const codexHome = options.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const directory = path.join(codexHome, 'generated_images', thread);
  if (!fs.existsSync(directory)) return [];
  const finished = Date.now();
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.png')).map(entry => path.join(directory, entry.name)).filter(file => { const modified = fs.statSync(file).mtimeMs; return modified >= started - 2000 && modified <= finished + 2000; });
}

async function invoke(options, instruction, refs, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const resultFile = path.join(directory, 'model-result.json'), eventFile = path.join(directory, 'events.jsonl'), stderrFile = path.join(directory, 'stderr.txt'), schemaFile = path.join(directory, 'schema.json');
  json(schemaFile, schema);
  const args = [...(options.prefixArgs ?? []), 'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low', '--enable', 'image_generation', '--ephemeral', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', directory, '--output-schema', schemaFile, '--output-last-message', resultFile];
  for (const ref of refs) args.push('--image', ref.path);
  args.push('-');
  const log = fs.createWriteStream(eventFile), err = fs.createWriteStream(stderrFile);
  const started = Date.now();
  let code, processError;
  await new Promise(resolve => {
    const child = spawn(options.codex ?? 'codex', args, { cwd: options.root, shell: false, windowsHide: true, env: { ...process.env, ...options.env, CODEX_IMAGEGEN_WORKER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { processError = 'Worker timed out'; child.kill(); }, options.timeoutMs ?? 600000);
    child.stdout.pipe(log); child.stderr.pipe(err);
    child.stdin.on('error', () => {}); child.stdin.end(instruction);
    child.once('error', error => { processError = error.message; });
    child.once('close', exitCode => { code = exitCode; clearTimeout(timer); resolve(); });
  });
  await Promise.all([new Promise(resolve => log.end(resolve)), new Promise(resolve => err.end(resolve))]);
  if (processError || code !== 0) throw Error(processError ?? `Codex exited ${code}; inspect ${stderrFile}`);
  const answer = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  return { answer, eventFile, started };
}

export async function runBatch(input, options) {
  const concurrency = options.concurrency ?? 16;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw Error('Concurrency must be 1..64');
  const jobs = prepareJobs(input, options.root), results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++, job = jobs[index];
      fs.mkdirSync(job.directory, { recursive: true });
      const receiptFile = path.join(job.directory, 'receipt.json');
      try {
        const existing = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        const savedOutput = path.resolve(options.root, existing.output_png);
        const savedAttempt = path.resolve(options.root, existing.attempt);
        const bytes = fs.readFileSync(savedOutput);
        validatePng(bytes);
        const savedEvidence = imageToolEvidence(path.join(savedAttempt, 'events.jsonl'));
        if (savedEvidence.failed || (existing.generation_evidence === 'completed_image_tool_event' && !savedEvidence.completed)) throw Error('Previous tool evidence is invalid');
        if (existing.status === 'generated' && existing.fingerprint === job.fingerprint && existing.png_sha256 === sha(bytes)) { results[index] = { ...existing, output_png: savedOutput, attempt: savedAttempt, skipped: true }; continue; }
      } catch { /* Missing, failed or tampered receipt is resumable. */ }
      const attempt = path.join(job.directory, 'attempts', `${Date.now()}-${crypto.randomUUID()}`);
      fs.mkdirSync(attempt, { recursive: true });
      fs.writeFileSync(path.join(attempt, 'prompt.txt'), job.promptBytes);
      const receipt = { id: job.id, status: 'failed', mode: job.mode, model: 'gpt-6-luna', reasoning_effort: 'low', execution: 'codex_cli_builtin_image_gen', fingerprint: job.fingerprint, prompt_sha256: job.prompt_sha256, reference_images: job.refs, output_png: null, visual_review_status: 'pending', attempt, error: null };
      try {
        // Detect changed reference files immediately before attachment as well as during preparation.
        for (const ref of job.refs) if (sha(fs.readFileSync(ref.path)) !== ref.sha256) throw Error('Reference changed after preparation');
        const { answer, eventFile, started } = await invoke(options, relayPrefix + job.prompt, job.refs, attempt);
        receipt.model_report = answer;
        const toolEvidence = imageToolEvidence(eventFile);
        if (toolEvidence.failed) throw Error('Built-in image generation reported cancellation or failure');
        // CLI versions can save the built-in output without exposing tool events or its path to the model.
        // Collect only new PNGs in this exact worker thread's documented built-in destination.
        const artifacts = threadArtifacts(eventFile, started, options);
        if (artifacts.length > 1) throw Error('Worker produced multiple PNGs; expected one generation');
        const artifact = artifacts[0];
        if (!artifact && answer.status !== 'generated') { receipt.status = answer.status === 'unavailable' ? 'unavailable' : 'failed'; throw Error(answer.error ?? 'Worker did not generate an image'); }
        if (!artifact && !toolEvidence.completed) throw Error('No completed built-in image generation event or thread artifact');
        const outputPath = artifact ?? answer.output_png;
        if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw Error('Generated PNG path must be absolute');
        const source = fs.realpathSync(outputPath);
        if (job.refs.some(ref => fs.realpathSync(ref.path) === source)) throw Error('Reference file is not generated output');
        if (fs.statSync(source).mtimeMs < started - 2000) throw Error('Reported PNG predates this generation attempt');
        const bytes = fs.readFileSync(source), dimensions = validatePng(bytes);
        const target = path.join(job.directory, 'image.png');
        fs.writeFileSync(target, bytes);
        Object.assign(receipt, { status: 'generated', output_png: target, png_sha256: sha(bytes), dimensions, generated_source: source, generation_evidence: artifact ? 'new_builtin_png_in_worker_thread_directory' : 'completed_image_tool_event', error: null });
      } catch (error) { receipt.error = error.message; }
      json(receiptFile, receipt); results[index] = receipt;
      options.onResult?.(receipt);
    }
  }));
  return results;
}

async function main() {
  const args = process.argv.slice(2), value = key => { const i = args.indexOf(key); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing ${key} value`); return args[i + 1]; };
  const options = { root: value('--root'), codex: value('--codex'), concurrency: Number(value('--concurrency') ?? 16), timeoutMs: Number(value('--timeout-ms') ?? 600000) };
  if (!options.root || !path.isAbsolute(options.root)) throw Error('Supply an absolute --root');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw Error('Timeout must be at least 1000 ms');
  const runDir = path.join(path.resolve(options.root, value('--log-dir') ?? 'output/imagegen-runs'), `${Date.now()}-${crypto.randomUUID()}`);
  if (args.includes('--probe')) {
    const { answer } = await invoke(options, 'IMAGEGEN_RELAY_WORKER\nReport available only if the built-in image generation tool is exposed and callable in this session. Do not generate images, launch workers, browse, run commands, or read files. output_png must be null.', [], runDir);
    json(path.join(runDir, 'probe.json'), answer); console.log(JSON.stringify({ ...answer, directory: runDir, probe_only: true }));
    if (answer.status !== 'available' || answer.output_png !== null) process.exitCode = 1;
    return;
  }
  if (!value('--jobs')) throw Error('Supply --jobs <file> or --probe');
  const input = JSON.parse(fs.readFileSync(path.resolve(value('--jobs')), 'utf8').replace(/^\uFEFF/, ''));
  options.onResult = result => console.log(JSON.stringify({ id: result.id, status: result.status, output_png: result.output_png, error: result.error }));
  const results = await runBatch(input, options);
  fs.mkdirSync(runDir, { recursive: true }); json(path.join(runDir, 'results.json'), results);
  console.log(JSON.stringify({ directory: runDir, total: results.length, generated: results.filter(r => r.status === 'generated').length, skipped: results.filter(r => r.skipped).length, failed: results.filter(r => r.status !== 'generated').length, concurrency: Math.min(options.concurrency, results.length), visual_review_status: 'pending' }));
  if (results.some(result => result.status !== 'generated')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
