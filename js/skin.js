// ============================================================
// 小栖 · 皮肤切换 skin.js（新增文件，不改动核心代码）
// 功能：右上角注入「🎨 皮肤」入口按钮 + 下拉菜单；
//       三款皮肤（moon 默认 / taro 香芋奶油 / sage 陶土鼠尾草）；
//       选择记忆在 localStorage（key: xq_skin），刷新后保持。
// 依赖：skins.css 中的 [data-skin] 变量覆盖。
// ============================================================
(function () {
  var SKINS = [
    { id: 'moon', name: '夜晚看月亮', emoji: '🌙', desc: '默认深色' },
    { id: 'taro', name: '香芋奶油', emoji: '💜', desc: '香芋紫 + 奶油米白' },
    { id: 'sage', name: '陶土鼠尾草', emoji: '🌿', desc: '陶土橙 + 鼠尾草绿' }
  ];
  var KEY = 'xq_skin';

  function apply(id) {
    var s = SKINS.find(function (x) { return x.id === id; }) || SKINS[0];
    document.documentElement.dataset.skin = s.id;
    try { localStorage.setItem(KEY, s.id); } catch (e) {}
    var avatar = document.querySelector('.avatar');
    if (avatar) avatar.textContent = s.emoji;
    var btn = document.getElementById('skinBtn');
    if (btn) btn.innerHTML = '🎨 皮肤设置';
    document.querySelectorAll('.skin-opt').forEach(function (o) {
      o.classList.toggle('active', o.dataset.id === s.id);
    });
  }

  function build() {
    var toolbar = document.querySelector('.toolbar');
    if (!toolbar || document.getElementById('skinBtn')) return;

    var wrap = document.createElement('div');
    wrap.className = 'skin-wrap';
    wrap.innerHTML =
      '<button class="tbtn" id="skinBtn">🎨 皮肤设置</button>' +
      '<div class="skin-menu" id="skinMenu"></div>';
    toolbar.appendChild(wrap);

    var menu = document.getElementById('skinMenu');
    SKINS.forEach(function (s) {
      var opt = document.createElement('button');
      opt.className = 'skin-opt';
      opt.dataset.id = s.id;
      opt.innerHTML =
        '<span class="e">' + s.emoji + '</span>' +
        '<span class="n">' + s.name + '</span>' +
        '<span class="d">' + s.desc + '</span>';
      opt.onclick = function () {
        apply(s.id);
        menu.classList.remove('open');
      };
      menu.appendChild(opt);
    });

    document.getElementById('skinBtn').onclick = function (e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    document.addEventListener('click', function () {
      menu.classList.remove('open');
    });

    var saved = 'moon';
    try { saved = localStorage.getItem(KEY) || 'moon'; } catch (e) {}
    apply(SKINS.some(function (s) { return s.id === saved; }) ? saved : 'moon');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
