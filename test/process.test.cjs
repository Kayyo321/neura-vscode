const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProcess, JsonLineDecoder } = require('./load.cjs')('src/process.ts');

test('structured arguments cannot execute shell metacharacters', async () => {
  const argument = 'space ; $(printf injected) `echo injected` "quoted"';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);', argument], { cwd: process.cwd() });
  assert.equal(result.code, 0); assert.equal(result.stdout, argument);
});
test('split UTF8 output is reassembled without replacing characters', async () => {
  const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("😀é");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)'], { cwd: process.cwd() });
  assert.equal(result.stdout, '😀é');
});
test('exit codes and stderr survive', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.error("problem");process.exit(7)'], { cwd: process.cwd() });
  assert.equal(result.code, 7); assert.match(result.stderr, /problem/);
});
test('elapsed-time and output limits terminate processes', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), timeoutMs: 50 }), /time limit/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { cwd: process.cwd(), maxOutputBytes: 100 }), /output exceeded/);
});
test('NDJSON handles partial chunks and rejects corrupt framing', () => {
  const values = []; const decoder = new JsonLineDecoder(value => values.push(value));
  decoder.push('{"event":"out'); decoder.push('put","text":"hello"}\n\n{"event":"summary"}'); decoder.finish();
  assert.equal(values.length, 2); assert.equal(values[0].text, 'hello');
  assert.throws(() => new JsonLineDecoder(()=>{}).push('program output\n'), /JSON/);
  assert.throws(() => new JsonLineDecoder(()=>{}).push('[]\n'), /Invalid/);
  assert.throws(() => new JsonLineDecoder(()=>{}, 10).push('x'.repeat(11)), /size limit/);
});
test('callback failures terminate and reject instead of escaping the event loop', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x");setInterval(()=>{},1000)'], { cwd: process.cwd(), onStdout() { throw new Error('bad protocol'); } }), /bad protocol/);
});
