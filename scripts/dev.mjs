import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {localKey} from './local-key.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = localKey(root);
const env = {...process.env, ...(key ? {OPENAI_API_KEY: key} : {})};
// Do not connect local development to the account's production Secrets Store.
const config = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
delete config.secrets_store_secrets;
config.main = path.join(root, config.main);
config.assets.directory = path.join(root, config.assets.directory);
config.secrets = {required: ['OPENAI_API_KEY']};
mkdirSync(path.join(root, '.wrangler'), {recursive: true});
const localConfig = path.join(root, '.wrangler', 'local-config.json');
// This generated config contains names and paths only, never the API key.
writeFileSync(localConfig, JSON.stringify(config, null, 2));
const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev',
  '--config', localConfig, '--persist-to', path.join(root, '.wrangler', 'state'), '--ip', '127.0.0.1', ...process.argv.slice(2)], {cwd: root, env, stdio: 'inherit'});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => {process.exitCode = code ?? 1;});
