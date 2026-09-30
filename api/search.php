<?php
/**
 * 수강편람 과목 검색 (입력 화면 3단 드롭다운용)
 *
 * GET /api/search.php?q=검색어&limit=10
 *
 * → {
 *     ok: true,
 *     items: [ { subject, profs: [ { name, slots: [ 분반 ] } ] } ],
 *     total, ms
 *   }
 *
 *   분반 = { label, room, meetings: [ { label, days, start, end, mode } ] }
 *
 * **분반(= 편람 한 행)이 단위다.** 한 분반이 요일마다 다른 시각에 열리는 경우가
 * 15.1%(310행)나 된다 — 예: `Python기초 / 한소율 / 화7,8,목9`는 화요일 15:00~16:50,
 * 목요일 17:00~17:50인 **하나의 수업**이다. 이걸 시각별로 쪼개 내려보내면 사용자가
 * 둘 중 하나만 고르게 되어 시간표의 절반이 빠진다. 그래서 한 행에서 나온 묶음은
 * 전부 `meetings`에 담아 **함께** 넘긴다.
 *
 * 반대로 **행이 다르면 다른 분반**이다. 채플/선교훈련팀은 8행이라 분반이 8개고,
 * 이때는 사용자가 골라야 한다. 두 경우를 가르는 기준이 곧 "행 경계"다.
 *
 * 같은 과목이 분반별로 최대 25행까지 있으므로 **과목명으로 묶어서** 반환한다.
 * 그대로 내리면 자동완성 목록이 같은 이름으로 도배된다.
 */

declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
    json_err('GET 요청만 허용됩니다.', 405);
}
header('Cache-Control: no-store');

$t0    = microtime(true);
$q     = trim((string) ($_GET['q'] ?? ''));
$limit = min(max((int) ($_GET['limit'] ?? 10), 1), 50);

if ($q === '') {
    json_ok(['items' => [], 'total' => 0, 'ms' => 0]);
}
$nq = norm($q);

$catalog = read_catalog();
if ($catalog === []) {
    json_err('수강편람 파일이 없습니다: data/catalog.csv', 500);
}

// 과목 → 교수 → 시간. 등장 순서를 유지한다.
$groups = [];
foreach ($catalog as $row) {
    $subject = $row['subject'];

    // 과목명 또는 교수명에 질의가 포함되면 채택 (공백·대소문자 무시)
    if (!str_contains(norm($subject), $nq) && !str_contains(norm($row['prof']), $nq)) {
        continue;
    }

    // 편람에 한 행(채플)은 수강신청 안내문 800자가 교수명·강의시간 칸에
    // 통째로 들어가 있다. 그대로 두면 드롭다운에 안내문이 옵션으로 뜬다.
    // 정상 교수명 중 가장 긴 것이 23자라 30자로 안전하게 갈린다.
    if (mb_strlen($row['prof']) > 30) {
        continue;
    }

    // 교수 정보가 없는 과목이 13개 있다 → 폴백 라벨
    $prof = $row['prof'] !== '' ? $row['prof'] : PROF_NONE;

    // 한 행에서 나온 묶음 전체가 곧 한 분반이다
    $slots = parse_class_time($row['time']);
    if ($slots === []) {
        continue;                      // 시간을 읽어낼 수 없는 행은 후보에서 뺀다
    }

    $meetings = [];
    $sig      = [];
    foreach ($slots as $slot) {
        $meetings[] = [
            'label' => slot_label($slot),
            'days'  => $slot['days'],
            'start' => $slot['start'],
            'end'   => $slot['end'],
            'mode'  => $slot['mode'],
        ];
        $sig[] = implode(',', $slot['days']) . ':' . $slot['start'] . '-' . $slot['end'];
    }
    sort($sig);

    $groups[$subject] ??= [];
    $groups[$subject][$prof] ??= [];

    // 시간표가 완전히 같은 분반(강의실 표기만 다른 중복 행 등)은 한 번만 보여준다.
    // ??= 이므로 먼저 나온 행의 강의실이 남는다.
    $groups[$subject][$prof][implode('|', $sig)] ??= [
        'label'    => implode(' · ', array_column($meetings, 'label')),
        'meetings' => $meetings,
        'room'     => $row['room'],   // 편람에 강의실 컬럼이 있으면 자동 채움에 쓴다
    ];
}

$total = count($groups);
$items = [];
foreach (array_slice($groups, 0, $limit, true) as $subject => $profs) {
    $profList = [];
    foreach ($profs as $name => $slots) {
        $profList[] = ['name' => $name, 'slots' => array_values($slots)];
    }
    $items[] = ['subject' => $subject, 'profs' => $profList];
}

json_ok([
    'items' => $items,
    'total' => $total,
    'ms'    => round((microtime(true) - $t0) * 1000, 2),
]);
