<?php
/**
 * 시간표 삭제 (묶음 단위)
 *
 * POST /api/delete.php   Content-Type: application/json
 * { "member": "김다겸", "group_id": "..." }
 *
 * → { ok: true, removed: 2 }
 *
 * **group_id 단위로 통째 지운다.** 월·수 같은 시간에 하는 수업은 2행인데
 * 한 행만 지우면 반쪽만 남은 시간표가 된다 (설계 문서 6-(1), 9절).
 */

declare(strict_types=1);

require __DIR__ . '/_lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    json_err('POST 요청만 허용됩니다.', 405);
}

$in = read_json_body();

// 명단 대조가 곧 경로 순회(../) 차단이다
$member = trim((string) ($in['member'] ?? ''));
if ($member === '') {
    json_err('이름을 선택하세요.');
}
if (!valid_member($member)) {
    json_err("명단에 없는 이름입니다: {$member}");
}

$groupId = trim((string) ($in['group_id'] ?? ''));
if (!preg_match('/^[0-9a-f]{16}$/', $groupId)) {
    json_err('group_id 형식이 올바르지 않습니다.');
}

$removed = mutate_rows($member, function (array $rows) use ($groupId): array {
    $kept = array_values(array_filter(
        $rows,
        fn($r) => ($r['group_id'] ?? '') !== $groupId
    ));

    $n = count($rows) - count($kept);
    if ($n === 0) {
        json_err('삭제할 수업을 찾을 수 없습니다.', 404);
    }

    return [$kept, $n];
});

json_ok(['removed' => $removed]);
