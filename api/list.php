<?php
/**
 * 시간표 조회
 *
 * GET /api/list.php
 *
 * → {
 *     "ok": true,
 *     "rows":    [ { id, group_id, member, day, start, end, subject, prof, room, color,
 *                   personal, grade, catalog }, ... ],
 *                                              // grade·catalog는 편람에서 조인한 값,
 *                                              // personal은 CSV에 저장된 개인일정 표시
 *     "members": [ { name, color }, ... ],
 *     "now":     { day, minutes, time, weekday }
 *   }
 *
 * 방식 B(설계 문서 2-2)이므로 겹침 계산을 하지 않고 원본 행을 그대로 내려준다.
 * 오버레이·현재수업·개인별 뷰 세 가지가 모두 이 원본에서 파생된다.
 */

declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
    json_err('GET 요청만 허용됩니다.', 405);
}

// 저장 직후 재조회가 캐시에 막히지 않도록
header('Cache-Control: no-store');

// ─── 시간표 ──────────────────────────────────────────────────────────
$rows = read_all_rows();

// 요일 → 시작 → 이름 순. 프론트에서 다시 정렬할 필요가 없도록 여기서 맞춰 둔다.
usort($rows, fn($a, $b) =>
    [$a['day'], $a['start'], $a['member']] <=> [$b['day'], $b['start'], $b['member']]
);

// ─── 명단 ────────────────────────────────────────────────────────────
// 아직 시간표를 등록하지 않은 구성원도 드롭다운에 나와야 하므로
// rows가 아니라 members.csv를 기준으로 내려준다 (설계 문서 9절).
$members = [];
foreach (load_members() as $name => $color) {
    $members[] = ['name' => $name, 'color' => $color];
}

// ─── 서버 시각 ───────────────────────────────────────────────────────
// 좌영역의 "지금 수업 중" 계산은 브라우저 시계를 쓰지만, 사용자 PC 시계가
// 틀어졌을 때 보정할 수 있도록 서버 기준 시각을 함께 내려준다.
// day: 0=월 ~ 4=금, 5=토, 6=일 (5 이상이면 프론트는 빈 상태를 표시한다)
$now = [
    'day'     => (int) date('N') - 1,
    'minutes' => (int) date('G') * 60 + (int) date('i'),
    'time'    => date('c'),
    'weekday' => ['월', '화', '수', '목', '금', '토', '일'][(int) date('N') - 1],
];

json_ok([
    'rows'    => $rows,
    'members' => $members,
    'now'     => $now,
]);
