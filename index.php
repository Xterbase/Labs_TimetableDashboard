<?php
/**
 * 시간표 대시보드 (조회 전용)
 *
 * 디자인 사양: docs/frontend_DESIGN.md
 * 좌영역 = Now(지금 수업 중인 사람) + Now info(가리킨 영역의 수강정보),
 * 우영역 = 월~금 시간표. 좌·우 면적이 40:60이고, 좌영역 안에서 두 박스가 1:1이다.
 *
 * 입력은 별도 페이지(input.php)가 담당한다 — 대시보드만 보러 온 방문자가
 * 입력 폼에 막히지 않도록, 기본 진입점은 항상 이 화면이다 (설계 문서 9절).
 *
 * 초기 데이터는 서버에서 심어 첫 화면에 fetch 왕복이 없도록 한다.
 * 이후 갱신은 js/timetable.js가 api/list.php로 재조회한다.
 */

declare(strict_types=1);

require __DIR__ . '/api/_lib.php';

// read_all_rows()가 편람에서 수강학년(grade)을 조인해 붙여 준다 (_lib.php).
$rows = read_all_rows();
usort($rows, fn($a, $b) =>
    [$a['day'], $a['start'], $a['member']] <=> [$b['day'], $b['start'], $b['member']]
);

$members = [];
foreach (load_members() as $name => $color) {
    $members[] = ['name' => $name, 'color' => $color];
}

// now.day: 0=월~4=금, 5=토, 6=일 (5 이상이면 좌영역은 빈 상태를 표시한다)
$initial = [
    'rows'    => $rows,
    'members' => $members,
    'now'     => [
        'day'     => (int) date('N') - 1,
        'minutes' => (int) date('G') * 60 + (int) date('i'),
        'time'    => date('c'),
        'weekday' => ['월', '화', '수', '목', '금', '토', '일'][(int) date('N') - 1],
    ],
];

// <script> 안에 들어가므로 태그·따옴표를 전부 이스케이프한다.
$initialJson = json_encode(
    $initial,
    JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
);
?>
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>연구실 시간표</title>
<link rel="stylesheet" href="css/style.css?v=14">
</head>
<body>

<div class="shell">

  <!-- 헤더 — 입력 화면(input.php)의 .page-head와 같은 높이·같은 자리다 -->
  <div class="page-head">
    <h1>연구실 시간표</h1>
    <a class="btn-pill" href="input.php">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      시간표 입력
    </a>
  </div>

  <div class="app" id="app">

    <!-- 좌영역: Now + Now info (1:1) -->
    <div class="col-left">

      <section class="panel panel-now">
        <div class="now-head">
          <span class="live-dot" id="live-dot" aria-hidden="true"></span>
          <h2>Now</h2>
        </div>
        <div class="now-sub" id="now-sub"></div>
        <div class="rule"></div>
        <div class="now-list" id="now-list"></div>
      </section>

      <!-- Timetable에서 가리킨 영역의 수강정보. hover=임시, click=고정 -->
      <section class="panel panel-info">
        <div class="info-head">
          <h2>Now info</h2>
          <span class="pin-badge" id="info-badge" hidden>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/></svg>
            고정됨
          </span>
          <button type="button" class="btn-round btn-sm" id="info-unpin" aria-label="고정 해제" hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="info-sub" id="info-sub"></div>
        <div class="rule"></div>
        <!-- 겹친 수업을 Now와 같은 리스트로 나열한다 -->
        <div class="info-list" id="info-list"></div>
      </section>

    </div>

    <!-- 우영역: 월~금 시간표 -->
    <section class="panel panel-tt">
      <div class="tt-head">
        <h2>Timetable</h2>
      </div>

      <!-- 전체 선택 = 전원 겹쳐보기 / 칩 = 원하는 구성원만 골라 겹쳐보기 -->
      <div class="tt-ctrl">
        <label class="check" for="select-all">
          <input type="checkbox" id="select-all" checked>
          <span class="box" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          </span>
          전체 선택
        </label>

        <!-- 구성원 선택 버튼(칩) — 항상 노출된다. js가 채운다.
             전체 선택 상태면 전원이 활성(회색)이고, 칩을 누르면 전체 선택이
             풀리면서 그 사람만 남는다. -->
        <div class="member-chips" id="member-chips"></div>
      </div>

      <!-- 겹쳐 보기: 인원수 그라데이션 바 — js가 채운다 -->
      <div class="legend" id="legend-heat"></div>

      <!-- 혼자만 선택: 그 사람 수업을 수강학년 색으로 -->
      <div class="legend" id="legend-grade" hidden>
        <span><i class="g1"></i>1학년</span>
        <span><i class="g2"></i>2학년</span>
        <span><i class="g3"></i>3학년</span>
        <span><i class="g4"></i>4학년</span>
        <span><i class="gG"></i>대학원</span>
        <span><i class="g0"></i>교양</span>
        <span><i class="gP"></i>개인일정</span>
      </div>

      <div class="grid-wrap">
        <div class="grid" id="grid"></div>
      </div>
    </section>

  </div><!-- /app -->

</div><!-- /shell -->

<!-- 그리드 위를 따라다니는 툴팁 — 구성원 명단 / "n명 가능" -->
<div class="tooltip" id="tooltip" hidden></div>

<script>window.__INITIAL__ = <?= $initialJson ?>;</script>
<script src="js/now.js?v=14"></script>
<script src="js/nowinfo.js?v=14"></script>
<script src="js/timetable.js?v=14"></script>
</body>
</html>
