#!/usr/bin/env node
// 테스트용 가짜 claude/codex — 받은 인자를 기록하고, stream-json 요청이면 FAKE_STREAM 파일 내용을 그대로 낸다.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, cwd: process.cwd(), nonblocking: process.env.MCP_CONNECTION_NONBLOCKING ?? null })}\n`);
  if (args.includes('stream-json') && process.env.FAKE_PERSIST === '1') {
    // Claude Code 가 큰 도구 결과를 남기는 자리를 흉내 낸다
    const d = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/s1/tool-results`;
    mkdirSync(d, { recursive: true });
    writeFileSync(`${d}/t.txt`, 'raw');
  }
  if (args.includes('stream-json')) process.stdout.write(readFileSync(process.env.FAKE_STREAM, 'utf8'));
  else process.stdout.write(`echo:${input.length}`);
});
