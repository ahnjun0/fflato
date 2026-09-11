// PLATO 는 한국어·영어·중국어를 지원한다. 서버 메시지 문구를 로직에 쓰면
// 언어를 바꾼 사용자에게서 깨진다. 새 API 는 { ok } 불리언과 응답 형식(JSON/HTML)
// 으로만 판별하므로 문구에 의존하지 않는다. 그 성질을 코드 전체에 대해 검사한다.
import fs from 'node:fs'; import path from 'node:path';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(52) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const q = path.join(d, e.name);
  return e.isDirectory() ? walk(q) : (e.name.endsWith('.js') ? [q] : []);
});
const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'popup.js'), path.join(ROOT, 'debug.js')];

const offenders = [];
for (const f of files) {
  for (const [i, line] of fs.readFileSync(f, 'utf8').split('\n').entries()) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/\.(includes|startsWith|endsWith|test)\(\s*['"`][^'"`]*[가-힣]/.test(line)
      || /\/[^/\n]*[가-힣][^/\n]*\/\s*\.test\(/.test(line)) {
      offenders.push(`${path.relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 70)}`);
    }
  }
}
check('한국어 문자열로 분기하는 코드 없음', offenders.length === 0, offenders.join(' | ') || 'OK');

// endedError 는 서버가 코드처럼 쓰는 값이라 예외다. 영문 소문자여야 한다.
const { profileForHost } = await import('../src/config/endpoints.js');
const p = profileForHost('plato.pusan.ac.kr');
check('endedError 는 언어 무관한 코드값', /^[a-z]+$/.test(p.endedError), p.endedError);
check('actions 값도 언어 무관', Object.values(p.actions).every((a) => /^[a-z]+$/i.test(a)), JSON.stringify(p.actions));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
