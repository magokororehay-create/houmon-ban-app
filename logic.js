// 自動生成：houmon_ban_gas/tools/build_web_logic.mjs。直接編集しない（元は houmon_ban_gas/Schema.gs・Logic.gs）。
var HoumonBan = (function () {
// 週間訪問スケジュール（訪問台帳・週間表）の列と設定の既定値。GAS API は使わない（node のテストからも読む）。
// 設計 docs/superpowers/specs/2026-10-04-houmon-schedule-ban-design.md

var LEDGER_COLUMNS = [
  '台帳ID', '担当', '曜日', '開始', '利用者', '利用者ID', '場所', '地区', '頻度', '隔週の基準日',
  '開始日', '終了日', '状態', '終了理由', '保険区分', '週の回', '代行優先度', 'メモ', '更新日時', '更新者',
];
var PLACE_COLUMNS = ['場所', '略称', '移動0分', '住所'];

var FREQS = ['毎週', '第1・3週', '第2・4週', '隔週'];
var STATUSES = ['通常', '新規予定', '入院中', '調整中', '終了予定'];
var STATUS_COLORS = {
  '通常': '#ffffff', '新規予定': '#ffff00', '入院中': '#f4cccc', '調整中': '#d9ead3', '終了予定': '#cfe2f3',
};
var FREE_COLOR = '#d9d9d9';   // 空き（いまの表の条件付き書式と同じ灰）
var OFF_COLOR = '#999999';    // 昼休み・勤務時間外
var HEAD_COLOR = '#fce5cd';
var WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];

var DEFAULT_SETTINGS = {
  '訪問の長さ（分）': '40',
  '移動の余白（分）': '20',
  '近い距離（km）': '5.5',   // 地区の代表点の直線距離がこれ以内なら、移動は「近い移動（分）」で可（0で使わない）
  '近い移動（分）': '10',
  '遠い距離（km）': '12',   // 地区の代表点の直線距離がこれを超えれば、移動は「遠い移動（分）」を求める（0で使わない）
  '遠い移動（分）': '30',
  '距離→分の係数': '2',     // 週間表の「移動（分）」の目安＝直線距離(km)×これ（5分単位で切り上げ）
  '事業所の地区': '',       // 例 甲賀市水口町山。入れると週間表の移動に事業所との行き帰りを足す（地区タブにその地区が要る）
  '表示する時間帯': '8:30-17:30',
  '昼休み': '12:00-13:00',
  'スタッフ名簿': '末廣、関札、松岡、伊地知',
  'スタッフ別の時間帯': '伊地知=8:30-16:30',
  '曜日': '月、火、水、木、金',
  '名前の読み替え': '',   // 今の表の誤記=正しい名前（取り込みで直す。段1の並走中だけ使う）
};

var DEFAULT_PLACES = [
  { '場所': '在宅', '略称': '', '移動0分': 'いいえ', '住所': '' },
  { '場所': 'まごころ甲賀', '略称': '甲', '移動0分': 'はい', '住所': '' },
  { '場所': '信楽青年寮', '略称': '自', '移動0分': 'はい', '住所': '' },
  { '場所': '誉の松', '略称': '誉', '移動0分': 'はい', '住所': '' },
];

function str_(v) { return v == null ? '' : String(v).trim(); }

// 'H:MM'（全角コロン可）→ 0時からの分。読めなければ null。
function parseHm(v) {
  var m = /^(\d{1,2})[:：](\d{2})$/.exec(str_(v));
  if (!m) return null;
  var h = +m[1], mm = +m[2];
  return h > 23 || mm > 59 ? null : h * 60 + mm;
}

// 分 → 'H:MM'（時は0埋めしない。いまの表と同じ）。
function fmtHm(min) { return Math.floor(min / 60) + ':' + ('0' + (min % 60)).slice(-2); }

// '8:30-16:30' → {from, to}。空・読めなければ null。
function parseRange(v) {
  var p = str_(v).split(/[-－〜~]/);
  if (p.length !== 2) return null;
  var a = parseHm(p[0]), b = parseHm(p[1]);
  return a === null || b === null || a >= b ? null : { from: a, to: b };
}

// '末廣、関札' / '末廣,関札' / 改行区切り → 配列。
function splitList(v) {
  return str_(v).split(/[、,，\n]/).map(str_).filter(function (s) { return s; });
}

// 設定タブの {キー: 値}（文字列）→ 計算に使う形。無いキーは既定値。
function normalizeSettings(raw) {
  var s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
  Object.keys(raw || {}).forEach(function (k) { if (str_(raw[k]) !== '') s[k] = str_(raw[k]); });
  var staffHours = {};
  splitList(s['スタッフ別の時間帯']).forEach(function (x) {
    var p = x.split('=');
    var r = p.length === 2 ? parseRange(p[1]) : null;
    if (!r) throw new Error('スタッフ別の時間帯が読めません: ' + x);
    staffHours[str_(p[0])] = r;
  });
  var out = {
    visitMin: +s['訪問の長さ（分）'],
    gapMin: +s['移動の余白（分）'],
    view: parseRange(s['表示する時間帯']),
    lunch: parseRange(s['昼休み']),
    staff: splitList(s['スタッフ名簿']),
    staffHours: staffHours,
    weekdays: splitList(s['曜日']),
    nearKm: +s['近い距離（km）'],
    nearGapMin: +s['近い移動（分）'],
    farKm: +s['遠い距離（km）'],
    farGapMin: +s['遠い移動（分）'],
    minPerKm: +s['距離→分の係数'],
    officeArea: str_(s['事業所の地区']),
    slotMin: 10,
  };
  if (!(out.minPerKm > 0)) throw new Error('距離→分の係数が読めません');
  if (!(out.nearKm >= 0)) throw new Error('近い距離（km）が読めません');
  if (!(out.nearGapMin >= 0) || out.nearGapMin % 10) throw new Error('近い移動は10分刻みで指定してください');
  if (!(out.farKm >= 0)) throw new Error('遠い距離（km）が読めません');
  if (!(out.farGapMin >= 0) || out.farGapMin % 10) throw new Error('遠い移動は10分刻みで指定してください');
  if (!(out.visitMin > 0) || out.visitMin % 10) throw new Error('訪問の長さは10分刻みで指定してください');
  if (!(out.gapMin >= 0) || out.gapMin % 10) throw new Error('移動の余白は10分刻みで指定してください');
  if (!out.view) throw new Error('表示する時間帯が読めません');
  if (!out.staff.length) throw new Error('スタッフ名簿が空です');
  out.weekdays.forEach(function (d) { if (WEEKDAYS.indexOf(d) < 0) throw new Error('曜日が読めません: ' + d); });
  return out;
}

// 地区タブの行 → {地区: {lat, lng}}（緯度・経度が読めない行は使わない）。
function normalizeAreas(rows) {
  var m = {};
  (rows || []).forEach(function (r) {
    var name = str_(r['地区']), lat = parseFloat(r['緯度']), lng = parseFloat(r['経度']);
    if (name && isFinite(lat) && isFinite(lng)) m[name] = { lat: lat, lng: lng };
  });
  return m;
}

// 場所タブの行 → {場所: {short, zero}}。
function normalizePlaces(rows) {
  var m = {};
  (rows || []).forEach(function (r) {
    var name = str_(r['場所']);
    if (!name) return;
    var short = name === '在宅' ? '' : ('略称' in r ? str_(r['略称']) : name);
    m[name] = { short: short, zero: str_(r['移動0分']) === 'はい', address: str_(r['住所']) };
  });
  return m;
}

// 週間訪問スケジュールの判定と描画（GAS API を使わない純粋関数。判定の正はここだけ）。
// 台帳の行は LEDGER_COLUMNS をキーにした object。日付は 'YYYY-MM-DD' の文字列。

function dayNumber_(ymd) {
  var p = str_(ymd).split('-');
  return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

// 1〜7日が第1週、8〜14日が第2週 …（月の何回目のその曜日か）。
function weekOfMonth(ymd) { return Math.ceil(+str_(ymd).split('-')[2] / 7); }

// 1970-01-05（月曜）からの週番号。隔週の偶奇に使う。
function weekIndex_(ymd) { return Math.floor((dayNumber_(ymd) - 4) / 7); }

var MONTH_WEEKS_ = { '第1・3週': [1, 3], '第2・4週': [2, 4] };

// その日付に、この枠の人が行くか。true / false / '未定'（第5週・隔週の基準日なし）。
function goesOn(row, ymd) {
  var f = str_(row['頻度']) || '毎週';
  if (f === '毎週') return true;
  if (MONTH_WEEKS_[f]) {
    var w = weekOfMonth(ymd);
    return w === 5 ? '未定' : MONTH_WEEKS_[f].indexOf(w) >= 0;
  }
  if (f === '隔週') {
    var base = str_(row['隔週の基準日']);
    if (!base) return '未定';
    return (weekIndex_(ymd) - weekIndex_(base)) % 2 === 0;
  }
  return '未定';
}

// 基準日に有効な枠か（開始日〜終了日。空は制限なし）。
function isActive(row, asOf) {
  var s = str_(row['開始日']), e = str_(row['終了日']);
  return (!s || s <= asOf) && (!e || e >= asOf);
}

// 同じ曜日・時間の2枠が、同じ日に重なりうるか（週で分けた枠は重ならない）。
// 第5週の割り当ては月ごとの例外で決めるので、ここでは重なりに数えない。
function weeksOverlap(a, b) {
  var fa = str_(a['頻度']) || '毎週', fb = str_(b['頻度']) || '毎週';
  if (fa === '毎週' || fb === '毎週') return true;
  if (MONTH_WEEKS_[fa] && MONTH_WEEKS_[fb]) {
    return MONTH_WEEKS_[fa].some(function (w) { return MONTH_WEEKS_[fb].indexOf(w) >= 0; });
  }
  if (fa === '隔週' && fb === '隔週') {
    var x = str_(a['隔週の基準日']), y = str_(b['隔週の基準日']);
    if (!x || !y) return true;
    return (weekIndex_(x) - weekIndex_(y)) % 2 === 0;
  }
  return true;
}

// 2点（{lat, lng}）の直線距離（km）。
function distanceKm(p, q) {
  var rad = Math.PI / 180, dLat = (q.lat - p.lat) * rad, dLng = (q.lng - p.lng) * rad;
  var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.pow(Math.sin(dLng / 2), 2);
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// a と b の間に要る移動の分。
// 同じ場所で「移動0分」→ 0／地区の代表点が 近い距離 以内 → 近い移動（10分）／遠い距離 を超える → 遠い移動（30分）／
// それ以外・地区不明 → 移動の余白（20分）。
// areas（normalizeAreas の結果）を渡さなければ近さは見ない。
function needGap(a, b, places, settings, areas) {
  var pa = str_(a['場所']), pb = str_(b['場所']);
  if (pa && pa === pb && places[pa] && places[pa].zero) return 0;
  var ka = areas && areas[str_(a['地区'])], kb = areas && areas[str_(b['地区'])];
  if (ka && kb) {
    var d = distanceKm(ka, kb);
    if (settings.nearKm > 0 && d <= settings.nearKm) return Math.min(settings.nearGapMin, settings.gapMin);
    if (settings.farKm > 0 && d > settings.farKm) return Math.max(settings.farGapMin, settings.gapMin);
  }
  return settings.gapMin;
}

// 週間表の「移動（分）」に使う移動時間の目安（置けるかの判定 needGap とは別）。
// 同じ場所で「移動0分」→ 0／両方の地区が分かる → 直線距離×係数を5分単位で切り上げ（最低5分）／それ以外 → 移動の余白。
function travelMinutes(a, b, places, settings, areas) {
  var pa = str_(a['場所']), pb = str_(b['場所']);
  if (pa && pa === pb && places[pa] && places[pa].zero) return 0;
  var ka = areas && areas[str_(a['地区'])], kb = areas && areas[str_(b['地区'])];
  if (!ka || !kb) return settings.gapMin;
  return Math.max(5, Math.ceil(distanceKm(ka, kb) * settings.minPerKm / 5) * 5);
}

function startOf_(row) { return parseHm(row['開始']); }

function hoursOf_(staff, settings) { return settings.staffHours[staff] || settings.view; }

// 担当・曜日ごとに、有効な枠を開始順に並べる。
function byColumn_(rows, asOf) {
  var m = {};
  rows.forEach(function (r) {
    if (!isActive(r, asOf) || startOf_(r) === null) return;
    var k = str_(r['担当']) + '|' + str_(r['曜日']);
    (m[k] = m[k] || []).push(r);
  });
  Object.keys(m).forEach(function (k) {
    m[k].sort(function (a, b) { return startOf_(a) - startOf_(b); });
  });
  return m;
}

// 台帳の検査：[{種類: 重なり|余白不足|時間外, 台帳ID: [...], 内容}]。
function checkLedger(rows, places, settings, asOf, areas) {
  var out = [], cols = byColumn_(rows, asOf), len = settings.visitMin;
  Object.keys(cols).forEach(function (k) {
    var list = cols[k], staff = k.split('|')[0], day = k.split('|')[1];
    list.forEach(function (r) {
      var h = hoursOf_(staff, settings), s = startOf_(r);
      if (s < h.from || s + len > h.to) {
        out.push({ '種類': '時間外', '台帳ID': [r['台帳ID']], '内容': staff + ' ' + day + ' ' + fmtHm(s) });
      }
    });
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        if (!weeksOverlap(a, b)) continue;
        // 入院中の枠には別の人を入れてよい（戻るまでの間）。重なりにも余白にも数えない。
        if (shownStatus(a) === '入院中' || shownStatus(b) === '入院中') continue;
        var gap = startOf_(b) - (startOf_(a) + len), where = staff + ' ' + day + ' ' + fmtHm(startOf_(b));
        if (gap < 0) {
          out.push({ '種類': '重なり', '台帳ID': [a['台帳ID'], b['台帳ID']], '内容': where });
        } else if (gap < needGap(a, b, places, settings, areas)) {
          out.push({ '種類': '余白不足', '台帳ID': [a['台帳ID'], b['台帳ID']], '内容': where + '（' + gap + '分）' });
        }
      }
    }
  });
  var order = { '重なり': 0, '余白不足': 1, '時間外': 2 };
  return out.sort(function (x, y) { return order[x['種類']] - order[y['種類']]; });
}

var CIRCLED_ = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

// 週の回（自動）：同じ人（利用者ID、無ければ利用者名）の有効な枠を曜日・時刻順に①②③。週1回の人は ''。
// 台帳の「週の回」列は使わない（手で振ると増回・減回のたびにずれるため）。返り値は {台帳ID: '①' | ''}。
function weekNumbers(rows, asOf) {
  var by = {}, out = {};
  rows.forEach(function (r) {
    if (!isActive(r, asOf) || startOf_(r) === null) return;
    var k = str_(r['利用者ID']) || ('名前:' + str_(r['利用者']));
    (by[k] = by[k] || []).push(r);
  });
  Object.keys(by).forEach(function (k) {
    var list = by[k].slice().sort(function (a, b) {
      return (WEEKDAYS.indexOf(str_(a['曜日'])) - WEEKDAYS.indexOf(str_(b['曜日']))) || (startOf_(a) - startOf_(b));
    });
    list.forEach(function (r, i) { out[r['台帳ID']] = list.length > 1 ? (CIRCLED_[i] || String(i + 1)) : ''; });
  });
  return out;
}

var FREQ_MARK_ = { '毎週': '', '第1・3週': '1・3週', '第2・4週': '2・4週', '隔週': '隔週' };

// セルに書く表記：氏名(医/甲)2・4週②B（在宅・毎週・空の項目は書かない）。
function cellLabel(row, places, kai) {
  var tags = [];
  var ins = str_(row['保険区分']);
  if (ins && ins !== '介') tags.push(ins);
  var p = places[str_(row['場所'])];
  if (p && p.short) tags.push(p.short);
  var freq = str_(row['頻度']) || '毎週';
  return str_(row['利用者']) + (tags.length ? '(' + tags.join('/') + ')' : '') +
    (FREQ_MARK_[freq] != null ? FREQ_MARK_[freq] : freq) + (kai == null ? str_(row['週の回']) : kai) +
    str_(row['代行優先度']);
}

// 表示の状態（終了日が入っていて手で選んだ状態が通常なら終了予定）。
function shownStatus(row) {
  var s = str_(row['状態']) || '通常';
  return s === '通常' && str_(row['終了日']) ? '終了予定' : s;
}

// 同じ枠のうち実際に行く人（入院中の人の枠に別の人が入っていればその人。全員入院中なら全員）。
function going_(group) {
  var g = group.filter(function (r) { return shownStatus(r) !== '入院中'; });
  return g.length ? g : group;
}

function goingFirst_(group) {
  var g = going_(group);
  return g.concat(group.filter(function (r) { return g.indexOf(r) < 0; }));
}

// 台帳 → いまの表と同じ並びの週間表 {values, colors}（同じ形の2次元配列）。
// 1行目＝曜日（グループの先頭だけ）、2行目＝担当、3行目＝週の件数（毎週1・それ以外0.5）、
// 4行目から10分刻みの時刻、最後に「移動（分）」（訪問と訪問の間の移動の目安 travelMinutes の合計。
// 設定「事業所の地区」があれば、事業所→最初の訪問と最後の訪問→事業所も足す）。
function renderWeekGrid(rows, places, settings, asOf, areas) {
  var cols = byColumn_(rows, asOf), len = settings.visitMin, slot = settings.slotMin;
  var kai = weekNumbers(rows, asOf);
  var heads = [];
  settings.weekdays.forEach(function (d) {
    settings.staff.forEach(function (s, i) { heads.push({ day: d, staff: s, first: i === 0 }); });
  });
  var times = [];
  for (var t = settings.view.from; t < settings.view.to; t += slot) times.push(t);
  var values = [[''], ['担当者'], ['訪問件数/週']], colors = [['#ffffff'], ['#ffffff'], ['#ffffff']];
  times.forEach(function (t) { values.push([fmtHm(t)]); colors.push(['#f3f3f3']); });
  values.push(['移動（分）']); colors.push(['#ffffff']);
  var last = values.length - 1;

  heads.forEach(function (h) {
    var list = cols[h.staff + '|' + h.day] || [];
    values[0].push(h.first ? h.day : ''); colors[0].push(HEAD_COLOR);
    values[1].push(h.staff); colors[1].push(HEAD_COLOR);
    // 同じ開始時刻の枠（週で分けた枠・入院中の枠に入れた人）をまとめる。入院中の人は後ろへ。
    var groups = [];
    list.forEach(function (r) {
      var g = groups[groups.length - 1];
      if (g && startOf_(g[0]) === startOf_(r)) g.push(r); else groups.push([r]);
    });
    groups = groups.map(goingFirst_);
    var count = groups.reduce(function (n, g) {
      return n + going_(g).reduce(function (m, r) { return m + ((str_(r['頻度']) || '毎週') === '毎週' ? 1 : 0.5); }, 0);
    }, 0);
    values[2].push(count); colors[2].push(HEAD_COLOR);
    var hours = hoursOf_(h.staff, settings);
    times.forEach(function (t, i) {
      var text = '', color = FREE_COLOR;
      if (t < hours.from || t >= hours.to || (settings.lunch && t >= settings.lunch.from && t < settings.lunch.to)) {
        color = OFF_COLOR;
      }
      groups.forEach(function (g) {
        var s = startOf_(g[0]);
        if (t < s || t >= s + len) return;
        text = g.map(function (r) {
          return cellLabel(r, places, kai[r['台帳ID']] || '') + (g.length > 1 && shownStatus(r) === '入院中' ? '［入院中］' : '');
        }).join('／');
        var st = going_(g).map(shownStatus).filter(function (x) { return x !== '通常'; })[0] || '通常';
        color = STATUS_COLORS[st] || STATUS_COLORS['通常'];
      });
      values[3 + i].push(text); colors[3 + i].push(color);
    });
    var move = 0;
    for (var k = 1; k < groups.length; k++) move += travelMinutes(groups[k - 1][0], groups[k][0], places, settings, areas);
    if (settings.officeArea && groups.length) {   // 事業所との行き帰り
      var office = { '場所': '', '地区': settings.officeArea };
      move += travelMinutes(office, groups[0][0], places, settings, areas) +
        travelMinutes(groups[groups.length - 1][0], office, places, settings, areas);
    }
    values[last].push(move); colors[last].push('#ffffff');
  });
  return { values: values, colors: colors };
}

// ---- 営業向けの空き枠（台帳から。利用者名は返さない） ----

var SLOT_WEEKS_ = ['毎週', '第1・3週', '第2・4週'];

function addDays_(ymd, n) {
  var d = new Date((dayNumber_(ymd) + n) * 86400000);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

// 担当・曜日の列で、start から訪問の長さの新しい枠 cand を置けるか（date の時点の枠で見る）。
// 塞ぐ枠：終了日が date より前でないもの（これから始まる枠・入院中の枠も塞ぐ）。行く週が重ならない枠は見ない。
// 前後の余白は needGap（同じ施設0・近い地区10・それ以外20）。前後に訪問が無ければ余白は要らない。
function fitsAt_(list, cand, start, date, places, settings, areas) {
  var len = settings.visitMin, end = start + len;
  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    if (str_(b['終了日']) && str_(b['終了日']) < date) continue;
    if (!weeksOverlap(cand, b)) continue;
    var bs = startOf_(b), be = bs + len;
    if (start < be && end > bs) return false;
    var need = needGap(b, cand, places, settings, areas);
    if (be <= start && start - be < need) return false;
    if (end <= bs && bs - end < need) return false;
  }
  return true;
}

// 新しい方を案内できる枠 [{weekday, staff, from, to, weeks, since, near}]（from〜to は開始できる時刻の幅）。
// weeks：毎週／第1・3週／第2・4週（週で分けた枠の空いている週）。since：その日から空く（減回・終了の予約）。空なら今から。
// near：前後の移動を「近い移動（10分）」で見て初めて入る枠（問い合わせの方の地区 opts.area が近いとき）。
// opts：area（問い合わせの方の地区）、place（同じ施設の方なら移動0分）、guideHours（案内する時間帯で絞る。スタッフ別の時間帯がある人は除く）。
function ledgerFreeSlots(rows, places, settings, asOf, areas, opts) {
  opts = opts || {};
  var len = settings.visitMin, out = [];
  settings.weekdays.forEach(function (day) {
    settings.staff.forEach(function (staff) {
      var list = rows.filter(function (r) {
        return str_(r['担当']) === staff && str_(r['曜日']) === day && startOf_(r) !== null &&
          !(str_(r['終了日']) && str_(r['終了日']) < asOf);
      });
      var dates = [asOf];
      list.forEach(function (r) {
        var e = str_(r['終了日']);
        if (e && dates.indexOf(addDays_(e, 1)) < 0) dates.push(addDays_(e, 1));
      });
      dates.sort();
      // 案内する時間帯（guideHours）は、スタッフ別の時間帯がある人には使わない（その人はその時間帯で案内する）。
      var h = hoursOf_(staff, settings), gh = settings.staffHours[staff] ? null : opts.guideHours;
      for (var t = h.from; t + len <= h.to; t += settings.slotMin) {
        if (gh && (t < gh.from || t + len > gh.to)) continue;
        if (settings.lunch && t < settings.lunch.to && t + len > settings.lunch.from) continue;
        var hit = null;
        for (var d = 0; d < dates.length && !hit; d++) {
          for (var w = 0; w < SLOT_WEEKS_.length && !hit; w++) {
            var cand = { '場所': opts.place || '', '地区': opts.area || '', '頻度': SLOT_WEEKS_[w] };
            if (!fitsAt_(list, cand, t, dates[d], places, settings, areas)) continue;
            hit = { weeks: SLOT_WEEKS_[w], since: d === 0 ? '' : dates[d],
                    near: !fitsAt_(list, cand, t, dates[d], places, settings, null) };
          }
        }
        if (!hit) continue;
        var last = out[out.length - 1], hm = fmtHm(t);
        if (last && last.weekday === day && last.staff === staff && last.weeks === hit.weeks && last.since === hit.since &&
            last.near === hit.near && parseHm(last.to) + settings.slotMin === t) {
          last.to = hm;
        } else {
          out.push({ weekday: day, staff: staff, from: hm, to: hm, weeks: hit.weeks, since: hit.since, near: hit.near });
        }
      }
    });
  });
  return out;
}

// 空き枠の添え書き（例「第2・4週のみ・11/1から・要相談：前後の移動10分」。毎週・今から・余白20分なら空）。
function freeSlotNote(r) {
  var notes = [];
  if (r.weeks && r.weeks !== '毎週') notes.push(r.weeks + 'のみ');
  if (r.since) notes.push(+r.since.slice(5, 7) + '/' + (+r.since.slice(8, 10)) + 'から');
  if (r.near) notes.push('要相談：前後の移動10分');
  return notes.join('・');
}

// 空き枠の表示・仮押さえに使う文字（例「水 関札 14:00〜14:20 開始（第2・4週のみ・11/1から）」）。
function freeSlotLabel(r) {
  var note = freeSlotNote(r);
  return r.weekday + ' ' + r.staff + ' ' + r.from + (r.to !== r.from ? '〜' + r.to : '') + ' 開始' + (note ? '（' + note + '）' : '');
}

// ---- 段3：盤面（置けるか・変更の適用・変更のまとめ） ----

// 新しい位置 cand（台帳の行の形。台帳ID が同じ行は自分自身として比べない）に置けるか。
// {level: 'ok' | 'near'（地区が近いので移動10分で足りている＝要相談） | 'ng', reason}。
// 勤務時間・昼休み・重なり（行く週が重なる枠だけ。入院中の枠には入れてよい）・前後の移動（needGap）を見る。
function placementCheck(rows, places, settings, areas, asOf, cand) {
  var start = startOf_(cand), len = settings.visitMin;
  if (start === null) return { level: 'ng', reason: '開始の時刻が読めません' };
  var end = start + len, staff = str_(cand['担当']), day = str_(cand['曜日']);
  var h = hoursOf_(staff, settings);
  if (start < h.from || end > h.to) return { level: 'ng', reason: staff + 'さんの勤務時間（' + fmtHm(h.from) + '〜' + fmtHm(h.to) + '）の外です' };
  if (settings.lunch && start < settings.lunch.to && end > settings.lunch.from) return { level: 'ng', reason: '昼休みにかかります' };
  var level = 'ok', reason = '';
  var others = rows.filter(function (r) {
    return r['台帳ID'] !== cand['台帳ID'] && str_(r['担当']) === staff && str_(r['曜日']) === day && startOf_(r) !== null &&
      isActive(r, asOf) && shownStatus(r) !== '入院中' && weeksOverlap(cand, r);
  }).sort(function (a, b) { return startOf_(a) - startOf_(b); });
  for (var i = 0; i < others.length; i++) {
    var b = others[i], bs = startOf_(b), be = bs + len, who = str_(b['利用者']);
    if (start < be && end > bs) return { level: 'ng', reason: who + ' と重なります' };
    var gap = be <= start ? start - be : bs - end, side = be <= start ? 'の後' : 'の前';
    var need = needGap(b, cand, places, settings, areas), strict = needGap(b, cand, places, settings, null);
    if (gap < need) return { level: 'ng', reason: who + ' ' + side + 'の移動が' + need + '分取れません' };
    if (gap < strict && level === 'ok') { level = 'near'; reason = who + ' ' + side + 'の移動が' + gap + '分（近いので可・要相談）'; }
  }
  return { level: level, reason: reason };
}

// 置いていない（開始の無い）枠＝待機。終わったものは出さない。
function waitingRows(rows, asOf) {
  return rows.filter(function (r) {
    return startOf_(r) === null && !(str_(r['終了日']) && str_(r['終了日']) < asOf);
  });
}

function where_(r) { return str_(r['曜日']) + ' ' + str_(r['担当']) + ' ' + str_(r['開始']); }

// 盤面の変更1件を台帳に当てる（元の rows は変えない）。{rows, history[]}。
// change.type：move（担当・曜日・開始。from が今日より後なら元の枠を前日で終え、新しい枠 newId を from から始める）／
//   place（待機の枠を置く。from を開始日に）／addWaiting（新規を待機に足す。状態は新規予定）／deleteWaiting。
function applyChange(rows, change, today, newId, who, now) {
  var out = rows.map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { o[k] = r[k]; }); return o; });
  var type = str_(change.type), from = str_(change.from), history = [];
  var log = function (kind, r, before, after, eff) {
    history.push({ '日時': now, '誰が': who, '種類': kind, '台帳ID': r['台帳ID'], '利用者': str_(r['利用者']),
                   '前': before, '後': after, '効く日': eff || today });
  };
  var touch = function (r) { r['更新日時'] = now; r['更新者'] = who; };
  if (type === 'addWaiting') {
    if (!str_(change['利用者'])) throw new Error('利用者を入れてください');
    var n = {};
    LEDGER_COLUMNS.forEach(function (k) { n[k] = ''; });
    ['利用者', '利用者ID', '場所', '地区', '頻度', '隔週の基準日', '保険区分', '代行優先度', 'メモ'].forEach(function (k) { n[k] = str_(change[k]); });
    n['台帳ID'] = newId; n['場所'] = n['場所'] || '在宅'; n['頻度'] = n['頻度'] || '毎週'; n['状態'] = '新規予定';
    touch(n);
    out.push(n);
    log('新規を待機に追加', n, '', '待機', today);
    return { rows: out, history: history };
  }
  var idx = -1;
  for (var i = 0; i < out.length; i++) if (out[i]['台帳ID'] === change.id) idx = i;
  if (idx < 0) throw new Error('台帳ID ' + change.id + ' が見つかりません（読み込み直してください）');
  var r = out[idx], waiting = startOf_(r) === null;
  if (type === 'deleteWaiting') {
    if (!waiting) throw new Error('置いてある枠は消せません（減回・終了で扱います）');
    out.splice(idx, 1);
    log('待機から削除', r, '待機', '', today);
    return { rows: out, history: history };
  }
  if (type !== 'move' && type !== 'place') throw new Error('不明な変更です: ' + type);
  if (type === 'place' && !waiting) throw new Error('待機の枠ではありません（読み込み直してください）');
  if (type === 'move' && waiting) throw new Error('待機の枠は「置く」で扱います');
  var to = { '担当': str_(change['担当']), '曜日': str_(change['曜日']), '開始': str_(change['開始']) };
  if (parseHm(to['開始']) === null || !to['担当'] || WEEKDAYS.indexOf(to['曜日']) < 0) throw new Error('置き先が読めません');
  if (type === 'place') {
    var before = '待機';
    Object.keys(to).forEach(function (k) { r[k] = to[k]; });
    r['開始日'] = from > today ? from : str_(r['開始日']);
    touch(r);
    log('新規の配置', r, before, where_(r), from || today);
    return { rows: out, history: history };
  }
  var old = where_(r);
  if (!from || from <= today) {
    Object.keys(to).forEach(function (k) { r[k] = to[k]; });
    touch(r);
    log('移動', r, old, where_(r), today);
    return { rows: out, history: history };
  }
  var nr = {};
  Object.keys(r).forEach(function (k) { nr[k] = r[k]; });
  Object.keys(to).forEach(function (k) { nr[k] = to[k]; });
  nr['台帳ID'] = newId; nr['開始日'] = from;
  if (str_(r['終了日']) && str_(r['終了日']) < from) throw new Error('この枠は ' + r['終了日'] + ' で終わる予定です');
  r['終了日'] = addDays_(from, -1);
  touch(r); touch(nr);
  out.push(nr);
  log('移動', nr, old, where_(nr), from);
  return { rows: out, history: history };
}

// 変更履歴のうち、その日（day）の、除く人（exclude）以外の変更を人ごと・種類ごとの件数にする（メール用・利用者名は出さない）。
function changeDigest(history, day, exclude) {
  var people = [], by = {};
  (history || []).forEach(function (h) {
    var who = str_(h['誰が']);
    if (str_(h['日時']).slice(0, 10) !== day || (exclude || []).indexOf(who) >= 0) return;
    if (!by[who]) { by[who] = { kinds: [], n: {} }; people.push(who); }
    var k = str_(h['種類']);
    if (!by[who].n[k]) { by[who].n[k] = 0; by[who].kinds.push(k); }
    by[who].n[k]++;
  });
  var total = 0;
  var lines = people.map(function (p) {
    return p + 'さん：' + by[p].kinds.map(function (k) { total += by[p].n[k]; return k + ' ' + by[p].n[k] + '件'; }).join('・');
  });
  return { total: total, lines: lines };
}

// 盤面の下書き（変更の並び）を、保存する前にまとめる（元の配列は変えない）。
// 同じ枠を今から続けて動かした・置き直した分は、最初の変更の位置に最後の置き先1回として残す。
// 下書きの中で足して消した待機の方は、両方とも落とす。先の日付からの移動（from あり）はまとめない。
function compressChanges(changes) {
  var out = [];
  (changes || []).forEach(function (ch) {
    var c = {};
    Object.keys(ch).forEach(function (k) { c[k] = ch[k]; });
    if (c.type === 'deleteWaiting') {
      var j = -1;
      out.forEach(function (o, i) { if (o.type === 'addWaiting' && o.tempId === c.id) j = i; });
      if (j >= 0) {
        out = out.filter(function (o, i) { return i !== j && o.id !== c.id; });
        return;
      }
    }
    if (c.type === 'move' && !c.from) {
      for (var i = out.length - 1; i >= 0; i--) {
        var o = out[i];
        if (o.id === c.id && (o.type === 'place' || (o.type === 'move' && !o.from))) {
          o['担当'] = c['担当']; o['曜日'] = c['曜日']; o['開始'] = c['開始'];
          return;
        }
      }
    }
    out.push(c);
  });
  return out;
}

  return { LEDGER_COLUMNS: LEDGER_COLUMNS, STATUS_COLORS: STATUS_COLORS, FREQS: FREQS, STATUSES: STATUSES, WEEKDAYS: WEEKDAYS, parseHm: parseHm, fmtHm: fmtHm, normalizeSettings: normalizeSettings, normalizePlaces: normalizePlaces, normalizeAreas: normalizeAreas, isActive: isActive, goesOn: goesOn, weeksOverlap: weeksOverlap, needGap: needGap, travelMinutes: travelMinutes, shownStatus: shownStatus, cellLabel: cellLabel, weekNumbers: weekNumbers, renderWeekGrid: renderWeekGrid, placementCheck: placementCheck, waitingRows: waitingRows, applyChange: applyChange, compressChanges: compressChanges };
})();
