// HEXAREA 中継サーバー（Cloudflare Workers + Durable Objects）
// ・1つのルーム（4文字のルームID）ごとに、Durable Object「Room」が1つ動く。
// ・ルームの状態と、隠された情報（霧の中のマス・相手の罠・スキルなど）は、このサーバーだけが持つ（正本）。
//   各プレイヤーには「公開情報＋その人だけの情報」を、観戦者には公開情報だけを送る。
//   （Devモードの暗証番号を確かめた観戦者には、盤面全体を送る）
// ・端末からは操作の内容（例: このマスをタップ）だけを受け取り、ルールで確かめてから反映し、全員に配る。
// ・プレイヤーの端末どうしは直接つながらないので、相手にIPアドレスは見えない。
// ・終局後は、最初の盤面と全員の操作の記録を配り、端末で最初から再生できるようにする。
// ・ファイルは、この index.js と wrangler.jsonc の2つだけ（フォルダに入れず、リポジトリの一番上に置く）。
import { DurableObject } from "cloudflare:workers";

/* =========================================================
   1. ゲームのルール（エンジン）
   ・ここから「エンジンの追加部分」までは、ゲーム本体（hexarea の index.html）のルールの処理を、そのまま写したもの。
     画面の処理（描画・音・ダイアログ）は、何もしない関数に置き換えている。
   ・ルールを変えるときは、index.html と、このファイルの両方を同じように直すこと。
     （index.html: init〜endTurn、unlock・checkUnlocks、SKILLS・learnSkill、クラフト画面のボタンの処理、resign）
   ・ルーム（Durable Object）ごとに createEngine() で1つ作る。モジュールの外側に状態を置かない
     （同じ実行環境で、複数のルームが動くことがあるため）。
   ========================================================= */
function createEngine() {
  // ---- 画面の処理の代わり（サーバーでは何もしない）----
  const render = () => {}, buildHeader = () => {}, showPopup = () => {}, draw = () => {}, renderTree = () => {}, renderTools = () => {}, villageHint = () => {}, gmGrant = () => {};
  let fxOut = [];   // 操作した人の端末で鳴らす効果音の名前
  const SFX = {play(n) { fxOut.push(n); }};
  // 確認ダイアログ: サーバーでは表示せず、内容を覚えておく（端末に確認を出してもらい、「はい」の返事で実行する）
  let asked = null;
  function ask(text, yes, fn, altLabel, altFn) { asked = {text: String(text), yes: String(yes), fn, alt: altLabel ? String(altLabel) : '', altFn: altFn || null}; }
  // 行動のあと: index.html では1秒後に「ターンを終了しますか」を出す。サーバーでは、端末からの「ターン終了」を待つ
  function finishAct() {
    if (actions === 0 || !anyLegal(turn)) { if (allStuck()) advance(); return; }
    advance();
  }

  // ===== ここから index.html のルールの写し =====
  const RADIUS_BY_NP = {2:7, 3:7, 4:8, 5:8, 6:9};   // 人数ごとのマップ半径（1人あたり約45〜85マス）
  const ROUNDS_BY_NP = {2:100, 3:68, 4:64, 5:52, 6:56};   // 人数ごとのラウンド数の初期値（1人あたりのマス数×約1.2を、4の倍数に）
  let NP = 2, RADIUS = RADIUS_BY_NP[NP], MAX_ROUNDS = ROUNDS_BY_NP[NP];   // NP: プレイ人数（2〜6）。RADIUSは init() で人数に合わせる
  // プレイヤーの色: 地形（山の茶・水域の青緑・森の緑・移動先の緑・空きマスの灰・資源の黄）と被らない10色
  const PALETTE = [{n:'青', c:'#3a7cb8'}, {n:'赤', c:'#c5453f'}, {n:'紫', c:'#8e5bd6'}, {n:'橙', c:'#f08c00'}, {n:'桃', c:'#e05aa8'},
                   {n:'水色', c:'#17b3d3'}, {n:'紺', c:'#2b3d9e'}, {n:'臙脂', c:'#9b1f3f'}, {n:'赤紫', c:'#c026d3'}, {n:'珊瑚', c:'#ff7a5c'}];
  const COLORS = {0:'#8b919c'}, PNAMES = {};
  let PNAME = {}, PCOL = {1:0, 2:1, 3:2, 4:3, 5:4, 6:5};   // プレイヤーの名前と、PALETTEの番号
  function applyColors() {   // 色が重ならないように整えて、COLORS・色名に反映する
    const used = new Set();
    for (let p = 1; p <= 6; p++) {
      let i = PCOL[p]; if (!(i >= 0 && i < PALETTE.length) || used.has(i)) i = PALETTE.findIndex((_, k) => !used.has(k));
      PCOL[p] = i; used.add(i); COLORS[p] = PALETTE[i].c; PNAMES[p] = PALETTE[i].n;
    }
  }
  applyColors();
  const esc = t => String(t).replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const PL = () => Array.from({length: NP}, (_, i) => i + 1);   // 参加プレイヤー番号
  const per = v => Object.fromEntries(PL().map(p => [p, typeof v === 'function' ? v(p) : v]));   // プレイヤーごとの値
  const isPlayer = o => o >= 1 && o <= NP;
  const isEnemy = (o, p) => isPlayer(o) && o !== p;
  let alive = per(true);   // 脱落していないプレイヤー
  const multi = () => NP > 2;   // 3人以上のときの特別ルール
  const firstPicker = () => multi() ? NP : 1;   // 3人以上は手番の逆順（P6→P1）で拠点を選ぶ
  const lastPicker = () => multi() ? 1 : NP;
  const nextPicker = t => multi() ? t - 1 : t + 1;
  const firstHalf = p => multi() && p <= Math.floor(NP / 2);   // 3人以上: 手番の前半組（P1〜P[人数÷2の切り捨て]）
  const startRp = p => (firstHalf(p) ? 1 : 0) + (NP === 6 && p === lastPicker() ? 1 : 0);   // 前半組は初期資源+1。6人戦では最後の選択者（P1）がさらに+1
  const startSp = p => (p === 1 ? 1 : 0) + (firstHalf(p) ? 1 : 0);   // 初期食料: P1が1。3人以上では前半組がさらに+1
  const DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
  const key = (q,r) => q + ',' + r;
  const calcBases = () => DIRS.map(([a,b]) => [a*(RADIUS-1), b*(RADIUS-1)]);   // 拠点候補: 最外周から1マス内側の六角形の頂点6か所
  let BASES = calcBases();
  const isBase = c => BASES.some(([q,r]) => c.q === q && c.r === r);

  let cells, sp, rp, skills, last, viewer, started, turn, round, actions, over, winner, msg, hover = null, selecting = true, gm = false, pw = per(1), bless = per(0), pot = per(0), boost = {stone:per(0), polish:per(0)}, tool = {stone:per(0), polish:per(0)}, lock = {stone:per(0), polish:per(0)}, fixed = {stone:per(0), polish:per(0), cook:per(0)};   // boost: 石器の使用回数ぶんの戦力（そのターンの間だけ）。 tool: 石器の残り使用回数（0〜2）。 lock: そのターンに壊れた石器（次のターンまで作製できない）。 pot: 土器の作製で増やした貯蔵上限。 bless: 命の糧による戦力（そのターンの間だけ）
  let size = 36, cx = 0, cy = 0;
  let busy = false, timer = null;
  let ONLINE = null;   // オンライン対戦中: {code, seat, uid, playing}
  const onPlay = () => !!(ONLINE && ONLINE.playing);
  const loadDV = () => false;   // 昼の全体表示は、ページを開くたびに必ずオフから始める（GMが切り替えても保存しない。切り替えはDevモードのみ）
  let villageTold = {};   // 村の建て方のお知らせを出したか（席ごと・ゲームごと。通信しない）
  let traps = {}, scoutV = {}, scoutMode = null, scoutPrev = null, trapMode = false, villageMode = false;   // villageMode: 村を建てる場所を選んでいる間 ／ traps: 罠 {マスのキー: 仕掛けた人} ／ scoutV: 偵察で晴らしたマス {席: [{c:[キー…], u:見える最後のラウンド}]} ／ scoutMode・trapMode・scoutPrev: 場所を選んでいる間の画面の状態（通信しない）
  let dayVision = loadDV();   // オンライン対戦中は、ホストが決めた部屋の設定になる
  const fullDay = () => dayVision && !selecting && isDay();   // 昼（朝・昼）は、盤面全体が見える（拠点を選ぶ間は、選んだ拠点を隠すため対象外）
  // AI（コンピューター）が操作する席: {席番号: 強さ}（1=やさしい 2=ふつう 3=つよい）。オフライン対戦のみ
  let CPU = {};
  const tutOn = () => false;   // サーバーではチュートリアルはない
  const spectating = () => !!(ONLINE && ONLINE.spec && ONLINE.playing);   // 観戦者（オンライン対戦の部屋を、席を取らずに眺める人。終局後の振り返りもこの扱い）
  const specAll = () => spectating() && ONLINE.view === 'all';   // 観戦者の「全体」表示（Devモードの観戦者と、終局後の振り返りだけ。サーバーが全体の情報を送ったときに限る）
  const specPub = () => spectating() && ONLINE.view !== 'all' && !(ONLINE.view > 0);   // 観戦者の通常表示: 公開情報だけ（盤面は霧のまま）
  const isCPU = p => !ONLINE && p >= 1 && p <= NP && !!CPU[p] && !tutOn();
  const humansAlive = () => PL().filter(q => !isCPU(q) && alive[q]).length;
  const humanSeat = () => (viewer && !isCPU(viewer) && alive[viewer]) ? viewer : (PL().find(q => !isCPU(q) && alive[q]) || viewer || turn);   // AIの番のときに盤面を見る人
  const viewP = () => onPlay() ? (ONLINE.spec ? (ONLINE.view > 0 ? ONLINE.view : ONLINE.view === 'all' ? turn : 0) : ONLINE.seat) : isCPU(turn) ? humanSeat() : turn;   // 盤面を見るプレイヤー（オンラインでは自分の席。観戦者は、選んだプレイヤーの視点。公開情報だけのときは 0）
  const myTurn = () => onPlay() ? ONLINE.seat === turn : !isCPU(turn);
  let langOpen = per(false), fireOpen = per(false), stoneOpen = per(false), pending = per(() => []), popupQ = [], gmBackup = null, xOpen = {};   // xOpen: 新石器スキルの解放状態
  const XIDS = ['farm','herd','polish','pottery','faith','cook','settle','trap','survey','summit']; const resetX = () => { for (const k of XIDS) xOpen[k] = per(false); }; resetX(); let baseCell = {}, retPick = {}, tieStay = false, vNew = {}, resT = {};   // vNew: 建てたばかり（次の自分の番まで拠点扱いでない）の村 {マスのキー: 1} ／ resT: 回収した資源マスの復活 {マスのキー: [回収した回数, 復活するラウンド]}
    //   // retPick: 強制帰還で同じ距離の拠点が複数あるとき、本人が選ぶ候補 {席: [マスのキー…] または null} ／ tieStay: 現在地への攻撃が引き分けで、攻撃側が入れなかった
    //   // 「言語の獲得」の解放状態と、表示待ちのお知らせ   // 手番交代の1秒待ち中は操作を受け付けない

  function init() {
    clearTimeout(timer); busy = false;
    RADIUS = RADIUS_BY_NP[NP] || 8; BASES = calcBases();   // マップの大きさは人数で決まる
    cells = new Map();
    for (let q=-RADIUS;q<=RADIUS;q++) for (let r=-RADIUS;r<=RADIUS;r++)
      if (Math.abs(q+r) <= RADIUS) cells.set(key(q,r), {q,r,o:0,t:'p'});
    shapeCoast();   // マップの輪郭を毎回ランダムに盛り上げ・削る
    genTerrain(); genResources();
    villageTold = {}; traps = {}; scoutV = per(() => []); scoutMode = null; scoutPrev = null; trapMode = false; villageMode = false;
    sp = per(startSp); started = per(false); rp = per(startRp); pw = per(1); bless = per(0); pot = per(0); boost = {stone:per(0), polish:per(0)}; tool = {stone:per(0), polish:per(0)}; lock = {stone:per(0), polish:per(0)}; fixed = {stone:per(0), polish:per(0), cook:per(0)}; skills = per(() => ({})); last = per(null); alive = per(true); turn = firstPicker(); viewer = isCPU(turn) ? (PL().find(q => !isCPU(q)) || turn) : turn; round = 1; actions = 0; over = false; winner = 0; selecting = true;
    langOpen = per(false); fireOpen = per(false); stoneOpen = per(false); resetX(); baseCell = {}; retPick = per(null); vNew = {}; resT = {}; pending = per(() => []); popupQ = []; 
    msg = `R1/${MAX_ROUNDS}（朝） ${name(turn)}は拠点を選んでください`; hover = null;
    render();
  }
  // マップの輪郭: 六角形を土台に、角度ごとに滑らかに変わる「ゆらぎ」で外周を最大 COAST_MAX マス盛り上げたり削ったりする。
  // 拠点候補の半径2マスと、中央付近（外周から3マスより内側）は削らない。最後に、本体から切れたマスと細い突き出しを取り除く
  const COAST_MAX = 2;   // 外周が基本の半径から増減する最大のマス数（通信の盤面データもこの分だけ大きく持つ）
  function shapeCoast() {
    const R0 = RADIUS, RB = R0 + COAST_MAX, S3 = Math.sqrt(3);
    const keep = c => ring(c) <= R0 - 3 || BASES.some(([bq, br]) => hexDist(c, {q: bq, r: br}) <= 2);
    const waves = [2, 3, 4, 5, 7].map((fq, i) => ({fq, a: [0.9, 0.7, 0.45, 0.35, 0.25][i] * (0.5 + Math.random()), ph: Math.random() * Math.PI * 2}));
    const bias = (Math.random() - 0.5) * 0.8 - 0.35;   // 全体の大きさのぶれ（拠点まわりは削らないため、やや縮む側に寄せて釣り合わせる）
    const off = (q, r) => { const th = Math.atan2(1.5 * r, S3 * (q + r / 2)); return Math.max(-COAST_MAX, Math.min(COAST_MAX, bias + waves.reduce((s, w) => s + w.a * Math.sin(w.fq * th + w.ph), 0))); };
    const all = new Map();
    for (let q = -RB; q <= RB; q++) for (let r = -RB; r <= RB; r++) if (Math.abs(q + r) <= RB) {
      const c = {q, r, o: 0, t: 'p'};
      if ((ring(c) <= R0 && keep(c)) || ring(c) <= Math.round(R0 + off(q, r))) all.set(key(q, r), c);
    }
    const nb = c => DIRS.map(([a, b]) => all.get(key(c.q + a, c.r + b))).filter(Boolean);
    for (let pass = 0; pass < 3; pass++) {   // 1マスだけ突き出た細い岬を削る／ほぼ囲まれた切れ込みを埋める
      for (const c of [...all.values()]) if (!keep(c) && nb(c).length <= 1) all.delete(key(c.q, c.r));
      for (let q = -RB; q <= RB; q++) for (let r = -RB; r <= RB; r++) {
        const k = key(q, r); if (Math.abs(q + r) > RB || all.has(k)) continue;
        const c = {q, r, o: 0, t: 'p'}; if (nb(c).length >= 5) all.set(k, c);
      }
    }
    const seen = new Set(['0,0']), st = [all.get('0,0')];   // 中央とつながっていないマスは消す
    while (st.length) { const c = st.pop(); for (const n of nb(c)) { const k = key(n.q, n.r); if (!seen.has(k)) { seen.add(k); st.push(n); } } }
    cells = new Map();
    for (let q = -RB; q <= RB; q++) for (let r = -RB; r <= RB; r++) { const k = key(q, r); if (seen.has(k)) cells.set(k, all.get(k)); }   // 並び順を q・r の順にそろえる
  }
  // 地形: p=平地(1pt) / m=山(2pt) / s=水域(通行不可)。毎回ランダムに生成
  function seaSize(c0) {   // c0を含む海マスのつながりの大きさ
    const seen = new Set([key(c0.q,c0.r)]), st = [c0];
    while (st.length) { const c = st.pop(); for (const n of nbrs(c)) if (n.t === 's' && !seen.has(key(n.q,n.r))) { seen.add(key(n.q,n.r)); st.push(n); } }
    return seen.size;
  }
  function badSea(c0) {   // 水域のかたまりが4マス以上、または3マスが直線ならNG
    const seen = new Map([[key(c0.q,c0.r), c0]]), st = [c0];
    while (st.length) { const c = st.pop(); for (const n of nbrs(c)) if (n.t === 's' && !seen.has(key(n.q,n.r))) { seen.set(key(n.q,n.r), n); st.push(n); } }
    if (seen.size > 3) return true;
    if (seen.size === 3) { const v = [...seen.values()]; return v.every(m => m.q === v[0].q) || v.every(m => m.r === v[0].r) || v.every(m => m.q + m.r === v[0].q + v[0].r); }
    return false;
  }
  // 資源: 平地（第2リング以降）に約20%（全体比）の確率で配置
  function genResources() {
    for (const c of cells.values()) { c.res = c.t === 'p' && !c.forest && !isBase(c) && Math.random() < SET.res / 100; c.harv = false; }
  }
  function placeMountain(c, len) {   // cを含む山のかたまりを置く（1・2マスは直線、3マスは直線に限らない）。他の山とは隣接させない
    let shapes = [];
    if (len === 1) shapes = [[c]];
    else if (len === 2) shapes = nbrs(c).map(n => [c, n]);
    else for (const n1 of nbrs(c)) for (const n2 of [...nbrs(c), ...nbrs(n1)]) if (n2 !== c && n2 !== n1) shapes.push([c, n1, n2]);
    shapes.sort(() => Math.random() - 0.5);
    for (const line of shapes) {
      if (line.some(m => isBase(m) || m.t !== 'p')) continue;
      if (line.some(m => nbrs(m).some(n => n.t === 'm' && !line.includes(n)))) continue;
      // 拠点候補に隣接する山は、拠点ごとに最大1マス
      if (BASES.some(([bq,br]) => nbrs(cells.get(key(bq,br))).filter(n => n.t === 'm' || line.includes(n)).length >= 2)) continue;
      for (const m of line) m.t = 'm';
      return true;
    }
    return false;
  }
  const hexDist = (a,b) => (Math.abs(a.q-b.q) + Math.abs(a.r-b.r) + Math.abs(a.q+a.r-b.q-b.r)) / 2;
  const isStraight = v => v.every(m => m.q === v[0].q) || v.every(m => m.r === v[0].r) || v.every(m => m.q + m.r === v[0].q + v[0].r);
  function placeWater(c, len) {   // cを含む水域のかたまり（1〜3マス、3マスは直線にしない）。他の水域・拠点候補の周囲1マスには置かない
    let shapes = [];
    if (len === 1) shapes = [[c]];
    else if (len === 2) shapes = nbrs(c).map(n => [c, n]);
    else for (const n1 of nbrs(c)) for (const n2 of [...nbrs(c), ...nbrs(n1)]) if (n2 !== c && n2 !== n1) shapes.push([c, n1, n2]);
    if (len === 3) shapes = shapes.filter(s => !isStraight(s));
    shapes.sort(() => Math.random() - 0.5);
    for (const line of shapes) {
      if (line.some(m => m.t !== 'p' || isBase(m) || nbrs(m).some(isBase))) continue;
      if (line.some(m => nbrs(m).some(n => n.t === 's' && !line.includes(n)))) continue;
      for (const m of line) m.t = 's';
      return true;
    }
    return false;
  }
  function shapesAt(c, len) {   // cを含む、つながった len マスの形（3マスは直線に限らない）
    if (len === 1) return [[c]];
    if (len === 2) return nbrs(c).map(n => [c, n]);
    const out = [];
    for (const n1 of nbrs(c)) for (const n2 of [...nbrs(c), ...nbrs(n1)]) if (n2 !== c && n2 !== n1) out.push([c, n1, n2]);
    return out;
  }
  function placeForests(all) {   // 森: 山と同様と1〜3マスのかたまりを分散させて置く。2マスは中心から全体の半径の3分の2以内、3マスは3分の1以内だけ
    const tF = all.length * SET.forest / 100;
    let cF = 0, fails = 0;
    for (let guard = 0; guard < 300 && cF < tF && fails < 15; guard++) {
      const len = Math.max(1, Math.min([1,1,2,2,3][Math.floor(Math.random()*5)], Math.ceil(tF - cF)));
      const okCell = m => m.t === 'p' && !m.forest && !isBase(m) && !nbrs(m).some(isBase) && (len === 1 || ring(m) <= RADIUS * (len === 3 ? 1/3 : 2/3));   // 3マス: マップの半径の3分の1以内 ／ 2マス: 3分の2以内   // 拠点候補の周囲1マスには森を置かない
      const pool = all.filter(okCell);
      if (!pool.length) break;
      const forests = all.filter(c => c.forest);
      const memo = new Map(), others = all.filter(c => c.t !== 'p'); const score = c => { if (!memo.has(c)) memo.set(c, (forests.length ? Math.min(...forests.map(q => hexDist(c, q))) : 6) + 0.3 * Math.min(others.length ? Math.min(...others.map(q => hexDist(c, q))) : 4, 4) + Math.random() * 0.4); return memo.get(c); };   // 森同士をなるべく離し、山・水域とも少し離す
      const cand = []; for (let i = 0; i < 40; i++) cand.push(pool[Math.floor(Math.random() * pool.length)]);
      cand.sort((x, y) => score(y) - score(x));
      let ok = false;
      for (const c of cand) {
        const shapes = shapesAt(c, len).sort(() => Math.random() - 0.5);
        const line = shapes.find(s => s.every(okCell) && !s.some(m => nbrs(m).some(n => n.forest && !s.includes(n))));
        if (line) { for (const m of line) { m.forest = true; m.f0 = true; } cF += len; ok = true; break; }
      }
      if (ok) fails = 0; else fails++;
    }
  }
  function genTerrain() {   // 山と水域は「いちばん他から離れた場所」を選んで置くので、マップ全体に分散する
    const all = [...cells.values()];
    const N = all.length, tM = N * SET.mount / 100, tW = N * SET.water / 100;
    for (let tries = 0; tries < 200; tries++) {
      for (const c of all) c.t = 'p';
      let cM = 0, cW = 0;
      const fails = {m: 0, s: 0};
      for (let guard = 0; guard < 600; guard++) {
        const needM = cM < tM && fails.m < 10, needW = cW < tW && fails.s < 10;
        if (!needM && !needW) break;
        const type = needM && needW ? (cM / tM <= cW / tW ? 'm' : 's') : (needM ? 'm' : 's');
        const remain = Math.ceil(type === 'm' ? tM - cM : tW - cW);
        const len = Math.max(1, Math.min([1,1,2,2,3][Math.floor(Math.random()*5)], remain));
        // 候補をランダムに集め、すでにある山・水域から最も離れたものを優先する
        const pool = all.filter(c => c.t === 'p' && !isBase(c) && (type === 'm' || !nbrs(c).some(isBase)));
        const same = all.filter(c => c.t === type), other = all.filter(c => c.t !== 'p' && c.t !== type);   // 同じ種類の地形からなるべく離す（種類ごとに全体へ均一に）
        const dmin = (c, arr, d0) => arr.length ? Math.min(...arr.map(q => hexDist(c, q))) : d0;
        const memo = new Map(); const score = c => { if (!memo.has(c)) memo.set(c, dmin(c, same, 6) + 0.3 * Math.min(dmin(c, other, 4), 4) + Math.random() * 0.4); return memo.get(c); };   // 同種との距離を主に、他の地形との距離を少し考慮（少しランダム）
        const cand = []; for (let i = 0; i < 40 && pool.length; i++) cand.push(pool[Math.floor(Math.random() * pool.length)]);
        cand.sort((x, y) => score(y) - score(x));
        let ok = false;
        for (const c of cand) if (type === 'm' ? placeMountain(c, len) : placeWater(c, len)) { ok = true; break; }
        if (ok) { if (type === 'm') cM += len; else cW += len; fails[type] = 0; } else fails[type]++;
      }
      // 水域以外が全て拠点候補から到達可能か確認
      const b0 = cells.get(key(BASES[0][0], BASES[0][1]));
      const seen = new Set([key(b0.q,b0.r)]), st = [b0];
      while (st.length) { const c = st.pop(); for (const n of nbrs(c)) if (n.t !== 's' && !seen.has(key(n.q,n.r))) { seen.add(key(n.q,n.r)); st.push(n); } }
      if (seen.size === all.filter(c => c.t !== 's').length) { placeForests(all); return; }
    }
    for (const c of all) c.t = 'p';   // 失敗時は全て平地
  }
  const nbrs = c => DIRS.map(([a,b]) => cells.get(key(c.q+a,c.r+b))).filter(Boolean);
  const ring = c => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;   // 中央からの距離
  const cost = (c,p=turn) => c.t === 'm' ? ((skills && skills[p] && skills[p].herd) ? 1 : 2) : 1;   // 山は2行動（牧畜の開始で1）
  const roadRange = p => 1;   // 道での移動半径（以前は煮炊きの技術で2だった）
  const isJump = (c,p) => c.o === p && !!last[p] && !nbrs(c).includes(last[p]);   // 隣でない道への移動（1行動・食料1）
  const returnBases = p => {   // 帰還できる拠点: 現在地から一番近い自分の拠点（最初の拠点・村）。同じ距離なら、どれにも戻れる。拠点の上にいるときは戻る先なし
    const L0 = last[p]; if (!L0) return [];
    const bs = basesOf(p); if (!bs.length) return [];
    const d = Math.min(...bs.map(b => hexDist(b, L0)));
    return d === 0 ? [] : bs.filter(b => hexDist(b, L0) === d);
  };
  const isReturn = (c,p) => c.o === p && (isActiveVillage(c) || c === baseCell[p]) && returnBases(p).includes(c);
  const moveCost = (c,p) => isBattle(c,p) ? cost(c,p) : (isReturn(c,p) || isJump(c,p)) ? 1 : cost(c,p);   // 一番近い自分の拠点へは、離れていても食料1で戻れる   // 戦闘も、そのマスへ移動する食料を使う（勝敗にかかわらず）   // 自分の色のマス（道）への移動はpt不要
  const onRoad = (c,p) => {   // 現在位置から自分の色のマスでつながっているか
    if (!last[p] || c.o !== p) return false;
    const seen = new Set([key(last[p].q, last[p].r)]), st = [last[p]];
    while (st.length) { const x = st.pop(); if (x === c) return true; for (const n of nbrs(x)) if (n.o === p && !seen.has(key(n.q,n.r))) { seen.add(key(n.q,n.r)); st.push(n); } }
    return false;
  };
  const visLevel = (c, p) => Math.max(1, ((isMyBase(c, p) || c === last[p]) ? 3 : 1) + (skills[p].faith ? 1 : 0) - ((isDay() || skills[p].fire) ? 0 : 1));   // 拠点と現在地はレベル3、他の自領はレベル1。夜は-1（火の発見で無効）、神秘の探究で+1
  const specialAround = c => new Set(nbrs(c).map(n => n.t === 'm' ? 'm' : n.t === 's' ? 's' : n.forest ? 'f' : '').filter(Boolean)).size;   // 周囲6マスにある地形の種類数（現在は山・水域・森。資源は含まない。新しい地形マスを追加したら、ここに種類を足す）
  const VILLAGE_RES = 3, VILLAGE_FOOD = 2, VILLAGE_MAX = 3;   // 村の建設: 資源3・食料2、1人最大3つ。壊しても資源・食料は戻らない
  const canBuildVillage = p => gm || (rp[p] >= VILLAGE_RES && sp[p] >= VILLAGE_FOOD && villageCount(p) < VILLAGE_MAX);
  const isAnyBase = x => !!x.village || (isPlayer(x.o) && baseCell[x.o] === x);   // だれかの拠点（最初の拠点、または村）
  const isFrontCell = (c, p) => PL().some(q => q !== p && alive[q] && [...cells.values()].some(x => isMyBase(x, q) && hexDist(x, c) <= 2));   // 前線: 他のプレイヤーの拠点（最初の拠点・村）から2マス以内
  const frontVillages = p => [...cells.values()].filter(c => c.o === p && c.village && isFrontCell(c, p)).length;   // 前線にある自分の村の数（建てたばかりを含む）
  const spotOwnOk = (c, p) => ![...cells.values()].some(x => x.o === p && isAnyBase(x) && hexDist(x, c) <= 2);   // 自分の拠点・村から2マス以内には建てられない
  const spotFrontOk = (c, p) => !isFrontCell(c, p) || frontVillages(p) < FRONT_MAX;   // 前線の村は同時に1つまで
  const forestVillages = p => [...cells.values()].filter(c => c.o === p && c.village && c.forest).length;   // 建てたばかりを含む
  const spotForestOk = (c, p) => !c.forest || forestVillages(p) < FOREST_VILLAGE_MAX;
  const villageSpotOk = (c, p = turn) => spotOwnOk(c, p) && spotFrontOk(c, p) && spotForestOk(c, p);   // 相手の拠点の近くにも建てられるが、前線の村は1つまで
  const FOREST_VILLAGE_MAX = 1;   // 森のマスに建てられる村の数（食料は減らないが、毎ターンの資源+1がない）
  const FRONT_MAX = 1;   // 前線の村（他のプレイヤーの拠点から2マス以内の村）を同時に持てる数
  const villageCand = (c, p) => !!c && started[p] && c.o === p && !c.village && !isHarvest(c, p) && (c === last[p] || isLegal(c, p));   // 村の候補: 自領のマスのうち、現在地か、いま動ける隣のマス（資源が残っているマスは、先に回収する）
  const villageSpotWhy = (c, p) => !spotOwnOk(c, p) ? 'ここには村を建てられません（自分の拠点・村から2マス以内には建てられません）' : !spotForestOk(c, p) ? `ここには村を建てられません（森の村は${FOREST_VILLAGE_MAX}つまでです。森の村を壊すと、別の森に建てられます）` : `ここには村を建てられません（前線の村は同時に${FRONT_MAX}つまでです。相手の拠点から2マス以内に建てた村を壊すと、建てられます）`;
  const villageWhy = p => villageCount(p) >= VILLAGE_MAX ? `村は最大${VILLAGE_MAX}つまでです（長押しで壊して建て直せます）` : `村の建設には、資源${VILLAGE_RES}と食料${VILLAGE_FOOD}が必要です`;
  function demolishVillage(c) {   // 村を壊す（行動1を使う）。資源・食料は戻らない
    const p = turn; if (busy || over || c.o !== p || !c.village || (!gm && actions < 1)) return;
    if (isActiveVillage(c) && basesOf(p).length <= 1) { msg = '最後の拠点は壊せません'; render(); return; }   // 拠点がなくなると脱落するため
    c.village = false; delete vNew[key(c.q, c.r)]; if (!gm) actions--;
    msg = `${name(p)} 🏚 村を壊した 残り行動 ${gm ? '∞' : actions}`; finishAct();
  }
  function buildVillage(c) {   // 村の建設: 資源3・食料2。拠点扱い。自分の拠点・村から2マス以内には建てられない
    const p = turn; if (c.o !== p || c.village || !canBuildVillage(p) || !villageSpotOk(c, p)) return;
    villageMode = false; if (!gm) { rp[p] -= VILLAGE_RES; sp[p] -= VILLAGE_FOOD; } c.village = true; vNew[key(c.q, c.r)] = 1;   // 建てたばかりの村は、次の自分の番まで拠点扱いにならない
    msg = `${name(p)} 🏠 村を建設した（次の自分の番から拠点になります。村は長押しで壊せますが、資源・食料は戻りません）`; checkUnlocks(p, c); finishAct();
  }
  function pray() {   // 命の糧（🙏ボタン）: 食料1を消費して、そのターンの間だけ戦力+1（行動は使わない）（神秘の探究の解放条件にもなる）
    const p = turn, c = last[p]; if (bless[p] >= 1) return; if (!gm) sp[p] -= 1; bless[p] += 1;
    msg = `${name(p)} 🙏 命の糧を捧げた… このターンの戦力+${bless[p]} 残り行動 ${gm ? '∞' : actions}`;
    if (skills[p].lang && specialAround(c) >= 3) unlock(p, '静寂の儀式', 'faith');
    finishAct();
  }
  const reach = p => Math.max(0, ...[...cells.values()].filter(c => c.o === p).map(ring));   // 今いる半径
  const DAY_LEN = 4, PHASE_LEN = DAY_LEN / 4;   // 1日 = 4ラウンド（朝・昼・夕・夜が1ラウンドずつ）。PHASE_LEN を2にすると各時間帯が2ラウンドになる
  const phaseIdx = () => Math.floor((((round - 1) % DAY_LEN) + DAY_LEN) % DAY_LEN / PHASE_LEN);   // 0=朝 1=昼 2=夕 3=夜
  const phaseStep = () => ((((round - 1) % PHASE_LEN) + PHASE_LEN) % PHASE_LEN) + 1;   // その時間帯の何ラウンド目か（1〜2）
  const phase = () => ['朝','昼','夕','夜'][phaseIdx()];   // 朝・昼=昼間 / 夕・夜=夜間
  const isDay = () => phaseIdx() < 2;   // 朝・昼=昼間 / 夕・夜=夜間 を繰り返す
  const villageCount = p => [...cells.values()].filter(c => c.o === p && c.village).length;   // 村の数（建てたばかりを含む。最大数・建設の判定に使う）
  const isActiveVillage = c => !!c.village && !vNew[key(c.q, c.r)];   // 拠点として働く村（建てたばかりの村は、次の自分の番まで働かない）
  const activeVillages = p => [...cells.values()].filter(c => c.o === p && isActiveVillage(c)).length;
  const actionsFor = () => (isDay() ? 2 : (skills[turn].fire ? 2 : 1)) + activeVillages(turn);   // 村1つにつき+1   // 昼は2、夜は1（火の発見で夜も2）
  const baseForest = p => basesOf(p).some(b => nbrs(b).some(n => n.f0));   // 拠点の周囲1マス以内に、もともと森があったか
  const spCap = p => 3 + (skills[p].pottery ? pot[p] : 0);   // 食料の上限: 3（土器の作製の「作製」で資源2につき+1）
  const addSp = (p, n) => { sp[p] = Math.max(sp[p], Math.min(spCap(p), sp[p] + n)); };
  const plainVillages = p => [...cells.values()].filter(c => c.o === p && isActiveVillage(c) && !c.forest).length;   // 森以外の有効な村（食料収入が減り、毎ターン資源+1がもらえる。森の村はどちらもない）
  const income = p => Math.max(0, 2 - plainVillages(p) + (skills[p].settle ? 1 : 0) + (skills[p].farm && isDay() ? 1 : 0) + (skills[p].herd && !isDay() ? 1 : 0));   // 農耕で昼間+1、牧畜で夜間+1
  // 空きマスが自領に隣接しているか（盤面が埋まったかの判定用）
  const isFrontier = (c,p) => c.o === 0 && c.t !== 's' && !!started[p] && nbrs(c).some(n => n.o === p);
  const canStep = p => last[p] && nbrs(last[p]).some(n => n.t !== 's' && (n.o === 0 || n.o === p));
  // 移動先: 最初は★の隣。以降は直近のマスの隣（空きマス、または自分が染めたマス）。行き場が無い時だけ自領の隣の空きマスへ
  const isTarget = (c,p) => {
    if (c.t === 's') return false;
    if (c.o !== 0 && c.o !== p) return !!started[p] && !!last[p] && nbrs(c).includes(last[p]);   // 相手の現在地（白枠）も攻撃できる   // 相手の色のマス: 現在位置に隣接していれば戦闘を挑める
    if (c.o === p) return started[p] && c !== last[p] && (isReturn(c, p) || nbrs(c).includes(last[p]) || (roadRange(p) > 1 && hexDist(c, last[p]) <= roadRange(p) && onRoad(c,p)));   // 自領: 通常は隣のマスだけ。煮炊きの技術で、道でつながった半径2マス以内も移動できる
    if (!started[p]) return isFrontier(c,p);
    if (!canStep(p)) return isFrontier(c,p);
    return nbrs(c).includes(last[p]);
  };
  const isHarvest = (c,p) => c.res && !c.harv && c.o === p && !!last[p] && (c === last[p] || (!!skills[p].lang && hexDist(c, last[p]) <= 2 && onRoad(c,p)));   // 今いる（直近の）自領の資源マスを再タップで採取、1pt
  const isLegal = (c,p) => !over && actions > 0 && ((isTarget(c,p) && sp[p] >= moveCost(c,p)) || (isHarvest(c,p) && sp[p] >= 1));
  const anyTarget = p => [...cells.values()].some(c => isFrontier(c,p));
  const anyHarvest = p => [...cells.values()].some(c => isHarvest(c,p));
  function markHarvested(c) {   // 資源を回収: 復活までのラウンド数は、1回目2、2回目3、3回目4…とだんだん遅くなる
    const k = key(c.q, c.r), n = (resT[k] ? resT[k][0] : 0) + 1;
    c.harv = true; resT[k] = [n, round + n + 1];
  }
  function respawnTick() {   // 復活の時期が来た資源マスを元に戻す。村のあるマスに復活したら、村の持ち主が自動で回収する（回収した扱いなので、次の復活はさらに遅くなる）
    for (const k of Object.keys(resT)) {
      const e = resT[k], c = cells.get(k);
      if (!c || !c.res) { delete resT[k]; continue; }
      if (!c.harv || round < e[1]) continue;
      c.harv = false;
      if (c.village && isPlayer(c.o) && alive[c.o]) { rp[c.o] += 1; markHarvested(c); if (rp[c.o] >= 2) unlock(c.o, '打撃の共鳴', 'stone'); }
    }
  }
  const anyLegal = p => [...cells.values()].some(c => isLegal(c,p));
  const count = p => [...cells.values()].filter(c => c.o === p).length;
  const name = p => `${PNAME[p] || 'P' + p}（${PNAMES[p] || ''}）`;

  function finish(w, why) {
    over = true; winner = w;
    msg = w ? `🏆 ${name(w)}の勝利！（${why}）` : `引き分け（${why}）`;
  }
  function territoryEnd() {   // 領地が最も多いプレイヤーの勝ち（最多が複数なら引き分け）
    const live = PL().filter(q => alive[q]), n = Object.fromEntries(PL().map(q => [q, count(q)]));
    const mx = Math.max(...live.map(q => n[q])), top = live.filter(q => n[q] === mx);
    finish(top.length === 1 ? top[0] : 0, `領地 ${PL().map(q => alive[q] ? n[q] : '脱落').join(' 対 ')}`);
  }
  const allStuck = () => PL().filter(q => alive[q]).every(q => !anyTarget(q));   // 盤面が埋まった
  function eliminate(o) {   // 脱落: 残りの領地（現在地・村）は空きマスに戻る
    alive[o] = false;
    for (const c of cells.values()) if (c.o === o) { c.o = 0; c.village = false; delete vNew[key(c.q, c.r)]; }
    for (const k in traps) if (traps[k] === o) delete traps[k];   // 脱落した人の罠は消える
    last[o] = null; pending[o] = []; retPick[o] = null;
  }
  function resign(p) {   // 投了（オンライン対戦）: その人は脱落する（拠点選びの間はできない）。残りが1人になれば、その人の勝ち
    // ※ルールの処理は、サーバー（hexarea-server の index.js）にも同じものがある。変えるときは両方を同じに直すこと
    if (over || selecting || !isPlayer(p) || !alive[p]) return false;
    const wasTurn = p === turn;
    eliminate(p);
    msg = `🏳 ${name(p)}が投了した`;
    const rest = PL().filter(q => alive[q]);
    if (rest.length === 1) { finish(rest[0], `${name(p)}が投了`); return true; }
    if (wasTurn) { switchTurn(`🏳 ${name(p)}が投了した。`); advance(); }
    return true;
  }
  function switchTurn(note) {   // ※ルールの処理（init〜endTurn、unlock・checkUnlocks、learnSkill、クラフト、resign）は、サーバー（index.js）にも同じものがある。ルールを変えるときは両方を同じに直すこと
    if (retPick[turn]) retPick[turn] = null;   // 帰還する拠点を選ばずに番を終えたときは、仮に置かれた拠点のまま
    if (!selecting && !over && skills[turn].fire && phase() === '夜') unlock(turn, '火を囲む夜');   // 火の発見後に夜を終える
    scoutMode = null; scoutPrev = null; trapMode = false; villageMode = false;
    scoutV = per(() => []);   // 偵察で晴らした霧は、ターンが替わると元に戻る
    bless = per(0); boost = {stone:per(0), polish:per(0)}; lock = {stone:per(0), polish:per(0)}; fixed = {stone:per(0), polish:per(0), cook:per(0)};   // 命の糧・石器の使用の効果はターン終了で消える。作製ロック・修繕後の使用不可も解ける
    let t = turn, g = 0;   // 次の（脱落していない）プレイヤーへ。P1に戻ったらラウンドが進む
    do { t = t % NP + 1; if (t === 1) round++; } while (!alive[t] && g++ < NP);
    turn = t;
    for (const k of Object.keys(vNew)) { const x = cells.get(k); if (!x || !x.village || x.o === turn) delete vNew[k]; }   // 自分の番が来た: 前に建てた村が拠点として働き始める
    respawnTick();
    if (round > MAX_ROUNDS) { territoryEnd(); return; }
    actions = gm ? 1e9 : actionsFor(); addSp(turn, income(turn));
    const vn = plainVillages(turn); if (vn > 0) { rp[turn] += vn; if (rp[turn] >= 2) unlock(turn, '打撃の共鳴', 'stone'); }   // 村1つにつき毎ターン資源+1
    msg = (note ? note + ' ' : '') + `R${round}/${MAX_ROUNDS}（${phase()}） ${name(turn)}のターン` + (retPick[turn] ? ' ／ 戻る拠点を選んでください' : '');
  }
  function advance() {
    let guard = 0, note = '';
    while (!over && (actions === 0 || !anyLegal(turn)) && guard++ < 4 * NP + 4) {
      if (allStuck()) { territoryEnd(); return; }
      if (actions > 0 && (anyTarget(turn) || anyHarvest(turn))) note = '';
      else if (actions > 0) note = `${name(turn)}は動けないためパス。`;
      switchTurn(note);
    }
  }

  function pickBase(c) {   // 拠点選び: 2人は先手→後手、3人以上は逆順。選んだ拠点は決定後お互いに見えない
    if (busy || over || !isBase(c) || c.o !== 0) return;
    c.o = turn; started[turn] = true; last[turn] = c; baseCell[turn] = c;
    if (turn !== lastPicker()) { turn = nextPicker(turn); msg = `R1/${MAX_ROUNDS}（朝） ${name(turn)}は拠点を選んでください`; }
    else { selecting = false; turn = 1; round = 1; actions = gm ? 1e9 : actionsFor(); msg = `R1/${MAX_ROUNDS}（朝） ${name(1)}のターン`; }
    render();
  }
  function act(c) {
    if (!selecting && !over && retPick[turn]) {   // 強制帰還で同じ距離の拠点が複数ある: 戻る拠点を選ぶ（光っている拠点をタップ）
      if (busy) return;
      if (retPick[turn].includes(key(c.q, c.r))) { last[turn] = c; retPick[turn] = null; msg = `${name(turn)}は拠点に戻った。 残り行動 ${gm ? '∞' : actions}`; }
      else msg = '戻る拠点を選んでください（光っている拠点をタップ）';
      render(); return;
    }
    if (selecting) {   // 拠点選び: 確認ダイアログで決定
      if (busy || over || !isBase(c) || c.o !== 0) return;
      ask(`${name(turn)}の拠点をここに決定しますか？`, '決定', () => pickBase(c));
      return;
    }
    if (!busy && !over && actions > 0 && isTarget(c, turn) && !isHarvest(c, turn) && sp[turn] < moveCost(c, turn)) { msg = `食料が足りません（このマスには食料${moveCost(c, turn)}が必要です）`; render(); return; }
    if (busy || !isLegal(c, turn)) return;
    if (isBattle(c, turn)) {   // 相手の色のマス・森のマス: 確認のうえ戦闘
      const wild = c.forest && c.o === 0;
      ask(wild ? `獣（戦力 ${forestSize(c)}）の縄張りです。<br>戦闘しますか？（自分の戦力 ${battlePower(turn, true, c)} ／ 食料${cost(c, turn)}消費）` : `${name(c.o)}と戦闘しますか？<br>（自分の戦力 ${battlePower(turn, false, c)} ／ 相手の戦力 ${battlePower(c.o, false, c)} ／ 食料${cost(c, turn)}消費）` + (isPlayer(c.o) && isMyBase(c, c.o) ? (basesOf(c.o).length === 1 ? '<br>🏴 ここは相手の最後の拠点です。奪うと相手は脱落します' : '<br>🏴 ここは相手の拠点です。拠点をすべて奪うと相手は脱落します') : ''), '戦闘', () => battle(c));
      return;
    }
    if (isHarvest(c, turn) && !pickMode && c !== last[turn] && isTarget(c, turn) && sp[turn] >= 1 && sp[turn] >= moveCost(c, turn)) {   // 回収と移動の両方できるマス（言語の獲得）: 選べる
      ask(`このマスは、回収と移動を選べます。<br>（回収: 行動1・食料1で資源+1 ／ 移動: 行動1・食料${moveCost(c, turn)}）`, '回収', () => { pickMode = 'harvest'; act(c); pickMode = null; }, '移動', () => { pickMode = 'move'; act(c); pickMode = null; });
      return;
    }
    if (isHarvest(c, turn) && pickMode !== 'move') {                          // 自領の資源マスを再タップ → 資源獲得
      if (!gm) sp[turn] -= 1; const gain = 1; markHarvested(c); rp[turn] += gain; actions--;
      msg = `${name(turn)} 💎資源+${gain} 残り行動 ${gm ? '∞' : actions}`;
      if (nbrs(c).some(n => n.t === 'm')) unlock(turn, '山火事の痕跡', 'fire'); if (rp[turn] >= 2) unlock(turn, '打撃の共鳴', 'stone');   // 山に隣接する資源を初めて回収
    } else {
      if (!gm) sp[turn] -= moveCost(c,turn); if (c.o === 0) c.o = turn; started[turn] = true; last[turn] = c; actions--;
      msg = `${name(turn)} 残り行動 ${gm ? '∞' : actions}`;
      meetCheck(turn, c);   // 他のプレイヤーと領地が隣り合った
      if (count(turn) >= 10) unlock(turn, '部族社会の発展'); checkUnlocks(turn, c);
      springTrap(turn, c);   // 相手の罠のマスに入った
    }
    finishAct();
  }
  const effPower = p => (gm && p === turn) ? 999 : Math.max(0, pw[p] + bless[p] - ((isDay() || skills[p].fire) ? 0 : 1));   // 戦力: 夜間-1（火の発見で打ち消し）
  const isMyBase = (c, p) => c.o === p && (c === baseCell[p] || isActiveVillage(c));   // 拠点または村（村は拠点扱い。建てたばかりの村は、次の自分の番から）
  const basesOf = p => [...cells.values()].filter(c => isMyBase(c, p));
  const baseDist = (p, c) => Math.min(99, ...basesOf(p).map(b => hexDist(c, b)));
  const baseNear = (p, c) => { if (!c) return 0; const d = baseDist(p, c); return d === 0 ? 2 : d === 1 ? 1 : 0; };   // 自分の拠点のマスで+2、周囲1マスで+1
  const battlePower = (p, wild, c) => effPower(p) + ((gm && p === turn) ? 0 : baseNear(p, c) + (wild ? boost.stone[p] : boost.polish[p]) + ((skills[p].faith && c && baseDist(p, c) <= 1) ? 1 : 0));   // 神秘の探究: 拠点の周囲1マスでの戦闘で+1   // 打製石器の加工: 獣との戦闘のみ+1 ／ 磨製石器の加工: 対人戦のみ+1
  function forestSize(c) {   // 獣の戦力 = つながった「だれの領地でもない」森のマス数（領地になった森には獣はいない）
    const seen = new Set([key(c.q,c.r)]), st = [c];
    while (st.length) { const x = st.pop(); for (const n of nbrs(x)) if (n.forest && n.o === 0 && !seen.has(key(n.q,n.r))) { seen.add(key(n.q,n.r)); st.push(n); } }
    return seen.size;
  }
  const isBattle = (c, p) => (c.forest && c.o === 0) || isEnemy(c.o, p);
  function meetCheck(p, c) {   // 「未知の存在との出会い」: 隣り合ったプレイヤー全員に解放
    const adj = [...new Set(nbrs(c).map(n => n.o).filter(o => isEnemy(o, p)))];
    if (adj.length) { unlock(p, '未知の存在との出会い'); for (const o of adj) unlock(o, '未知の存在との出会い'); }
  }
  function forceReturn(o, from) {   // 現在地を奪われた人を、奪われたマスから一番近い自分の拠点へ強制帰還させる（行動は消費しない）。同じ距離の拠点が複数あるときは、本人が次の番に選ぶ（AIは自動で選ぶ）
    retPick[o] = null; const bs = basesOf(o); if (!bs.length) return [];
    const d = Math.min(...bs.map(b => hexDist(b, from))), cand = bs.filter(b => hexDist(b, from) === d);
    last[o] = cand[0];   // 選ぶまでは仮にここに置く
    if (cand.length > 1) {
      if (isCPU(o)) { const near = b => [...cells.values()].filter(x => x.o === o && hexDist(x, b) <= 2).length; last[o] = cand.reduce((a, b) => near(b) > near(a) ? b : a); }   // AI: 自分の領地が多く集まっている拠点
      else retPick[o] = cand.map(b => key(b.q, b.r));
    }
    return cand;
  }
  function battle(c) {   // 戦闘に挑む（確認済み）。勝利でマスを奪う／同数は通行のみ／敗北は何も起きない。行動は必ず1回使う
    const p = turn, o = c.o, wild = c.forest && c.o === 0, wasBase = !wild && isPlayer(o) && isMyBase(c, o), wasLoc = !wild && isPlayer(o) && last[o] === c;   // wasBase: 奪うマスは相手の拠点 ／ wasLoc: 相手の現在地への攻撃
    tieStay = false;
    if (!gm) sp[p] -= cost(c, p);   // 戦闘の食料（そのマスへ移動するのと同じ）
    const me = battlePower(p, wild, c), foe = wild ? forestSize(c) : battlePower(o, false, c);
    const title = wild ? '縄張りの主張' : '戦闘';
    let sub;
    if (me > foe) {
      c.o = p; c.village = false; delete vNew[key(c.q, c.r)]; started[p] = true; last[p] = c;   // 森は獣に勝っても森のまま（自分の領地の森になる）
      if (wild) { skills[p].beastWon = true; addSp(p, 1); sub = `勝利！（戦力 ${me} 対 ${foe}）食料を1奪った`; }
      else if (rp[o] > 0) { rp[o]--; rp[p]++; sub = `勝利！（戦力 ${me} 対 ${foe}）資源を1奪った`; }
      else sub = `勝利！（戦力 ${me} 対 ${foe}）マスを奪った`;
    } else if (me === foe) {
      if (wasLoc) { tieStay = true; sub = `引き分け（戦力 ${me} 対 ${foe}）相手がいるマスなので、通行できない`; }   // 相手と同じマスには入れない
      else { last[p] = c; sub = `引き分け（戦力 ${me} 対 ${foe}）このマスを通行できる`; }
    } else sub = `敗北…（戦力 ${me} 対 ${foe}）何も起こらなかった`;
    actions--;
    msg = `${name(p)} ${title}：${sub}`;
    if (last[p] === c) springTrap(p, c);   // 勝ち・引き分けでそのマスに入ったとき、相手の罠があれば発動
    if (me > foe) {
      meetCheck(p, c);
      if (count(p) >= 10) unlock(p, '部族社会の発展'); checkUnlocks(p, c); if (wild && foe >= 2) unlock(p, '獣の馴化', 'herd');   // 2マス以上の森の獣に勝ったときだけ解放
    }
    if (!isCPU(p)) popupQ.push({t: title, s: sub});
    else if (!wild && !isCPU(o)) {   // AIに攻められた人へ、守った側から見た結果を知らせる
      const ds = me > foe ? `マスを奪われた…（戦力 ${me} 対 ${foe}）` + (sub.includes('資源') ? ' 資源を1奪われた' : '') : me === foe ? `引き分け（戦力 ${me} 対 ${foe}）` + (wasLoc ? '相手は通行できなかった' : '相手はこのマスを通行した') : `撃退した！（戦力 ${me} 対 ${foe}）`;
      (o === viewP() && humansAlive() < 2 ? popupQ : pending[o]).push({t: `⚔ ${name(p)}の攻撃`, s: ds});
    }
    const baseTaken = me > foe && wasBase, baseHit = baseTaken && basesOf(o).length === 0;   // 拠点潰し: 相手の拠点（最初の拠点・村）をすべて奪った
    if (baseTaken && !baseHit) { popupQ.push({t: '拠点を奪った', s: `${name(o)}の拠点を奪った！（相手の拠点は、あと${basesOf(o).length}か所）`}); msg += ' ／ 🏴拠点を奪った！'; }
    if (baseHit) {   // 相手の拠点をすべて奪った → 脱落
      popupQ.push({t: '拠点潰し', s: `${name(o)}の拠点をすべて奪った！`}); msg += ' ／ 🏴拠点をすべて奪った！';
      eliminate(o);
      const rest = PL().filter(q => alive[q]);
      if (rest.length === 1) { showPopup(); finish(p, `${NP === 2 ? '相手' : name(o)}の拠点をすべて奪った（拠点潰し）`); render(); return; }
      popupQ.push({t: '脱落', s: `${name(o)}は拠点をすべて失い、脱落した`}); msg += ` ／ ${name(o)}が脱落！`;
    }
    if (me > foe && !wild && alive[o]) {   // 強制帰還: 現在地を奪われた人は、一番近い拠点へ戻される
      if (retPick[o] && !wasLoc) {   // 帰還先の候補にしていた別の拠点を奪われた: 候補を減らす
        retPick[o] = retPick[o].filter(k => { const x = cells.get(k); return x && isMyBase(x, o); });
        if (retPick[o].length === 1) { last[o] = cells.get(retPick[o][0]); retPick[o] = null; } else if (!retPick[o].length) retPick[o] = null;
      }
      if (wasLoc) {
        const cand = forceReturn(o, c), to = cand.length === 1 ? '一番近い拠点' : `同じ距離の拠点（${cand.length}か所）`;
        msg += ` ／ ${name(o)}は拠点へ強制帰還`;
        if (!isCPU(o)) (isCPU(p) && o === viewP() && humansAlive() < 2 ? popupQ : pending[o]).push({t: '🏠 強制帰還', s: cand.length === 1 ? `現在地を奪われ、${to}へ戻された。` : retPick[o] ? `現在地を奪われた。${to}があるので、次の自分の番に、戻る拠点を選んでください。` : `現在地を奪われ、${to}のひとつへ戻された。`});
      }
    }
    showPopup();
    finishAct();
  }

  // ===== 🔭 偵察: 行動1・食料1で、離れた7マスの塊、または一直線のマスの霧を晴らす =====
  const SCOUT_MIN = 2, SCOUT_RANGE = 3, SCOUT_LINE = 6, SCOUT_ACT = 1, SCOUT_FOOD = 1;   // 地形の熟知: 中心は現在地から2〜3マス ／ 山頂の物見: 6マス
  const onOwnMountain = p => !!last[p] && last[p].o === p && last[p].t === 'm';   // 山頂の物見は、自分の領地の山マスにいるときだけ
  const scoutModeOk = (p, mode) => mode === 'hex' ? !!skills[p].survey : mode === 'line' ? !!skills[p].summit && onOwnMountain(p) : false;
  const scoutSet = p => { const s = new Set(); for (const e of ((scoutV && scoutV[p]) || [])) if (e.u >= round) for (const k of e.c) s.add(k); return s; };   // いま見えている偵察のマス
  const canScout = p => !!last[p] && started[p] && (!!skills[p].survey || !!skills[p].summit) && (gm || (actions >= SCOUT_ACT && sp[p] >= SCOUT_FOOD));   // 偵察はスキルを習得してから
  function scoutCells(mode, c, p = turn) {   // 偵察で晴れるマスのキー
    const o = last[p]; if (!o || !c || !scoutModeOk(p, mode)) return [];
    if (mode === 'hex') return hexDist(c, o) >= SCOUT_MIN && hexDist(c, o) <= SCOUT_RANGE ? [c, ...nbrs(c)].map(n => key(n.q, n.r)) : [];
    if (c === o) return [];
    const a = toPixel(o.q, o.r), b = toPixel(c.q, c.r), ang = Math.atan2(b.y - a.y, b.x - a.x);   // タップした方向に、いちばん近い6方向のひとつを選ぶ
    let best = 0, bd = -Infinity;
    DIRS.forEach(([dq, dr], i) => { const v = toPixel(o.q + dq, o.r + dr), d = Math.cos(Math.atan2(v.y - a.y, v.x - a.x) - ang); if (d > bd) { bd = d; best = i; } });
    const [dq, dr] = DIRS[best], out = [];
    for (let i = 1; i <= SCOUT_LINE; i++) { const k = key(o.q + dq * i, o.r + dr * i); if (cells.has(k)) out.push(k); }
    return out;
  }
  function scout(keys) {   // 偵察の実行（確認済み）。晴らすマスのキーを受け取る
    const p = turn; if (busy || over || selecting || !canScout(p) || !keys || !keys.length) return;
    if (!gm) { actions -= SCOUT_ACT; sp[p] -= SCOUT_FOOD; }
    scoutV[p] = [...(scoutV[p] || []), {c: keys.filter(k => cells.has(k)), u: round}];   // そのターンの間だけ見える（ターン交代で消える）
    scoutMode = null; scoutPrev = null;
    const foes = keys.filter(k => traps[k] && traps[k] !== p).length;
    msg = `${name(p)} 🔭 偵察した（${keys.length}マス${foes ? `・相手の罠を${foes}つ発見！` : ''}） 残り行動 ${gm ? '∞' : actions}`;
    finishAct();
  }
  // ===== 🪤 罠: 「罠の工夫」を習得すると、クラフト（⛏）から仕掛けられる =====
  const TRAP_RES = 1, TRAP_ACT = 1, TRAP_MAX = 3, TRAP_FOOD_DMG = 2;   // 仕掛ける: 資源1・行動1。1人3つまで ／ かかると食料-2・そのターンの行動終了
  const trapCount = p => Object.values(traps).filter(o => o === p).length;
  const canAffordTrap = p => !!skills[p] && !!skills[p].trap && trapCount(p) < TRAP_MAX && (gm || (rp[p] >= TRAP_RES && actions >= TRAP_ACT));
  const canTrapAt = (c, p) => !!c && !!last[p] && c.t !== 's' && !traps[key(c.q, c.r)] && !PL().some(q => last[q] === c) && !(c.forest && c.o === 0)
    && (c.o === p || (c.o === 0 && hexDist(c, last[p]) === 1));   // 自分の領地、または現在地の隣の空きマス（森・水域・だれかの現在地は不可）
  function setTrap(c) {   // 罠を仕掛ける（確認済み）
    const p = turn; if (busy || over || selecting || !canAffordTrap(p) || !canTrapAt(c, p)) return;
    if (!gm) { rp[p] -= TRAP_RES; actions -= TRAP_ACT; }
    traps[key(c.q, c.r)] = p; trapMode = false;
    msg = `${name(p)} 🪤 罠を仕掛けた（${trapCount(p)}/${TRAP_MAX}） 残り行動 ${gm ? '∞' : actions}`;
    finishAct();
  }
  function springTrap(p, c) {   // 相手の罠のマスに入った: 食料-2、このターンの行動はここで終わり。罠はなくなる
    const k = key(c.q, c.r), o = traps[k]; if (!o || o === p || !isPlayer(o)) return false;
    delete traps[k];
    if (!gm) { sp[p] = Math.max(0, sp[p] - TRAP_FOOD_DMG); actions = 0; }
    msg = msg.replace(/ 残り行動 \S+/, '') + ` ／ 🪤 ${name(o)}の罠にかかった！（食料-${TRAP_FOOD_DMG}・行動終了）`;
    if (!isCPU(p)) popupQ.push({t: '🪤 罠にかかった！', s: `${name(o)}の罠が作動した。食料-${TRAP_FOOD_DMG}、このターンの行動はここまで`});
    if (!isCPU(o) && alive[o]) pending[o].push({t: '🪤 罠が作動した', s: `${name(p)}があなたの罠にかかった（食料-${TRAP_FOOD_DMG}・足止め）`});
    try { SFX.play('trap'); } catch (e) {}
    return true;
  }
  // 場所を選んでいる間（偵察・罠）の、選べるマスとタップの処理
  function modeCells() {
    const p = turn, o = last[p]; if (!o) return [];
    if (trapMode) return [...cells.values()].filter(c => canTrapAt(c, p));
    if (villageMode) return [...cells.values()].filter(c => villageCand(c, p) && villageSpotOk(c, p));
    if (scoutMode === 'hex') return [...cells.values()].filter(c => hexDist(c, o) >= SCOUT_MIN && hexDist(c, o) <= SCOUT_RANGE);
    if (scoutMode === 'line') { const out = []; for (const [dq, dr] of DIRS) for (let i = 1; i <= SCOUT_LINE; i++) { const c = cells.get(key(o.q + dq * i, o.r + dr * i)); if (c) out.push(c); } return out; }
    return [];
  }
  function modePick(c) {   // 盤面のタップ（偵察・罠・村の場所選び中）
    if (busy || over || selecting || !myTurn()) return;
    if (villageMode) {
      if (!canBuildVillage(turn)) { villageMode = false; msg = villageWhy(turn); render(); return; }
      if (!villageCand(c, turn)) { msg = '🏠 そこには建てられません（自分の領地の、現在地か隣のマスを選んでください。光っているマスが候補です。やめるときは⛏）'; render(); return; }
      if (!villageSpotOk(c, turn)) { msg = '🏠 ' + villageSpotWhy(c, turn); render(); return; }
      ask(`このマスに村を建設しますか？<br>（資源${VILLAGE_RES}・食料${VILLAGE_FOOD}。最大${VILLAGE_MAX}つ。村は、次の自分の番から拠点になります）` + (c.forest ? '<br>🌲 森の村です。食料収入は減りませんが、毎ターンの資源+1はありません（森の村は1つまで）' : '') + '<br>※建てた村は長押しで壊せます（行動1を使い、資源・食料は戻りません）', '建設', () => buildVillage(c));
      return;
    }
    if (trapMode) {
      if (!canTrapAt(c, turn)) { msg = '🪤 そこには仕掛けられません（自分の領地か、現在地の隣の空きマスを選んでください。やめるときは⛏）'; render(); return; }
      ask(`このマスに罠を仕掛けますか？<br>（資源${TRAP_RES}・行動${TRAP_ACT}。相手が入ると、食料-${TRAP_FOOD_DMG}とそのターンの行動終了）`, '仕掛ける', () => setTrap(c));
      return;
    }
    const keys = scoutCells(scoutMode, c);
    if (!keys.length) { msg = !scoutModeOk(turn, scoutMode) ? '🔭 この偵察は、いまは使えません' : scoutMode === 'hex' ? `🔭 現在地から${SCOUT_MIN}〜${SCOUT_RANGE}マス離れたマスを選んでください（やめるときは🔭）` : '🔭 現在地以外のマスをタップして、方向を選んでください（やめるときは🔭）'; render(); return; }
    scoutPrev = keys; draw();
    ask(scoutMode === 'hex' ? `光っている7マスを偵察しますか？（地形の熟知）<br>（行動${SCOUT_ACT}・食料${SCOUT_FOOD}。見えるのはこのターンの間だけです）` : `この方向の${keys.length}マスを偵察しますか？（山頂の物見）<br>（行動${SCOUT_ACT}・食料${SCOUT_FOOD}。見えるのはこのターンの間だけです）`, '偵察', () => scout(keys));
  }
  const SET_DEFAULT = {mount:10, water:10, res:20, forest:10};   // 出現率(%)の初期値。変更できるのはDevモードのみ（ラウンド数の初期値は ROUNDS_BY_NP）
  let SET = {mount: SET_DEFAULT.mount, water: SET_DEFAULT.water, res: SET_DEFAULT.res, forest: SET_DEFAULT.forest};   // 出現率(%)。設定画面から、ゲーム開始前のみ変更できる
  const canEdit = () => !ONLINE && selecting && PL().every(q => !started[q]) && !over;   // 最初のプレイヤーが拠点を選ぶ前だけ
  let confirmFn = null, confirmAlt = null, skipVillage = false, pickMode = null;   // 確認ダイアログで「はい」を押したときに実行する処理
  function endTurn() {
    if (over || busy || selecting) return;
    switchTurn(''); advance(); render();
  }
  const toPixel = (q,r) => ({x: cx + size*Math.sqrt(3)*(q + r/2), y: cy + size*1.5*r});
  function unlock(p, title, kind = 'lang') {
    const st = kind === 'fire' ? fireOpen : kind === 'stone' ? stoneOpen : kind === 'lang' ? langOpen : xOpen[kind];
    if (st[p]) return;
    st[p] = true;
    if (isCPU(p)) return;   // AIには、お知らせを出さない
    (p === turn ? popupQ : pending[p]).push({t: title, s: `「${(SKILLS.find(k => k.id === kind) || {name: '言語の獲得'}).name}」を解放`});
    showPopup();
  }
  function checkUnlocks(p, c) {   // 新石器スキルの解放条件
    if (skills[p].polish && [...cells.values()].some(x => x.o === p && x.t === 'p' && nbrs(x).some(n => n.t === 's'))) unlock(p, '大地の開墾', 'farm');   // 磨製石器の加工後、水域に面した平地を領地にする
    if (c && c.t === 'm' && skills[p].stone) unlock(p, '研磨の技術', 'polish');   // 打製石器の後に山を占領
    if (skills[p].farm && skills[p].herd && villageCount(p) >= 1) unlock(p, '集落の礎', 'settle');   // 農耕・牧畜を習得し、村を建設
    if (skills[p].pottery) unlock(p, '炎が生む滋養', 'cook');   // 土器の作製を習得
    if (skills[p].stone && skills[p].beastWon) unlock(p, '狩りの知恵', 'trap');   // 打製石器の加工を習得し、獣に勝つ
    if (skills[p].lang) unlock(p, '土地の名づけ', 'survey');   // 言語の獲得を習得 → 地形の熟知（偵察: 7マスの塊）
    if ([...cells.values()].some(x => x.o === p && x.t === 'm')) unlock(p, '高みからの眺め', 'summit');   // 山を領地にする → 山頂の物見（偵察: 一直線）
    if (skills[p].fire && [...cells.values()].some(x => x.o === p && x.t === 'm')) unlock(p, '形を成す粘土', 'pottery');   // 火の発見を習得し、山を領地にする
  }
  const isOpen = (k, p) => !k.lock || (k.lock === 'fire' ? fireOpen[p] : k.lock === 'stone' ? stoneOpen[p] : k.lock === 'lang' ? langOpen[p] : xOpen[k.lock][p]);
  const SKILLS = [{id:'fire', name:'火の発見', cost:1, spCost:1, lock:'fire', desc:'夜間（夕・夜）の行動+1。夜間の視界の低下と戦力-1がなくなる。'},
    {id:'lang', name:'言語の獲得', cost:0, spCost:1, lock:'lang', desc:'道でつながった半径2マス以内の、未回収の資源マスをタップして、1回の行動と食料1で回収できる（通常は今いるマスだけ）。移動できるマスは、タップで回収か移動かを選べる。'},
    {id:'stone', name:'打製石器の加工', cost:1, spCost:1, lock:'stone', desc:'習得すると打製石器が手に入る。クラフト（⛏）で「使用」するたびに、そのターンの獣との戦闘の戦力+1。使うとゲージが半分減り、2回使うと壊れる。'},
    {id:'survey', name:'地形の熟知', cost:1, spCost:1, lock:'survey', desc:'🔭偵察で、現在地から2〜3マス離れたマスを中心に、7マスの塊の霧を晴らせる（使うたびに行動1・食料1。見えるのはそのターンの間だけ）。'},
    {id:'summit', name:'山頂の物見', cost:1, spCost:1, lock:'summit', desc:'自分の領地の山マスにいるとき、🔭偵察で、選んだ方向へまっすぐ6マスの霧を晴らせる（使うたびに行動1・食料1。見えるのはそのターンの間だけ）。'},
    {id:'trap', name:'罠の工夫', cost:1, spCost:1, lock:'trap', desc:'クラフト（⛏）から罠を仕掛けられる（資源1・行動1、1人3つまで）。自分の領地か、現在地の隣の空きマスに置け、相手が入ると食料-2・そのターンの行動終了。罠は仕掛けた人にしか見えない。'},
    {id:'farm', name:'農耕の確立', cost:2, spCost:1, foodCost:1, lock:'farm', desc:'昼間（朝・昼）の食料+1。'},
    {id:'herd', name:'牧畜の開始', cost:1, spCost:1, foodCost:1, lock:'herd', desc:'夜間（夕・夜）の食料+1。山を開放する行動が2→1になる。'},
    {id:'polish', name:'磨製石器の加工', cost:2, spCost:1, lock:'polish', desc:'習得すると磨製石器が手に入る。クラフト（⛏）で「使用」するたびに、そのターンの対人戦（相手のマスへの戦闘）の戦力+1。使うとゲージが半分減り、2回使うと壊れる。'},
    {id:'pottery', name:'土器の作製', cost:2, spCost:1, lock:'pottery', desc:'習得後、クラフト（⛏）の「作製」で、資源ポイント2を使うごとに食料の貯蔵上限が+1される（基本は3、最大3個作製で上限6）。'},
    {id:'cook', name:'煮炊きの技術', cost:2, spCost:1, foodCost:1, lock:'cook', desc:'習得後、クラフト（⛏）の「煮炊き」で、食料1を使って行動+1できる（1ターンに1回まで）。'},
    {id:'settle', name:'定住の暮らし', cost:2, spCost:1, lock:'settle', desc:'毎ターンの食料収入が+1される。'},
    {id:'faith', name:'神秘の探究', cost:3, spCost:1, lock:'faith', desc:'視界が向上する。拠点の周囲1マスでの戦闘で戦力+1。'}];
  function learnSkill(id) {   // スキルの習得（手番のプレイヤー）。AIもこれを使う
    const k = SKILLS.find(x => x.id === id);
    if (!k || over || busy || selecting || !isOpen(k, turn) || skills[turn][id] || (!gm && (rp[turn] < k.cost || actions < k.spCost || sp[turn] < (k.foodCost || 0)))) return false;
    if (!gm) { rp[turn] -= k.cost; actions -= k.spCost; sp[turn] -= (k.foodCost || 0); } skills[turn][id] = true;
    if (id === 'stone' || id === 'polish') tool[id][turn] = 2;   // 習得したら、満タンの石器がすぐ使える
    if (id === 'fire' && !isDay()) actions += 1;   // 夜に習得したら、このターンから+1アクション
    msg = `${name(turn)} が「${k.name}」を習得！`; checkUnlocks(turn, last[turn]);
    render(); renderTree();
    if (!gm && actions <= 0) { finishAct(); }   // 行動を使い切ったらターン終了の確認へ
    return true;
  }
  const TOOLS = [{id:'stone', name:'打製石器', target:'獣との戦闘', cost:1, act:1}, {id:'polish', name:'磨製石器', target:'対人戦', cost:2, act:1}];   // 作製コスト = 習得コスト
  // ===== ここまで index.html のルールの写し =====

  /* ---------------------------------------------------------
     エンジンの追加部分（ここから下は index.html にはない。サーバーだけの処理）
     --------------------------------------------------------- */
  // ---- 対戦結果の記録（index.html の RESULT が、関数を包んで記録しているのと同じ内容）----
  let stats = {}, hist = [], why = '', outSeq = 0, notes = {}, noteSeq = 0, gid = 0;
  const newStats = () => ({win: 0, draw: 0, lose: 0, beast: 0, harv: 0, built: 0, out: 0, outSeq: 0});
  function snap(r) {
    const e = {r, n: Object.fromEntries(PL().map(p => [p, count(p)]))};
    if (hist.length && hist[hist.length - 1].r === r) hist[hist.length - 1] = e; else hist.push(e);
  }
  const wrapE = (f, g) => function (...a) { return g(f, a); };
  // 効果音（index.html の SFX の包み方と同じ判定）→ 結果の記録（RESULT と同じ）の順に包む
  let depth = 0;
  act = wrapE(act, (o, a) => { const p = turn, rp0 = rp[p], last0 = last[p]; depth++; try { o(...a); } finally { depth--; } if (depth === 0) { if (rp[p] > rp0) SFX.play('harvest'); else if (last[p] !== last0) SFX.play('step'); } });
  battle = wrapE(battle, (o, a) => { const c = a[0], p = turn, o0 = c.o; o(...a); if (!over) SFX.play(c.o === p && o0 !== p ? 'win' : (last[p] === c || tieStay) ? 'draw' : 'lose'); });
  buildVillage = wrapE(buildVillage, (o, a) => { const had = a[0].village; o(...a); if (!had && a[0].village) SFX.play('build'); });
  demolishVillage = wrapE(demolishVillage, (o, a) => { const had = a[0].village; o(...a); if (had && !a[0].village) SFX.play('demolish'); });
  scout = wrapE(scout, (o, a) => { const p = turn, n = (scoutV[p] || []).length; o(...a); if ((scoutV[p] || []).length > n) SFX.play('scout'); });
  setTrap = wrapE(setTrap, (o, a) => { const n = Object.keys(traps).length; o(...a); if (Object.keys(traps).length > n) SFX.play('craft'); });
  pray = wrapE(pray, (o, a) => { const b = bless[turn]; o(...a); if (bless[turn] > b) SFX.play('pray'); });
  pickBase = wrapE(pickBase, (o, a) => { const o0 = a[0].o; o(...a); if (o0 === 0 && a[0].o !== 0) SFX.play('base'); });
  unlock = wrapE(unlock, (o, a) => { const st = () => JSON.stringify([langOpen, fireOpen, stoneOpen, xOpen]), b = st(); o(...a); if (a[0] === turn && b !== st()) SFX.play('unlock'); });
  init = wrapE(init, (o, a) => { stats = per(newStats); hist = []; why = ''; outSeq = 0; return o(...a); });
  pickBase = wrapE(pickBase, (o, a) => { const s0 = selecting, r = o(...a); if (s0 && !selecting) snap(0); return r; });
  act = wrapE(act, (o, a) => { const c = a[0], p = turn, h0 = c && c.harv, r = o(...a); if (c && !h0 && c.harv && stats[p]) stats[p].harv++; return r; });
  battle = wrapE(battle, (o, a) => {
    const c = a[0], p = turn, o0 = c.o, wild = c.forest && c.o === 0, r = o(...a), s = stats[p];
    if (s) { if (c.o === p && o0 !== p) { s.win++; if (wild) s.beast++; } else if (last[p] === c || tieStay) s.draw++; else s.lose++; }
    return r;
  });
  buildVillage = wrapE(buildVillage, (o, a) => { const had = a[0].village, r = o(...a); if (!had && a[0].village && stats[turn]) stats[turn].built++; return r; });
  eliminate = wrapE(eliminate, (o, a) => { const q = a[0]; if (stats[q]) { stats[q].out = round; stats[q].outSeq = ++outSeq; } return o(...a); });
  switchTurn = wrapE(switchTurn, (o, a) => { const r0 = round, sel = selecting, r = o(...a); if (!sel && round > r0) snap(r0); return r; });
  finish = wrapE(finish, (o, a) => { why = a[1] || ''; const r = o(...a); snap(Math.min(round, MAX_ROUNDS)); return r; });

  // ---- クラフト画面のボタン（index.html の toolBody のクリック処理と同じ内容）----
  function toolOp(kind, id) {
    if (over || busy || selecting) return;
    const p = turn, T = TOOLS.find(x => x.id === id);
  if (kind === 'cook') {   // 煮炊き: 食料1 → 行動+1
    if (!skills[p].cook || fixed.cook[p] || (!gm && sp[p] < 1)) return;
    if (!gm) sp[p] -= 1; fixed.cook[p] = 1; actions += 1; msg = `${name(p)} が煮炊きをした！食料-1・行動+1（残り行動 ${actions}）`;
  } else if (kind === 'pot') {
    if (!skills[p].pottery || pot[p] >= 3 || (!gm && rp[p] < 2)) return;
    if (!gm) rp[p] -= 2; pot[p] += 1; msg = `${name(p)} が土器を作製！食料の貯蔵上限 ${spCap(p)}`;
  } else if (!T || !skills[p][id]) return;
  else if (kind === 'use') {   // 使用: ゲージが半分減る。2回目で壊れる。戦力は使用した分だけ上がる
    if (fixed[id][p] || (!gm && tool[id][p] < 1)) return;   // 修繕したターンは使用できない
    if (!gm) tool[id][p]--; boost[id][p]++;
    msg = `${name(p)} が${T.name}を使用！このターンの${T.target}の戦力+${boost[id][p]}`;
    if (!gm && tool[id][p] === 0) { lock[id][p] = 1; msg += `（${T.name}は壊れた。次のターンまで作製できない）`; }
  } else if (kind === 'repair') {   // 修繕: 1回だけ使った石器を、資源1で使用1回分直す
    if (gm || tool[id][p] !== 1 || rp[p] < 1) return;
    rp[p] -= 1; tool[id][p] = 2; fixed[id][p] = 1; msg = `${name(p)} が${T.name}を修繕した（このターンは使用できない）`;
  } else if (kind === 'craft') {   // 作製: 壊れた石器を、習得と同じ資源・行動で作り直す
    if (gm || tool[id][p] !== 0 || lock[id][p] || rp[p] < T.cost || actions < T.act) return;
    rp[p] -= T.cost; actions -= T.act; tool[id][p] = 2; fixed[id][p] = 1; msg = `${name(p)} が${T.name}を作製！（このターンは使用できない） 残り行動 ${actions}`;
    render(); renderTools();
    if (actions <= 0) { finishAct(); }
    return;
  } else return;
  }

  // ---- 盤面の保存（ストレージ）と、端末に送る形 ----
  const K = c => c ? key(c.q, c.r) : null;
  const flagsOf = c => ((c.forest ? 1 : 0) | (c.f0 ? 2 : 0) | (c.res ? 4 : 0) | (c.harv ? 8 : 0) | (c.village ? 16 : 0)).toString(36);
  function encodeCells(mask) {   // 1マス3文字: 所有者・地形・フラグ。輪郭の外は xxx、見えないマスは 0p0（index.html の exportState と同じ並び）
    let cs = ''; const RB = RADIUS + COAST_MAX;
    for (let q = -RB; q <= RB; q++) for (let r = -RB; r <= RB; r++) if (Math.abs(q + r) <= RB) {
      const k = key(q, r), c0 = cells.get(k);
      if (!c0) { cs += 'xxx'; continue; }
      const c = mask ? mask(c0, k) : c0;
      cs += c ? String(c.o) + c.t + flagsOf(c) : '0p0';
    }
    return cs;
  }
  function decodeCells(cs) {
    cells = new Map(); let i = 0; const RB = RADIUS + COAST_MAX;
    for (let q = -RB; q <= RB; q++) for (let r = -RB; r <= RB; r++) if (Math.abs(q + r) <= RB) {
      const e = cs.substr(i * 3, 3), f = parseInt(e[2], 36) || 0; i++;
      if (e === 'xxx') continue;
      cells.set(key(q, r), {q, r, o: +e[0] || 0, t: e[1] || 'p', forest: !!(f & 1), f0: !!(f & 2), res: !!(f & 4), harv: !!(f & 8), village: !!(f & 16)});
    }
  }
  const clone = v => JSON.parse(JSON.stringify(v));
  function dump() {   // サーバーが持つ正本（すべての情報）
    return clone({NP, MAX_ROUNDS, SET, PNAME, PCOL, cells: encodeCells(null), last: per(p => K(last[p])), baseCell: per(p => K(baseCell[p])),
      sp, rp, pw, skills, started, bless, pot, boost, tool, lock, fixed, langOpen, fireOpen, stoneOpen, xOpen, pending, alive, retPick,
      vNew: Object.keys(vNew), resT: Object.entries(resT), traps: Object.entries(traps), scout: scoutV,
      turn, round, actions, over, winner, msg, selecting, tieStay, stats, hist, why, outSeq, notes, noteSeq, gid});
  }
  function load(d) {
    d = clone(d);
    NP = d.NP; MAX_ROUNDS = d.MAX_ROUNDS; SET = d.SET; RADIUS = RADIUS_BY_NP[NP] || 8; BASES = calcBases();
    PNAME = d.PNAME; PCOL = d.PCOL; applyColors();
    decodeCells(d.cells);
    const g = k => k ? cells.get(k) || null : null;
    last = per(p => g(d.last[p])); baseCell = {}; for (const p of PL()) { const b = g(d.baseCell[p]); if (b) baseCell[p] = b; }
    ({sp, rp, pw, skills, started, bless, pot, boost, tool, lock, fixed, langOpen, fireOpen, stoneOpen, xOpen, pending, alive, retPick, turn, round, actions, over, winner, msg, selecting, stats, hist, why, outSeq, notes, noteSeq, gid} = d);
    tieStay = !!d.tieStay; scoutV = d.scout;
    vNew = {}; for (const k of d.vNew) vNew[k] = 1;
    resT = Object.fromEntries(d.resT); traps = Object.fromEntries(d.traps);
    if (!fixed.cook) fixed.cook = per(0);
    popupQ = []; asked = null;
  }
  function newGame(o) {   // o: {np, rounds, names: {席: 名前}, cols: {席: 色の番号}, gid}
    NP = o.np; MAX_ROUNDS = o.rounds; SET = {...SET_DEFAULT}; PNAME = {...o.names}; PCOL = {...o.cols}; applyColors();
    init();
    notes = per(() => []); noteSeq = 0; gid = o.gid || 0; popupQ = []; asked = null; fxOut = [];
  }

  // 見せてよい情報だけにした盤面（index.html の draw() の視界の計算と同じ）
  // V: 席番号＝そのプレイヤーに見えるもの ／ 0＝観戦者（公開情報だけ）／ 'all'＝すべて（終局後・Devモードの観戦者）
  function view(V) {
    const all = V === 'all' || over || (V > 0 && !alive[V]);   // 脱落した人には、index.html と同じく盤面全体が見える
    const full = new Set(), nores = new Set(), scoutOnly = new Set();
    const disk = (set, sc, n) => { for (let dq = -n; dq <= n; dq++) for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) set.add(key(sc.q + dq, sc.r + dr)); };
    const seen = V > 0 ? scoutSet(V) : new Set();
    if (!all) {
      if (selecting) { for (const sc of cells.values()) if (isBase(sc)) disk(full, sc, 2); }   // 拠点選びの間は、候補6か所の半径2マス（全員に見える）
      else if (V > 0) {
        for (const sc of cells.values()) if (sc.o === V || sc === last[V]) { full.add(key(sc.q, sc.r)); const lv = visLevel(sc, V); if (lv === 2) disk(nores, sc, 1); else if (lv >= 3) disk(full, sc, lv - 2); }
        for (const kk of seen) if (!full.has(kk) && !nores.has(kk)) { full.add(kk); scoutOnly.add(kk); }
      }
      if (V > 0 && !selecting && round === 1) for (const q of PL()) {   // 1ターン目だけ見える、ほかの人の拠点
        const b = baseCell[q]; if (q === V || !alive[q] || !b || b.o !== q) continue;
        if (multi()) { if (q < V) full.add(key(b.q, b.r)); } else if (q > V) disk(full, b, 2);
      }
    }
    const vis = k => all || full.has(k) || nores.has(k);
    const hide = k => { if (all || !scoutOnly.has(k)) return false; const c = cells.get(k); return !!c && (c.forest || c.f0) && isEnemy(c.o, V); };   // 偵察だけで見えている森の中の相手は隠す
    const mask = (c, k) => {
      if (all) return c;
      if (!vis(k)) return null;
      if (hide(k)) return {o: 0, t: c.t, forest: true, f0: c.f0, res: false, harv: false, village: false};
      if (!full.has(k)) return {...c, res: false, harv: false};   // 視界レベル2: 地形だけ（資源は見えない）
      return c;
    };
    const shown = c => !!c && vis(K(c)) && !hide(K(c));
    const mine = p => all || p === V;
    const pp = (o, d) => per(p => mine(p) ? o[p] : d);
    return clone({
      NP, MAX_ROUNDS, SET, PNAME, PCOL, cells: encodeCells(mask),
      last: per(p => shown(last[p]) ? K(last[p]) : null), baseCell: per(p => shown(baseCell[p]) ? K(baseCell[p]) : null),
      sp, rp, started, alive,
      pw: pp(pw, 1), bless: pp(bless, 0), pot: pp(pot, 0), skills: per(p => mine(p) ? skills[p] : {}),
      boost: {stone: pp(boost.stone, 0), polish: pp(boost.polish, 0)}, tool: {stone: pp(tool.stone, 0), polish: pp(tool.polish, 0)},
      lock: {stone: pp(lock.stone, 0), polish: pp(lock.polish, 0)}, fixed: {stone: pp(fixed.stone, 0), polish: pp(fixed.polish, 0), cook: pp(fixed.cook, 0)},
      langOpen: pp(langOpen, false), fireOpen: pp(fireOpen, false), stoneOpen: pp(stoneOpen, false),
      xOpen: Object.fromEntries(XIDS.map(id => [id, pp(xOpen[id], false)])),
      pending: per(() => []), retPick: pp(retPick, null),
      vNew: Object.keys(vNew).filter(vis), resT: Object.entries(resT).filter(([k]) => all || full.has(k)).map(([k, e]) => [k, e[0], e[1]]),
      traps: Object.entries(traps).filter(([k, o]) => all || o === V || seen.has(k)),
      scout: per(p => mine(p) ? (scoutV[p] || []) : []),
      turn, round, actions, over, winner, msg, selecting, tieStay,
      result: over ? {stats, hist, why, outSeq} : null,
      pub: per(p => ({cn: count(p), inc: income(p), cap: spCap(p), pw: effPower(p), ac: selecting ? '-' : (!over && turn === p) ? actions : (isDay() || skills[p].fire ? 2 : 1)})),   // プレイヤー欄に全員分が出ている数字
      notes: V > 0 ? (notes[V] || []).slice(-30) : [],
      stuck: V > 0 && V === turn && !over && !selecting && (actions === 0 || !anyLegal(turn)),
      me: V > 0 ? V : 0, gid
    });
  }

  // ---- 端末からの操作 ----
  // o: {a: 'tap'|'mode'|'demolish'|'pray'|'learn'|'tool'|'end'|'resign', k: マスのキー, m, id, kind, ch: 'yes'|'alt'}（形は呼び出す前に確かめてある）
  // 返り値: {changed: true, fx} ／ {ask: {text, yes, alt}}（確認が必要。盤面は変わっていない）／ {hint: '…'}（盤面は変わらず、本人にだけ伝える文）／ {e: '理由'}
  const coreSig = () => { const d = dump(); delete d.msg; return JSON.stringify(d); };
  function run(seat, o) {
    const p = turn, c = o.k ? cells.get(o.k) : null;
    switch (o.a) {
      case 'tap': if (c) act(c); return;
      case 'mode': {   // 村・罠・偵察の場所選び（index.html の toolBody／偵察パネルのボタンの条件）
        if (!c || busy || over || selecting || !started[p] || !last[p]) return;
        if (o.m === 'village') { if (!canBuildVillage(p)) { msg = villageWhy(p); return; } villageMode = true; }
        else if (o.m === 'trap') { if (!canAffordTrap(p)) return; trapMode = true; }
        else { if (!canScout(p) || !scoutModeOk(p, o.m)) { msg = !canScout(p) ? `偵察には、行動${SCOUT_ACT}と食料${SCOUT_FOOD}が必要です` : '🔭 この偵察は、いまは使えません'; return; } scoutMode = o.m; }
        try { modePick(c); } finally { if (!asked || o.ch) { villageMode = false; trapMode = false; scoutMode = null; } scoutPrev = null; }
        return;
      }
      case 'demolish':   // 村の長押し（index.html の pointerdown の処理の条件）
        if (!c || selecting || over || busy || !started[p] || c.o !== p || !c.village) return;
        if (!gm && actions < 1) { msg = '村を壊すには、行動1が必要です'; return; }
        demolishVillage(c); return;
      case 'pray':   // 🙏 ボタン（index.html の prayBtn の処理の条件）
        if (busy || over || selecting || !started[p] || !last[p]) return;
        if (bless[p] >= 1) { msg = '命の糧は、1ターンに1回までです'; return; }
        if (!gm && sp[p] < 1) { msg = '捧げる食料がありません'; return; }
        pray(); return;
      case 'learn': learnSkill(o.id); return;
      case 'tool': toolOp(o.kind, o.id); return;
      case 'end': if (!over && !busy && !selecting) endTurn(); return;
    }
  }
  function op(seat, o) {
    if (o.a === 'resign') {
      const before = coreSig();
      popupQ = []; fxOut = [];
      if (!resign(seat)) return {e: 'resign'};
      flush(seat);
      return {changed: coreSig() !== before, fx: []};
    }
    if (over) return {e: 'over'};
    if (seat !== turn) return {e: 'turn'};
    const before = coreSig(), msg0 = msg;
    asked = null; popupQ = []; fxOut = [];
    run(seat, o);
    if (asked) {
      const a = asked; asked = null;
      if (o.ch === 'yes' && a.fn) a.fn();
      else if (o.ch === 'alt' && a.altFn) a.altFn();
      else { msg = msg0; popupQ = []; fxOut = []; villageMode = false; trapMode = false; scoutMode = null; return {ask: {text: a.text, yes: a.yes, alt: a.alt}}; }
      if (asked) { asked = null; }   // 2段目の確認は起きない（念のため捨てる）
    }
    villageMode = false; trapMode = false; scoutMode = null; scoutPrev = null; pickMode = null;
    if (coreSig() === before) { const h = msg !== msg0 ? msg : ''; msg = msg0; popupQ = []; fxOut = []; return {hint: h}; }
    flush(seat);
    const fx = fxOut.slice(0, 6); fxOut = [];
    return {changed: true, fx};
  }
  function flush(seat) {   // お知らせ: 操作した人の分はすぐに、ほかの人の分（pending）は、その人の番が来たときに届ける
    const add = (p, it) => { if (!notes[p]) notes[p] = []; notes[p].push({i: ++noteSeq, t: String(it.t || ''), s: String(it.s || '')}); if (notes[p].length > 40) notes[p].splice(0, notes[p].length - 40); };
    for (const it of popupQ.splice(0)) if (isPlayer(seat)) add(seat, it);
    if (!over && !selecting && isPlayer(turn) && pending[turn] && pending[turn].length) for (const it of pending[turn].splice(0)) add(turn, it);
  }
  return {
    newGame, dump, load, view, op,
    get over() { return over; }, get turn() { return turn; }, get np() { return NP; }, get gid() { return gid; },
    K: {ROUNDS_BY_NP, PALETTE_N: PALETTE.length, SKILL_IDS: SKILLS.map(k => k.id), XIDS}
  };
}


/* =========================================================
   2. 中継サーバー（入口の Worker と、ルームごとの Durable Object）
   ========================================================= */
const K0 = createEngine().K;   // ルールの定数（人数ごとのラウンド数・色の数など）
const ROOM_RE = /^[A-HJ-NP-Z2-9]{4}$/;          // ルームID: 4文字。見間違えやすい I・O・0・1 は使わない
const TOK_RE = /^[A-Za-z0-9_-]{16,48}$/;         // 本人を見分ける合言葉（端末が作る。ほかの人には絶対に送らない）
const CELL_RE = /^-?\d{1,2},-?\d{1,2}$/;
const MAX_MSG = 4096;            // 受け取る1通の大きさの上限（文字数）
const RATE_SOFT = 20, RATE_HARD = 60, RATE_STRIKES = 5;   // 1秒あたりの送信回数: これを超えたら無視 ／ さらに超えたら切断 ／ 無視が5秒続いたら切断
const MAX_MEMBERS = 12, MAX_SPEC = 8;            // 1ルームの参加者（席に着いていない人を含む）と観戦者の上限
const IDLE_MS = 7 * 24 * 3600 * 1000;            // 7日間使われていないルームは消す
const LOG_CHUNK = 200;                            // 操作の記録を、この件数ずつ分けて保存する
const DEV_PIN_HASH = 'a50da2f2674762d6fc8b380a45fd82706b48366b7d3d715d0a1dfa82c73113ee';   // index.html の GM_PIN_HASH と同じ（暗証番号そのものは書かない）
const DEV_TRIES = 5;                              // Devモードの暗証番号は、1つの接続で5回まで
const OPS = new Set(['tap', 'mode', 'demolish', 'pray', 'learn', 'tool', 'end', 'resign']);
const MODES = new Set(['village', 'trap', 'hex', 'line']);
const TOOL_KINDS = new Set(['cook', 'pot', 'use', 'repair', 'craft']), TOOL_IDS = new Set(['stone', 'polish', 'boil', 'pottery']);

const cleanName = v => String(v == null ? '' : v).replace(/[<>&"'`\u0000-\u001f\u007f]/g, '').trim().slice(0, 8);
const normName = v => v.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const randId = (n = 8) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); };
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const b = new Uint32Array(1); crypto.getRandomValues(b); const j = b[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function sha256hex(s) { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }

// 端末から届いた操作の形と値の範囲を確かめる（おかしければ null）
function cleanOp(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || !OPS.has(o.a)) return null;
  const r = {a: o.a};
  if (o.ch !== undefined) { if (o.ch !== 'yes' && o.ch !== 'alt') return null; r.ch = o.ch; }
  if (o.a === 'tap' || o.a === 'mode' || o.a === 'demolish') { if (typeof o.k !== 'string' || !CELL_RE.test(o.k)) return null; r.k = o.k; }
  if (o.a === 'mode') { if (!MODES.has(o.m)) return null; r.m = o.m; }
  if (o.a === 'learn') { if (!K0.SKILL_IDS.includes(o.id)) return null; r.id = o.id; }
  if (o.a === 'tool') { if (!TOOL_KINDS.has(o.kind) || !TOOL_IDS.has(o.id)) return null; r.kind = o.kind; r.id = o.id; }
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('hexarea-server は動作中です（HEXAREA オンライン対戦の中継サーバー）', {headers: {'content-type': 'text/plain; charset=utf-8'}});
    if (url.pathname !== '/ws') return new Response('not found', {status: 404});
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);   // 空なら制限なし
    if (allowed.length && !allowed.includes(request.headers.get('Origin') || '')) return new Response('forbidden origin', {status: 403});
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('WebSocket で接続してください', {status: 426});
    const room = url.searchParams.get('room') || '';
    if (!ROOM_RE.test(room)) return new Response('bad room id', {status: 400});
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null; this.eng = null; this.rate = new Map(); this.chunk = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));   // "ping" には、休止したまま "pong" を返す
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });   // 休止から戻ったときも、保存した状態から続ける
  }

  async fetch(request) {
    const code = new URL(request.url).searchParams.get('room') || '';
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({code, role: '', tok: '', id: '', dev: false, tries: 0});
    return new Response(null, {status: 101, webSocket: client});
  }

  // ---- 受信 ----
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MSG) { this.limit(ws, 3); return; }
    if (!this.limit(ws, 1)) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
    const at = ws.deserializeAttachment() || {};
    try {
      if (m.t === 'hello') { if (!at.role) await this.hello(ws, at, m); return; }
      if (!at.role || !this.room) return;
      this.touch();
      switch (m.t) {
        case 'sync': this.sendRoom(ws); this.sendState(ws); return;
        case 'me': return await this.me(ws, at, m);
        case 'sit': case 'stand': return await this.sit(ws, at, m.t === 'sit');
        case 'set': return await this.settings(ws, at, m);
        case 'start': return await this.start(ws, at, false);
        case 'again': return await this.start(ws, at, true);
        case 'op': return await this.op(ws, at, m);
        case 'rep': return await this.replay(ws);
        case 'dev': return await this.dev(ws, at, m);
        case 'bye': return await this.bye(ws, at);
      }
    } catch (e) { console.error('message error', e); this.send(ws, {t: 'no', q: isInt(m.q, 1, 1e9) ? m.q : 0}); }
  }
  // 送りすぎの検査: 1秒あたり RATE_SOFT 通を超えたら無視、RATE_HARD 通を超えるか、無視が続いたら切断
  limit(ws, w) {
    const now = Date.now(); let r = this.rate.get(ws);
    if (!r || now - r.at >= 1000) { if (r && r.n > RATE_SOFT) r.strikes++; else if (r) r.strikes = 0; r = {at: now, n: 0, strikes: r ? r.strikes : 0}; this.rate.set(ws, r); }
    r.n += w;
    if (r.n > RATE_HARD || r.strikes >= RATE_STRIKES) { this.rate.delete(ws); try { ws.close(1008, 'too many messages'); } catch (e) {} return false; }
    return r.n <= RATE_SOFT;
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    this.rate.delete(ws);
    const at = ws.deserializeAttachment() || {};
    if (!this.room || !at.role) return;
    if (at.role === 'player' && this.room.phase === 'lobby' && !this.socketsOf(at.tok, ws).length) {   // 待合室で接続が切れた人は、一覧から外す
      this.room.members = this.room.members.filter(x => x.tok !== at.tok);
      await this.save();
    }
    this.broadcastRoom(ws);
  }

  // ---- 部屋の情報 ----
  sockets(except) { return this.ctx.getWebSockets().filter(w => w !== except && w.readyState !== 2 && w.readyState !== 3); }
  socketsOf(tok, except) { return this.sockets(except).filter(w => { const a = w.deserializeAttachment() || {}; return a.role === 'player' && a.tok === tok; }); }
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) {} }
  seatOf(tok) { const R = this.room; if (!R || !R.seats) return 0; const mem = R.members.find(x => x.tok === tok); if (!mem) return 0; return +(Object.keys(R.seats).find(k => R.seats[k] === mem.id) || 0); }
  roomMsg(at, except) {   // 合言葉（tok）は入れない
    const R = this.room, on = new Set(this.sockets(except).map(w => (w.deserializeAttachment() || {})).filter(a => a.role === 'player').map(a => a.tok));
    const me = R.members.find(x => x.tok === at.tok);
    return {t: 'room', code: R.code, phase: R.phase, np: R.np, rounds: R.rounds, spec: R.spec, gid: R.gid,
      members: R.members.map(x => ({id: x.id, name: x.name, col: x.col, seated: !!x.seated, on: on.has(x.tok)})),
      seats: R.seats || {}, specN: this.sockets(except).filter(w => (w.deserializeAttachment() || {}).role === 'spec').length,
      you: me ? me.id : '', role: at.role};
  }
  sendRoom(ws, except) { this.send(ws, this.roomMsg(ws.deserializeAttachment() || {}, except)); }
  broadcastRoom(except) { for (const w of this.sockets(except)) if ((w.deserializeAttachment() || {}).role) this.sendRoom(w, except); }
  engine() {
    if (!this.eng && this.room && this.room.game) { this.eng = createEngine(); this.eng.load(this.room.game); }
    return this.eng;
  }
  viewFor(at) {   // 席の人にはその人の視界、観戦者には公開情報だけ（Devモードを確かめた観戦者には全体）
    const E = this.engine(); if (!E || this.room.phase !== 'play') return null;
    if (at.role === 'spec') return E.view(at.dev ? 'all' : 0);
    const seat = this.seatOf(at.tok); return seat ? E.view(seat) : E.view(0);
  }
  sendState(ws, extra) { const at = ws.deserializeAttachment() || {}; const s = this.viewFor(at); if (s) this.send(ws, {t: 'st', v: this.room.gv, s, ...(extra || {})}); }
  broadcastState(from, extra) { for (const w of this.sockets()) { const a = w.deserializeAttachment() || {}; if (a.role) this.sendState(w, w === from ? extra : null); } }
  touch() { if (this.room) this.room.active = Date.now(); }
  async save() {
    const R = this.room; if (!R) return;
    R.active = Date.now();
    await this.ctx.storage.put('room', R);
    const al = await this.ctx.storage.getAlarm();
    if (!al || al < R.active + IDLE_MS - 3600 * 1000) await this.ctx.storage.setAlarm(R.active + IDLE_MS);
  }
  async alarm() {   // 7日間使われていないルームを消す
    const R = (await this.ctx.storage.get('room')) || null;
    if (R && Date.now() - (R.active || 0) < IDLE_MS) { await this.ctx.storage.setAlarm((R.active || 0) + IDLE_MS); return; }
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, 'room expired'); } catch (e) {} }
    await this.ctx.storage.deleteAll(); this.room = null; this.eng = null; this.chunk = null;
  }

  // ---- 入室 ----
  async hello(ws, at, m) {
    const fail = e => { this.send(ws, {t: 'err', e}); try { ws.close(1000, e); } catch (_) {} };
    if (typeof m.tok !== 'string' || !TOK_RE.test(m.tok)) return fail('bad');
    const spec = m.spec === true, code = at.code;
    let R = this.room;
    if (m.create === true && !spec) {
      if (R) return fail('exists');   // 同じIDのルームがすでにある（端末が別のIDで作り直す）
      const np = isInt(m.np, 2, 6) ? m.np : 2;
      R = this.room = {code, phase: 'lobby', np, rounds: K0.ROUNDS_BY_NP[np], spec: true, members: [], seats: null, gv: 0, gid: 0, game: null, logN: 0, created: Date.now(), active: Date.now()};
    }
    if (!R) return fail('noroom');
    if (spec) {
      if (!R.spec) return fail('nospec');
      if (this.sockets(ws).filter(w => (w.deserializeAttachment() || {}).role === 'spec').length >= MAX_SPEC) return fail('full');
      Object.assign(at, {role: 'spec', tok: m.tok, id: 's' + randId(6), dev: false, tries: 0});
    } else {
      let mem = R.members.find(x => x.tok === m.tok);
      if (!mem) {
        if (R.phase !== 'lobby') return fail('playing');
        if (R.members.length >= MAX_MEMBERS) return fail('full');
        const used = new Set(R.members.map(x => x.col));
        let col = isInt(m.col, 0, K0.PALETTE_N - 1) ? m.col : 0; if (used.has(col)) col = [...Array(K0.PALETTE_N).keys()].find(k => !used.has(k)) ?? 0;
        mem = {tok: m.tok, id: 'm' + randId(6), name: cleanName(m.name), col, seated: R.members.filter(x => x.seated).length < R.np, at: Date.now()};
        R.members.push(mem);
      }
      for (const w of this.socketsOf(m.tok, ws)) { this.send(w, {t: 'kicked'}); try { w.close(1000, 'replaced'); } catch (e) {} }   // 同じ人が別の画面で入り直した: 古い接続を切る
      Object.assign(at, {role: 'player', tok: m.tok, id: mem.id, dev: false, tries: 0});
    }
    ws.serializeAttachment(at);
    await this.save();
    this.send(ws, {t: 'welcome', id: at.id, role: at.role});
    this.broadcastRoom();
    this.sendState(ws);
  }
  member(at) { return this.room.members.find(x => x.tok === at.tok) || null; }
  async me(ws, at, m) {   // 名前と色（待合室のみ）
    const mem = this.member(at); if (!mem || this.room.phase !== 'lobby') return;
    if ('name' in m) mem.name = cleanName(m.name);
    if ('col' in m && isInt(m.col, 0, K0.PALETTE_N - 1) && !this.room.members.some(x => x !== mem && x.col === m.col)) mem.col = m.col;
    await this.save(); this.broadcastRoom();
  }
  async sit(ws, at, on) {   // 席に着く／立つ（待合室のみ）
    const R = this.room, mem = this.member(at); if (!mem || R.phase !== 'lobby') return;
    if (on && !mem.seated && R.members.filter(x => x.seated).length >= R.np) { this.send(ws, {t: 'no', e: 'seats'}); return; }
    mem.seated = on; await this.save(); this.broadcastRoom();
  }
  async settings(ws, at, m) {   // 人数・ラウンド数・観戦の許可（待合室で、席に着いている人なら誰でも）
    const R = this.room, mem = this.member(at); if (!mem || !mem.seated || R.phase !== 'lobby') return;
    if (isInt(m.np, 2, 6) && m.np !== R.np) {
      R.np = m.np; R.rounds = K0.ROUNDS_BY_NP[m.np];
      const seated = R.members.filter(x => x.seated).sort((a, b) => a.at - b.at);
      for (const x of seated.slice(R.np)) if (x !== mem) x.seated = false;   // 席が足りなくなったら、あとから着いた人から立ってもらう
      if (R.members.filter(x => x.seated).length > R.np) mem.seated = false;
    } else if (isInt(m.rounds, 1, 999)) R.rounds = m.rounds;
    if (typeof m.spec === 'boolean') R.spec = m.spec;
    await this.save(); this.broadcastRoom();
  }
  // ---- 対局開始・もう一局（ホストはいない。席の人なら誰でも押せる）----
  async start(ws, at, again) {
    const R = this.room, mem = this.member(at); if (!mem) return;
    let list;
    if (again) {
      if (R.phase !== 'play' || !this.engine() || !this.engine().over || !this.seatOf(at.tok)) return;
      list = Object.values(R.seats).map(id => R.members.find(x => x.id === id)).filter(Boolean);
      if (list.length !== R.np) { R.phase = 'lobby'; R.seats = null; R.game = null; this.eng = null; for (const x of R.members) x.seated = list.includes(x); await this.save(); this.broadcastRoom(); return; }   // 抜けた人がいる: 待合室に戻る
    } else {
      if (R.phase !== 'lobby' || !mem.seated) return;
      list = R.members.filter(x => x.seated);
      if (list.length !== R.np) { this.send(ws, {t: 'no', e: 'seats'}); return; }
    }
    const order = shuffle(list), seats = {}, names = {}, cols = {}, usedN = new Set();   // 出番は、部屋に入った順ではなくランダム
    order.forEach((x, i) => {
      const p = i + 1; let nm = cleanName(x.name) || 'P' + p;
      if (usedN.has(normName(nm))) nm = nm.slice(0, 7) + p;   // 同じ名前の人がいたら番号を付ける
      usedN.add(normName(nm)); seats[p] = x.id; names[p] = nm; cols[p] = x.col;
    });
    R.gid = (R.gid || 0) + 1;
    const E = createEngine(); E.newGame({np: R.np, rounds: R.rounds, names, cols, gid: R.gid});
    this.eng = E; R.phase = 'play'; R.seats = seats; R.game = E.dump(); R.gv = (R.gv || 0) + 1;
    const old = R.logN || 0; R.logN = 0; this.chunk = {i: 0, a: []};
    for (let i = 0; i * LOG_CHUNK < old; i++) await this.ctx.storage.delete('log:' + i);
    await this.ctx.storage.put('init', E.view('all'));   // 振り返り用の、最初の盤面（すべての情報）
    await this.save();
    this.broadcastRoom(); this.broadcastState();
  }
  // ---- 対局中の操作 ----
  async op(ws, at, m) {
    const q = isInt(m.q, 1, 1e9) ? m.q : 0, R = this.room, E = this.engine();
    const no = e => this.send(ws, {t: 'no', q, e});
    if (at.role !== 'player' || R.phase !== 'play' || !E) return no('phase');
    const seat = this.seatOf(at.tok); if (!seat) return no('seat');
    const o = cleanOp(m.o); if (!o) return no('bad');
    const r = E.op(seat, o);
    if (r.ask) return this.send(ws, {t: 'ask', q, text: r.ask.text, yes: r.ask.yes, alt: r.ask.alt});
    if (r.e) return no(r.e);
    if (!r.changed) return this.send(ws, {t: 'hint', q, text: r.hint || ''});
    R.game = E.dump(); R.gv++;
    await this.logPush([seat, o]);
    await this.save();
    this.broadcastState(ws, {q, fx: r.fx});
  }
  async logChunk(i) {
    if (!this.chunk || this.chunk.i !== i) this.chunk = {i, a: (await this.ctx.storage.get('log:' + i)) || []};
    return this.chunk;
  }
  async logPush(e) {
    const R = this.room, i = Math.floor(R.logN / LOG_CHUNK), ch = await this.logChunk(i);
    ch.a.push(e); R.logN++;
    await this.ctx.storage.put('log:' + i, ch.a);
  }
  async replay(ws) {   // 終局後だけ: 最初の盤面と、全員の操作の記録
    const R = this.room, E = this.engine();
    if (R.phase !== 'play' || !E || !E.over) { this.send(ws, {t: 'no', e: 'rep'}); return; }
    const init = await this.ctx.storage.get('init'), log = [];
    for (let i = 0; i * LOG_CHUNK < R.logN; i++) log.push(...((await this.ctx.storage.get('log:' + i)) || []));
    this.send(ws, {t: 'rep', gid: R.gid, init, log: log.slice(0, R.logN)});
  }
  // ---- Devモードの観戦者: 暗証番号をここでも確かめてから、盤面全体を送る ----
  async dev(ws, at, m) {
    if (at.role !== 'spec') return;
    if (m.off === true) { at.dev = false; ws.serializeAttachment(at); this.sendState(ws); return; }
    if (typeof m.pin !== 'string' || m.pin.length > 8) return;
    const ok = (await sha256hex('hexjintori:' + m.pin)) === DEV_PIN_HASH;
    at.tries = (at.tries || 0) + (ok ? 0 : 1); at.dev = ok; ws.serializeAttachment(at);
    this.send(ws, {t: 'dev', ok});
    if (ok) this.sendState(ws);
    else if (at.tries >= DEV_TRIES) { try { ws.close(1008, 'too many tries'); } catch (e) {} }
  }
  async bye(ws, at) {   // 退出: 待合室なら一覧から外す。終局後なら席を空ける。対局中は席を残す（あとで戻れる）
    const R = this.room;
    if (at.role === 'player') {
      const E = this.engine();
      if (R.phase === 'lobby' || (E && E.over)) { R.members = R.members.filter(x => x.tok !== at.tok); await this.save(); }
    }
    at.role = ''; ws.serializeAttachment(at);
    try { ws.close(1000, 'bye'); } catch (e) {}
    this.broadcastRoom(ws);
  }
}
