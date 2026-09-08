#!/usr/bin/env node
// Passwords are accepted only over stdin, never argv, environment, or defaults.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createAccountAuth } from '../team-web/server/account-auth.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    db: { type: 'string' }, 'public-url': { type: 'string' }, username: { type: 'string', default: 'admin' },
    name: { type: 'string', default: '超级管理员' }, company: { type: 'string' },
  } });
  const mode = positionals[0];
  if (positionals.length !== 1 || !['create', 'reset'].includes(mode) || !values.db || !values['public-url']) {
    throw new Error('用法：node scripts/team-admin.mjs create|reset --db /path/team.sqlite --public-url https://team.example.com [--username admin] [--name 超级管理员] [--company 西浦]；密码仅从标准输入读取。');
  }
  if (process.stdin.isTTY) throw new Error('请通过隐藏输入或受保护管道提供密码；不要将密码放进命令行参数。');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('密码输入超出请求限制。');
    chunks.push(chunk);
  }
  // Strip only the single line ending introduced by a pipe; preserve password spaces.
  const supplied = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!supplied.trim()) throw new Error('密码不能为空。');
  const auth = createAccountAuth({ dbPath: resolve(values.db), publicUrl: values['public-url'], host: '127.0.0.1', nodeEnv: 'production' });
  try {
    const result = await auth.provisionSuperAdmin({ mode, username: values.username, name: values.name,
      password: supplied, ...(values.company === undefined ? {} : { company: values.company }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { auth.close(); }
}
main().catch(error => { process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`); process.exitCode = 1; });
