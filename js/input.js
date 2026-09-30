/**
 * 시간표 입력 화면 로직
 *
 * 디자인 사양: docs/input_DESIGN.md
 *
 * 두 부류의 사용자를 모두 수용해야 한다 (설계 문서 7-5):
 *   학부생   편람 검색 → 교수 → 시간 3단 선택 → 자동 채움 확인 후 저장
 *   대학원생 과목명 직접 입력 → 요일 체크 → 시간 직접 선택
 * 대학원 수업은 편람에 없으므로 자동완성에만 의존하는 설계는 불가하다.
 *
 * 시간 상수·교시표는 input.php가 _lib.php에서 주입한다(window.__BOOT__).
 * 여기에 하드코딩하지 말 것 — 백엔드 검증과 어긋나면 저장이 조용히 실패한다.
 */

(function () {
  'use strict';

  var BOOT     = window.__BOOT__ || {};
  var DAYS     = BOOT.days || ['월', '화', '수', '목', '금'];
  var PERIODS  = BOOT.periods || { '50': {}, '75': {} };
  var SLOT_MIN = BOOT.slotMin || 5;
  var TIME_MIN = BOOT.timeMin || 480;
  var TIME_MAX = BOOT.timeMax || 1440;

  var DEBOUNCE_MS = 200;
  var TOAST_MS    = 2400;

  // 미리보기 그리드 범위 — 시안대로 09:00~19:00, 데이터가 넘치면 정시 단위로 확장
  var VIEW_MIN = 540;
  var VIEW_MAX = 1140;
  var STEP     = 5;      // 5분 행 (css의 --prev-slot과 일치)
  var BUCKET   = 30;     // 배경 한 칸

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    member: $('member'), courseHint: $('course-hint'),
    tabCatalog: $('tab-catalog'), tabManual: $('tab-manual'),
    seg: $('seg'), segThumb: $('seg-thumb'),
    modeCatalog: $('mode-catalog'), modeManual: $('mode-manual'),
    query: $('query'), results: $('results'),
    lbCourse: $('lb-course'), lbProf: $('lb-prof'), lbSlot: $('lb-slot'), lbRoom: $('lb-room'),
    chosenCourse: $('chosen-course'), prof: $('prof'),
    slot: $('slot'), chosenSlot: $('chosen-slot'),
    roomSelect: $('room-select'), roomCustom: $('room-custom'),
    manualSubject: $('manual-subject'), manualProf: $('manual-prof'),
    manualRoom: $('manual-room'), manualPersonal: $('manual-personal'),
    autofillHint: $('autofill-hint'), days: $('days'),
    lbTimeMode: $('lb-timemode'), timeModes: $('time-modes'),
    periodRow: $('period-row'), pStart: $('p-start'), pEnd: $('p-end'),
    customRow: $('custom-row'), sh: $('sh'), sm: $('sm'), eh: $('eh'), em: $('em'),
    autoTime: $('auto-time'),
    save: $('save'), cancelEdit: $('cancel-edit'), saveHint: $('save-hint'),
    preview: $('preview'), swSaved: $('sw-saved'),
    listSub: $('list-sub'), entries: $('entries'),
    toast: $('toast'),
    modal: $('modal'), modalBody: $('modal-body'),
    modalCancel: $('modal-cancel'), modalConfirm: $('modal-confirm')
  };

  var state = {
    members: BOOT.members || [],
    member: '',
    rows: [],                 // 선택된 구성원의 등록 행

    courseMode: 'catalog',    // 'catalog' | 'manual'
    results: [],
    activeResult: 0,          // ↑↓로 움직이는 검색 결과 커서
    course: '', profs: [], prof: '', slots: [], slotIdx: '',
    manualSubject: '',

    days: {},                 // { 0: true, ... }
    timeMode: '50',           // '50' | '75' | 'custom'
    autofilled: false,

    // 편람에서 확정된 수업 시간 묶음. [{ days:[..], start, end, label }]
    // 한 수업이 요일마다 다른 시각에 열릴 수 있어 **배열**이다 —
    // Python기초/한소율 = 화 15:00~16:50 + 목 17:00~17:50 (편람 행의 15.1%).
    // null이면 아래 요일 칩 + 교시 드롭다운을 그대로 쓴다.
    meetings: null,

    editingGroup: null,       // 수정 중인 묶음
    pendingGroup: null,       // 방금 저장한 묶음 (미리보기 강조)
    modalGroup: null
  };

  var toastTimer = null;
  var searchTimer = null;

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmt(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function memberColor(name) {
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].name === name) { return state.members[i].color; }
    }
    return '#b9b9be';
  }
  function dayText(days) {
    return days.slice().sort().map(function (d) { return DAYS[d]; }).join('·');
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, TOAST_MS);
  }

  // ── 정적 컨트롤 채우기 ────────────────────────────────────────────

  function fillMembers() {
    state.members.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      el.member.appendChild(opt);
    });
  }

  function fillDays() {
    DAYS.forEach(function (label, d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-chip';
      b.dataset.day = String(d);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = label;
      b.addEventListener('click', function () {
        if (daysLocked()) { return; }        // 편람 확정 요일은 손대지 못하게
        state.days[d] = !state.days[d];
        state.autofilled = false;
        renderDays();
        renderPreview();
      });
      el.days.appendChild(b);
    });
  }

  /**
   * 편람 검색 모드에서 시간(분반)을 고르면 그 수업의 요일이 확정된다.
   * 그 뒤에 다른 요일을 임의로 켜면 편람과 어긋난 시간표가 되므로 잠근다.
   * 직접 입력 모드는 편람에 없는 수업이라 항상 자유롭게 고를 수 있다.
   */
  /** 편람에서 시간이 확정되었으면 그 묶음, 아니면 null */
  function autoMeetings() {
    return state.courseMode === 'catalog' ? state.meetings : null;
  }

  function daysLocked() {
    return autoMeetings() !== null;
  }

  /**
   * 편람 시간은 고르는 것이 아니라 자동으로 들어간다.
   *
   * 자동으로 채워 놓고 아래 교시 드롭다운으로 다시 고칠 수 있게 두면 편람과
   * 어긋난 시간이 저장된다. 그래서 편람 검색 모드에서 시간이 채워지면 요일과
   * 함께 시간 컨트롤도 잠근다. 편람에 없는 수업은 '직접 입력' 탭을 쓰면 된다.
   */
  function timeLocked() {
    return autoMeetings() !== null;
  }

  function renderDays() {
    var locked = daysLocked();
    Array.prototype.forEach.call(el.days.children, function (b) {
      var on = !!state.days[Number(b.dataset.day)];
      b.className = 'day-chip' + (on ? ' is-on' : '');
      b.disabled = locked && !on;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = '';
      if (on) {
        b.insertAdjacentHTML('beforeend',
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>');
      }
      b.appendChild(document.createTextNode(DAYS[Number(b.dataset.day)]));
    });
  }

  function fillTimeModes() {
    [['50', '50분제'], ['75', '75분제'], ['custom', '직접 입력']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.mode = m[0];
      b.innerHTML = '<span class="ring"><i></i></span>';
      b.appendChild(document.createTextNode(m[1]));
      b.addEventListener('click', function () {
        if (timeLocked()) { return; }
        state.timeMode = m[0];
        state.autofilled = false;
        fillPeriods();
        renderTimeModes();
        renderPreview();
      });
      el.timeModes.appendChild(b);
    });
  }

  function renderTimeModes() {
    var auto = autoMeetings();

    // 자동으로 확정된 시간은 고르는 것이 아니므로, 컨트롤을 아예 치우고
    // 확정된 내용을 요약으로 보여준다.
    el.lbTimeMode.hidden = !!auto;
    el.timeModes.hidden  = !!auto;
    el.autoTime.hidden   = !auto;

    var custom = state.timeMode === 'custom';
    el.periodRow.hidden = !!auto || custom;
    el.customRow.hidden = !!auto || !custom;

    Array.prototype.forEach.call(el.timeModes.children, function (b) {
      var on = b.dataset.mode === state.timeMode;
      b.className = 'radio-pill' + (on ? ' is-on' : '');
      b.disabled = !!auto;
    });
    [el.pStart, el.pEnd, el.sh, el.sm, el.eh, el.em].forEach(function (sel) {
      sel.disabled = !!auto;
    });

    el.autoTime.textContent = '';
    if (!auto) { return; }

    auto.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'at-row';

      var day = document.createElement('span');
      day.className = 'at-day';
      day.textContent = dayText(m.days);

      var time = document.createElement('span');
      time.className = 'at-time';
      time.textContent = fmt(m.start) + ' ~ ' + fmt(m.end);

      row.appendChild(day);
      row.appendChild(time);

      // 편람 라벨에서 "3,4교시" 부분만 떼어 옆에 덧붙인다 (있을 때만)
      var period = /([0-9A-G,]+교시)/.exec(m.label || '');
      if (period) {
        var p = document.createElement('span');
        p.className = 'at-period';
        p.textContent = period[1];
        row.appendChild(p);
      }
      el.autoTime.appendChild(row);
    });
  }

  /** 교시 드롭다운은 시작·종료 두 개다 — 5,6교시 연강처럼 여러 교시에 걸친
   *  수업이 흔해서 하나로는 표현할 수 없다 (설계 문서 7-5). */
  function fillPeriods() {
    if (state.timeMode === 'custom') { return; }
    var table = PERIODS[state.timeMode] || {};

    [el.pStart, el.pEnd].forEach(function (sel, isEnd) {
      var keep = sel.value;
      sel.textContent = '';
      Object.keys(table).forEach(function (k) {
        var opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k + '교시 ' + fmt(table[k][isEnd ? 1 : 0]);
        sel.appendChild(opt);
      });
      if (keep && table[keep]) { sel.value = keep; }
    });
  }

  function fillCustom() {
    var hStart = Math.floor(TIME_MIN / 60);
    var hEnd   = Math.floor(TIME_MAX / 60) - 1;

    [el.sh, el.eh].forEach(function (sel) {
      for (var h = hStart; h <= hEnd; h++) {
        var o = document.createElement('option');
        o.value = String(h);
        o.textContent = pad(h);
        sel.appendChild(o);
      }
    });
    [el.sm, el.em].forEach(function (sel) {
      for (var m = 0; m < 60; m += SLOT_MIN) {
        var o = document.createElement('option');
        o.value = String(m);
        o.textContent = pad(m);
        sel.appendChild(o);
      }
    });
    el.sh.value = '9';  el.sm.value = '0';
    el.eh.value = '10'; el.em.value = '0';

    [el.sh, el.sm, el.eh, el.em].forEach(function (sel) {
      sel.addEventListener('change', function () {
        state.autofilled = false;
        renderPreview();
      });
    });
  }

  /** 현재 폼이 가리키는 시각 구간 (자정 기준 분) */
  function resolvedTime() {
    if (state.timeMode === 'custom') {
      return {
        start: Number(el.sh.value) * 60 + Number(el.sm.value),
        end:   Number(el.eh.value) * 60 + Number(el.em.value)
      };
    }
    var table = PERIODS[state.timeMode] || {};
    var a = table[el.pStart.value];
    var b = table[el.pEnd.value];
    if (!a || !b) { return null; }
    return { start: a[0], end: b[1] };
  }

  /**
   * 지금 폼이 가리키는 시간 묶음 — 그대로 api/save.php의 `slots`가 된다.
   * 편람에서 확정된 수업은 여러 묶음일 수 있고, 직접 입력은 항상 한 묶음이다.
   */
  function resolvedSlots() {
    var auto = autoMeetings();
    if (auto) {
      return auto.map(function (m) {
        return { days: m.days.slice(), start: m.start, end: m.end };
      });
    }

    var t = resolvedTime();
    var days = selectedDays();
    if (!t || days.length === 0) { return []; }
    return [{ days: days, start: t.start, end: t.end }];
  }

  function currentSubject() {
    return state.courseMode === 'manual'
      ? el.manualSubject.value.trim()
      : state.course;
  }

  function currentProf() {
    return state.courseMode === 'manual'
      ? el.manualProf.value.trim()
      : state.prof;
  }

  var ROOM_CUSTOM = '__custom__';

  /** 강의실도 나머지 3단과 같은 드롭박스다. 편람에 없는 강의실은 "직접 입력"으로 받는다. */
  function currentRoom() {
    if (state.courseMode === 'manual') {
      return el.manualRoom.value.trim();
    }
    if (el.roomSelect.value === ROOM_CUSTOM) {
      return el.roomCustom.value.trim();
    }
    return el.roomSelect.value.trim();
  }

  /**
   * 개인일정 여부 — 직접 입력 모드에서만 받는다.
   *
   * 판정은 서버(_lib.php의 is_yes)가 하고 여기서는 글자를 그대로 넘긴다.
   * 양쪽에서 따로 해석하면 규칙이 갈라져 "네라고 썼는데 회색이 안 된다"가 된다.
   */
  function currentPersonal() {
    return state.courseMode === 'manual' ? el.manualPersonal.value.trim() : '';
  }

  function setRoomOptions(rooms, selected) {
    el.roomSelect.textContent = '';
    el.roomSelect.appendChild(new Option('강의실 선택…', ''));
    rooms.forEach(function (r) {
      if (r) { el.roomSelect.appendChild(new Option(r, r)); }
    });
    el.roomSelect.appendChild(new Option('직접 입력…', ROOM_CUSTOM));
    el.roomSelect.value = selected || '';

    // 편람에 없는 값을 되살리는 경우(수정 등)는 직접 입력 칸으로 넘긴다
    if (selected && el.roomSelect.value !== selected) {
      el.roomSelect.value = ROOM_CUSTOM;
      el.roomCustom.value = selected;
    }
    renderRoom();
  }

  function renderRoom() {
    var custom = el.roomSelect.value === ROOM_CUSTOM;
    el.roomCustom.hidden = !custom;
    if (!custom) { el.roomCustom.value = ''; }
    el.lbRoom.className = 'step-label' + (currentRoom() ? ' is-on' : '');
  }

  function selectedDays() {
    return Object.keys(state.days)
      .filter(function (d) { return state.days[d]; })
      .map(Number)
      .sort(function (a, b) { return a - b; });
  }

  // ── 과목 검색 ─────────────────────────────────────────────────────

  // ── 세그먼트 토글 슬라이딩 인디케이터 ───────────────────────────────
  // 활성 버튼(.is-on) 밑으로 .seg-thumb를 실측 위치·너비로 옮긴다.
  // animate=false면 트랜지션 없이 즉시(첫 배치·리사이즈), true면 미끄러진다.
  var REDUCE_MOTION = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var segReady = false;

  function moveSegThumb(animate) {
    var t = el.segThumb;
    if (!t || !el.seg) { return; }
    var on = state.courseMode === 'manual' ? el.tabManual : el.tabCatalog;
    if (!on.offsetParent) { return; }   // 화면에 없으면(display:none) 건너뜀

    var instant = !animate || !segReady || REDUCE_MOTION;
    if (instant) { t.classList.add('no-anim'); }

    t.style.width = on.offsetWidth + 'px';
    t.style.transform = 'translateX(' + on.offsetLeft + 'px)';

    if (instant) {
      void t.offsetWidth;             // 강제 리플로우 후 트랜지션 복구
      t.classList.remove('no-anim');
    } else {
      // 이동 중 '리퀴드' 늘어남 — 재생 중이어도 다시 시작되도록 토글
      el.seg.classList.remove('is-sliding');
      void el.seg.offsetWidth;
      el.seg.classList.add('is-sliding');
    }
    segReady = true;
  }

  function setCourseMode(mode) {
    state.courseMode = mode;
    el.tabCatalog.className = mode === 'catalog' ? 'is-on' : '';
    el.tabManual.className  = mode === 'manual' ? 'is-on' : '';
    moveSegThumb(true);
    el.modeCatalog.hidden = mode !== 'catalog';
    el.modeManual.hidden  = mode !== 'manual';
    el.courseHint.textContent = mode === 'catalog'
      ? '편람에서 검색해 과목 → 교수 → 시간을 순서대로 고르세요.'
      : '편람에 없는 과목 혹은 개인일정을 직접입력합니다.';
    if (mode === 'manual') { closeResults(); }
    renderDays();                // 모드에 따라 요일·시간 잠금이 달라진다
    renderTimeModes();
    renderHints();
    renderPreview();
  }

  function closeResults() {
    el.results.hidden = true;
    el.results.textContent = '';
    el.results.className = 'results';
  }

  function runSearch() {
    var q = el.query.value.trim();
    if (q === '') { closeResults(); return; }

    fetch('api/search.php?limit=8&q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { closeResults(); return; }
        state.results = d.items || [];
        state.activeResult = 0;
        renderResults();
      })
      .catch(closeResults);
  }

  function renderResults() {
    el.results.textContent = '';

    if (state.results.length === 0) {
      el.results.className = 'results empty';
      // 사용자 입력이 섞이지 않는 고정 문구라 innerHTML을 써도 안전하다
      el.results.innerHTML = '검색 결과가 없습니다. 편람에 없는 수업은 ' +
                             '<strong>직접 입력</strong>으로 등록하세요.';
      el.results.hidden = false;
      return;
    }

    el.results.className = 'results';
    state.results.forEach(function (item, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = i === state.activeResult ? 'is-active' : '';
      b.setAttribute('aria-selected', i === state.activeResult ? 'true' : 'false');

      var name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = item.subject;          // 편람 원문 — textContent만 쓴다

      var meta = document.createElement('span');
      meta.className = 'r-meta';
      meta.textContent = item.profs.map(function (p) { return p.name; }).join(', ');

      b.appendChild(name);
      b.appendChild(meta);
      b.addEventListener('click', function () { pickCourse(item); });
      // 마우스를 올린 항목으로 키보드 커서도 따라가게 해서 둘이 어긋나지 않게 한다
      b.addEventListener('mouseenter', function () {
        state.activeResult = i;
        highlightResults();
      });
      el.results.appendChild(b);
    });
    el.results.hidden = false;
  }

  /** 목록을 다시 만들지 않고 강조만 옮긴다 (↑↓ 이동은 이쪽이 가볍고 깜빡임도 없다) */
  function highlightResults() {
    Array.prototype.forEach.call(el.results.children, function (b, i) {
      var on = i === state.activeResult;
      b.className = on ? 'is-active' : '';
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && b.scrollIntoView) { b.scrollIntoView({ block: 'nearest' }); }
    });
  }

  function moveResult(step) {
    var n = state.results.length;
    if (n === 0) { return; }
    state.activeResult = (state.activeResult + step + n) % n;   // 위아래로 순환
    highlightResults();
  }

  // ⚠️ 상위 선택이 바뀌면 하위를 반드시 초기화한다. 과목을 바꿨는데 이전 교수가
  // 남아 있으면 잘못된 조합이 저장된다 (설계 문서 7-5).
  function pickCourse(item) {
    state.course  = item.subject;
    state.profs   = item.profs || [];
    state.prof    = '';
    state.slots   = [];
    state.slotIdx = '';
    state.autofilled = false;
    state.meetings = null;
    setRoomOptions([]);          // 하위 선택(교수·시간)과 함께 강의실도 초기화
    el.query.value = item.subject;
    closeResults();
    renderSteps();
    renderDays();                // 시간 선택이 풀렸으니 요일 잠금도 해제
    renderTimeModes();
    renderHints();

    // 교수가 한 명뿐이면 그 교수까지 자동으로 확정한다 (시간도 하나면 이어서 채워진다)
    if (state.profs.length === 1) {
      el.prof.value = state.profs[0].name;
      el.prof.dispatchEvent(new Event('change'));
    }
  }

  function renderSteps() {
    el.chosenCourse.textContent = state.course || '검색 후 선택';
    el.chosenCourse.className = 'chosen' + (state.course ? ' is-on' : '');
    el.lbCourse.className = 'step-label' + (state.course ? ' is-on' : '');

    el.prof.textContent = '';
    el.prof.appendChild(new Option('교수 선택…', ''));
    state.profs.forEach(function (p) { el.prof.appendChild(new Option(p.name, p.name)); });
    el.prof.value = state.prof;
    el.prof.disabled = !state.course;
    el.lbProf.className = 'step-label' + (state.prof ? ' is-on' : '');

    // 3 · 시간 — 원칙은 자동 입력이라 읽기 전용 표시만 둔다.
    // 같은 과목·같은 교수인데 시간이 여러 개인 경우(채플처럼 8개)에만
    // 예외적으로 드롭다운을 꺼내 고르게 한다.
    var many = state.slots.length > 1;

    el.slot.hidden = !many;
    el.chosenSlot.hidden = many;

    el.slot.textContent = '';
    el.slot.appendChild(new Option('시간 선택…', ''));
    state.slots.forEach(function (s, i) { el.slot.appendChild(new Option(s.label, String(i))); });
    el.slot.value = state.slotIdx;
    el.slot.disabled = !state.prof;

    var picked = state.slotIdx === '' ? null : state.slots[Number(state.slotIdx)];
    el.chosenSlot.textContent = picked ? picked.label
      : (state.course ? '아래에서 직접 지정' : '과목을 먼저 고르세요');
    el.chosenSlot.className = 'chosen' + (picked ? ' is-on' : '');

    el.lbSlot.textContent = many ? '3 · 시간 (분반 선택)' : '3 · 시간 (자동)';
    el.lbSlot.className = 'step-label' + (state.slotIdx !== '' ? ' is-on' : '');

    // 시간이 자동으로 들어가므로 강의실은 과목이 정해지면 바로 열어 둔다
    el.roomSelect.disabled = !state.course;
    if (el.roomSelect.disabled) { el.roomCustom.hidden = true; }
    el.lbRoom.className = 'step-label' + (currentRoom() ? ' is-on' : '');
  }

  /**
   * 편람에서 정해진 분반을 폼에 확정한다.
   *
   * 분반 하나가 요일마다 다른 시각을 가질 수 있으므로 `meetings` **전부**를
   * 그대로 들여온다. 예전처럼 교시 드롭다운 한 쌍에 밀어 넣으면 `화7,8 목9`
   * 같은 수업의 절반이 사라진다.
   */
  function applySlot(idx) {
    state.slotIdx = idx;
    var slot = state.slots[Number(idx)];
    if (!slot) { renderSteps(); return; }

    state.meetings = (slot.meetings || []).map(function (m) {
      return { days: m.days.slice(), start: m.start, end: m.end, label: m.label };
    });

    state.days = {};
    state.meetings.forEach(function (m) {
      m.days.forEach(function (d) { state.days[d] = true; });
    });

    // 편람에 강의실이 있으면 그 값을 골라 둔다. 다른 강의실로 바꾸려면
    // "직접 입력…"을 고르면 된다.
    setRoomOptions(slot.room ? [slot.room] : [], slot.room || '');

    state.autofilled = true;
    renderSteps();
    renderDays();
    renderTimeModes();
    renderHints();
    renderPreview();
  }

  function renderHints() {
    var auto = autoMeetings();
    el.autofillHint.textContent = auto
      ? (auto.length > 1
          ? '요일마다 시각이 다른 수업입니다. 편람 값 그대로 함께 저장됩니다.'
          : '편람 시간이 자동으로 입력되었습니다. 다른 시간이면 위의 「직접 입력」 탭을 쓰세요.')
      : (state.courseMode === 'catalog'
          ? '위에서 과목·교수를 고르면 요일과 시간이 자동으로 채워집니다.'
          : '요일과 시간을 직접 고르세요.');

    el.save.textContent = state.editingGroup ? '수정 저장' : '저장';
    el.cancelEdit.hidden = !state.editingGroup;
    el.saveHint.textContent = state.editingGroup
      ? (auto && auto.length > 1
          ? '요일마다 시각이 다른 수업은 시간을 고칠 수 없습니다. 지우고 다시 등록하세요.'
          : '수정 중인 항목이 목록에서 강조됩니다.')
      : '저장하면 우측의 미리보기에 바로 표시됩니다.';
  }

  // ── 데이터 ────────────────────────────────────────────────────────

  function loadRows() {
    return fetch('api/list.php', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { return; }
        state.members = d.members || state.members;
        state.rows = (d.rows || []).filter(function (r) { return r.member === state.member; });
        renderList();
        renderPreview();
      })
      .catch(function () { toast('목록을 불러오지 못했습니다'); });
  }

  /** 같은 group_id끼리 묶는다. 화면에는 묶음 하나가 한 줄로 보인다. */
  function groups() {
    var byId = {};
    var order = [];
    state.rows.forEach(function (r) {
      if (!byId[r.group_id]) { byId[r.group_id] = []; order.push(r.group_id); }
      byId[r.group_id].push(r);
    });
    return order.map(function (id) {
      var rs = byId[id].slice().sort(function (a, b) {
        return a.day - b.day || a.start - b.start;
      });

      // 한 수업이 요일마다 다른 시각일 수 있으므로 (시작,종료)가 같은 것끼리 묶는다
      var meetings = [];
      rs.forEach(function (r) {
        var hit = null;
        meetings.forEach(function (m) {
          if (m.start === r.start && m.end === r.end) { hit = m; }
        });
        if (hit) { hit.days.push(r.day); }
        else { meetings.push({ days: [r.day], start: r.start, end: r.end }); }
      });

      return {
        id: id,
        meetings: meetings,
        days: rs.map(function (r) { return r.day; }),
        subject: rs[0].subject, prof: rs[0].prof, room: rs[0].room, color: rs[0].color,
        catalog: !!rs[0].catalog,
        personal: !!rs[0].personal
      };
    });
  }

  /** "화 15:00~16:50 · 목 17:00~17:50" */
  function meetingsText(meetings) {
    return meetings.map(function (m) {
      return dayText(m.days) + ' ' + fmt(m.start) + '~' + fmt(m.end);
    }).join(' · ');
  }

  // ── 등록 목록 ─────────────────────────────────────────────────────

  function renderList() {
    var gs = groups();
    el.listSub.textContent = state.member
      ? state.member + ' · ' + gs.length + '건'
      : '이름을 먼저 선택하세요';

    el.entries.textContent = '';

    if (gs.length === 0) {
      var box = document.createElement('div');
      box.className = 'empty-box';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = '등록된 수업 없음';
      var b = document.createElement('div');
      b.className = 'b';
      b.textContent = state.member
        ? '위에서 과목을 입력하고 저장하면 이 목록에 쌓입니다.'
        : '이름을 선택하면 이미 등록한 수업을 불러옵니다.';
      box.appendChild(t);
      box.appendChild(b);
      el.entries.appendChild(box);
      return;
    }

    gs.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'entry' + (state.editingGroup === g.id ? ' is-editing' : '');

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = g.color;

      var body = document.createElement('div');
      body.className = 'body';
      var subject = document.createElement('div');
      subject.className = 'subject';
      subject.textContent = g.subject;            // 사용자 입력 — textContent만
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = meetingsText(g.meetings) +
                         (g.room ? ' · ' + g.room : '') +
                         (g.prof ? ' · ' + g.prof : '');
      body.appendChild(subject);
      body.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'actions';
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-row btn-edit';
      edit.textContent = '수정';
      edit.addEventListener('click', function () { startEdit(g); });
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-row btn-del';
      del.textContent = '삭제';
      del.addEventListener('click', function () { openModal(g); });
      actions.appendChild(edit);
      actions.appendChild(del);

      row.appendChild(dot);
      row.appendChild(body);
      row.appendChild(actions);
      el.entries.appendChild(row);
    });
  }

  // ── 미리보기 ──────────────────────────────────────────────────────

  function previewRange() {
    var min = VIEW_MIN, max = VIEW_MAX;
    state.rows.forEach(function (r) {
      if (r.start < min) { min = r.start; }
      if (r.end > max) { max = r.end; }
    });
    draftBlocks().forEach(function (d) {
      if (d.start < min) { min = d.start; }
      if (d.end > max) { max = d.end; }
    });
    return [
      Math.max(TIME_MIN, Math.floor(min / 60) * 60),
      Math.min(TIME_MAX, Math.ceil(max / 60) * 60)
    ];
  }

  /** 아직 저장하지 않았지만 폼에 잡혀 있는 수업 (점선 블록).
   *  요일마다 시각이 다른 수업은 묶음마다 하나씩 나온다. */
  function draftBlocks() {
    var subject = currentSubject();
    if (!subject) { return []; }
    return resolvedSlots()
      .filter(function (sl) { return sl.end > sl.start && sl.days.length; })
      .map(function (sl) {
        return { days: sl.days, start: sl.start, end: sl.end, subject: subject };
      });
  }

  function renderPreview() {
    var range = previewRange();
    var g0 = range[0], g1 = range[1];
    var nRows = (g1 - g0) / STEP;

    el.preview.style.gridTemplateRows = '24px repeat(' + nRows + ', var(--prev-slot))';
    el.preview.textContent = '';
    el.swSaved.style.background = memberColor(state.member) + '59';
    el.swSaved.style.border = '1px solid ' + memberColor(state.member);

    var frag = document.createDocumentFragment();

    DAYS.forEach(function (label, di) {
      var h = document.createElement('div');
      h.className = 'prev-day';
      h.style.gridColumn = di + 2;
      h.textContent = label;
      frag.appendChild(h);
    });

    for (var m = Math.ceil(g0 / 60) * 60; m < g1; m += 60) {
      var t = document.createElement('div');
      t.className = 'prev-hour';
      var row = (m - g0) / STEP + 2;
      t.style.gridRow = row + ' / ' + (row + 60 / STEP);
      t.textContent = fmt(m);
      frag.appendChild(t);
    }

    for (var di2 = 0; di2 < 5; di2++) {
      for (var b = g0; b < g1; b += BUCKET) {
        var cell = document.createElement('div');
        cell.className = 'prev-cell' + (b % 60 === 0 ? ' on-hour' : '');
        var r = (b - g0) / STEP + 2;
        cell.style.gridColumn = di2 + 2;
        cell.style.gridRow = r + ' / ' + (r + BUCKET / STEP);
        frag.appendChild(cell);
      }
    }

    // 저장된 수업 — 수정 중인 묶음은 아래 점선 블록이 대신하므로 건너뛴다
    var color = memberColor(state.member);
    groups().forEach(function (g) {
      if (g.id === state.editingGroup) { return; }
      var pending = g.id === state.pendingGroup;
      g.meetings.forEach(function (m) {
        m.days.forEach(function (d) {
          frag.appendChild(block(d, m.start, m.end, g.subject, g0, g1,
                                 pending ? 'pending' : 'saved', color));
        });
      });
    });

    // 아직 저장하지 않은 입력
    draftBlocks().forEach(function (draft) {
      draft.days.forEach(function (d) {
        frag.appendChild(block(d, draft.start, draft.end, draft.subject, g0, g1, 'pending', color));
      });
    });

    el.preview.appendChild(frag);
  }

  function block(day, start, end, subject, g0, g1, kind, color) {
    var b = document.createElement('div');
    b.className = 'prev-block ' + kind;
    var rowStart = (Math.max(start, g0) - g0) / STEP + 2;
    var rowEnd   = (Math.min(end, g1) - g0) / STEP + 2;
    b.style.gridColumn = day + 2;
    b.style.gridRow = rowStart + ' / ' + rowEnd;
    if (kind === 'saved') {
      b.style.setProperty('--c-base', color);
      b.style.setProperty('--c-soft', color + '59');
    }
    b.textContent = subject;
    return b;
  }

  // ── 저장 · 수정 · 삭제 ────────────────────────────────────────────

  function save() {
    if (!state.member) { toast('이름을 먼저 선택하세요'); return; }

    var subject = currentSubject();
    var slots = resolvedSlots();

    if (!subject) { toast('과목명을 입력하세요'); return; }
    if (slots.length === 0) { toast('요일을 하나 이상 선택하세요'); return; }

    var bad = false;
    slots.forEach(function (sl) { if (sl.end <= sl.start) { bad = true; } });
    if (bad) { toast('종료 시간이 시작 시간보다 뒤여야 합니다'); return; }

    var body = {
      member: state.member,
      slots: slots,               // 요일마다 시각이 다른 수업은 묶음이 여러 개다
      subject: subject,
      prof: currentProf(),
      room: currentRoom(),
      personal: currentPersonal()
    };
    if (state.editingGroup) { body.group_id = state.editingGroup; }

    el.save.disabled = true;
    fetch('api/save.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          // 서버 메시지에는 사용자 입력이 섞이므로 textContent 경로로만 출력한다
          toast(d && d.error ? d.error : '저장에 실패했습니다');
          return;
        }
        var wasEdit = !!state.editingGroup;
        state.pendingGroup = d.group_id;
        state.editingGroup = null;
        resetForm();
        renderHints();
        return loadRows().then(function () {
          toast(wasEdit ? '수정되었습니다' : '저장되었습니다');
        });
      })
      .catch(function () { toast('서버에 연결하지 못했습니다'); })
      .then(function () { el.save.disabled = false; });
  }

  function startEdit(g) {
    state.editingGroup = g.id;

    // 편람에 없는 수업은 검색으로 되살릴 수 없으므로 직접 입력 모드로 열어야
    // 그 자리에서 고칠 수 있다. 편람 수록 여부(row.catalog)는 서버가 조회할 때마다
    // 편람과 대조해 붙여 준다 — 직접 입력에도 교수명을 적을 수 있으므로
    // 교수명 유무로는 가를 수 없다 (api/_lib.php in_catalog).
    var manual = !g.catalog;
    setCourseMode(manual ? 'manual' : 'catalog');

    if (manual) {
      el.manualSubject.value = g.subject;
      el.manualProf.value = g.prof || '';
      el.manualRoom.value = g.room || '';
      el.manualPersonal.value = g.personal ? '네' : '';
      el.query.value = '';
      state.course = '';
      state.profs = [];
      state.prof = '';
    } else {
      state.course = g.subject;
      state.profs = [{ name: g.prof, slots: [] }];
      state.prof = g.prof;
      el.query.value = g.subject;
    }
    state.slots = [];
    state.slotIdx = '';
    state.meetings = null;

    state.days = {};
    g.days.forEach(function (d) { state.days[d] = true; });

    // 요일마다 시각이 다른 묶음은 편람에서만 나온다(직접 입력은 한 묶음에
    // 시각이 하나뿐이다). 직접 입력은 항상 아래 단일 시각 경로로 되살린다.
    if (!manual && g.meetings.length > 1) {
      // 요일마다 시각이 다른 수업. 교시 드롭다운 한 쌍으로는 표현할 수 없으므로
      // 확정된 시간 그대로 읽기 전용 요약으로 되살린다. 시각을 바꾸려면
      // 지우고 다시 등록해야 한다 (안내 문구로 알린다).
      state.meetings = g.meetings.map(function (m) {
        return { days: m.days.slice(), start: m.start, end: m.end, label: '' };
      });
      state.autofilled = true;
    } else {
      state.meetings = null;
      state.autofilled = false;

      // 저장된 시각이 교시표에 맞으면 그 교시를, 아니면 직접 입력으로 되살린다
      var one = g.meetings[0] || { start: 540, end: 590 };
      var matched = null;
      ['50', '75'].forEach(function (mode) {
        if (matched) { return; }
        var table = PERIODS[mode] || {};
        var a = null, b = null;
        Object.keys(table).forEach(function (k) {
          if (table[k][0] === one.start) { a = k; }
          if (table[k][1] === one.end)   { b = k; }
        });
        if (a !== null && b !== null) { matched = { mode: mode, s: a, e: b }; }
      });

      if (matched) {
        state.timeMode = matched.mode;
        fillPeriods();
        el.pStart.value = matched.s;
        el.pEnd.value = matched.e;
      } else {
        state.timeMode = 'custom';
        el.sh.value = String(Math.floor(one.start / 60));
        el.sm.value = String(one.start % 60);
        el.eh.value = String(Math.floor(one.end / 60));
        el.em.value = String(one.end % 60);
      }
    }

    // 강의실은 편람 모드에서만 드롭다운으로 되살린다 (직접 입력은 위 input에 넣었다)
    setRoomOptions(manual ? [] : (g.room ? [g.room] : []), manual ? '' : (g.room || ''));

    renderSteps();
    renderDays();
    renderTimeModes();
    renderHints();
    renderList();
    renderPreview();
    el.save.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function resetForm() {
    state.course = ''; state.profs = []; state.prof = '';
    state.slots = []; state.slotIdx = '';
    state.days = {};
    state.autofilled = false;
    state.meetings = null;
    el.query.value = '';
    el.manualSubject.value = '';
    el.manualProf.value = '';
    el.manualRoom.value = '';
    el.manualPersonal.value = '';
    setRoomOptions([]);
    closeResults();
    renderSteps();
    renderDays();
    renderTimeModes();
  }

  function openModal(g) {
    state.modalGroup = g.id;
    el.modalBody.textContent = g.subject + ' · ' + meetingsText(g.meetings) +
      ' 항목이 대시보드에서도 사라집니다.';
    el.modal.hidden = false;
  }

  function closeModal() {
    state.modalGroup = null;
    el.modal.hidden = true;
  }

  function confirmDelete() {
    var id = state.modalGroup;
    if (!id) { return; }

    fetch('api/delete.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member: state.member, group_id: id })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        closeModal();
        if (!d || !d.ok) { toast(d && d.error ? d.error : '삭제에 실패했습니다'); return; }
        if (state.editingGroup === id) { state.editingGroup = null; resetForm(); renderHints(); }
        if (state.pendingGroup === id) { state.pendingGroup = null; }
        return loadRows().then(function () { toast('삭제되었습니다'); });
      })
      .catch(function () { closeModal(); toast('서버에 연결하지 못했습니다'); });
  }

  // ── 이벤트 ────────────────────────────────────────────────────────

  el.member.addEventListener('change', function () {
    state.member = el.member.value;
    state.editingGroup = null;
    state.pendingGroup = null;
    renderHints();
    if (!state.member) {
      state.rows = [];
      renderList();
      renderPreview();
      return;
    }
    loadRows();
  });

  el.tabCatalog.addEventListener('click', function () { setCourseMode('catalog'); });
  el.tabManual.addEventListener('click', function () { setCourseMode('manual'); });
  if (el.seg) {
    el.seg.addEventListener('animationend', function (e) {
      if (e.animationName === 'seg-liquid') { el.seg.classList.remove('is-sliding'); }
    });
    window.addEventListener('resize', function () { moveSegThumb(false); });
    window.addEventListener('load', function () { moveSegThumb(false); });
  }

  // 디바운스 200ms — 서버는 최악 15ms라 성능 문제는 없지만 요청을 줄인다
  el.query.addEventListener('input', function () {
    state.course = ''; state.profs = []; state.prof = '';
    state.slots = []; state.slotIdx = '';
    state.activeResult = 0;
    state.autofilled = false;
    state.meetings = null;
    renderSteps();
    renderDays();
    renderTimeModes();
    renderHints();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, DEBOUNCE_MS);
  });
  el.query.addEventListener('focus', function () {
    if (el.query.value.trim() && state.results.length) { renderResults(); }
  });

  // 검색 결과는 직접 만든 목록이라 키보드 조작을 손으로 붙여 줘야 한다.
  // ↑↓로 옮기고 Enter로 고르고 Esc로 닫는다 — 네이티브 select와 같은 감각.
  el.query.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeResults(); return; }
    if (el.results.hidden || state.results.length === 0) { return; }

    if (e.key === 'ArrowDown') {
      e.preventDefault();                  // 커서가 입력창 끝으로 튀는 것을 막는다
      moveResult(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveResult(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var item = state.results[state.activeResult];
      if (item) { pickCourse(item); }
    }
  });
  document.addEventListener('click', function (e) {
    if (!el.results.hidden && !e.target.closest('.search-wrap')) { closeResults(); }
  });

  el.prof.addEventListener('change', function () {
    state.prof = el.prof.value;
    state.slotIdx = '';
    state.slots = [];
    state.meetings = null;
    state.autofilled = false;
    setRoomOptions([]);          // 분반이 바뀌기 전까지는 강의실도 미정
    state.profs.forEach(function (p) {
      if (p.name === state.prof) { state.slots = p.slots || []; }
    });

    // 시간이 하나로 정해지면 고르게 하지 않고 바로 채운다
    if (state.slots.length === 1) { applySlot('0'); return; }

    renderSteps();
    renderDays();                // 시간 선택이 풀렸으니 요일 잠금 해제
    renderTimeModes();           // 자동 채움이 풀렸으니 시간 잠금도 해제
    renderHints();
  });

  el.slot.addEventListener('change', function () { applySlot(el.slot.value); });
  el.roomSelect.addEventListener('change', renderRoom);
  el.roomCustom.addEventListener('input', function () {
    el.lbRoom.className = 'step-label' + (currentRoom() ? ' is-on' : '');
  });

  el.manualSubject.addEventListener('input', renderPreview);
  el.pStart.addEventListener('change', function () { state.autofilled = false; renderPreview(); });
  el.pEnd.addEventListener('change', function () { state.autofilled = false; renderPreview(); });

  el.save.addEventListener('click', save);
  el.cancelEdit.addEventListener('click', function () {
    state.editingGroup = null;
    resetForm();
    renderHints();
    renderList();
    renderPreview();
  });

  el.modalCancel.addEventListener('click', closeModal);
  el.modalConfirm.addEventListener('click', confirmDelete);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.modal.hidden) { closeModal(); }
  });

  // ── 시작 ──────────────────────────────────────────────────────────

  fillMembers();
  fillDays();
  fillTimeModes();
  fillPeriods();
  fillCustom();
  setRoomOptions([]);
  renderSteps();
  renderDays();
  renderTimeModes();
  renderHints();
  renderList();
  renderPreview();
  moveSegThumb(false);         // 유리 알약을 활성 버튼 위치로 즉시 배치
})();
