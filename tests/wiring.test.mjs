// 모듈 그래프와 DOM 결선을 정적으로 검사한다.
// 확장을 실제로 로드하지 않고도 "import 오타 / 없는 export / 없는 엘리먼트 id" 를 잡는다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label.padEnd(50) + (detail ?? ''));
  cond ? pass++ : fail++;
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
});

const ENTRIES = ['popup.js', 'debug.js'].map((f) => path.join(ROOT, f));
const SOURCES = [...ENTRIES, ...walk(path.join(ROOT, 'src'))];

const read = (f) => fs.readFileSync(f, 'utf8');
const IMPORT = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+'([^']+)'/g;
const EXPORT = /export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)|export\s*\{([^}]*)\}/g;

const exportsOf = (file) => {
  const names = new Set();
  for (const m of read(file).matchAll(EXPORT)) {
    if (m[1]) names.add(m[1]);
    if (m[2]) m[2].split(',').forEach((n) => names.add(n.trim().split(/\s+as\s+/).pop()));
  }
  return names;
};

// --- import 해석 + export 존재 확인 ---
{
  let broken = [];
  const edges = new Map();
  for (const file of SOURCES) {
    const deps = [];
    for (const m of read(file).matchAll(IMPORT)) {
      const spec = m[3];
      if (!spec.startsWith('.')) continue; // node: 내장 등은 건너뜀
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) { broken.push(`${path.relative(ROOT, file)} → ${spec} (파일 없음)`); continue; }
      deps.push(target);
      const available = exportsOf(target);
      const wanted = (m[1] || m[2] || '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of wanted) {
        if (!available.has(name)) broken.push(`${path.relative(ROOT, file)} → ${spec} 에 '${name}' export 없음`);
      }
    }
    edges.set(file, deps);
  }
  check(`import ${SOURCES.length}개 파일 전수 해석`, broken.length === 0, broken.join(' / ') || `${SOURCES.length}개 OK`);

  // --- 순환 참조 ---
  const cycles = [];
  const seen = new Map();
  const visit = (n, stack) => {
    if (stack.includes(n)) { cycles.push([...stack.slice(stack.indexOf(n)), n].map((f) => path.relative(ROOT, f)).join(' → ')); return; }
    if (seen.get(n)) return;
    seen.set(n, true);
    for (const d of edges.get(n) || []) visit(d, [...stack, n]);
  };
  for (const f of SOURCES) visit(f, []);
  check('순환 참조 없음', cycles.length === 0, cycles.join(' | ') || '없음');
}

// --- HTML 결선 ---
const wiring = [
  ['popup.html', 'popup.js'],
  ['debug.html', 'debug.js'],
];
for (const [htmlFile, jsFile] of wiring) {
  const html = read(path.join(ROOT, htmlFile));
  const js = read(path.join(ROOT, jsFile));

  check(`${htmlFile}: 모듈로 로드`, html.includes(`<script type="module" src="${jsFile}">`));
  check(`${htmlFile}: plato-api.js 참조 없음`, !html.includes('plato-api.js'));

  // HTML 에 있거나, JS 가 직접 만들어 넣는 id 면 유효하다.
  const has = (id) => html.includes(`id="${id}"`) || js.includes(`id="${id}"`);

  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = ids.filter((id) => !has(id));
  check(`${htmlFile}: 참조하는 id ${ids.length}개 모두 존재`, missing.length === 0, missing.join(', ') || 'OK');

  const selectors = [...js.matchAll(/querySelector\('#([a-z-]+)/g)].map((m) => m[1]);
  const missingSel = selectors.filter((id) => !has(id));
  check(`${htmlFile}: querySelector 대상 존재`, missingSel.length === 0, missingSel.join(', ') || 'OK');

  // 반대 방향: HTML 의 버튼에 핸들러가 붙어 있는가 (붙이는 걸 잊은 버튼 탐지)
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  const unbound = buttons.filter((id) => !js.includes(`'${id}'`));
  check(`${htmlFile}: 버튼 ${buttons.length}개 모두 핸들러 연결됨`, unbound.length === 0, unbound.join(', ') || 'OK');
}

// --- 삭제된 파일이 남아 참조되지 않는지 ---
check('plato-api.js 제거됨', !fs.existsSync(path.join(ROOT, 'plato-api.js')));
{
  const stale = SOURCES.concat(wiring.map(([h]) => path.join(ROOT, h)))
    .filter((f) => /plato-api\.js/.test(read(f)));
  check('plato-api 참조 잔존 없음', stale.length === 0, stale.map((f) => path.relative(ROOT, f)).join(', ') || 'OK');
}

// --- manifest 가 가리키는 파일이 존재하는지 ---
{
  const m = JSON.parse(read(path.join(ROOT, 'manifest.json')));
  const refs = [m.action.default_popup, ...Object.values(m.action.default_icon), ...Object.values(m.icons)];
  const missing = [...new Set(refs)].filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('manifest 참조 파일 존재', missing.length === 0, missing.join(', ') || 'OK');
  check('permissions 는 storage 하나', JSON.stringify(m.permissions) === '["storage"]', JSON.stringify(m.permissions));
  check('host_permissions 는 plato 하나', m.host_permissions.length === 1 && m.host_permissions[0].includes('plato.pusan.ac.kr'), JSON.stringify(m.host_permissions));
}

// --- 코드가 부르는 셀렉터/패턴 키가 실제로 정의되어 있는가 ---
// sel(profile, 'x') 는 없는 키에 throw 한다. 그 throw 가 try/catch 에 삼켜지면
// "전 과목 시간표 수집 실패" 같은 엉뚱한 증상으로만 드러난다. 실제로 겪었다.
{
  const { SELECTORS, PATTERNS } = await import('../src/config/selectors.js');
  const defined = {
    sel: new Set(Object.keys(SELECTORS.v2 || {})),
    pattern: new Set(Object.keys(PATTERNS.v2 || {})),
  };
  const bad = [];
  for (const f of SOURCES) {
    const src = read(f);
    for (const m of src.matchAll(/\b(sel|pattern)\(\s*\w+\s*,\s*'([^']+)'/g)) {
      if (!defined[m[1]].has(m[2])) bad.push(`${path.relative(ROOT, f)}: ${m[1]}('${m[2]}')`);
    }
  }
  const used = [...SOURCES.map(read).join('\n').matchAll(/\b(?:sel|pattern)\(\s*\w+\s*,\s*'([^']+)'/g)].length;
  check(`셀렉터/패턴 키 ${used}곳이 모두 정의되어 있음`, bad.length === 0, bad.join(', ') || 'OK');

  // 반대 방향: 정의만 되어 있고 아무도 안 쓰는 키 (자가진단 비용만 든다)
  const allSrc = SOURCES.map(read).join('\n');
  const unused = [...defined.sel, ...defined.pattern].filter((k) => !allSrc.includes(`'${k}'`));
  check('쓰이지 않는 셀렉터 없음', unused.length === 0, unused.join(', ') || 'OK');
}

// --- 화면이 참조하는 필드가 실제로 만들어지는가 ---
// 캐시 형태를 바꾸면서 popup/debug 를 안 고쳐 런타임 오류가 났던 적이 있다
// ("Cannot read properties of undefined (reading 'length')").
// 화면이 읽는 필드 이름이 소스 어딘가에서 실제로 만들어지는지 정적으로 본다.
{
  const ui = ['popup.js', 'debug.js'].map((f) => read(path.join(ROOT, f))).join('\n');
  const src = walk(path.join(ROOT, 'src')).map(read).join('\n');

  // 화면이 스캔 결과에서 꺼내 쓰는 필드
  const consumed = [...new Set(
    [...ui.matchAll(/\b(?:r|context|result)\.([a-zA-Z]\w+)/g)].map((m) => m[1])
  )];
  const missing = consumed.filter((name) => {
    if (/^(then|catch|map|filter|length|join|sort|includes|slice|some|every|forEach|push)$/.test(name)) return false;
    // 어딘가에서 그 이름으로 값을 만들고 있어야 한다
    return !new RegExp(`(^|[^.\\w])${name}\\s*[:,=]`, 'm').test(src)
      && !new RegExp(`\\b${name}\\b`).test(src);
  });
  check(`화면이 읽는 필드 ${consumed.length}개가 모두 소스에 존재`, missing.length === 0, missing.join(', ') || 'OK');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
