/**
 * 우영역 — 월~금 시간표 (겹쳐보기 히트맵)
 *
 * 디자인 사양: docs/frontend_DESIGN.md
 * 데이터·시각 상태를 이 파일이 소유하고, 좌영역에는 이벤트로 넘긴다.
 *   'tt:update' → now.js   (지금 수업 중인 사람)
 *   'tt:focus'  → nowinfo.js (마우스를 올린 영역, hover)
 *   'tt:pin'    → nowinfo.js (클릭해 고정한 영역)
 *
 * 두 가지 그리기 방식:
 *   2명 이상  — 수업마다 연한 반투명 파란 박스를 하나씩 그린다. 겹치면 알파가
 *              쌓여 저절로 진해진다 (사람별 색은 쓰지 않는다).
 *   혼자만    — 그 사람 수업을 수강학년 색(1학년 노랑·2학년 초록…)의 불투명
 *              블록으로. 과목·강의실·교수·시간 글자가 블록 안에 들어간다.
 *
 * 구성원 필터:
 *   구성원 칩은 **항상 보인다.**
 *   전체 선택(체크)  — 전원. 칩이 모두 활성(회색)이 된다.
 *   칩 클릭          — 전체 선택 상태였다면 체크가 풀리고 그 사람 한 명만 남는다.
 *                      아니면 그 칩만 켜고 끈다. 전원이 켜지면 체크가 다시 붙는다.
 *   1명이면 수강학년 블록, 2명 이상이면 반투명 겹침.
 *
 * ⚠️ 세로축은 5분 단위 선형 시간 그대로다(시간 라벨도 유지). 다만 **그리는
 * 영역은 교시 밴드에 맞춘다** — 09:00~11:50 수업은 1·2·3교시를 채워 09:00~12:00으로
 * 그려지고, 12:00에 시작하는 다음 수업과 딱 붙는다. 이게 없으면 교시 사이
 * 쉬는 시간(09:50~10:00)이 전부 빈틈으로 남는다.
 */

(function () {
  'use strict';

  var DAYS     = ['월', '화', '수', '목', '금'];
  var ROW_H    = 28;      // 30분 한 칸 높이(px) — css의 --row-h와 반드시 일치
  var STEP     = 5;       // 그리드 최소 단위(분) — 백엔드 SLOT_MIN과 일치
  var VIEW_MIN = 540;     // 기본 표시 시작 09:00 (시안 기준)
  var VIEW_MAX = 1140;    // 기본 표시 끝   19:00
  var HARD_MIN = 480;     // 08:00 — 백엔드 TIME_MIN
  var HARD_MAX = 1440;    // 24:00 — 백엔드 TIME_MAX
  var TICK_MS    = 60 * 1000;
  var REFRESH_MS = 5 * 60 * 1000;

  // 열 배치: [교시(50분제)] [시간] [월~금] [교시(75분제)]
  var COL_DAY0 = 3;       // 월요일 열 번호 (1=50분제축, 2=시간축)
  var COL_P75  = 8;       // 금요일 오른쪽 75분제 축

  /**
   * 교시 밴드 — [교시명, 시작, 밴드끝]. 밴드끝은 **다음 교시가 시작하는 시각**이다.
   *
   * 1교시는 09:00~09:50이지만 밴드는 09:00~10:00이다. 블록을 밴드에 맞춰 그려야
   * 1교시 수업과 2교시 수업이 붙는다 — 쉬는 시간 10분이 빈틈으로 남지 않는다.
   * 시작 시각은 백엔드 _lib.php의 PERIODS_50 / PERIODS_75와 반드시 같아야 한다.
   *
   * 두 체계는 3시간마다(540·720·900·1080) 경계가 맞는다 — 50분제 3칸 = 75분제 2칸.
   */
  function bands(names, first, step) {
    return names.map(function (name, i) {
      return { name: name, start: first + i * step, end: first + (i + 1) * step };
    });
  }
  var P50 = bands(['0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15'], 480, 60);
  var P75 = bands(['A','B','C','D','E','F','G'], 540, 90);

  var $ = function (id) { return document.getElementById(id); };

  var gridEl    = $('grid'),
      selectAll = $('select-all'),
      chipsEl   = $('member-chips'),
      legendHeatEl  = $('legend-heat'),
      legendGradeEl = $('legend-grade'),
      tipEl     = $('tooltip'),
      liveDot   = $('live-dot');

  // ── 반투명 겹침 ───────────────────────────────────────────────────
  // 수업 하나 = 연한 반투명 파란 박스 하나. 여러 장이 겹치면 알파가 쌓여
  // 저절로 진해진다. 인원수를 세어 팔레트에서 색을 고르던 방식(Blues 히트맵)은
  // 폐기했다 — 박스가 실제로 겹쳐 보여야 "몇 명이 몰렸는지"가 형태로도 읽힌다.
  var WASH_RGB = [0, 113, 227];   // --accent (#0071e3)
  var WASH_A   = 0.13;            // 한 장의 알파. 진하기를 바꾸려면 여기만
  var PAPER    = [255, 255, 255]; // --paper — 범례 색을 미리 합성할 때 쓴다

  /**
   * 반투명 박스 n장이 흰 종이 위에 겹쳤을 때의 색.
   *
   * 알파 합성은 한 장 얹을 때마다 남는 투명도가 (1-a)배씩 줄어드는 거듭제곱이라
   * 최종 알파는 1-(1-a)^n 이다. 범례는 실제로 겹쳐 그리는 게 아니라 이 식으로
   * 같은 색을 미리 계산해 칠한다 — 그래야 그리드와 범례가 정확히 일치한다.
   */
  function washColor(count) {
    if (count <= 0) { return null; }
    var a = 1 - Math.pow(1 - WASH_A, count);
    return 'rgb(' +
      Math.round(PAPER[0] + (WASH_RGB[0] - PAPER[0]) * a) + ',' +
      Math.round(PAPER[1] + (WASH_RGB[1] - PAPER[1]) * a) + ',' +
      Math.round(PAPER[2] + (WASH_RGB[2] - PAPER[2]) * a) + ')';
  }

  // ── 교시 밴드 맞추기 ──────────────────────────────────────────────
  /**
   * 수업 시각을 교시 밴드에 맞춘다 → [밴드시작, 밴드끝].
   *
   * 50분제와 75분제 중 **덜 늘어나는 쪽**을 고른다. 어느 체계의 수업인지는
   * 데이터에 없지만, 실제 교시에 맞춰 입력된 값이라 낭비가 적은 쪽이 곧 원래
   * 체계다. 예: 10:30~11:45는 75분제 B(→10:30~12:00, 15분 낭비)이고 50분제로
   * 보면 2·3교시에 걸쳐(→10:00~12:00, 45분 낭비) 훨씬 크게 번진다.
   */
  function fit(table, start, end) {
    var lo = null, hi = null;
    table.forEach(function (p) {
      if (p.start < end && start < p.end) {
        if (lo === null) { lo = p.start; }
        hi = p.end;
      }
    });
    return lo === null ? [start, end] : [lo, hi];
  }

  function snap(start, end) {
    var a = fit(P50, start, end);
    var b = fit(P75, start, end);
    // 동점이면 50분제 — 학부 수업의 다수가 50분제다
    return (b[1] - b[0]) < (a[1] - a[0]) ? b : a;
  }

  /** 행마다 교시 밴드 좌표(_s·_e)를 붙인다. start·end 원본은 표시용으로 남긴다. */
  function withBands(rows) {
    return rows.map(function (r) {
      var s = snap(r.start, r.end);
      var o = {};
      for (var k in r) { o[k] = r[k]; }
      o._s = s[0];
      o._e = s[1];
      return o;
    });
  }

  // ── 상태 ──────────────────────────────────────────────────────────
  var state = {
    rows: [],               // 원본 행
    view: [],               // 원본 + 교시 밴드 좌표(_s·_e). 그리기는 전부 이걸 쓴다
    members: [],
    now: { day: 0, minutes: 0 },
    gridStart: VIEW_MIN,
    gridEnd: VIEW_MAX,

    allOn: true,            // 전체 선택 상태 (칩은 이때도 계속 보인다)
    selected: {},           // { 이름: true } — allOn이 false일 때 그릴 구성원

    regions: {},            // 키 → 영역. hover/click이 여기서 찾아 쓴다
    hoverKey: null,         // 지금 마우스가 올라가 있는 영역의 키
    pinnedKey: null,        // 클릭해 고정한 영역의 키
    base: null,             // 서버가 알려준 기준 시각 + 그때의 브라우저 시각
    clockOffset: 0          // 서버 시각 - 브라우저 시각 (밀리초)
  };

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmt(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }

  // ── 표시 범위 ─────────────────────────────────────────────────────
  // 08:00~24:00 전체를 그리면 5분 행이 192개가 된다. 기본은 시안대로
  // 09:00~19:00을 쓰고, 그 밖의 수업이 있으면 그만큼만 정시 단위로 넓힌다.
  // 범위는 원본이 아니라 **교시 밴드 좌표**로 잡는다. 밴드가 원본보다 넓어
  // 그대로 두면 마지막 수업의 아래쪽이 잘린다.
  function computeRange(rows) {
    var min = VIEW_MIN, max = VIEW_MAX;
    rows.forEach(function (r) {
      if (r._s < min) { min = r._s; }
      if (r._e > max) { max = r._e; }
    });
    return [
      Math.max(HARD_MIN, Math.floor(min / 60) * 60),
      Math.min(HARD_MAX, Math.ceil(max / 60) * 60)
    ];
  }

  /** 지금 화면에 겹쳐지는 행 — 전체 선택이 아니면 칩으로 고른 사람만 */
  function shownRows() {
    if (state.allOn) { return state.view; }
    return state.view.filter(function (r) { return state.selected[r.member]; });
  }

  /** 지금 겹쳐보기 대상인 구성원 수 (툴팁의 "n명 가능" 기준) */
  function shownMemberCount() {
    if (state.allOn) { return state.members.length; }
    return state.members.filter(function (m) { return state.selected[m.name]; }).length;
  }

  /** 혼자만 골라 수강학년 블록으로 보는 상태인가 */
  function isSingleView() {
    return !state.allOn && shownMemberCount() === 1;
  }

  /** Now info로 넘기는 한 수업의 정보 */
  function toItem(r) {
    return {
      member: r.member, subject: r.subject, room: r.room, prof: r.prof,
      start: r.start, end: r.end, grade: r.grade || ''
    };
  }

  // ── 겹침 구간 계산 ────────────────────────────────────────────────
  /**
   * 하루치 행을 "겹친 사람이 바뀌지 않는 구간"으로 자른다.
   *
   * 반투명 박스는 눈으로 보는 층이고, 이 구간들은 그 위에 덮는 **투명한 판정
   * 층**이다. 박스끼리 겹치면 맨 위 한 장만 마우스를 받아 Now info가 한 명밖에
   * 못 보여 주므로, 판정은 박스가 아니라 구간이 맡는다.
   *
   * 경계는 교시 밴드 좌표(_s·_e)다 — 화면에 그려진 박스의 경계와 정확히 같아야
   * 마우스를 올린 자리와 집히는 구간이 어긋나지 않는다.
   */
  function segmentsOf(rows, g0, g1) {
    var marks = {};
    rows.forEach(function (r) {
      marks[Math.max(r._s, g0)] = true;
      marks[Math.min(r._e, g1)] = true;
    });

    var xs = Object.keys(marks).map(Number).sort(function (a, b) { return a - b; });
    var raw = [];
    for (var i = 0; i < xs.length - 1; i++) {
      var a = xs[i], b = xs[i + 1];
      var items = rows.filter(function (r) { return r._s < b && a < r._e; });
      if (items.length === 0) { continue; }
      items.sort(function (p, q) { return p.member.localeCompare(q.member, 'ko'); });
      raw.push({ start: a, end: b, items: items });
    }

    // 인원이 그대로인 채 이어지는 구간은 하나로 합친다. 안 합치면 같은 색
    // 사각형이 여러 개로 쪼개져 이음매가 보인다.
    var out = [];
    raw.forEach(function (seg) {
      var last = out[out.length - 1];
      if (last && last.end === seg.start && sameMembers(last.items, seg.items)) {
        last.end = seg.end;
      } else {
        out.push(seg);
      }
    });
    return out;
  }

  function sameMembers(a, b) {
    if (a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i++) {
      if (a[i].member !== b[i].member) { return false; }
    }
    return true;
  }

  // ── Now info 연동 ─────────────────────────────────────────────────
  // hover는 임시 표시(떼면 사라짐), click은 고정. 다른 영역을 클릭하면
  // 고정된 내용이 그 영역으로 바뀐다.

  function region(key, day, start, end, items) {
    return {
      key: key, day: day, start: start, end: end,
      dayLabel: DAYS[day],
      items: items.map(toItem)
    };
  }

  function sendFocus(r) {
    window.dispatchEvent(new CustomEvent('tt:focus', { detail: r }));
  }
  function sendPin(r) {
    state.pinnedKey = r ? r.key : null;
    window.dispatchEvent(new CustomEvent('tt:pin', { detail: r }));
  }

  /**
   * hover는 칸마다 리스너를 붙이지 않고 **그리드 하나에 위임**한다.
   *
   * 칸은 600개가 넘고 1분마다 통째로 다시 그려진다. 요소마다 mouseenter를
   * 걸어 두면, 마우스가 어떤 칸 위에 올려진 채로 다시 그려질 때 옛 노드는
   * mouseleave를 못 받고 새 노드는 mouseenter를 못 받아 hover가 통째로
   * 멈춘 것처럼 보인다. mousemove로 매번 대상을 다시 찾으면 그 틈이 없다.
   */
  function regionOf(key) {
    var r = state.regions[key];
    return r ? region(key, r.day, r.start, r.end, r.items) : null;
  }

  gridEl.addEventListener('mousemove', function (e) {
    var hit = e.target && e.target.closest ? e.target.closest('[data-key]') : null;
    var key = hit ? hit.getAttribute('data-key') : null;

    if (key !== state.hoverKey) {
      state.hoverKey = key;
      var r = key ? regionOf(key) : null;
      sendFocus(r);
      if (r) { showTip(e, tipLines(r)); } else { hideTip(); }
      return;
    }
    if (key) { moveTip(e); }
  });

  gridEl.addEventListener('mouseleave', function () {
    state.hoverKey = null;
    sendFocus(null);
    hideTip();
  });

  gridEl.addEventListener('click', function (e) {
    var hit = e.target && e.target.closest ? e.target.closest('[data-key]') : null;
    var r = hit ? regionOf(hit.getAttribute('data-key')) : null;
    sendPin(r && r.items.length ? r : null);   // 빈 영역을 누르면 고정 해제
    renderGrid();
  });

  // ── 툴팁 ──────────────────────────────────────────────────────────
  // 내용에 사용자 입력(이름·과목명)이 섞이므로 textContent만 쓴다.

  /** 툴팁에 넣을 줄 */
  function tipLines(r) {
    // 혼자만 골랐을 때 — 그 수업 한 건의 상세 (이름 / 과목·교수·강의실 / 시간)
    if (isSingleView()) {
      if (r.items.length === 0) { return []; }
      var it = r.items[0];
      return [
        it.member,
        [it.subject, [it.prof, it.room].filter(Boolean).join(' · ')].filter(Boolean).join(' · '),
        fmt(it.start) + '–' + fmt(it.end)
      ];
    }

    // 그 외 — "구성원 명단 / n명 가능"
    var total = shownMemberCount();
    if (r.items.length === 0) {
      return total > 0 ? [total + '명 전원 가능'] : [];   // 아무도 안 골랐으면 툴팁 없음
    }
    return [
      r.items.map(function (it) { return it.member; }).join(' · '),
      (total - r.items.length) + '명 가능'
    ];
  }

  function showTip(e, lines) {
    lines = (lines || []).filter(Boolean);
    if (lines.length === 0) { hideTip(); return; }

    tipEl.textContent = '';
    lines.forEach(function (text, i) {
      var d = document.createElement('div');
      d.className = i === 0 ? 'tip-main' : 'tip-sub';
      d.textContent = text;
      tipEl.appendChild(d);
    });
    tipEl.hidden = false;
    moveTip(e);
  }

  function moveTip(e) {
    if (tipEl.hidden) { return; }
    // 화면 오른쪽·아래 끝에서는 커서 반대편으로 넘겨 잘리지 않게 한다
    var box = tipEl.getBoundingClientRect();
    var x = e.clientX + 14;
    var y = e.clientY + 14;
    if (x + box.width  > window.innerWidth  - 8) { x = e.clientX - box.width  - 14; }
    if (y + box.height > window.innerHeight - 8) { y = e.clientY - box.height - 14; }
    tipEl.style.left = Math.max(8, x) + 'px';
    tipEl.style.top  = Math.max(8, y) + 'px';
  }

  function hideTip() {
    tipEl.hidden = true;
  }

  // ── 그리드 ────────────────────────────────────────────────────────
  function renderGrid() {
    var g0 = state.gridStart, g1 = state.gridEnd;
    var nRows = (g1 - g0) / STEP;
    var rows  = shownRows();
    var single = isSingleView();

    gridEl.style.gridTemplateRows = '40px repeat(' + nRows + ', var(--slot-h))';

    var frag = document.createDocumentFragment();
    var pinnedRegion = null;

    state.regions = {};     // 칸이 새로 그려지므로 영역 목록도 새로 만든다

    // 요일 헤더 — 오늘은 액센트로 강조
    DAYS.forEach(function (label, di) {
      var h = document.createElement('div');
      h.className = 'day-head' + (state.now.day === di ? ' is-today' : '');
      h.style.gridColumn = di + COL_DAY0;
      h.textContent = label;
      frag.appendChild(h);
    });

    // 교시 축 — 왼쪽에 50분제(1~n교시), 금요일 오른쪽에 75분제(A~G)
    periodAxis(P50, 1, g0, g1, frag);
    periodAxis(P75, COL_P75, g0, g1, frag);

    // 시간축 — 정시마다 한 칸(60분 = 12행). 교시가 몇 시인지 읽는 용도로 남긴다.
    for (var m = Math.ceil(g0 / 60) * 60; m < g1; m += 60) {
      var t = document.createElement('div');
      t.className = 'time-label';
      var trow = (m - g0) / STEP + 2;
      t.style.gridRow = trow + ' / ' + (trow + 60 / STEP);
      t.textContent = fmt(m);
      frag.appendChild(t);
    }

    // 레이어 0 — 빈 칸. 격자선이자 "수업 없는 영역"의 hover 대상이고,
    // 단위는 30분이 아니라 **50분제 교시 밴드**다 (영역 = 교시).
    for (var di = 0; di < 5; di++) {
      P50.forEach(function (p) {
        var a = Math.max(p.start, g0), b = Math.min(p.end, g1);
        if (b > a) { frag.appendChild(emptyCell(di, a, b, g0)); }
      });
    }

    if (single) {
      // 레이어 1 — 혼자만 골랐을 때: 수강학년 색 블록 (글자가 들어간다)
      rows.forEach(function (r) {
        if (r._e <= g0 || r._s >= g1) { return; }
        var el = blockEl(r, g0);
        if (el.getAttribute('data-key') === state.pinnedKey) {
          el.classList.add('is-active');
          pinnedRegion = region(state.pinnedKey, r.day, r._s, r._e, [r]);
        }
        frag.appendChild(el);
      });
      legendHeatEl.hidden  = true;
      legendGradeEl.hidden = false;
    } else {
      // 레이어 1 — 눈으로 보는 층: 수업마다 반투명 박스 한 장.
      // 겹치면 알파가 쌓여 진해진다. 마우스는 받지 않는다(css의 pointer-events).
      rows.forEach(function (r) {
        if (r._e <= g0 || r._s >= g1) { return; }
        frag.appendChild(washEl(r, g0));
      });

      // 레이어 1' — 판정 층: 겹친 사람이 같은 구간마다 투명 칸 하나.
      // 박스가 아니라 이쪽이 hover·click을 받아야 Now info가 겹친 수업을 전부 낸다.
      var max = 0;
      for (var d = 0; d < 5; d++) {
        var dayRows = rows.filter(function (r) {
          return r.day === d && r._e > g0 && r._s < g1;
        });
        segmentsOf(dayRows, g0, g1).forEach(function (seg) {
          if (seg.items.length > max) { max = seg.items.length; }
          var el = hitEl(d, seg, g0);
          if (el.getAttribute('data-key') === state.pinnedKey) {
            el.classList.add('is-active');
            pinnedRegion = region(state.pinnedKey, d, seg.start, seg.end, seg.items);
          }
          frag.appendChild(el);
        });
      }
      renderLegendWash(max);
      legendHeatEl.hidden  = false;
      legendGradeEl.hidden = true;
    }

    // 레이어 2 — 요일 칸막이 (블록이 격자선을 덮으므로 위에 따로 올린다)
    for (var c = 0; c < 5; c++) {
      var rule = document.createElement('div');
      rule.className = 'col-rule';
      rule.style.gridColumn = c + COL_DAY0;
      rule.style.gridRow = '2 / ' + (nRows + 2);
      frag.appendChild(rule);
    }

    // 레이어 3 — 현재 시각선. 월요일부터 금요일까지 한 줄로 가로지른다.
    if (state.now.minutes >= g0 && state.now.minutes <= g1) {
      var line = document.createElement('div');
      line.className = 'now-line';
      line.style.gridColumn = COL_DAY0 + ' / ' + COL_P75;
      line.style.gridRow = '2 / ' + (nRows + 2);
      line.style.setProperty('--now-offset',
        ((state.now.minutes - g0) / STEP * (ROW_H / 6)) + 'px');
      frag.appendChild(line);
    }

    gridEl.textContent = '';
    gridEl.appendChild(frag);

    // 데이터가 바뀌어 고정해 둔 영역이 사라졌으면 조용히 풀고,
    // 남아 있으면 새 내용으로 갱신한다.
    if (state.pinnedKey) { sendPin(pinnedRegion); }
  }

  /**
   * 교시 축 한 열. 밴드마다 라벨 칸을 만든다.
   *
   * 그리드 끝에서 잘리는 밴드는 절반 넘게 보일 때만 그린다 — 안 그러면 맨 아래에
   * 글자만 겨우 들어가는 얇은 칸이 남는다.
   */
  function periodAxis(table, col, g0, g1, frag) {
    table.forEach(function (p) {
      var a = Math.max(p.start, g0), b = Math.min(p.end, g1);
      if (b - a < (p.end - p.start) * 0.6) { return; }

      var el = document.createElement('div');
      el.className = 'period';
      el.style.gridColumn = col;
      el.style.gridRow = ((a - g0) / STEP + 2) + ' / ' + ((b - g0) / STEP + 2);
      el.textContent = p.name + '교시';
      frag.appendChild(el);
    });
  }

  function place(el, day, start, end, g0) {
    var rowStart = (Math.max(start, g0) - g0) / STEP + 2;
    var rowEnd   = (Math.min(end, state.gridEnd) - g0) / STEP + 2;
    el.style.gridColumn = day + COL_DAY0;
    el.style.gridRow = rowStart + ' / ' + rowEnd;
  }

  /** 이 요소를 hover·click 대상으로 등록한다 */
  function mark(el, key, day, start, end, items) {
    el.setAttribute('data-key', key);
    state.regions[key] = { day: day, start: start, end: end, items: items };
    return el;
  }

  function emptyCell(di, start, end, g0) {
    var cell = document.createElement('div');
    cell.className = 'cell';
    place(cell, di, start, end, g0);
    return mark(cell, 'e|' + di + '|' + start, di, start, end, []);
  }

  /** 수업 한 건 = 연한 반투명 파란 박스 한 장 (겹치면 알파가 쌓인다) */
  function washEl(r, g0) {
    var el = document.createElement('div');
    el.className = 'wash';
    place(el, r.day, r._s, r._e, g0);
    return el;
  }

  /** 겹친 인원이 같은 구간 = 투명한 판정 칸 하나 */
  function hitEl(di, seg, g0) {
    var el = document.createElement('div');
    el.className = 'hit';
    place(el, di, seg.start, seg.end, g0);
    return mark(el, 'h|' + di + '|' + seg.start + '|' + seg.end,
                di, seg.start, seg.end, seg.items);
  }

  /** 혼자만 골랐을 때 쓰는 불투명 수업 블록 — 수강학년 색 + 안쪽 텍스트 */
  function blockEl(r, g0) {
    var el = document.createElement('div');
    el.className = 'block g' + (r.grade || '0');   // 수강학년 색 (미지정=g0)
    place(el, r.day, r._s, r._e, g0);              // 자리는 교시 밴드, 글자는 실제 시각

    var subject = document.createElement('div');
    subject.className = 'block-subject';
    subject.textContent = r.subject;               // 사용자 입력 — textContent만
    el.appendChild(subject);

    // 강의실 · 교수명 — 둘 중 있는 것만, 둘 다 없으면 줄 자체를 만들지 않는다
    var meta = [r.room, r.prof].filter(Boolean).join(' · ');
    if (meta) {
      var metaEl = document.createElement('div');
      metaEl.className = 'block-meta';
      metaEl.textContent = meta;
      el.appendChild(metaEl);
    }

    var time = document.createElement('div');
    time.className = 'block-meta';
    time.textContent = fmt(r.start) + '–' + fmt(r.end);
    el.appendChild(time);

    return mark(el, 'b|' + r.day + '|' + r._s + '|' + r._e + '|' + r.member,
                r.day, r._s, r._e, [r]);
  }

  /**
   * 겹침 범례 — 짧은 가로 그라데이션 바 + 양 끝 눈금.
   *
   * 겹침은 알파 누적이라 단계가 아니라 연속적인 농도다. 칸을 끊어 늘어놓으면
   * 실제로는 없는 경계가 있는 것처럼 보이므로 바 하나로 잇는다. 색은 그리드와
   * 똑같이 washColor()로 만들되, 겹침 수가 그대로 등간격이 아니므로(1-(1-a)^n)
   * 단계마다 색을 뽑아 색 정지점을 그 위치에 박는다.
   */
  function renderLegendWash(max) {
    legendHeatEl.textContent = '';

    // 아무도 안 골랐으면 그라데이션이 성립하지 않는다(정지점 1개는 CSS가 버린다)
    if (max <= 0) {
      var only = document.createElement('span');
      only.className = 'scale-empty';
      only.textContent = '0명';
      legendHeatEl.appendChild(only);
      return;
    }

    var bar = document.createElement('div');
    bar.className = 'scale-bar';

    // 0명(빈 종이) → max명. 정지점을 n마다 찍어야 알파 누적의 휘어짐이 살아난다.
    var stops = ['rgb(255,255,255) 0%'];
    for (var k = 1; k <= max; k++) {
      stops.push(washColor(k) + ' ' + (k / max * 100).toFixed(1) + '%');
    }
    bar.style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';

    var ticks = document.createElement('div');
    ticks.className = 'scale-ticks';
    var lo = document.createElement('span');
    lo.textContent = '0';                    // 제일 옅은 색 바로 아래
    var hi = document.createElement('span');
    hi.textContent = max + '명';             // 제일 진한 색 바로 아래
    ticks.appendChild(lo);
    ticks.appendChild(hi);

    var wrap = document.createElement('div');
    wrap.className = 'scale';
    wrap.appendChild(bar);
    wrap.appendChild(ticks);
    legendHeatEl.appendChild(wrap);
  }

  // ── 구성원 선택 칩 ────────────────────────────────────────────────
  // 칩은 **항상 보인다.** 전체 선택 상태에서는 전원이 활성(회색)으로 칠해진다.
  function renderChips() {
    chipsEl.textContent = '';
    state.members.forEach(function (mem) {
      var on = state.allOn || !!state.selected[mem.name];

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (on ? ' is-active' : '');
      chip.setAttribute('data-name', mem.name);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.textContent = mem.name;   // 사용자 입력 — textContent만

      chipsEl.appendChild(chip);
    });
  }

  /** 선택 상태에 맞춰 체크박스를 정렬한다 (칩 줄은 늘 떠 있다) */
  function syncChrome() {
    selectAll.checked = state.allOn;
  }

  function applyFilterChange() {
    state.hoverKey = null;
    hideTip();
    sendFocus(null);
    sendPin(null);          // 겹쳐지는 대상이 바뀌면 고정해 둔 영역은 더 이상 없다
    syncChrome();
    renderChips();
    renderGrid();
    emit();
  }

  // 전체 선택: 체크 → 전원 / 해제 → 아무도 안 그려진 빈 그리드
  selectAll.addEventListener('change', function () {
    state.allOn = selectAll.checked;
    state.selected = {};
    applyFilterChange();
  });

  // 칩 클릭 — 칩 줄 하나에 위임 (칩은 다시 그려지므로 개별 리스너를 안 붙인다)
  chipsEl.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (!chip) { return; }
    var name = chip.getAttribute('data-name');
    if (!name) { return; }

    if (state.allOn) {
      // 전원이 겹쳐 보이는 상태에서 한 명을 고르면 전체 선택이 풀리고
      // 그 사람만 남는다 (전원에서 한 명을 빼는 게 아니다)
      state.allOn = false;
      state.selected = {};
      state.selected[name] = true;
    } else if (state.selected[name]) {
      delete state.selected[name];
    } else {
      state.selected[name] = true;
      // 손으로 전원을 다 켰다면 체크박스도 따라 붙는다
      if (shownMemberCount() === state.members.length && state.members.length > 0) {
        state.allOn = true;
        state.selected = {};
      }
    }
    applyFilterChange();
  });

  // Now info의 고정 해제(×) 버튼 — 그리드의 강조 표시까지 함께 지운다
  window.addEventListener('tt:unpin', function () {
    sendPin(null);
    renderGrid();
  });

  // ── 시각 ──────────────────────────────────────────────────────────
  // 브라우저 시계 대신 서버가 알려준 시각을 기준으로 경과분만 더한다.
  // 사용자 PC 시계가 틀어져 있어도, 브라우저 시간대가 KST가 아니어도 맞는다.
  function tick() {
    if (!state.base) { return; }
    var elapsed = Math.floor((Date.now() - state.base.at) / 60000);
    var minutes = state.base.minutes + elapsed;
    var day = state.base.day;
    while (minutes >= 1440) { minutes -= 1440; day = (day + 1) % 7; }
    state.now = { day: day, minutes: minutes };
  }

  function emit() {
    window.dispatchEvent(new CustomEvent('tt:update', { detail: state }));
  }

  /**
   * NOW 옆 점의 깜빡임을 서버의 초 경계에 맞춘다.
   *
   * base.minutes는 분 단위라 위상을 잡을 수 없어, ISO 시각(초 포함)에서
   * 브라우저와의 차이를 구해 이미 지난 만큼 애니메이션을 앞당겨 시작한다.
   * animation-delay만 고쳐서는 이미 돌고 있는 애니메이션에 반영되지 않으므로
   * 한 번 끄고 리플로를 강제한 뒤 다시 켠다.
   */
  function syncLiveDot() {
    if (!liveDot) { return; }
    var phase = ((Date.now() + state.clockOffset) % 1000 + 1000) % 1000;
    liveDot.style.animation = 'none';
    void liveDot.offsetWidth;
    liveDot.style.animation = '';
    liveDot.style.animationDelay = '-' + phase + 'ms';
  }

  // ── 데이터 ────────────────────────────────────────────────────────
  function adopt(data) {
    state.rows    = data.rows || [];
    state.view    = withBands(state.rows);   // 교시 밴드 좌표를 한 번만 계산해 둔다
    state.members = data.members || [];

    // 명단에서 빠진 사람은 선택 상태에서도 지운다
    var names = {};
    state.members.forEach(function (m) { names[m.name] = true; });
    Object.keys(state.selected).forEach(function (n) {
      if (!names[n]) { delete state.selected[n]; }
    });

    var range = computeRange(state.view);
    state.gridStart = range[0];
    state.gridEnd   = range[1];

    if (data.now) {
      state.base = { day: data.now.day, minutes: data.now.minutes, at: Date.now() };

      var serverMs = Date.parse(data.now.time);
      if (!isNaN(serverMs)) {
        state.clockOffset = serverMs - Date.now();
        syncLiveDot();
      }
    }
    tick();

    syncChrome();
    renderChips();
    renderGrid();
    emit();
  }

  function refresh() {
    fetch('api/list.php', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) { if (data && data.ok) { adopt(data); } })
      .catch(function () { /* 일시적 실패는 다음 주기에 다시 시도한다 */ });
  }

  // 첫 화면은 index.php가 심어 준 데이터로 즉시 그린다 (fetch 왕복 없음)
  if (window.__INITIAL__) {
    adopt(window.__INITIAL__);
  } else {
    refresh();
  }

  // 1분마다 현재 시각만 다시 계산 (네트워크 요청 없음), 5분마다 데이터 재조회
  setInterval(function () { tick(); renderGrid(); emit(); }, TICK_MS);
  setInterval(refresh, REFRESH_MS);
})();
