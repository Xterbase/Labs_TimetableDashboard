<?php
/**
 * 시간표 저장 (추가 / 수정)
 *
 * POST /api/save.php   Content-Type: application/json
 * {
 *   "member":   "김다겸",
 *   "slots": [                          // 한 수업이 열리는 시간 묶음들
 *     { "days": [1], "start": 900,  "end": 1010 },   // 화 15:00~16:50
 *     { "days": [3], "start": 1020, "end": 1070 }    // 목 17:00~17:50
 *   ],
 *   "subject":  "Python기초",
 *   "prof":     "한소율",     // 선택
 *   "room":     "060107-0",  // 선택
 *   "group_id": "..."        // 있으면 그 묶음을 덮어쓰는 수정 모드
 * }
 *
 * **한 수업이 요일마다 다른 시각에 열릴 수 있다.** `Python기초 / 한소율`은
 * 화 15:00~16:50 + 목 17:00~17:50인 하나의 수업이고, 편람 행의 15.1%가 이 형태다.
 * 그래서 `days + 단일 start/end`가 아니라 **`slots` 배열**을 받는다.
 * 구버전 형식(`days`/`start`/`end` 또는 `day`)도 계속 받는다 — slots 한 개로 접는다.
 *
 * → { ok: true, group_id, rows: [...] }
 *
 * color는 서버가 members.csv에서 채운다. 클라이언트가 보낸 값은 신뢰하지 않는다.
 *
 * ⚠️ **전부 검증한 뒤에만 기록한다.** 월·수 중 수요일만 겹칠 때 월요일만
 * 저장되는 "반쪽 상태"가 생기면 안 된다. 그래서 요일별로 나눠 쓰지 않고
 * mutate_rows()로 한 번에 교체한다 (설계 문서 8-7).
 * slots끼리 서로 겹치는지도 기록 전에 함께 본다.
 */

declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_err('POST 요청만 허용됩니다.', 405);
}

$in = read_json_body();

// ─── member ──────────────────────────────────────────────────────────
// 명단 대조가 곧 경로 순회(../) 차단이다. 반드시 먼저 검사할 것.
$member = trim((string) ($in['member'] ?? ''));
if ($member === '') {
    json_err('이름을 선택하세요.');
}
if (!valid_member($member)) {
    json_err("명단에 없는 이름입니다: {$member}");
}

// ─── slots ───────────────────────────────────────────────────────────
// 구버전(days + 단일 start/end, 또는 단일 day)도 계속 받는다.
$rawSlots = $in['slots'] ?? null;
if (!is_array($rawSlots) || $rawSlots === []) {
    $rawSlots = [[
        'days'  => $in['days'] ?? (isset($in['day']) ? [$in['day']] : null),
        'start' => $in['start'] ?? null,
        'end'   => $in['end']   ?? null,
    ]];
}
if (count($rawSlots) > 5) {
    json_err('한 수업의 시간 묶음은 최대 5개까지입니다.');
}

/** 검증을 마친 (요일, 시작, 종료) 목록. 이대로 한 행씩 기록된다. */
$meetings = [];

foreach ($rawSlots as $slot) {
    if (!is_array($slot)) {
        json_err('시간 형식이 올바르지 않습니다.');
    }

    $rawDays = $slot['days'] ?? (isset($slot['day']) ? [$slot['day']] : null);
    if (!is_array($rawDays) || $rawDays === []) {
        json_err('요일을 하나 이상 선택하세요.');
    }
    if (count($rawDays) > 5) {
        json_err('요일은 최대 5개까지 선택할 수 있습니다.');
    }

    $days = [];
    foreach ($rawDays as $d) {
        $v = filter_var($d, FILTER_VALIDATE_INT);
        if ($v === false || $v < DAY_MIN || $v > DAY_MAX) {
            json_err('요일은 0(월)~4(금) 사이여야 합니다.');
        }
        if (in_array($v, $days, true)) {
            json_err('같은 요일을 두 번 선택했습니다.');
        }
        $days[] = $v;
    }
    sort($days);

    $start = filter_var($slot['start'] ?? null, FILTER_VALIDATE_INT);
    $end   = filter_var($slot['end']   ?? null, FILTER_VALIDATE_INT);

    if ($start === false || $end === false) {
        json_err('시작·종료 시간은 숫자여야 합니다.');
    }
    foreach (['시작' => $start, '종료' => $end] as $label => $v) {
        if ($v < TIME_MIN || $v > TIME_MAX) {
            json_err(sprintf(
                '%s 시간은 %s~%s 사이여야 합니다.',
                $label, fmt_min(TIME_MIN), fmt_min(TIME_MAX % 1440)
            ));
        }
        if ($v % SLOT_MIN !== 0) {
            json_err("{$label} 시간은 " . SLOT_MIN . '분 단위여야 합니다.');
        }
    }
    if ($end <= $start) {
        json_err('종료 시간이 시작 시간보다 뒤여야 합니다.');
    }

    foreach ($days as $day) {
        // 같은 요청 안에서 스스로 겹치는지 먼저 본다.
        // 겹침 판정: a.start < b.end && b.start < a.end
        foreach ($meetings as $m) {
            if ($m['day'] === $day && $start < $m['end'] && $m['start'] < $end) {
                json_err(sprintf(
                    '%s요일에 입력한 시간끼리 겹칩니다: %s~%s 와 %s~%s',
                    DAY_LABELS[$day],
                    fmt_min($m['start']), fmt_min($m['end']),
                    fmt_min($start), fmt_min($end)
                ));
            }
        }
        $meetings[] = ['day' => $day, 'start' => $start, 'end' => $end];
    }
}

if (count($meetings) > 10) {
    json_err('한 수업에 넣을 수 있는 시간은 최대 10개입니다.');
}

usort($meetings, fn($a, $b) => [$a['day'], $a['start']] <=> [$b['day'], $b['start']]);

// ─── subject / prof / room ───────────────────────────────────────────
// 줄바꿈은 fputcsv가 따옴표로 감싸 보존하지만, 시간표 항목에는 들어갈 이유가
// 없으므로 공백으로 눌러 CSV를 한 줄=한 행으로 유지한다.
$clean = fn($v) => trim(preg_replace('/[\r\n\t]+/u', ' ', (string) $v));

$subject = $clean($in['subject'] ?? '');
if ($subject === '') {
    json_err('과목명을 입력하세요.');
}
if (mb_strlen($subject) > 50) {
    json_err('과목명은 50자 이내여야 합니다.');
}

$prof = $clean($in['prof'] ?? '');       // 편람 미등록 과목·대학원 수업은 빈 값 허용
if (mb_strlen($prof) > 30) {
    json_err('교수명은 30자 이내여야 합니다.');
}

$room = $clean($in['room'] ?? '');
if (mb_strlen($room) > 30) {
    json_err('강의실은 30자 이내여야 합니다.');
}

// 개인일정 여부(과방·알바 등). 입력 화면이 "네/아니오"를 그대로 보내므로
// 여기서 해석한다 — 오타·표기 흔들림을 받아 주되, 아니면 전부 일반 수업으로 본다.
// 저장값은 '1' 또는 ''이고, 조회 시 grade='P'(짙은 회색)로 바뀐다.
$personal = is_yes($in['personal'] ?? '') ? '1' : '';

// ─── 수정 모드 ───────────────────────────────────────────────────────
$groupId = $clean($in['group_id'] ?? '');
if ($groupId !== '' && !preg_match('/^[0-9a-f]{16}$/', $groupId)) {
    json_err('group_id 형식이 올바르지 않습니다.');
}
$isEdit = $groupId !== '';

$color = member_color($member);
if ($groupId === '') {
    $groupId = gen_id();
}

// ─── 검증 후 한 번에 기록 ────────────────────────────────────────────
$saved = mutate_rows($member, function (array $rows) use (
    $member, $meetings, $subject, $prof, $room, $color, $groupId, $isEdit, $personal
): array {
    // 수정 모드면 기존 묶음을 통째로 걷어낸 상태에서 겹침을 따진다.
    // 안 그러면 "자기 자신과 겹친다"며 자기 수정이 항상 막힌다.
    $kept = array_values(array_filter(
        $rows,
        fn($r) => !$isEdit || ($r['group_id'] ?? '') !== $groupId
    ));

    if ($isEdit && count($kept) === count($rows)) {
        json_err('수정할 수업을 찾을 수 없습니다.', 404);
    }

    // 한 사람이 같은 시간에 두 수업을 들을 수는 없다.
    // 겹침 판정: a.start < b.end && b.start < a.end
    foreach ($kept as $r) {
        foreach ($meetings as $m) {
            if ($r['day'] === $m['day'] && $m['start'] < $r['end'] && $r['start'] < $m['end']) {
                json_err(sprintf(
                    '%s요일에 이미 등록된 수업과 시간이 겹칩니다: %s (%s~%s)',
                    DAY_LABELS[$r['day']],
                    $r['subject'],
                    fmt_min($r['start']),
                    fmt_min($r['end'])
                ), 409);
            }
        }
    }

    // 여기까지 왔으면 모든 묶음이 안전하다 → 이제서야 기록한다
    $added = [];
    foreach ($meetings as $m) {
        $added[] = [
            'id'       => gen_id(),
            'group_id' => $groupId,
            'member'   => $member,
            'day'      => $m['day'],
            'start'    => $m['start'],
            'end'      => $m['end'],
            'subject'  => $subject,
            'prof'     => $prof,
            'room'     => $room,
            'color'    => $color,       // 서버가 채움
            'personal' => $personal,
        ];
    }

    $next = array_merge($kept, $added);
    usort($next, fn($a, $b) => [$a['day'], $a['start']] <=> [$b['day'], $b['start']]);

    return [$next, $added];
});

json_ok(['group_id' => $groupId, 'rows' => $saved]);
