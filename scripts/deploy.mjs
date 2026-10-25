import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {localKey} from './local-key.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = localKey(root);
if (key && process.platform === 'win32') {
  console.error('Windowsでは npx wrangler secret put OPENAI_API_KEY でキーを登録し、npx wrangler deploy で公開してください。');
  process.exit(1);
}
// POSIX stdin is read as a file by Wrangler; no extra secret file is created.
const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
  ...(key ? ['--secrets-file', '/dev/stdin'] : []), ...process.argv.slice(2)],
  {cwd: root, stdio: [key ? 'pipe' : 'inherit', 'inherit', 'inherit']});
if (key) {child.stdin.on('error', () => {});child.stdin.end(JSON.stringify({OPENAI_API_KEY: key}));}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => {process.exitCode = code ?? 1;});
