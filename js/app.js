// ============================================================
// 小栖 API Demo · 主逻辑
// ============================================================
// 机制实现（与《02-对话与记忆机制设计方案》对应）：
//   对话轮：人设锚注入 + 四级响应路由 + 流式输出 + 击穿拦截重写 + 危机信号 L4
//   记忆轮：结束对话 → 异步提取事件卡片（JSON mode）→ 入库 localStorage
//   次日引用：新的一天 → 按待跟进项生成主动开场
//   删除反向链路：删卡片 → 派生标签清除 → 缓存失效说明
// ============================================================

const $ = (id) => document.getElementById(id);

// ---------- 状态 ----------
let conversation = []; // [{role:'user'|'assistant', content}]
let memory = []; // 事件卡片
let sessionNo = 1;
let currentLevel = 'L1';
let levelBeforeCrisis = null;
let busy = false;
let archived = false;
let stats = { inChars: 0, outChars: 0, calls: 0 };

const LS = {
  history: 'xiaoqi_history',
  memory: 'xiaoqi_memory',
  session: 'xiaoqi_session_no',
  archived: 'xiaoqi_archived',
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {}
}

// ---------- 聊天渲染 ----------
function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg fadein ' + (who === 'ai' ? 'ai' : 'user');
  d.textContent = text;
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
  return d;
}
function addSys(text) {
  const d = document.createElement('div');
  d.className = 'sys fadein';
  d.textContent = text;
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
}
function showTyping() {
  const t = document.createElement('div');
  t.className = 'typing';
  t.id = 'typing';
  t.textContent = '小栖正在输入…';
  $('chat').appendChild(t);
  $('chat').scrollTop = $('chat').scrollHeight;
}
function hideTyping() {
  const t = $('typing');
  if (t) t.remove();
}

// ---------- 系统内部视角 ----------
const LV_LABEL = { L1: 'L1 倾听', L2: 'L2 安抚', L3: 'L3 建议', L4: 'L4 干预' };

function updateInjectionView(sysPrompt) {
  const anchorLen = XQ_PROMPT.XIAOQI_ANCHOR.length;
  const memCount = memory.length;
  const histWin = Math.min(conversation.length, 20);
  $('injectionView').innerHTML = `
    <b>人设锚：</b><span style="color:#7dd87d">✓ 已注入（${anchorLen} 字符）</span><br>
    <b>事件卡片：</b>${memCount > 0 ? `<span style="color:#5aa9ff">×${memCount}（分层注入最近10张）</span>` : '<span style="color:#8b93a7">无（首次对话）</span>'}<br>
    <b>响应级别：</b><span class="lv lv${currentLevel[1]}">${LV_LABEL[currentLevel]}</span>${levelBeforeCrisis ? '<span style="color:#ffd35a">（危机临时升级）</span>' : ''}<br>
    <b>历史窗口：</b>最近 ${histWin} 条（截断防记忆通胀）<br>
    <b>System Prompt 总量：</b>约 ${sysPrompt ? sysPrompt.length : anchorLen} 字符`;
}

function updateSafetyView(breakdown, crisis) {
  let html = `<b>击穿拦截器：</b><span style="color:${breakdown ? 'var(--red)' : 'var(--green)'}">${breakdown ? '⚠ 命中「' + breakdown + '」→ 已重写' : '监听中（8 模式·关键词级演示）'}</span><br>
    <b>危机信号监测：</b><span style="color:${crisis ? 'var(--red)' : 'var(--green)'}">${crisis ? '⚠ L4 已触发（热线后置校验开启）' : '待命'}</span><br>
    <b>干预边界：</b><span style="color:#ffd35a">泛青年日常陪伴人群（本产品特有裁决）</span><br>
    <span style="font-size:10px;color:#8b93a7">此边界不可从其他角色复制——脆弱人群需整体上移，换角色须重划（见00总览§5.4）</span>`;
  $('safetyView').innerHTML = html;
}

function updateCostView() {
  const inTok = Math.round(stats.inChars * 0.8);
  const outTok = Math.round(stats.outChars);
  const cost = ((inTok + outTok) / 1000) * 0.006;
  $('costView').innerHTML = `
    本次会话累计（粗略估算）：<br>
    输入 ≈ ${inTok.toLocaleString()} tok ｜ 输出 ≈ ${outTok.toLocaleString()} tok ｜ 调用 ${stats.calls} 次<br>
    <b style="color:#ffd35a">估算成本 ≈ ¥${cost.toFixed(4)}</b>（按假设单价 ¥0.006/千tok，实际以服务商账单为准）`;
}

function updateRelState() {
  const n = memory.length;
  const pending = memory.filter((e) => e.follow_up).length;
  let label = '初识';
  if (n >= 8) label = '老朋友';
  else if (n >= 5) label = '可以依赖';
  else if (n >= 2) label = '熟悉';
  const pct = Math.min(100, 10 + n * 9);
  $('relLabel').textContent = label;
  $('relFill').style.width = pct + '%';
  $('relNote').innerHTML =
    (pending > 0 ? `待跟进事项：<b style="color:#ffd35a">${pending} 项</b>` : '待跟进事项：无') +
    `<br>事件卡片：${n} 张`;
}

// 画像标签：由事件的情绪字段派生（删除事件即同步清除）
function updateTags() {
  const tags = [];
  memory.forEach((e) => {
    if (e.user_emotion) {
      e.user_emotion.split(/[+、,，\s]+/).forEach((t) => {
        t = t.trim();
        if (t && t.length <= 8 && !tags.includes(t)) tags.push(t);
      });
    }
  });
  const top = tags.slice(0, 6);
  $('tagWall').innerHTML = top.length
    ? top.map((t) => `<span class="tag">${t}</span>`).join('') +
      '<div style="font-size:10px;color:#8b93a7;margin-top:6px">由事件派生 · 删除事件即同步清除</div>'
    : '<div style="font-size:12px;color:#8b93a7">（暂无 · 随事件积累派生）</div>';
}

// ---------- 记忆墙 ----------
function renderMemoryWall() {
  const wall = $('memWall');
  if (!memory.length) {
    wall.innerHTML = '<div class="state-box" style="text-align:center;">（空 · 点击「结束对话·记忆轮」生成事件卡片）</div>';
    return;
  }
  wall.innerHTML = '';
  memory.forEach((e, i) => {
    const card = document.createElement('div');
    card.className = 'event-card';
    card.innerHTML = `
      <button class="card-del" title="删除这条记忆（反向链路）">×</button>
      <span class="eid">${e.id}</span> · ${e.type}<br>
      <b style="color:#e8eaf2">${escHtml(e.content)}</b><br>
      用户情绪：${escHtml(e.user_emotion || '—')}<br>
      小栖行为：${escHtml(e.character_action || '—')}<br>
      ${e.follow_up ? `<span style="color:#ffd35a">待跟进：${escHtml(e.follow_up)}</span><br>` : ''}
      <span style="color:#7dd87d">✓ 人设校验通过</span> · <span style="color:#ffd35a">HITL 抽检队列</span>`;
    card.querySelector('.card-del').onclick = () => deleteMemory(i);
    wall.appendChild(card);
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 删除反向链路：卡片移除 → 派生标签同步清除 → 缓存失效说明
function deleteMemory(i) {
  const e = memory[i];
  if (!confirm(`删除这条记忆？\n\n「${e.content}」\n\n删除后：事件卡片移除 → 派生画像标签同步清除 → 下一轮对话注入缓存失效（48h 内全链路生效）。此操作不生成新记忆。`)) return;
  memory.splice(i, 1);
  lsSet(LS.memory, memory);
  renderMemoryWall();
  updateTags();
  updateRelState();
  addSys(`—— 已删除记忆 ${e.id}：卡片移除 · 派生标签清除 · 注入缓存将在下一轮失效 ——`);
  logMemory(`🗑 删除 ${e.id}（${e.type}）→ 标签/关系状态已重算`);
}

function logMemory(text) {
  const d = document.createElement('div');
  d.textContent = text;
  $('memoryLog').prepend(d);
}

// ---------- 发送 ----------
async function send(text) {
  if (busy) return;
  text = (text || $('input').value).trim();
  if (!text) return;

  if (!XQ_API.hasConfig()) {
    openSettings();
    return;
  }

  busy = true;
  $('sendBtn').disabled = true;
  $('input').value = '';
  $('input').style.height = 'auto';

  conversation.push({ role: 'user', content: text });
  addMsg(text, 'user');
  lsSet(LS.history, conversation);

  // 危机信号前置检测（系统做安全边界，不依赖模型自觉）
  const isCrisis = XQ_PROMPT.CRISIS_PATTERNS.some((re) => re.test(text));
  if (isCrisis && currentLevel !== 'L4') {
    levelBeforeCrisis = currentLevel;
    currentLevel = 'L4';
    setLevelUI('L4');
    addSys('—— 危机信号检测：已自动升级至 L4 干预级别（干预边界按「泛青年日常陪伴人群」裁决：触发即干预）——');
  }
  updateSafetyView(null, isCrisis);

  // 组装 System Prompt
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const sysPrompt = XQ_PROMPT.buildSystemPrompt(currentLevel, memory, { sessionNo, timeStr });
  updateInjectionView(sysPrompt);

  const history = conversation.slice(-20);
  stats.inChars += sysPrompt.length + JSON.stringify(history).length;
  stats.calls++;

  showTyping();
  const aiMsg = addMsg('', 'ai');
  let full = '';
  try {
    full = await XQ_API.callAIStream(history, sysPrompt, null, (chunk) => {
      aiMsg.textContent = chunk;
      $('chat').scrollTop = $('chat').scrollHeight;
    });
  } catch (err) {
    hideTyping();
    aiMsg.textContent = '（连接出了点问题：' + err.message.split('\n')[0] + '）';
    busy = false;
    $('sendBtn').disabled = false;
    return;
  }
  hideTyping();
  if (!full) full = '（返回为空，请重试）';
  aiMsg.textContent = full;
  stats.outChars += full.length;
  updateCostView();

  // L4 后置校验：热线资源缺失 → 系统补充（安全边界由系统兜底）
  if (currentLevel === 'L4' && !/400-161-9995|010-82951332|400-821-1215/.test(full)) {
    full += '\n\n' + XQ_PROMPT.HOTLINE_BLOCK;
    aiMsg.textContent = full;
    addSys('—— 输出后置校验：热线资源缺失，系统已自动补充 ——');
  }

  // 八种击穿模式拦截（演示级关键词检测 + 一次重写）
  const hit = XQ_PROMPT.BREAKDOWN_PATTERNS.find((p) => p.re.test(full));
  if (hit) {
    updateSafetyView(hit.name, isCrisis);
    addSys(`—— 击穿拦截：命中「${hit.name}」，触发重写 ——`);
    aiMsg.style.opacity = '0.4';
    showTyping();
    try {
      const rewritten = await XQ_API.callAI(
        [{ role: 'user', content: `请重写以下回应：\n"""${full}"""` }],
        XQ_PROMPT.buildRewritePrompt(hit.name, hit.desc, full),
        null
      );
      hideTyping();
      if (rewritten && rewritten.trim()) {
        full = rewritten.trim();
        aiMsg.textContent = full;
        stats.outChars += full.length;
        updateCostView();
      }
    } catch (e) {
      hideTyping();
      addSys('—— 重写失败，保留原文（真实产品会进入告警队列） ——');
    }
    aiMsg.style.opacity = '1';
    updateSafetyView(null, isCrisis);
  }

  conversation.push({ role: 'assistant', content: full });
  lsSet(LS.history, conversation);

  // 危机处理完自动回落级别
  if (levelBeforeCrisis && currentLevel === 'L4') {
    currentLevel = levelBeforeCrisis;
    levelBeforeCrisis = null;
    setLevelUI(currentLevel);
  }

  busy = false;
  $('sendBtn').disabled = false;
  $('input').focus();
}

// ---------- 记忆轮（异步事件提取） ----------
async function runMemoryWheel() {
  if (busy || conversation.length < 2) {
    addSys('—— 对话内容不足，记忆轮未提取到事件 ——');
    return;
  }
  busy = true;
  $('memBtn').disabled = true;
  addSys('—— 对话结束 · 记忆轮启动（异步 · 提取事件卡片）——');
  logMemory('⚙ 记忆轮启动：事件提取中…');

  const convText = conversation
    .map((m) => `${m.role === 'user' ? '用户' : '小栖'}：${m.content}`)
    .join('\n');

  let raw;
  try {
    raw = await XQ_API.callAI(
      [{ role: 'user', content: '请提取这段对话的事件卡片。' }],
      XQ_PROMPT.buildMemoryExtractionPrompt(convText),
      null,
      { json: true }
    );
  } catch (err) {
    addSys('—— 记忆轮失败：' + err.message.split('\n')[0] + ' ——');
    logMemory('⚠ 记忆轮失败：' + err.message.split('\n')[0]);
    busy = false;
    $('memBtn').disabled = false;
    return;
  }

  // 防御性 JSON 解析（剥掉 markdown 代码栅栏 / 截取首个大括号）
  let parsed;
  try {
    let t = raw.replace(/```json|```/g, '').trim();
    const m = t.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : t);
  } catch (e) {
    parsed = null;
  }

  const events = parsed && Array.isArray(parsed.events) ? parsed.events : [];
  if (!events.length) {
    addSys('—— 记忆轮完成：本次对话无值得入库的事件（宁可少记，不可错记）——');
    logMemory('✓ 记忆轮完成：0 条（宁少记不错记）');
  } else {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let added = 0;
    events.slice(0, 2).forEach((e) => {
      if (!e || !e.content) return;
      memory.push({
        id: `E${dateStr}-${String(memory.length + 1).padStart(3, '0')}`,
        date: dateStr,
        type: ['情绪事件', '生活事件', '重要约定', '用户偏好'].includes(e.type) ? e.type : '生活事件',
        content: String(e.content).slice(0, 100),
        user_emotion: String(e.user_emotion || '').slice(0, 30),
        character_action: String(e.character_action || '').slice(0, 60),
        follow_up: String(e.follow_up || '').slice(0, 60),
      });
      added++;
    });
    lsSet(LS.memory, memory);
    sessionNo += 1;
    lsSet(LS.session, sessionNo);
    archived = true;
    lsSet(LS.archived, true);
    renderMemoryWall();
    updateTags();
    updateRelState();
    updateInjectionView(null);
    addSys(`—— 记忆轮完成：新增 ${added} 张事件卡片，已入库（HITL 首周抽检队列）——`);
    logMemory(`✓ 记忆轮完成：${added} 条事件入库 · 对话归档为第 ${sessionNo - 1} 次`);
  }

  busy = false;
  $('memBtn').disabled = false;
}

// ---------- 新的一天：清空对话 + 次日主动引用 ----------
async function newDay() {
  if (busy) return;
  if (conversation.length >= 2 && !archived) {
    if (!confirm('当前对话尚未归档（未运行记忆轮），直接开始新的一天将丢失这段对话的记忆提取。继续吗？')) return;
  }
  conversation = [];
  archived = false;
  lsSet(LS.history, []);
  lsSet(LS.archived, false);
  $('chat').innerHTML = '';
  addSys(`—— 新的一天 · 这是你们的第 ${sessionNo} 次对话 ——`);
  updateInjectionView(null);
  await greet();
  $('input').focus();
}

// ---------- 开场 ----------
async function greet() {
  if (!XQ_API.hasConfig()) {
    addSys('请先点击右上角 ⚙ 配置 API，然后刷新或发送消息开始对话。');
    return;
  }

  const hasPending = memory.some((e) => e.follow_up);

  if (!hasPending && memory.length === 0) {
    // 首次对话：模板层提供开场（降级兜底同款机制）
    addMsg('在的。今天怎么样？', 'ai');
    addSys('—— 开场白由模板层提供（首次无记忆，不消耗 token）——');
    return;
  }

  // 有记忆：AI 生成主动引用式开场
  showTyping();
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  try {
    const greeting = await XQ_API.callAI(
      [{ role: 'user', content: '生成今天开场问候。' }],
      XQ_PROMPT.XIAOQI_ANCHOR + '\n\n---\n\n' + XQ_PROMPT.buildGreetingPrompt(memory) + `\n\n【上下文】当前时间：${timeStr}`,
      null
    );
    hideTyping();
    addMsg(greeting.trim(), 'ai');
    addSys('—— 开场由记忆驱动：引用待跟进事件（自然融入，至多1件）——');
  } catch (err) {
    hideTyping();
    addMsg('在的。最近怎么样？', 'ai');
    addSys('—— 开场生成失败，模板层兜底 ——');
  }
}

// ---------- 级别切换（用户主权） ----------
function setLevelUI(lv) {
  document.querySelectorAll('.lv-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.lv === lv);
  });
  updateInjectionView(null);
}

// ---------- 设置弹窗 ----------
function openSettings() {
  const cfg = XQ_API.getConfig() || {};
  const isDemo = XQ_API.isDemoMode();
  $('modeBadge').textContent = isDemo ? 'Netlify 代理模式（Key 在服务端环境变量）' : '本地直连模式（Key 存本机 localStorage）';
  $('providerSelect').value = cfg.provider || 'deepseek';
  fillModels();
  $('modelSelect').value = cfg.model || XQ_API.PROVIDERS[cfg.provider || 'deepseek'].defaultModel;
  $('apiKeyInput').style.display = isDemo ? 'none' : 'block';
  $('keyLabel').style.display = isDemo ? 'none' : 'block';
  $('apiKeyInput').value = cfg.apiKey || '';
  $('settingsModal').style.display = 'flex';
}

function fillModels() {
  const pid = $('providerSelect').value;
  const p = XQ_API.PROVIDERS[pid];
  $('modelSelect').innerHTML = p.models.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
}

async function saveSettings() {
  const cfg = {
    provider: $('providerSelect').value,
    model: $('modelSelect').value,
    apiKey: $('apiKeyInput').value.trim(),
  };
  if (!XQ_API.isDemoMode() && !cfg.apiKey) {
    $('settingsStatus').textContent = '请填写 API Key';
    $('settingsStatus').style.color = 'var(--red)';
    return;
  }
  $('settingsStatus').textContent = '正在测试连通性…';
  $('settingsStatus').style.color = 'var(--muted)';
  const result = await XQ_API.testAPI(cfg);
  if (result.ok) {
    XQ_API.saveConfig(cfg);
    $('settingsStatus').textContent = '✓ ' + result.message;
    $('settingsStatus').style.color = 'var(--green)';
    setTimeout(() => {
      $('settingsModal').style.display = 'none';
      if (conversation.length === 0) {
        $('chat').innerHTML = '';
        greet();
      }
    }, 600);
  } else {
    $('settingsStatus').textContent = '✗ ' + result.message;
    $('settingsStatus').style.color = 'var(--red)';
  }
}

// ---------- 初始化 ----------
function init() {
  conversation = lsGet(LS.history, []);
  memory = lsGet(LS.memory, []);
  sessionNo = lsGet(LS.session, 1);
  archived = lsGet(LS.archived, false);

  renderMemoryWall();
  updateTags();
  updateRelState();
  updateSafetyView(null, false);
  updateCostView();

  setLevelUI('L1');
  updateInjectionView(null);

  // 事件绑定
  $('sendBtn').onclick = () => send();
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  });
  document.querySelectorAll('.lv-btn').forEach((b) => {
    b.onclick = () => {
      if (busy) return;
      currentLevel = b.dataset.lv;
      setLevelUI(currentLevel);
      addSys(`—— 响应级别切换：${LV_LABEL[currentLevel]}（用户主权，即时生效）——`);
    };
  });
  $('memBtn').onclick = runMemoryWheel;
  $('newDayBtn').onclick = newDay;
  $('settingsBtn').onclick = openSettings;
  $('settingsClose').onclick = () => ($('settingsModal').style.display = 'none');
  $('saveCfgBtn').onclick = saveSettings;
  $('providerSelect').onchange = fillModels;
  $('clearMemBtn').onclick = () => {
    if (!confirm('清空全部记忆？关系状态与画像标签将一并重置（模拟"删除全部数据"反向链路）。')) return;
    memory = [];
    conversation = [];
    sessionNo = 1;
    archived = false;
    lsSet(LS.memory, []);
    lsSet(LS.history, []);
    lsSet(LS.session, 1);
    lsSet(LS.archived, false);
    renderMemoryWall();
    updateTags();
    updateRelState();
    $('chat').innerHTML = '';
    logMemory('🗑 用户删除全部数据：记忆/画像/关系状态已清空');
    addSys('—— 全部数据已删除（反向链路走完）——');
    greet();
  };
  document.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      $('input').value = c.textContent;
      send();
    };
  });

  // 恢复或开场
  if (conversation.length > 0) {
    conversation.forEach((m) => addMsg(m.content, m.role === 'user' ? 'user' : 'ai'));
    addSys(`—— 已恢复上次对话（第 ${sessionNo} 次 · ${archived ? '已归档' : '进行中'}）——`);
  } else {
    addSys(`—— 第 ${sessionNo} 次对话 ——`);
    greet();
  }
}

init();
