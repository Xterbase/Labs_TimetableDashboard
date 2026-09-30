<?php
/**
 * 시간표 입력 화면
 *
 * 디자인 사양: docs/input_DESIGN.md
 * 대시보드(index.php)는 조회 전용이고, 입력·수정·삭제는 전부 이 페이지가 맡는다.
 *
 * `.html`이 아니라 `.php`인 이유: 교시표(PERIODS_50/75)와 시간 상수를
 * _lib.php에서 그대로 주입하기 위해서다. JS에 하드코딩하면 백엔드 검증과
 * 어긋나는 순간 "저장 버튼이 조용히 실패하는" 증상이 된다 (설계 문서 3-2).
 */

declare(strict_types=1);

require __DIR__ . '/api/_lib.php';

$members = [];
foreach (load_members() as $name => $color) {
    $members[] = ['name' => $name, 'color' => $color];
}

$boot = [
    'members'  => $members,
    'days'     => DAY_LABELS,
    'timeMin'  => TIME_MIN,
    'timeMax'  => TIME_MAX,
    'slotMin'  => SLOT_MIN,
    // 교시표는 [키 => [시작, 종료]]. 키 순서가 곧 드롭다운 순서다.
    'periods'  => ['50' => PERIODS_50, '75' => PERIODS_75],
];

$bootJson = json_encode(
    $boot,
    JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
);
?>
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>시간표 입력</title>
<link rel="stylesheet" href="css/input.css?v=7">
</head>
<body>

<div class="page">
  <div class="column">

    <!-- 헤더 -->
    <div class="page-head">
      <h1>시간표 입력</h1>
      <a class="btn-pill" href="index.php">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
        대시보드 보기
      </a>
    </div>

    <!-- 좌: 입력 폼 / 우: 미리보기 + 등록 목록 -->
    <div class="layout">
    <div class="col">

    <!-- 이름 -->
    <section class="card card-name">
      <div class="card-title">이름</div>
      <div class="card-hint">본인 이름을 선택하면 등록한 수업이 아래에 표시됩니다.</div>
      <select id="member" class="select w-280" aria-label="구성원 선택">
        <option value="">이름 선택…</option>
      </select>
    </section>

    <!-- 과목 -->
    <section class="card card-course">
      <div class="head-row">
        <div class="grow">
          <div class="card-title">과목</div>
          <div class="card-hint" id="course-hint">편람에서 과목 → 교수만 고르면 시간·강의실이 자동으로 채워집니다.</div>
        </div>
        <div class="seg" id="seg">
          <span class="seg-thumb" id="seg-thumb" aria-hidden="true"></span>
          <button type="button" id="tab-catalog" class="is-on">편람 검색</button>
          <button type="button" id="tab-manual">직접 입력</button>
        </div>
      </div>

      <!-- 편람 검색 모드 -->
      <div id="mode-catalog" class="group" style="gap:14px">
        <div class="search-wrap">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" id="query" class="input" placeholder="과목명 검색 (예: 데이터)" autocomplete="off">
          <div id="results" class="results" hidden></div>
        </div>

        <!-- 2×2: 1 과목 / 2 교수명 · 3 시간 / 4 강의실 -->
        <div class="steps">
          <div class="step">
            <div class="step-label" id="lb-course">1 · 과목</div>
            <div class="chosen" id="chosen-course">검색 후 선택</div>
          </div>
          <div class="step">
            <div class="step-label" id="lb-prof">2 · 교수명</div>
            <select id="prof" class="select" aria-label="교수명" disabled>
              <option value="">교수 선택…</option>
            </select>
          </div>
          <!-- 시간은 편람에서 자동으로 들어간다. 같은 과목·같은 교수인데
               시간이 여러 개일 때(채플 등)만 예외로 드롭다운이 나온다. -->
          <div class="step">
            <div class="step-label" id="lb-slot">3 · 시간 (자동)</div>
            <div class="chosen" id="chosen-slot">과목을 먼저 고르세요</div>
            <select id="slot" class="select" aria-label="분반 시간" disabled hidden>
              <option value="">시간 선택…</option>
            </select>
          </div>
          <div class="step">
            <div class="step-label" id="lb-room">4 · 강의실</div>
            <select id="room-select" class="select" aria-label="강의실" disabled>
              <option value="">강의실 선택…</option>
            </select>
            <input type="text" id="room-custom" class="input room-custom" placeholder="강의실 직접 입력" hidden>
          </div>
        </div>
      </div>

      <!-- 직접 입력 모드 — 과목 / 교수명 / 강의실 / 개인일정 여부 순 -->
      <div id="mode-manual" class="group tight" hidden>
        <label class="field-label" for="manual-subject">과목(세미나)/일정명</label>
        <input type="text" id="manual-subject" class="input" maxlength="50" placeholder="예: 대학원세미나 / 랩미팅">
        <label class="field-label mt" for="manual-prof">교수명</label>
        <input type="text" id="manual-prof" class="input" maxlength="30" placeholder="예: 홍길동 (없으면 공란으로)">
        <label class="field-label mt" for="manual-room">강의실</label>
        <input type="text" id="manual-room" class="input" maxlength="30" placeholder="예) 060326(없으면 공란으로)">
        <!-- 「네」면 시간표에 회색 개인일정으로 들어간다. 공란·「아니오」면 일반 수업. -->
        <label class="field-label mt" for="manual-personal">개인일정 여부</label>
        <input type="text" id="manual-personal" class="input" maxlength="10" placeholder="예) 네 (과방·알바 등 / 아니면 공란)">
      </div>
    </section>

    <!-- 요일 · 시간 -->
    <section class="card card-when">
      <div>
        <div class="card-title">요일 · 시간</div>
        <div class="card-hint" id="autofill-hint" style="margin-top:4px">직접 고르거나, 위에서 과목을 선택하면 자동으로 채워집니다.</div>
      </div>

      <div class="group">
        <div class="field-label">요일 (여러 개 선택 가능)</div>
        <div class="chip-row" id="days"></div>
      </div>

      <div class="group">
        <!-- 편람에서 시간이 확정되면 이 줄들 대신 #auto-time 요약이 뜬다 -->
        <div class="field-label" id="lb-timemode">시간 방식</div>
        <div class="chip-row" id="time-modes"></div>

        <div id="period-row" class="time-row">
          <select id="p-start" class="time-unit" aria-label="시작 교시"></select>
          <span class="sep">~</span>
          <select id="p-end" class="time-unit" aria-label="종료 교시"></select>
        </div>

        <div id="custom-row" class="time-row" hidden>
          <div class="time-pair">
            <select id="sh" class="time-unit" aria-label="시작 시"></select>
            <span class="sep">:</span>
            <select id="sm" class="time-unit" aria-label="시작 분"></select>
          </div>
          <span class="sep">~</span>
          <div class="time-pair">
            <select id="eh" class="time-unit" aria-label="종료 시"></select>
            <span class="sep">:</span>
            <select id="em" class="time-unit" aria-label="종료 분"></select>
          </div>
        </div>

        <!-- 편람에서 확정된 시간. 요일마다 시각이 다른 수업은 여러 줄이 된다
             (예: Python기초/한소율 = 화 15:00~16:50 + 목 17:00~17:50) -->
        <div id="auto-time" class="auto-time" hidden></div>
      </div>

      <div class="save-row">
        <button type="button" id="save" class="btn-primary">저장</button>
        <button type="button" id="cancel-edit" class="btn-quiet" hidden>수정 취소</button>
        <span class="card-hint" id="save-hint">저장하면 우측의 미리보기에 바로 표시됩니다.</span>
      </div>
    </section>

    </div><!-- /col 좌 -->
    <div class="col">

    <!-- 미리보기 -->
    <section class="card card-preview">
      <div class="title-row">
        <div class="card-title">미리보기</div>
        <div class="card-hint">저장 전 확인용 · 실제 조회는 대시보드에서</div>
      </div>
      <div class="preview" id="preview"></div>
      <div class="legend">
        <span><i id="sw-saved"></i>등록된 수업</span>
        <span><i class="sw-pending"></i>방금 입력한 수업</span>
      </div>
    </section>

    <!-- 내 등록 목록 -->
    <section class="card card-list">
      <div class="title-row" style="margin-bottom:10px">
        <div class="card-title">내 등록 목록</div>
        <div class="card-hint" id="list-sub">이름을 먼저 선택하세요</div>
      </div>
      <div id="entries"></div>
    </section>

    </div><!-- /col 우 -->
    </div><!-- /layout -->

  </div>
</div>

<div class="toast" id="toast" hidden></div>

<div class="backdrop" id="modal" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="t" id="modal-title">이 수업을 삭제할까요?</div>
    <div class="b" id="modal-body"></div>
    <div class="actions">
      <button type="button" class="btn-cancel" id="modal-cancel">취소</button>
      <button type="button" class="btn-danger" id="modal-confirm">삭제</button>
    </div>
  </div>
</div>

<script>window.__BOOT__ = <?= $bootJson ?>;</script>
<script src="js/input.js?v=10"></script>
</body>
</html>
