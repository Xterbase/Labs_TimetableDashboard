<?php
/**
 * 시간표 대시보드 — 공통 라이브러리
 *
 * 설계 문서: /home/cksgdx/docs/web_dashboard.md
 *
 * 이 파일은 함수와 상수만 정의한다 (직접 요청해도 출력 없음).
 * 데이터는 웹 루트 바깥(/home/cksgdx/data)에 두며, 여기서 절대경로로 접근한다.
 */

declare(strict_types=1);

/**
 * 시간대를 명시적으로 고정한다.
 *
 * 이 서버는 php.ini에 date.timezone이 없어 시스템 값으로 폴백하는데,
 * 그게 Asia/Pyongyang으로 해석된다. 현재는 서울과 같은 UTC+9라 결과가
 * 일치하지만, 평양은 2015~2018년 UTC+8:30을 쓴 전례가 있다.
 * "지금 수업 중인 사람"을 계산하는 화면이므로 30분 오차도 치명적이다.
 */
date_default_timezone_set('Asia/Seoul');

// ─── 경로 ────────────────────────────────────────────────────────────
const DATA_DIR     = '/home/cksgdx/data';
const MEMBERS_DIR  = DATA_DIR . '/members';
const MEMBERS_FILE = DATA_DIR . '/members.csv';
const LOCK_FILE    = DATA_DIR . '/.lock';

// ─── 스키마 ──────────────────────────────────────────────────────────
/**
 * 8-6: group_id(주 N회 수업 묶음 키), prof(교수명) 추가.
 * 17절: personal(개인일정 여부, '1' 또는 '') 추가.
 *
 * 컬럼을 늘릴 때는 반드시 기존 CSV를 먼저 마이그레이션할 것 — 헤더만 바꾸면
 * read_rows()의 count($row) < count(CSV_HEADER) 방어 코드가 기존 데이터를
 * 전부 "깨진 줄"로 판정해 조용히 버린다 (설계 문서 3-1).
 *
 * personal만 CSV에 저장하고 grade는 저장하지 않는 이유: grade는 편람에서
 * 조인해 오지만(12-6) 개인일정은 애초에 편람에 없어 조인할 근거가 없다.
 */
const CSV_HEADER = ['id', 'group_id', 'member', 'day', 'start', 'end', 'subject', 'prof', 'room', 'color', 'personal'];

/** 개인일정 행의 grade 값. 1~4·G(대학원)·''(교양)과 같은 자리에서 색을 가른다. */
const GRADE_PERSONAL = 'P';

/** 편람에 교수명이 없는 과목(17행)을 드롭다운에 올릴 때 쓰는 이름. 저장도 이 값으로 된다. */
const PROF_NONE = '(교수 미지정)';

/**
 * "네" 같은 자유 입력을 참/거짓으로 읽는다 (개인일정 여부 칸).
 *
 * 입력 화면이 체크박스가 아니라 글자를 받는 칸이라 표기가 흔들린다. 긍정으로
 * 읽을 값만 화이트리스트로 두고, 빈칸·"아니오"·오타는 전부 거짓으로 접는다 —
 * 애매한 값이 개인일정으로 둔갑하는 것보다 일반 수업으로 남는 편이 안전하다.
 */
function is_yes(mixed $v): bool
{
    if (is_bool($v)) {
        return $v;
    }
    $s = mb_strtolower(trim(preg_replace('/\s+/u', '', (string) $v) ?? ''));
    return in_array($s, ['네', '예', 'ㅇ', 'y', 'yes', 'o', '1', 'true', '개인일정'], true);
}

/**
 * 그리드 범위 — 프론트 렌더링(7-3)과 반드시 일치시킬 것.
 *
 * 이 학교는 75분제(A~G)와 50분제(0~10교시)가 병행 운영된다.
 * 두 체계의 시각 경계를 모두 담으려면 5분 단위가 필요하다:
 *   75분제 종료 시각 615·705·795·885·975·1065·1155 → 10분 배수도 아님
 *   50분제 0교시는 08:00(480) 시작 → 09:00 기준으로는 담기지 않음
 * 30분 단위로 두면 실제 수업이 거의 전부 거부되므로 절대 되돌리지 말 것.
 */
const TIME_MIN  = 480;   // 08:00 (0교시 시작)
const TIME_MAX  = 1440;  // 24:00 — 편람 15교시(23:00~23:50)까지 수용
const SLOT_MIN  = 5;     // 시간 단위(분) — 두 시간제를 모두 표현하는 최소 단위
const DAY_MIN   = 0;     // 월
const DAY_MAX   = 4;     // 금

/**
 * 교시 정의. [시작, 종료] 자정 기준 분.
 * 입력 UI에서 교시를 고르면 이 표로 시각을 채운다.
 */
const PERIODS_75 = [
    'A' => [540, 615],  'B' => [630, 705],  'C' => [720, 795],  'D' => [810, 885],
    'E' => [900, 975],  'F' => [990, 1065], 'G' => [1080, 1155],
];
const PERIODS_50 = [
    '0' => [480, 530],   '1' => [540, 590],   '2' => [600, 650],  '3' => [660, 710],
    '4' => [720, 770],   '5' => [780, 830],   '6' => [840, 890],  '7' => [900, 950],
    '8' => [960, 1010],  '9' => [1020, 1070], '10' => [1080, 1130],
    // 11~15교시는 야간. 학교가 준 주간 시간표에는 없지만 편람에 174회 등장한다.
    // n교시 = (8+n):00~(8+n):50 선형 규칙을 그대로 연장한 값 — 학교 확인 필요.
    '11' => [1140, 1190], '12' => [1200, 1250], '13' => [1260, 1310],
    '14' => [1320, 1370], '15' => [1380, 1430],
];

/**
 * 오버레이(반투명 중첩)에 적합한 파스텔 팔레트.
 * 겹쳤을 때 서로 잘 구분되도록 색상각(hue)을 12칸으로 고르게 벌린 연한 톤.
 * 프론트가 hex에서 hue만 추출하므로(_DESIGN 참고) 여기서는 hue 간격이 핵심이다.
 */
const PALETTE = [
    '#F6B0A0', '#FBD79A', '#CFE39A', '#A6DDB4',
    '#93DAD0', '#8FDCE8', '#96CFEF', '#9FC7F5',
    '#AEB4E8', '#C9A8E9', '#E4A8E0', '#F4A9C4',
];

// ─── 응답 ────────────────────────────────────────────────────────────

/** 성공 응답을 내보내고 종료한다. */
function json_ok(array $data = []): never
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE);
    exit;
}

/** 실패 응답을 내보내고 종료한다. */
function json_err(string $message, int $code = 400): never
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

// ─── ID ──────────────────────────────────────────────────────────────

/**
 * 16자리 16진수 ID.
 * "기존 최댓값 + 1"은 동시성 문제를 부르고 uniqid()는 마이크로초 기반이라
 * 동시 요청 시 충돌 여지가 있으므로 random_bytes를 쓴다.
 */
function gen_id(): string
{
    return bin2hex(random_bytes(8));
}

// ─── 잠금 ────────────────────────────────────────────────────────────

/**
 * 별도 잠금 파일로 쓰기 전체를 감싼다.
 *
 * 교체 대상 CSV 자체에 잠그면 rename() 순간 그 잠금이 무의미해지므로
 * 반드시 별도 .lock 파일을 쓸 것 (설계 문서 6-(2)).
 */
function with_lock(callable $fn): mixed
{
    $lock = fopen(LOCK_FILE, 'c');
    if ($lock === false) {
        json_err('잠금 파일을 열 수 없습니다. data/ 디렉터리 권한을 확인하세요.', 500);
    }
    @chmod(LOCK_FILE, 0666);

    if (!flock($lock, LOCK_EX)) {
        fclose($lock);
        json_err('잠금 획득에 실패했습니다.', 500);
    }

    try {
        return $fn();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

// ─── 명단 (members.csv) ──────────────────────────────────────────────

/**
 * 명단을 읽어 [이름 => 색상] 맵으로 반환한다.
 */
function load_members(): array
{
    if (!is_file(MEMBERS_FILE)) {
        return [];
    }
    $fp = fopen(MEMBERS_FILE, 'r');
    if ($fp === false) {
        return [];
    }

    $out = [];
    fgetcsv($fp);                       // 헤더 버림
    while (($row = fgetcsv($fp)) !== false) {
        if ($row === [null] || !isset($row[0]) || $row[0] === '') {
            continue;                   // 빈 줄
        }
        $out[$row[0]] = $row[1] ?? PALETTE[0];
    }
    fclose($fp);
    return $out;
}

/**
 * 명단에 등록된 이름인지 확인한다.
 *
 * member 값은 그대로 파일명이 되므로, 명단 대조가 곧 경로 순회(../) 차단이 된다.
 * 정규식 검사만으로는 부족하므로 화이트리스트 방식을 쓴다 (설계 문서 6-(1)).
 */
function valid_member(string $name): bool
{
    return array_key_exists($name, load_members());
}

/** 해당 구성원의 색상. 서버가 채우며 클라이언트가 보낸 값은 신뢰하지 않는다. */
function member_color(string $name): string
{
    return load_members()[$name] ?? PALETTE[0];
}

/**
 * 아직 쓰이지 않은 팔레트 색을 랜덤으로 하나 고른다.
 * 12색을 모두 소진하면 황금각(137.5°)으로 hue를 벌려 파스텔 색을 생성한다.
 */
function assign_color(array $usedColors): string
{
    $free = array_values(array_diff(PALETTE, $usedColors));
    if ($free !== []) {
        return $free[random_int(0, count($free) - 1)];
    }
    $hue = (int) round(count($usedColors) * 137.5) % 360;
    return hsl_to_hex($hue, 60, 65);    // 채도·명도를 팔레트와 비슷하게 고정
}

/** HSL(0-360, %, %) → #RRGGBB */
function hsl_to_hex(int $h, int $s, int $l): string
{
    $s /= 100;
    $l /= 100;
    $c = (1 - abs(2 * $l - 1)) * $s;
    $x = $c * (1 - abs(fmod($h / 60, 2) - 1));
    $m = $l - $c / 2;

    [$r, $g, $b] = match (intdiv($h, 60)) {
        0       => [$c, $x, 0],
        1       => [$x, $c, 0],
        2       => [0, $c, $x],
        3       => [0, $x, $c],
        4       => [$x, 0, $c],
        default => [$c, 0, $x],
    };

    return sprintf(
        '#%02X%02X%02X',
        (int) round(($r + $m) * 255),
        (int) round(($g + $m) * 255),
        (int) round(($b + $m) * 255)
    );
}

/**
 * 명단에 없으면 색을 배정해 추가하고, 그 색을 반환한다.
 * 이미 있으면 기존 색을 그대로 돌려준다.
 */
function ensure_member(string $name): string
{
    return with_lock(function () use ($name): string {
        $members = load_members();
        if (isset($members[$name])) {
            return $members[$name];
        }

        $color = assign_color(array_values($members));
        $members[$name] = $color;

        $tmp = MEMBERS_FILE . '.tmp';
        $fp  = fopen($tmp, 'w');
        fputcsv($fp, ['name', 'color']);
        foreach ($members as $n => $c) {
            fputcsv($fp, [$n, $c]);
        }
        fclose($fp);
        chmod($tmp, 0666);
        rename($tmp, MEMBERS_FILE);

        return $color;
    });
}

// ─── 시간표 CSV (data/members/{이름}.csv) ────────────────────────────

/** 구성원 CSV의 절대경로. 호출 전 valid_member()로 검증할 것. */
function member_path(string $member): string
{
    return MEMBERS_DIR . '/' . $member . '.csv';
}

/**
 * 한 구성원의 시간표를 읽는다.
 *
 * CSV는 모든 값을 문자열로 돌려주므로 day/start/end를 정수로 캐스팅한다.
 * 이걸 빠뜨리면 프론트의 엄격 비교(`r.day === 0`)가 조용히 실패한다.
 */
function read_rows(string $member): array
{
    $path = member_path($member);
    if (!is_file($path)) {
        return [];
    }
    $fp = fopen($path, 'r');
    if ($fp === false) {
        return [];
    }

    $out = [];
    fgetcsv($fp);                       // 헤더 버림
    while (($row = fgetcsv($fp)) !== false) {
        if ($row === [null] || count($row) < count(CSV_HEADER)) {
            continue;                   // 빈 줄 · 깨진 줄은 건너뛴다
        }
        $r = array_combine(CSV_HEADER, array_slice($row, 0, count(CSV_HEADER)));
        $r['day']   = (int) $r['day'];
        $r['start'] = (int) $r['start'];
        $r['end']   = (int) $r['end'];
        $out[] = $r;
    }
    fclose($fp);
    return $out;
}

/** 전체 구성원의 시간표를 합쳐서 반환한다. */
function read_all_rows(): array
{
    $out = [];
    foreach (glob(MEMBERS_DIR . '/*.csv') ?: [] as $path) {
        $member = basename($path, '.csv');
        foreach (read_rows($member) as $row) {
            // 학년은 CSV에 저장하지 않고 조회할 때마다 편람에서 조인한다.
            // catalog.csv를 새로 올리면 기존 시간표에도 즉시 반영된다.
            // 개인일정(과방·알바 등)은 편람에 없으므로 조인을 건너뛰고 P를 쓴다.
            $row['personal'] = ($row['personal'] ?? '') === '1';
            $row['grade'] = $row['personal']
                ? GRADE_PERSONAL
                : lookup_grade($row['subject'], $row['prof']);
            // 편람에서 고른 수업인지 — 입력 화면의 「수정」이 어느 모드로 열지 가른다.
            // 개인일정은 이름이 편람 과목과 우연히 겹쳐도 직접 입력 모드로 열어야 한다.
            $row['catalog'] = !$row['personal'] && in_catalog($row['subject'], $row['prof']);
            $out[] = $row;
        }
    }
    return $out;
}

/**
 * 한 행을 파일 끝에 덧붙인다. 파일이 없으면 헤더부터 쓴다.
 *
 * 구성원별로 파일이 분리돼 있어 서로 다른 사람의 동시 저장은 충돌하지 않지만,
 * 같은 사람이 두 탭에서 저장하는 경우를 위해 잠금을 건다.
 */
function append_row(string $member, array $row): void
{
    with_lock(function () use ($member, $row): void {
        $path   = member_path($member);
        $isNew  = !is_file($path);

        $fp = fopen($path, 'a');
        if ($fp === false) {
            json_err('시간표 파일을 열 수 없습니다. data/members 권한을 확인하세요.', 500);
        }
        if ($isNew) {
            fputcsv($fp, CSV_HEADER);
        }
        fputcsv($fp, array_map(fn($k) => $row[$k] ?? '', CSV_HEADER));
        fclose($fp);

        // 없으면 cksgdx가 이 파일을 수정할 수 없다 (설계 문서 5-4)
        chmod($path, 0666);
    });
}

/**
 * 구성원 파일 전체를 다시 쓴다 (수정·삭제용).
 *
 * "전체 읽기 → 메모리 수정 → 전체 쓰기" 도중 스크립트가 죽으면 파일이 반쯤
 * 잘린 채 남으므로, 임시 파일에 쓴 뒤 rename()으로 원자적 교체한다.
 */
function write_all(string $member, array $rows): void
{
    with_lock(function () use ($member, $rows): void {
        write_all_unlocked($member, $rows);
    });
}

/**
 * 잠금 없이 파일만 교체한다. **반드시 with_lock 안에서만 호출할 것.**
 *
 * mutate_rows()가 "읽기 → 수정 → 쓰기"를 하나의 잠금으로 묶기 위해 필요하다.
 * write_all()을 그 안에서 부르면 같은 프로세스가 .lock을 두 번 잠그려다
 * 스스로 막혀 교착 상태가 된다.
 */
function write_all_unlocked(string $member, array $rows): void
{
    $path = member_path($member);
    $tmp  = $path . '.tmp';

    $fp = fopen($tmp, 'w');
    if ($fp === false) {
        json_err('임시 파일을 만들 수 없습니다. data/members 권한을 확인하세요.', 500);
    }
    fputcsv($fp, CSV_HEADER);
    foreach ($rows as $row) {
        fputcsv($fp, array_map(fn($k) => $row[$k] ?? '', CSV_HEADER));
    }
    fclose($fp);
    chmod($tmp, 0666);

    rename($tmp, $path);                // 같은 파일시스템 내 rename은 원자적
}

/**
 * 한 구성원의 시간표를 잠금 안에서 읽고·고치고·되쓴다.
 *
 * $fn은 현재 행 배열을 받아 [새 행 배열, 반환값]을 돌려준다.
 * 읽기와 쓰기가 한 잠금 안에 들어가므로, 같은 사람이 두 탭에서 동시에
 * 저장해도 나중 저장이 앞선 저장을 덮어써 잃어버리는 일이 없다.
 */
function mutate_rows(string $member, callable $fn): mixed
{
    return with_lock(function () use ($member, $fn): mixed {
        [$next, $ret] = $fn(read_rows($member));
        write_all_unlocked($member, $next);
        return $ret;
    });
}

// ─── 수강편람 (data/catalog.csv) ─────────────────────────────────────
//
// 읽기 전용 참조 데이터. 앱이 쓰지 않는다 (설계 문서 3-3).

const CATALOG_FILE = DATA_DIR . '/catalog.csv';
// 대학원 편람 (선택). 학부 편람과 이어 읽는다 — 학부 파일을 통째로 교체해도
// 대학원 자료가 사라지지 않도록 파일을 분리했다. 학년 칸은 "대학원"으로 채운다.
const CATALOG_GRAD_FILE = DATA_DIR . '/catalog_grad.csv';

const DAY_CHARS = ['월' => 0, '화' => 1, '수' => 2, '목' => 3, '금' => 4, '토' => 5, '일' => 6];
const DAY_LABELS = ['월', '화', '수', '목', '금'];

/**
 * 비교용 정규화: 공백 제거 + 소문자화.
 *
 * 고유 과목명의 97.7%가 붙여쓰기("AI와함께하는글로벌문제해결")인데 사용자는
 * 자연스럽게 띄어 친다. 이게 없으면 검색이 실패한다 (설계 문서 3-3).
 * 표시는 원문 그대로 하고 비교할 때만 정규화한다.
 */
function norm(string $s): string
{
    return mb_strtolower(preg_replace('/\s+/u', '', $s) ?? '');
}

/** 자정 기준 분 → "HH:MM" */
function fmt_min(int $m): string
{
    return sprintf('%02d:%02d', intdiv($m, 60), $m % 60);
}

/**
 * 편람 CSV를 읽는다. 요청당 한 번만 읽고 캐시한다.
 *
 * 학부 편람(CATALOG_FILE) 다음에 대학원 편람(CATALOG_GRAD_FILE)을 이어 읽는다.
 * 대학원 파일은 없어도 되고, 있으면 학년 칸이 "대학원"이라 개별 보기에서
 * 별도 색으로 구분된다.
 *
 * ⚠️ 학부 파일은 UTF-8 **BOM**이 붙어 있다. 첫 컬럼명을 그대로 쓰면
 * "\xEF\xBB\xBF과목명"이 되므로 반드시 제거한다 (설계 문서 6-(4)).
 *
 * 4번째 컬럼(강의실)은 선택 사항이다 — 없는 파일도 그대로 읽힌다.
 * 있으면 검색 결과에 실려 입력 화면에서 강의실을 자동으로 채우는 데 쓰인다.
 */
function read_catalog(): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }

    $cache = [];
    foreach ([CATALOG_FILE, CATALOG_GRAD_FILE] as $file) {
        if (!is_file($file)) {
            continue;
        }
        $fp = fopen($file, 'r');
        if ($fp === false) {
            continue;
        }

        $first = true;
        fgetcsv($fp);                                   // 헤더 버림
        while (($r = fgetcsv($fp)) !== false) {
            if ($r === [null] || count($r) < 2) {
                continue;
            }
            $subject = trim((string) $r[0]);
            if ($first) {
                $subject = preg_replace('/^\xEF\xBB\xBF/', '', $subject);   // BOM
                $first = false;
            }
            if ($subject === '') {
                continue;
            }
            // 채플 행처럼 안내문이 잘못 밀려 들어온 경우를 대비한 방어(6-(4) 사례 참고).
            // 실제 강의실 표기 최대 길이보다 넉넉히 30자로 자른다.
            $room = trim((string) ($r[3] ?? ''));
            if (mb_strlen($room) > 30) {
                $room = '';
            }
            $cache[] = [
                'subject' => $subject,
                'prof'    => trim((string) ($r[1] ?? '')),
                'time'    => trim((string) ($r[2] ?? '')),
                'room'    => $room,
                'grade'   => normalize_grade((string) ($r[4] ?? '')),
            ];
        }
        fclose($fp);
    }
    return $cache;
}

/**
 * 편람의 `강의시간` 표기를 [{days, start, end, mode, periods}] 로 파싱한다.
 *
 *   화5,6         → 화 13:00~14:50            (같은 요일의 연속 교시)
 *   화B,목B       → 화 10:30~11:45 · 목 10:30~11:45
 *   월7,8/금7,8   → 월 15:00~16:50 · 금 15:00~16:50
 *   화 1 목 2,3   → 화 09:00~09:50 · 목 10:00~11:50
 *
 * ⚠️ 쉼표가 두 가지 뜻으로 쓰인다 — `화5,6`은 같은 요일의 다음 교시,
 * `화B,목B`는 새 요일. 그래서 구분자를 믿지 않고 **요일 문자를 만날 때마다
 * 묶음을 끊는** 방식으로 읽는다. 구분자(`,` `/` 공백)는 전부 무시해도 된다.
 */
function parse_class_time(string $raw): array
{
    $s = trim($raw);

    // 한 행에 수강신청 안내문 800자가 통째로 들어간 경우가 있다 (채플).
    // 시간 표기는 아무리 길어야 40자를 넘지 않는다.
    if ($s === '' || mb_strlen($s) > 40) {
        return [];
    }

    $chars = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $n = count($chars);

    $groups      = [];
    $pendingDays = [];
    $periods     = [];

    for ($i = 0; $i < $n; ) {
        $c = $chars[$i];

        if (isset(DAY_CHARS[$c])) {
            // 이미 교시를 모으던 중이면 앞 묶음을 끊는다 (화B,"목"B → 여기서 화 확정)
            if ($periods !== []) {
                $groups[]    = ['days' => $pendingDays, 'periods' => $periods];
                $pendingDays = [];
                $periods     = [];
            }
            $pendingDays[] = DAY_CHARS[$c];
            $i++;
            continue;
        }

        if (preg_match('/[0-9]/', $c)) {
            $num = '';
            while ($i < $n && preg_match('/[0-9]/', $chars[$i])) {
                $num .= $chars[$i];
                $i++;
            }
            $periods[] = ['50', (string) (int) $num];
            continue;
        }

        if (preg_match('/^[A-Ga-g]$/', $c)) {
            $periods[] = ['75', strtoupper($c)];
            $i++;
            continue;
        }

        $i++;                                       // 구분자·"교시" 같은 잔여 문자
    }
    if ($periods !== []) {
        $groups[] = ['days' => $pendingDays, 'periods' => $periods];
    }

    $slots = [];
    foreach ($groups as $g) {
        // 토·일은 그리드(월~금) 밖이라 버린다
        $days = array_values(array_filter(
            $g['days'],
            fn($d) => $d >= DAY_MIN && $d <= DAY_MAX
        ));
        if ($days === []) {
            continue;
        }
        foreach (period_ranges($g['periods']) as $range) {
            $slots[] = [
                'days'    => $days,
                'start'   => $range['start'],
                'end'     => $range['end'],
                'mode'    => $range['mode'],
                'periods' => $range['periods'],
            ];
        }
    }

    // 병합: 같은 시각이 요일만 다르게 반복되면(화B,목B → 화 B / 목 B) 한 슬롯으로
    // 합친다. 주 2회 수업을 하루만 듣는 경우는 없으므로 드롭다운에 "화·목 B교시"
    // 하나로 보여주는 편이 자연스럽다. 시각이 다른 요일(화 1 목 2,3)은 합치지 않는다.
    $merged = [];
    foreach ($slots as $s) {
        $key = $s['mode'] . '|' . $s['start'] . '-' . $s['end'];
        if (isset($merged[$key])) {
            $merged[$key]['days'] = array_values(array_unique(array_merge($merged[$key]['days'], $s['days'])));
            sort($merged[$key]['days']);
        } else {
            $merged[$key] = $s;
        }
    }
    return array_values($merged);
}

/**
 * 교시 목록을 연속된 구간으로 묶는다. `5,6` → 하나의 13:00~14:50 구간.
 * 떨어져 있으면(`1,3`) 구간을 나눈다.
 */
function period_ranges(array $periods): array
{
    $out  = [];
    $cur  = null;
    $prev = null;

    foreach ($periods as [$mode, $key]) {
        $table = $mode === '75' ? PERIODS_75 : PERIODS_50;
        if (!isset($table[$key])) {
            continue;                               // 편람에 없는 교시 번호
        }
        [$start, $end] = $table[$key];

        $continues = $cur !== null
            && $prev[0] === $mode
            && ($mode === '75'
                ? ord($key) === ord($prev[1]) + 1
                : (int) $key === (int) $prev[1] + 1);

        if ($continues) {
            $cur['end'] = $end;
            $cur['periods'][] = $key;
        } else {
            if ($cur !== null) {
                $out[] = $cur;
            }
            $cur = ['start' => $start, 'end' => $end, 'mode' => $mode, 'periods' => [$key]];
        }
        $prev = [$mode, $key];
    }
    if ($cur !== null) {
        $out[] = $cur;
    }
    return $out;
}

/** 슬롯을 "화·목 3교시 11:00~11:50" 형태의 표시 문자열로 만든다. */
function slot_label(array $slot): string
{
    $days = implode('·', array_map(fn($d) => DAY_LABELS[$d], $slot['days']));
    $p    = implode(',', $slot['periods']) . '교시';
    return $days . ' ' . $p . ' ' . fmt_min($slot['start']) . '~' . fmt_min($slot['end']);
}

// ─── 수강학년 ────────────────────────────────────────────────────────
//
// 편람 `학년` 컬럼은 표기가 고르지 않다 — "1"·"2,3,4"·"전체학년"·"9"·빈칸이 섞여
// 있다. 개별 시간표는 1~4학년 + 대학원만 색으로 구분하므로 그 밖의 값은 전부
// '' (미지정, 회색)로 접는다. 복수 학년("2,3,4")은 맨 앞 학년의 색을 쓴다.
// 대학원 편람은 학년이 없어 학년 칸을 "대학원"으로 채워 두었고 → 'G'로 접는다.

/** 편람의 학년 표기 → '1'|'2'|'3'|'4'|'G'(대학원)|'' */
function normalize_grade(string $raw): string
{
    $s = trim($raw);
    if ($s === '' || str_contains($s, '전체')) {
        return '';                                  // 전체학년 = 학년 무관
    }
    if (str_contains($s, '대학원')) {
        return 'G';                                 // 대학원 = 학부 1~4학년과 별개 색
    }
    // 5학년(종합설계)·9(대학원·비교과)는 색 구분 대상이 아니므로 1~4만 집는다
    return preg_match('/[1-4]/', $s, $m) ? $m[0] : '';
}

/**
 * 과목명+교수명 → 학년 색인. 요청당 한 번만 만든다.
 *
 * 교수명이 비어 있거나(편람 13건) 저장 당시와 표기가 다를 수 있어
 * 과목명만으로 찾는 2차 색인도 함께 만든다. 같은 키에 학년이 여러 개면
 * 편람에 먼저 나온 값을 쓴다.
 */
function catalog_grade_index(): array
{
    static $idx = null;
    if ($idx !== null) {
        return $idx;
    }

    $idx = ['pair' => [], 'subject' => []];
    foreach (read_catalog() as $row) {
        if ($row['grade'] === '') {
            continue;
        }
        $subject = norm($row['subject']);
        $idx['pair'][$subject . '|' . norm($row['prof'])] ??= $row['grade'];
        $idx['subject'][$subject] ??= $row['grade'];
    }
    return $idx;
}

/**
 * 저장된 시간표 한 행의 수강학년을 편람에서 찾는다.
 *
 * 학년을 CSV에 적어 두지 않고 조회할 때마다 조인하는 이유: catalog.csv를
 * 새로 올리면 이미 등록된 시간표에도 바로 반영되고, 기존 CSV를 마이그레이션할
 * 필요도 없다. 편람에 없는 수업(직접 입력한 세미나·랩미팅)은 ''가 된다.
 */
function lookup_grade(string $subject, string $prof): string
{
    $idx = catalog_grade_index();
    $s   = norm($subject);

    $hit = $idx['pair'][$s . '|' . norm($prof)] ?? $idx['subject'][$s] ?? null;
    if ($hit !== null) {
        return $hit;
    }

    // "스크립트언어(실)"처럼 실습 분반은 괄호 꼬리표만 다르고 학년은 같다
    $bare = norm(preg_replace('/\([^)]*\)\s*$/u', '', $subject) ?? '');
    return ($bare !== '' && $bare !== $s) ? ($idx['subject'][$bare] ?? '') : '';
}

/**
 * "과목명|교수명" 집합. 편람에 그 조합이 실제로 있는지 보는 용도다.
 *
 * 학년 색인(catalog_grade_index)은 학년이 빈 행을 걸러내므로 수록 여부를
 * 판정하는 데 쓸 수 없다. 그래서 따로 만든다.
 */
function catalog_pair_index(): array
{
    static $idx = null;
    if ($idx !== null) {
        return $idx;
    }

    $idx = [];
    foreach (read_catalog() as $row) {
        $subject = norm($row['subject']);
        // 교수명이 빈 행은 입력 화면에서 PROF_NONE으로 골라 그 이름으로 저장된다
        $prof = $row['prof'] !== '' ? $row['prof'] : PROF_NONE;
        $idx[$subject . '|' . norm($prof)] = true;
    }
    return $idx;
}

/**
 * 저장된 한 행이 편람에서 고른 수업인지 판정한다.
 *
 * 입력 화면의 「수정」이 편람 검색 모드로 열지, 직접 입력 모드로 열지를 이 값으로
 * 가른다. 교수명 유무로는 가를 수 없다 — 직접 입력에도 교수명을 적을 수 있기
 * 때문이다. 학년(grade)과 마찬가지로 CSV에 저장하지 않고 조회할 때마다 편람에서
 * 조인하므로 컬럼을 늘릴 필요가 없다.
 *
 * 편람에 그 조합이 없으면 검색으로는 되살릴 수 없는 수업이므로, 직접 입력 모드가
 * 유일하게 고칠 수 있는 화면이 된다.
 */
function in_catalog(string $subject, string $prof): bool
{
    if ($prof === '') {
        return false;               // 편람에서 고르면 교수명이 반드시 남는다
    }
    return isset(catalog_pair_index()[norm($subject) . '|' . norm($prof)]);
}

// ─── 요청 파싱 ───────────────────────────────────────────────────────

/** JSON 요청 본문을 배열로 읽는다. */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        json_err('요청 본문이 비어 있습니다.');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        json_err('JSON 형식이 올바르지 않습니다.');
    }
    return $data;
}
