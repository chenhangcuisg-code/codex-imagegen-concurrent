import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2), option = flag => args[args.indexOf(flag) + 1];
const root = process.env.MOCK_PROJECT_ROOT ?? process.cwd(), output = option('--output-last-message');
const input = await new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => resolve(text)); });
const key = path.basename(path.dirname(output));
const record = { args, input, worker: process.env.CODEX_IMAGEGEN_WORKER };
fs.mkdirSync(path.join(root, 'calls'), { recursive: true });
fs.writeFileSync(path.join(root, 'calls', key + '.json'), JSON.stringify(record));
fs.appendFileSync(path.join(root, 'timeline.jsonl'), JSON.stringify({ at: Date.now(), kind: 'start', key }) + '\n');
await new Promise(resolve => setTimeout(resolve, 150));

function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const bytes = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); bytes.copy(out, 4); out.writeUInt32BE(crc(bytes), out.length - 4); return out; }
const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
if (input.includes('INVALID_PNG_COLOR')) header[9] = 7;
if (input.includes('MISSING_PNG_PALETTE')) header[9] = 3;
if (input.includes('INVALID_PNG_DEPTH')) header[8] = 4;
if (input.includes('INVALID_PNG_METHOD')) header[10] = 1;
if (input.includes('ADAM7_PNG')) header[12] = 1;
const defaultPixelBytes = Buffer.from([0, 0, 255, 255, 255]);
const pixels = input.includes('SHORT_SCANLINE') ? [0] : input.includes('INVALID_SCANLINE_FILTER') ? [5, 0, 255, 255, 255] : defaultPixelBytes;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(pixels))), chunk('IEND', Buffer.alloc(0))]);
const image = path.join(path.dirname(output), 'mock-generated.png');
fs.writeFileSync(image, input.includes('FALSE_PNG') ? 'not a PNG' : png);
let answer = { status: 'generated', output_png: image, error: null };
if (input.includes('FAIL_JOB')) answer = { status: 'failed', output_png: null, error: 'mock generation failed' };
if (input.includes('REFERENCE_AS_OUTPUT')) answer.output_png = option('--image');
const imageItem = { type: 'image_generation', status: 'completed', tool: 'image_gen', output: image };
if (input.includes('CANCELLED_TOOL')) imageItem.status = 'cancelled';
if (input.includes('ABORTED_TOOL')) imageItem.status = 'aborted';
if (input.includes('ERROR_FLAG_TOOL')) imageItem.isError = true;
if (input.includes('INNER_FAILED_TOOL')) imageItem.result = { success: false };
if (input.includes('AMBIGUOUS_TOOL')) imageItem.status = 'running';
if (!input.includes('NO_TOOL_EVENT')) console.log(JSON.stringify({ type: 'item.completed', item: imageItem }));
if (input.includes('HIDDEN_BUILTIN_ARTIFACT')) {
  const thread = 'mock-thread-' + key;
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
  const directory = path.join(process.env.CODEX_HOME, 'generated_images', thread);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'exec-output.png'), png);
  if (input.includes('OLD_ARTIFACT')) fs.utimesSync(path.join(directory, 'exec-output.png'), 0, 0);
  if (input.includes('MULTIPLE_ARTIFACTS')) fs.writeFileSync(path.join(directory, 'exec-other.png'), png);
  answer = { status: 'unavailable', output_png: null, error: 'tool returned no file path' };
}
fs.writeFileSync(output, JSON.stringify(answer));
fs.appendFileSync(path.join(root, 'timeline.jsonl'), JSON.stringify({ at: Date.now(), kind: 'end', key }) + '\n');
if (input.includes('NONZERO_EXIT')) process.exitCode = 3;
