/**
 * 좌상영역 — 지금 수업 중인 사람 리스트
 *
 * 데이터·시각 계산은 timetable.js가 소유한다. 이 파일은 'tt:update' 이벤트를
 * 받아 그리기만 한다 (방식 B: 원본이 이미 메모리에 있으므로 네트워크 요청 없이
 * 재계산만 하면 된다 — 설계 문서 2-2, 7-1).
 *
 * 로드 순서: now.js → nowinfo.js → timetable.js. 이 파일은 리스너만 등록하고,
 * 실제 렌더는 timetable.js가 데이터를 채운 뒤에 일어난다.
 */

(function () {
  'use strict';

  var subEl  = document.getElementById('now-sub');
  var listEl = document.getElementById('now-list');

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmt(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }

  function render(state) {
    var now = state.now;

    // 경계 조건: start <= 현재 < end. 끝나는 시각 정각에는 목록에서 빠진다.
    // 토(5)·일(6)이면 필터가 비게 되므로 자연히 빈 상태가 된다.
    var cur = state.rows.filter(function (r) {
      return r.day === now.day && r.start <= now.minutes && now.minutes < r.end;
    });
    cur.sort(function (a, b) {
      return a.start - b.start || a.member.localeCompare(b.member, 'ko');
    });

    // "14:32 현재 / 3명 수업중"
    subEl.textContent = fmt(now.minutes) + ' 현재 / ' + cur.length + '명 수업중';

    listEl.textContent = '';

    if (cur.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'now-empty';
      empty.textContent = '지금 수업 중인 사람이 없습니다';
      listEl.appendChild(empty);
      return;
    }

    var frag = document.createDocumentFragment();
    cur.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'now-row';

      var text = document.createElement('div');
      text.className = 'now-text';

      var name = document.createElement('div');
      name.className = 'now-name';
      name.textContent = r.member;          // 사용자 입력이므로 textContent만 쓴다

      var subject = document.createElement('div');
      subject.className = 'now-subject';
      subject.textContent = [r.subject, r.prof].filter(Boolean).join(' · ');

      var time = document.createElement('div');
      time.className = 'now-time';
      time.textContent = fmt(r.start) + '–' + fmt(r.end);

      text.appendChild(name);
      text.appendChild(subject);
      row.appendChild(text);
      row.appendChild(time);
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
  }

  window.addEventListener('tt:update', function (e) { render(e.detail); });
})();
