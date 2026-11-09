// ============================================
// ONE BEHAVIOUR: proximity stretch
// 规则：每个格子的尺寸 = f(指针到它的距离)
// + ml5 0.12.2 声音分类驱动 RULES（Clap / Voice / Tap / Background）
// ============================================

// ---------- 声音模型配置 ----------
// Teachable Machine 模型（Audio Project）
// 类别由模型自带的 metadata.json -> wordLabels 决定，代码里不用写死；
// 启动后控制台会打印一次实际拿到的类别列表，方便确认模型是否已更新。
// 早期版本只有 ["Background Noise", "Clap", "Voice"] 三类，此时 Tap 不会触发。
const MODEL_URL = 'https://teachablemachine.withgoogle.com/models/gPa2FZdHa/model.json';

const THRESHOLD = 0.85;      // 置信度门槛：低于它 → 中性类，不接管 RULES
const SOUND_SMOOTH = 0.06;   // 声音规则对 RULES 的平滑速度（0~1，越大越跟手）
const PANEL_W = 300;         // HUD 面板宽度（加了 label/confidence 后需要宽一点）

// 声音类别 -> RULES 目标值
// radius：影响半径越大，波纹铺得越开
// maxStretch：指针处最大拉伸倍数
// ease：衰减指数，越大边缘越"硬"、中心聚焦越强
const LABEL_MAP = {
  Clap:       { radius: 470, maxStretch: 3.40, ease: 3.40 },  // 拍手：短促爆发 → 大范围、强拉伸
  Voice:      { radius: 330, maxStretch: 2.00, ease: 1.50 },  // 人声：持续 → 柔和、长尾
  Tap:        { radius: 190, maxStretch: 1.55, ease: 2.80 },  // 敲击：小范围、干脆
  Background: { radius: 260, maxStretch: 2.20, ease: 2.00 }   // 背景：回到默认呼吸状态
};

// 常见别名 / 中文标签归一化（Teachable Machine 里标签随手写也能认）
// 本模型用的是 "Background Noise"，所以这里显式收了带空格的写法
const LABEL_ALIASES = {
  clap: 'Clap', clapping: 'Clap', 拍手: 'Clap', 拍掌: 'Clap',
  voice: 'Voice', speech: 'Voice', talking: 'Voice', 人声: 'Voice', 说话: 'Voice', 语音: 'Voice',
  tap: 'Tap', knock: 'Tap', 敲击: 'Tap', 敲: 'Tap', 轻敲: 'Tap',
  'background noise': 'Background', 'background-noise': 'Background', 'no background': 'Background',
  background: 'Background', noise: 'Background', silence: 'Background',
  背景: 'Background', 背景噪音: 'Background', 背景音: 'Background',
  环境音: 'Background', 静音: 'Background', 噪音: 'Background'
};

const DEFAULTS = {
  cellSize: 56,     // 网格间距
  radius: 260,      // 指针影响半径
  maxStretch: 2.2,  // 距离为 0 时的尺寸倍数
  ease: 2.0,        // 衰减曲线：1=线性，2=平滑，3=陡峭
  smooth: 0.14,     // 0~1，格子追赶目标尺寸的速度
  squash: 0.45      // 垂直方向响应相对水平的比例
};

let RULES = { ...DEFAULTS };
let cells = [];
let showHUD = true;

// ---------- 声音状态 ----------
let classifier = null;       // ml5 分类器
let modelReady = false;
let classifying = false;
let listenError = '';

let soundEnabled = true;     // 'm' 键开关：关掉后只用鼠标/键盘
let soundTarget = null;      // 当前生效的 RULES 目标（null = 中性，保持现状）
let soundClass = '';         // 归一化后的类别名

let lastLabel = '—';         // 原始 label（HUD 显示）
let lastConfidence = 0;      // 原始置信度 0~1
let labelsLogged = false;    // 类别清单只在首帧打印一次

// ============================================
// preload：加载 Teachable Machine 模型
// ============================================
function preload() {
  if (!MODEL_URL) {
    console.warn('[sound] MODEL_URL 为空，声音分类未启动；填好 URL 后刷新即可。');
    return;
  }
  if (typeof ml5 === 'undefined') {
    listenError = 'ml5 未加载';
    console.error('[sound] 找不到 ml5，请检查 CDN 引用是否在 sketch.js 之前。');
    return;
  }

  // probabilityThreshold 设为 0：所有结果都返回，由我们自己按 THRESHOLD 判定
  classifier = ml5.soundClassifier(MODEL_URL, { probabilityThreshold: 0.0, topk: 1 }, onModelReady);
}

function onModelReady() {
  modelReady = true;
  console.log('[sound] 模型加载完成，开始监听。');
  startClassify();
}

function startClassify() {
  if (!modelReady || classifying || !classifier) return;
  classifying = true;
  classifier.classify(gotResult);
}

// ============================================
// gotResult：ml5 持续回调（约每秒数十次）
// ============================================
function gotResult(error, results) {
  if (error) {
    listenError = String(error).slice(0, 26);
    console.error('[sound] classify error:', error);
    return;
  }
  listenError = '';

  // 没有结果（模型刚启动 / 麦克风串流还没就绪）
  if (!results || results.length === 0) {
    setNeutral('—', 0);
    return;
  }

  const top = results[0];
  lastLabel = top.label;
  lastConfidence = top.confidence || 0;

  // 首帧把模型真实类别打印出来：确认线上模型是否已经包含新加的 Tap
  if (!labelsLogged) {
    labelsLogged = true;
    const labels = results.map(r => r.label);
    console.log('[sound] 模型类别 (' + labels.length + '):', labels);
    const missing = ['Clap', 'Voice', 'Tap', 'Background'].filter(
      k => !labels.some(l => normalizeLabel(l) === k.toLowerCase())
    );
    if (missing.length) console.warn('[sound] 以下类别未在模型中出现，映射不会触发:', missing);
  }

  // 中性类处理：
  // 1) 置信度不到 THRESHOLD —— 不可信，不改变 RULES
  // 2) 标签不在映射表里 —— 未知类，同样当中性
  const mapped = normalizeLabel(top.label);

  if (lastConfidence < THRESHOLD || !mapped) {
    setNeutral(lastLabel, lastConfidence);
    return;
  }

  commitRule(mapped);
}

// 标签归一化：忽略大小写 / 空格，并接受中英文别名
function normalizeLabel(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');

  if (LABEL_MAP[key]) return key;                 // 已经就是 Clap/voice/tap/background
  const alias = LABEL_ALIASES[key];
  if (alias) return alias.toLowerCase();          // 走别名
  // 宽松匹配：'Clapping lightly' 这类带修饰的标签也能归类
  for (const a in LABEL_ALIASES) {
    if (key.includes(a)) return LABEL_ALIASES[a].toLowerCase();
  }
  for (const k in LABEL_MAP) {
    if (key.includes(k)) return k;
  }
  return null;
}

// 中性：清空目标，RULES 保持现状（不强行拉回默认值，避免来回抖动）
function setNeutral(label, confidence) {
  soundClass = '';
  soundTarget = null;
  if (label !== undefined) {
    lastLabel = label;
    lastConfidence = confidence;
  }
}

// 命中即切换目标；真正的「缓过来」交给 applySoundRules 的 lerp 完成
function commitRule(cls) {
  soundClass = cls;
  soundTarget = LABEL_MAP[capitalize(cls)] || null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================
// applySoundRules：把声音目标平滑地推到 RULES 上
// ============================================
function applySoundRules() {
  if (!soundEnabled || !soundTarget) return;

  RULES.radius = lerp(RULES.radius, soundTarget.radius, SOUND_SMOOTH);
  RULES.maxStretch = lerp(RULES.maxStretch, soundTarget.maxStretch, SOUND_SMOOTH);
  RULES.ease = lerp(RULES.ease, soundTarget.ease, SOUND_SMOOTH);

  // 兜底：键盘和声音同时改时，别让值跑出合法区间
  RULES.radius = constrain(RULES.radius, 40, 900);
  RULES.maxStretch = constrain(RULES.maxStretch, 1, 5);
  RULES.ease = constrain(RULES.ease, 0.5, 5);
}

// ============================================
// p5 生命周期
// ============================================
function setup() {
  createCanvas(windowWidth, windowHeight);
  noStroke();
  colorMode(HSB, 360, 100, 100, 100);
  buildGrid();

  // 若 preload 阶段没走到回调，这里补一次启动
  if (modelReady) startClassify();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildGrid();
}

// 网格只在 cellSize 变化或窗口尺寸变化时重建
function buildGrid() {
  const s = RULES.cellSize;
  const cols = ceil(width / s) + 2;
  const rows = ceil(height / s) + 2;
  cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: (c - 1) * s,
        y: (r - 1) * s,
        w: s,
        h: s
      });
    }
  }
}

function draw() {
  background(220, 8, 12);

  // 声音规则先作用于 RULES，再用这一帧的 RULES 去画
  applySoundRules();

  const s = RULES.cellSize;

  for (const cell of cells) {
    // 1. 测量：指针到格子中心的距离
    const cx = cell.x + s / 2;
    const cy = cell.y + s / 2;
    const d = dist(mouseX, mouseY, cx, cy);

    // 2. 规则：距离 -> 强度（0~1）
    let t = 0;
    if (d < RULES.radius) {
      const linear = 1 - d / RULES.radius;   // 线性 0~1
      t = pow(linear, RULES.ease);           // 用指数重塑衰减曲线
    }

    // 3. 规则：强度 -> 目标尺寸（水平拉伸多于垂直，产生「拉长」感）
    const tw = s * (1 + t * (RULES.maxStretch - 1));
    const th = s * (1 + t * (RULES.maxStretch - 1) * RULES.squash);

    // 4. 平滑：当前尺寸逐帧逼近目标，产生弹性延迟
    cell.w = lerp(cell.w, tw, RULES.smooth);
    cell.h = lerp(cell.h, th, RULES.smooth);

    // 5. 可视化：距离同时驱动色相（近暖远冷）
    const nd = constrain(d, 0, RULES.radius) / RULES.radius;
    fill(lerp(25, 205, nd), lerp(78, 45, nd), lerp(96, 82, nd), 90);

    // 6. 绘制：以格子中心为锚点向外扩张
    const ox = (cell.w - s) / 2;
    const oy = (cell.h - s) / 2;
    rect(cell.x - ox, cell.y - oy, cell.w, cell.h, 3);
  }

  if (showHUD) drawHUD();
}

function drawHUD() {
  // 声音状态文案
  let audioLine;
  if (!MODEL_URL)         audioLine = 'sound   URL 未填写';
  else if (listenError)   audioLine = 'sound   ' + listenError;
  else if (!modelReady)   audioLine = 'sound   模型加载中…';
  else if (!soundEnabled) audioLine = 'sound   已静音 (m)';
  else if (soundTarget)   audioLine = 'sound   ' + soundClass + ' 接管中';
  else                    audioLine = 'sound   中性 / 保持现状';

  const lines = [
    'radius      ' + RULES.radius.toFixed(0) + '   ↑ ↓',
    'maxStretch  ' + RULES.maxStretch.toFixed(2) + '   ← →',
    'ease        ' + RULES.ease.toFixed(2) + '   [ ]',
    'cellSize    ' + RULES.cellSize.toFixed(0) + '   - +',
    'smooth      ' + RULES.smooth.toFixed(2) + '   z x',
    '',
    audioLine,
    'label       ' + lastLabel + '   (阈值 ' + THRESHOLD.toFixed(2) + ')',
    'confidence  ' + (lastConfidence * 100).toFixed(1) + '%',
    '',
    'H 隐藏 / R 重置 / M 声音开关'
  ];

  push();
  noStroke();
  fill(0, 0, 100, 82);
  rect(16, 16, PANEL_W, 30 + lines.length * 16, 6);
  fill(0, 0, 18);
  textSize(12);
  textFont('monospace');
  text(lines.join('\n'), 30, 38);

  // 置信度条：直观看出离 0.85 还有多远
  const barX = 30;
  const barW = PANEL_W - 60;
  const barY = 28 + lines.length * 16;
  noFill();
  stroke(0, 0, 60, 70);
  rect(barX, barY, barW, 4, 2);
  noStroke();
  fill(lastConfidence >= THRESHOLD ? 140 : 25, 70, 85);   // 达标=青绿，未达标=橙
  rect(barX, barY, barW * constrain(lastConfidence, 0, 1), 4, 2);
  // 阈值刻度线
  fill(0, 0, 30, 70);
  rect(barX + barW * THRESHOLD - 0.5, barY - 2, 1, 8);
  pop();
}

function keyPressed() {
  const k = key.toLowerCase();

  if (k === 'h') showHUD = !showHUD;
  if (k === 'r') { RULES = { ...DEFAULTS }; soundTarget = null; soundClass = ''; buildGrid(); }
  if (k === 'm') soundEnabled = !soundEnabled;

  if (keyCode === UP_ARROW)    RULES.radius = min(RULES.radius + 20, 900);
  if (keyCode === DOWN_ARROW)  RULES.radius = max(RULES.radius - 20, 40);
  if (keyCode === RIGHT_ARROW) RULES.maxStretch = min(RULES.maxStretch + 0.1, 5);
  if (keyCode === LEFT_ARROW)  RULES.maxStretch = max(RULES.maxStretch - 0.1, 1);

  if (k === ']') RULES.ease = min(RULES.ease + 0.1, 5);
  if (k === '[') RULES.ease = max(RULES.ease - 0.1, 0.5);

  if (k === '+' || k === '=') { RULES.cellSize = min(RULES.cellSize + 8, 160); buildGrid(); }
  if (k === '-')              { RULES.cellSize = max(RULES.cellSize - 8, 16);  buildGrid(); }

  if (k === 'x') RULES.smooth = min(RULES.smooth + 0.02, 0.5);
  if (k === 'z') RULES.smooth = max(RULES.smooth - 0.02, 0.02);

  // 手动调了声音接管的三个参数，就暂时脱离接管，避免"我调一半它又被拉回去"
  if (keyCode === UP_ARROW || keyCode === DOWN_ARROW || keyCode === LEFT_ARROW ||
      keyCode === RIGHT_ARROW || k === '[' || k === ']') {
    soundTarget = null;
    soundClass = '';
  }

  return false; // 阻止方向键滚动页面
}
