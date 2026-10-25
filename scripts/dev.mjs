import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {localKey} from './local-key.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = localKey(root);
const env = {...process.env, ...(key ? {OPENAI_API_KEY: key} : {})};
// Only the secret named in wrangler.jsonc is imported from the child environment.
const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--ip', '127.0.0.1', ...process.argv.slice(2)], {cwd: root, env, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => {process.exitCode = code ?? 1;});
