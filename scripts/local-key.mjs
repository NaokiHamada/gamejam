import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
// Never log this return value or include it in command-line arguments.
export function localKey(root) {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const file = path.join(root, 'apikey.local');
  if (!existsSync(file)) return '';
  const content = readFileSync(file, 'utf8').trim();
  const match = content.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/m);
  return match ? match[1].replace(/^['"]|['"]$/g, '') : content.includes('\n') || content.includes('=') ? '' : content;
}
