# PLATO 통신 규약

`src/config/` 의 값들이 어디서 나왔는지, 무엇이 실측이고 무엇이 추정인지 기록한다.
전부 2026-09 기준 실측이다.

## 학생 출결은 `local/ubsmartbook` 이다

같은 화면에 플러그인 두 개가 얽혀 있다. 헷갈리면 안 된다.

| | `local/ubattend` | `local/ubsmartbook` |
|---|---|---|
| 정체 | 벤더(교수자) 모듈 | 부산대가 얹은 학생용 |
| 학생 인증번호 입력 | **없음** | **여기 있음** |
| 액션 파라미터 | `coursemostype` | `action` |
| 응답 | `{code, msg}` | `{ok, error}` |

`ubattend` 의 자바스크립트 번들에는 `smartAttemptAnswer`, `smartAnswer(endTime)`,
`#modal-smart-answer` 가 다 들어 있고 서버도 그 액션들을 등록해 두고 있다.
그럴듯해 보이지만 **학생 화면에는 렌더되지 않는다.** 이것만 보고 구현했다가
첫 실제 출결에서 아무것도 감지하지 못했다.

> 번들에 있다는 것이 실제로 쓰인다는 뜻은 아니다.

## 인증번호 입력

세션이 열리면 `/local/ubsmartbook/my.php?id=<courseid>` 에 폼이 렌더된다.
세션이 없거나 출석이 끝나면 이 블록은 통째로 사라진다 (출석 직후 "출석
처리되었습니다" 를 0.8초 보여주고 새로고침한다).

폼은 9월 한 달 동안 세 번 바뀌었다. 리더를 여럿 두고 순서대로 시도하는 이유다.

### 2026-09-16 — 폼에 히든 필드 (현재, `readForm`)

```html
<form id="sb-smart-answer-form" action="…/local/ubsmartbook/action.php" method="post" class="d-flex">
  <input type="hidden" name="id" value="6539">
  <input type="hidden" name="action" value="smartanswer">
  <input type="hidden" name="sesskey" value="…">
  <input type="hidden" name="smartid" value="3197">
  <input type="text" id="sb-smart-answer-key" name="authkey" inputmode="numeric" …>
  <button type="submit" class="btn btn-primary btn-sm">확인</button>
</form>
<div id="sb-smart-answer-msg" class="mt-2 fw-bold" role="alert" hidden></div>
```

서버가 "이걸 보내라" 고 적어 둔 그대로라 가장 좋은 출처다. 지금까지 상수로
채우던 `action=smartanswer` 를 페이지에서 읽는다 — 캡처 대조표의 `assumed` 가
빈다. `sesskey` 와 `authkey` 는 읽지 않고 제출 때 채운다. 마감 시각과 문구는
폼에 없으므로 아래 설정 JSON 에서 가져온다 (같은 페이지에 그대로 있다).

AMD 핸들러가 참조하는 `#sb-smart-remain`(남은 횟수 표시) 요소는 이 저장본에
**없다.** 코드는 있지만 아직 렌더되지 않는다.

### 2026-09-07 — 설정 JSON (`readConfig`)

```js
require(['local_ubsmartbook/my'], amd => amd.smartAnswer({
  "endtime":1788760181, "courseid":6552, "smartid":995, "sesskey":"…",
  "actionurl":"https:\/\/plato.pusan.ac.kr\/local\/ubsmartbook\/action.php",
  "msgSuccess":"출석 처리되었습니다.", "msgWrong":"인증번호가 일치하지 않습니다.",
  "msgEnded":"자동출결이 종료되었습니다.",
  "msgExceeded":"입력 시도 0회 초과하여서 부정출결처리 됩니다."   // 09-16 추가
}));
```

폼에 `name` 이 없던 시기. 감싸는 함수 이름을 보지 않고 `"smartid"` 를 담은 JSON
객체로 찾는다. `action` 값은 여기에도 없어 상수로 채웠다.

### 2026-09-01 — 인라인 `$.post` (`readInlinePost`)

```js
var endtime = 1788327638;
$.post(M.cfg.wwwroot + '/local/ubsmartbook/action.php', {
  id: 1001, action: 'smartanswer', sesskey: M.cfg.sesskey, smartid: 12345, authkey: authkey
})
```

호출을 통째로 읽어 파라미터를 그대로 쓴다 (`parsePayload`). PLATO 가 되돌릴
수도 있으니 남겨 둔다.

## 제출

```
POST /local/ubsmartbook/action.php
Content-Type: application/x-www-form-urlencoded   (jQuery $.post 기본값)
  action=smartanswer  id=<courseid>  smartid=<n>  sesskey=<...>  authkey=<입력>
→ 200 application/json   {"ok":true}
                       | {"ok":false,"error":"wrong_key","remain":<n>}   불일치 · 남은 시도 (실측 2026-09-16)
                       | {"ok":false,"error":"exceeded"}                 시도 횟수 초과
                       | {"ok":false,"error":"ended"}                    자동출결 종료
```

세 코드는 PLATO 의 AMD 핸들러 `local_ubsmartbook/my` (2026-09-16 저장본의
`requirejs.php`) 에서 읽었다. `wrong_key` 만 실제 응답으로도 봤다. 핸들러 원문:

```js
if (res && res.ok) showMsg(cfg.msgSuccess)
else {
  var msg = cfg.msgWrong;
  if (res.error === 'ended')         msg = cfg.msgEnded;
  else if (res.error === 'exceeded') { msg = cfg.msgExceeded; remainEl.textContent = "0"; }
  else if (res.error === 'wrong_key' && typeof res.remain === 'number') remainEl.textContent = res.remain;
  showMsg(msg, true);
}
```

두 가지가 여기서 나온다. (1) **모르는 코드는 PLATO 도 "불일치" 로 취급한다.** 우리도
같되, 서버 응답을 뒤에 붙여 단서를 남긴다. (2) **문구는 페이지 설정 JSON 이 준다**
(`msgWrong`, `msgEnded`, `msgExceeded`, `msgSuccess`). 서버가 언어에 맞춰 준 것이라
우리가 적어 둔 한국어 대신 그걸 쓴다. 옛 인라인 형태에는 없으므로 그때는 우리 문구다.

오류 동작:

| 상황 | 응답 |
|---|---|
| `action` 또는 `id` 누락 | **404 HTML** |
| `sesskey` 누락 · 불일치 | **404 HTML** |
| 모르는 `action` | **404 HTML** |
| `smartid` / `authkey` 누락 | 200 JSON `{ok:false, error:"필수 매개변수 (…) 누락"}` |

`error` 는 위 세 코드로만 분기한다. 문구를 보고 판정하지 않으므로 언어 설정과 무관하다.

### 서버 메시지는 언어에 따라 바뀐다

PLATO 는 한국어·영어·중국어를 지원하고 사용자가 언어를 바꾸면 응답 문구도 바뀐다.

```
ko  [probeXYZ123] 으로 등록된 함수가 없습니다.
en  No function registered as [probeXYZ123].
ko  - 스마트 출석 고유 번호는 필수 입력 항목입니다.
en  - Smart Attendance Unique Number is a required field.
```

**문구를 로직에 쓰면 안 된다.** 같은 이유로 화면의 한국어 배지
("자율강좌" / "교과과정")로 과목을 구분하지 않는다 — `shortname` 의 학수번호는
언어와 무관하다. `tests/i18n.test.mjs` 가 이 규칙을 코드 전체에 대해 검사한다.

### 자기 기술 오라클

필수 파라미터(`action`, `id`, `sesskey`)를 갖춘 상태에서

- 살아 있는 액션 → **200 JSON**
- 모르는 액션 → **404 HTML**

이 차이로 액션 이름의 유효성만 확인할 수 있다. 파라미터를 채우지 않으므로
어떤 상태도 바꾸지 않고, 문구를 보지 않으므로 ko/en/zh 어디서나 동작한다.
`src/core/health.js` 가 이걸 쓴다. PLATO 가 또 바뀌면 이 검사가 먼저 빨간불이 켜진다.

## 출결 상태

전체 목록은 학생 페이지의 **"세부 출결 상태"** 요약에서 확인했다(2026-09-04).
서버가 매 페이지에 다섯 항목을 모두 실어 주므로 관측이 아니라 전수다.

| 클래스 | 표시 | 우리 해석 |
|---|---|---|
| `csms-chips-blue` | 출석 | 응답 반영됨 |
| `csms-chips-red` | 결석 | **반영 안 됨. 세션 진행 중 기본값이기도 하다** |
| `csms-chips-green` | 지각 | 응답 반영됨 |
| `csms-chips-yellow` | 조퇴 | 응답 반영됨 |
| `csms-chips-gray-light` | 지각 조퇴 | 응답 반영됨 |
| (칩 없음) | `-` | 아직 도래하지 않은 차시 |

> 벤더 페이지(`local/ubattend/my.php`)의 교수용 드롭다운은 4개(출석/결석/지각/기타)
> 뿐이고 `gray-light` 를 "기타" 라 부른다. 같은 클래스를 다르게 쓰는 셈이니,
> 벤더 쪽 라벨은 참고만 한다.

### 결석 칩은 두 상황을 뜻한다

같은 `csms-chips-red` 가 서로 다른 상황에 붙는다. 실제 저장본으로 확인:

    2026-09-02  자동출결 진행 중, 아직 응답 안 함   →  결석 (red)
    2026-09-04  세션 종료, 결석 확정              →  결석 (red)

구분되지 않으므로 **이 값으로 "볼 필요 없음" 을 판단하면 안 된다.**
출결이 열려 있는 바로 그 순간에도 결석으로 표시된다.

### 요약 섹션 (2026-09-04 추가)

학생 페이지에 상태별 집계와 출석률이 생겼다. 9월 3일에는 없었다.

```
.attendance-info
  .attendance-guide-progress.level-danger   "출석률이 매우 낮습니다…"
  .progress-container                       "총 15개의 출결 항목 중 0개의 출석  0%"
  .attendance-status-list
    .status-item  "0 출석" / "1 결석" / "0 지각" / "0 조퇴" / "0 지각 조퇴" / "14 -"
```

이 집계는 서버가 직접 센 값이라 우리가 표를 세는 것보다 정확하고, 조퇴·지각조퇴
처럼 구분이 까다로운 것도 들어 있다. 같은 페이지라 추가 요청이 없다.

무엇보다 **범례가 매번 실려 온다.** 자가진단이 이것을 `STATUS_CHIPS` 와 대조하므로,
PLATO 가 상태를 늘리면 다음 자가진단에서 드러난다.

출결의 단위는 하루가 아니라 **차시**다 — 이 표의 한 행(수업일자 + 교시).
연강이면 같은 날 두 번 열린다.

### 벤더 페이지에서 가져온 것 / 가져오지 않은 것

`local/ubattend/my.php` (273KB) 에는 학생 화면에 없는 것이 더 있다.
정적 지식은 한 번 캐서 코드에 담고, 매번 받아야 하는 것은 가져오지 않는다.

| 항목 | 판단 |
|---|---|
| 상태 목록 (출석/결석/지각/기타/초기화) | **가져옴.** 정적 지식이라 `selectors.js` 에 담았다 |
| 출결 요약 카운트 (`.attendance-status-list`) | **개념만.** 같은 값을 우리가 이미 받은 표에서 센다 (요청 0) |
| 경고 문구 ("출석률이 매우 낮습니다") | 서버 계산값. 매번 273KB 를 받아야 해서 가져오지 않는다. 카운트로 대신한다 |
| `classperiodid`, 차시별/활동별 구분, hyflex | 우리 목적에 필요하지 않다 |

## 자율강좌 구분

PLATO 가 자율강좌만 싣는 페이지를 따로 준다.

```
GET /local/ubeclass/my.php     (217KB)
  <h2>자율강좌</h2>
  a.course-card[href*="/course/view.php?id="]  ×3
```

**서버가 스스로 가르는 기준**이라 이름 추측보다 확실하다.
실측(2026-09-03)에서 교과 과목은 한 건도 섞이지 않았다.

신 대시보드에는 구분 표시가 **없다**. 구 시스템에는 `li.course-label-r`(교과) /
`li.course-label-cms-e`(자율) 클래스가 있었지만 개편되며 사라졌고, 새 카드에는
클래스도 data 속성도 없다. 화면의 "자율강좌" 배지 글자는 언어에 따라 바뀌므로
쓰지 않는다.

웹서비스 쪽도 확인했다. `core_course_get_enrolled_courses_by_timeline_classification`
이 주는 필드에는 카테고리 **이름**(`coursecategory`)만 있고 ID 는 없다.
`core_enrol_get_users_courses` 는 `servicenotavailable` 이다.

이 목록을 24시간 캐시하고, 목록에 있는 강좌는 시간표조차 받지 않는다.
목록을 못 받으면 아무도 제외되지 않고 아래의 출석부 판정이 그대로 동작한다 —
느릴 뿐 틀리지 않는다.

## 출석부가 없는 강좌

자율강좌는 `ubsmartbook/my.php` 에 출결 표(`table.table-local-ubattend`) 자체가
렌더되지 않는다. 한 번 받아 보면 확정적으로 알 수 있으므로, 이름 규칙에 기대지 않고
이걸로 조회 대상에서 뺀다 (`src/core/schedule.js` 의 `hasAttendanceLedger`).

`shortname` 으로도 1차 판별을 하지만 이름은 바뀐다 — 2026-09-01 에
`…_mig4392` 였던 강좌가 이틀 뒤 접미사 없는 해시로 바뀌어 있었다.

## 과목 목록

대시보드 스크래핑 대신 Moodle 표준 AJAX 웹서비스를 쓴다. 쿠키 + sesskey 로 열린다.

```
POST /lib/ajax/service.php?sesskey=<sesskey>&info=core_course_get_enrolled_courses_by_timeline_classification
[{ "index":0, "methodname":"…", "args":{"classification":"inprogress","limit":0,"offset":0,"sort":"fullname"} }]
```

sesskey 가 만료되면 `errorcode: "invalidsesskey"` 를 준다. 그때만 홈페이지를 받아
갱신하고 한 번 재시도한다.

교과/자율 구분은 `shortname` 으로 한다.

```
교과  "과목다 (2026-0000, AA2222222_003)"     → 분반 062
자율  "fedcba9876543210fedcba9876543210"
      "fedcba9876543210fedcba9876543210_mig4392"   (접미사는 있을 수도 없을 수도)
```

판별이 안 되면 `unknown` 으로 두고 조회 대상에 남긴다 — 요청 하나가 더 드는 것이
놓치는 것보다 낫다. 그렇게 남은 강좌도 한 번 조회하면 출석부 유무로 확정된다.

## 페이지 무게

압축 전(HTML 원본) 기준이다. 서버가 gzip 을 적용하므로 실제 전송량은 약 1/5.

| | 압축 전 | 실제 전송 | 응답 |
|---|---|---|---|
| `ubsmartbook/my.php` | 194KB | 44KB | ~400ms |
| 홈페이지 (sesskey 용) | 342KB | 64KB | ~1000ms |
| 웹서비스 (과목 목록) | 93KB | — | ~100ms |

홈페이지는 sesskey 10글자를 얻으려고 받는 것이라 캐시한다. 미리 유효성을
확인하지 않는다 — 확인 자체가 요청 하나다. 서버가 거부할 때만 갱신한다.

## 개편 전 시스템

2026-09 이전에는 `local/ubattendance` 였고 지금은 전부 404 다.

| 용도 | 구 | 신 |
|---|---|---|
| 출결 폼 | `ubattendance/autoattendance.php` | `ubsmartbook/my.php` |
| 출석 현황 | `ubattendance/my_status.php` | `ubsmartbook/my.php` |
| 제출 | `ubattendance/user_action.php` | `ubsmartbook/action.php` |

구 시스템의 `my_status.php` 는 **결석을 행 단위로 표시하지 않았다.** 합계에는
"결석 : 1" 이 뜨는데 해당 행의 결석 칸은 `&nbsp;` 였다. 결석 판정은 "과거 날짜인데
출석 칸이 비어 있음" 으로 해야 했다. 신 시스템은 행마다 상태가 명시된다.

`dev-plato.pusan.ac.kr` 에 개편 전 시스템이 남아 있어 마이그레이션 중에는 대조군으로
썼지만 코드에는 남기지 않았다 — 배포판에 그 호스트 권한을 요구할 이유가 없다.

## 아직 확인하지 못한 것

- **연강(같은 날 2차시) 실물.** 이번 학기 수강 과목은 모두 하루 1교시라
  같은 날짜에 두 행이 생기는 경우를 보지 못했다. 코드와 테스트는 그 경우를
  상정해 두었다.
