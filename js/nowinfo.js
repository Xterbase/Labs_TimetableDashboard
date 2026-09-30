/**
 * 좌하영역 — Now info
 *
 * Timetable에서 가리킨 영역의 수강정보를 보여준다. 예전에는 마우스를 따라다니는
 * 툴팁 하나가 전부였는데, 겹친 수업이 많을수록 툴팁 한 줄로는 담기지 않아
 * 고정 영역으로 분리했다. 툴팁은 스치듯 읽는 요약(구성원 명단 / n명 가능),
 * 이쪽은 머물러 읽는 상세를 맡는다.
 *
 *   hover  → 그 영역의 정보가 임시로 뜬다. 마우스를 떼면 사라진다.
 *   click  → 그 영역으로 고정된다. 다른 영역을 클릭하면 그쪽으로 바뀐다.
 *
 * 겹친 수업은 **Now와 같은 모양의 리스트**로 전부 나열한다. 고르는 조작은 없다 —
 * 한 번에 다 보이는 편이 "이 시간에 누가 무슨 수업인지"를 읽기에 빠르다.
 * 행 클래스(.now-row 계열)를 Now와 공유해 두 패널의 리듬을 맞춘다.
 *
 * 데이터는 timetable.js가 'tt:focus' / 'tt:pin'으로 넘겨준다.
 * 로드 순서: now.js → nowinfo.js → timetable.js.
 */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var subEl   = $('info-sub'),
      listEl  = $('info-list'),
      badgeEl = $('info-badge'),
      unpinEl = $('info-unpin');

  var pinned  = null;   // 클릭으로 고정한 영역
  var hovered = null;   // 지금 마우스가 올라가 있는 영역

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmt(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }

  function line(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    d.textContent = text;         // 사용자 입력·편람 원문이므로 textContent만
    return d;
  }

  function empty(lines) {
    var box = document.createElement('div');
    box.className = 'info-empty';
    var inner = document.createElement('div');
    lines.forEach(function (t) { inner.appendChild(line('', t)); });
    box.appendChild(inner);
    listEl.appendChild(box);
  }

  /** 한 수업 = 한 줄. 이름 / 과목명 · 교수명 · 강의실 / 강의시간 */
  function row(it) {
    var el = document.createElement('div');
    el.className = 'now-row';

    var text = document.createElement('div');
    text.className = 'now-text';
    text.appendChild(line('now-name', it.member));
    text.appendChild(line('now-subject',
      [it.subject, it.prof, it.room].filter(Boolean).join(' · ')));

    var time = document.createElement('div');
    time.className = 'now-time';
    time.textContent = fmt(it.start) + '–' + fmt(it.end);

    el.appendChild(text);
    el.appendChild(time);
    return el;
  }

  function render() {
    // hover가 고정보다 우선한다 — 마우스를 떼면 고정된 내용으로 되돌아온다.
    var live = hovered !== null;
    var r    = hovered || pinned;
    var showPin = !live && pinned !== null;

    badgeEl.hidden = !showPin;
    unpinEl.hidden = !showPin;

    listEl.textContent = '';

    if (!r) {
      subEl.textContent = '';
      empty([
        '시간표에 마우스를 올리면 그 시간의 수강정보가 여기에 뜹니다.',
        '클릭하면 고정됩니다.'
      ]);
      return;
    }

    var span = r.dayLabel + '요일 ' + fmt(r.start) + '–' + fmt(r.end);

    if (r.items.length === 0) {
      subEl.textContent = span;
      empty(['이 시간에는 수업이 없습니다.']);
      return;
    }

    subEl.textContent = span + ' · ' + r.items.length + '명 수업 중';

    var frag = document.createDocumentFragment();
    r.items.forEach(function (it) { frag.appendChild(row(it)); });
    listEl.appendChild(frag);
  }

  window.addEventListener('tt:focus', function (e) {
    hovered = e.detail || null;
    render();
  });

  window.addEventListener('tt:pin', function (e) {
    pinned = e.detail || null;
    render();
  });

  unpinEl.addEventListener('click', function () {
    window.dispatchEvent(new CustomEvent('tt:unpin'));
  });

  render();
})();
