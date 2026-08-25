/* ============================================================================
   Physio Ryu Tokyo — 共通スクリプト（全ページ共通で読み込む）
   ---------------------------------------------------------------------------
   ビルド不要のバニラJS。読み込みは </body> 直前で <script src="js/site.js" defer>。
   やっていることは3つだけ:
     1) グローバルナビの開閉（スマホ）
     2) スクロールに合わせて現れる演出（IntersectionObserver / .reveal に付ける）
     3) スマホ下部の固定CTAの表示制御（ページ内CTAが見えている間は引っ込める）
   FAQ は <details>/<summary> のネイティブ動作なので JS は使わない。
   JSが動かなくても、内容はすべて読める状態を保つこと。
============================================================================ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  /* ---------------------------------------------------------------------
     1. グローバルナビの開閉
        必要なマークアップ:
          <header class="site-header" id="siteHeader">
            <button class="nav-toggle" aria-expanded="false" aria-controls="gnav">
            <nav class="gnav" id="gnav">
  --------------------------------------------------------------------- */
  function initNav() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var toggle = header.querySelector('.nav-toggle');
    var nav = header.querySelector('.gnav');
    if (!toggle || !nav) return;

    function setOpen(open) {
      header.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function () {
      setOpen(!header.classList.contains('is-open'));
    });

    // メニュー内のリンクを押したら閉じる
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    // Esc で閉じる
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    // 画面外をクリックしたら閉じる
    document.addEventListener('click', function (e) {
      if (!header.classList.contains('is-open')) return;
      if (!header.contains(e.target)) setOpen(false);
    });

    // PC幅に戻したら状態をリセット
    if (window.matchMedia) {
      var mq = window.matchMedia('(min-width: 768px)');
      var onChange = function (ev) { if (ev.matches) setOpen(false); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------------------------------------------------------------------
     2. スクロールに合わせて現れる演出
        .reveal を付けた範囲の「中身ひとつずつ」を出す。
        範囲ごとにまとめて出すと、長いセクションでは画面外の要素まで
        一度に動いてしまい、スクロールと動きがつながらない。

        JS が .reveal-ready を足してから観測するので、
        JS が動かない環境では最初から表示されたままになる。

        同じタイミングで画面に入ったものだけ、順に少しずつ遅らせる。
        別々にスクロールインしたものには遅れを付けない
        （待たされているように見えるため）。
  --------------------------------------------------------------------- */

  // 中身を1段だけ開いて数える箱。並んでいるものが順に出た方が気持ちがよい
  var REVEAL_FLATTEN = '.steps, .list-dot, .ph-grid, .faq';
  var STAGGER_MS = 90;   // 同時に入ったとき、1つあたりの遅れ
  var STAGGER_MAX = 4;   // 遅らせる段数の上限。これ以上は待たされて見える

  function revealItems(block) {
    var items = [];
    Array.prototype.forEach.call(block.children, function (child) {
      if (child.matches && child.matches(REVEAL_FLATTEN) && child.children.length) {
        Array.prototype.push.apply(items, Array.prototype.slice.call(child.children));
      } else {
        items.push(child);
      }
    });
    return items;
  }

  function initReveal() {
    var blocks = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!blocks.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) return;

    var targets = [];
    blocks.forEach(function (block) {
      revealItems(block).forEach(function (el) {
        el.classList.add('reveal-ready');
        targets.push(el);
      });
    });
    if (!targets.length) return;

    function show(el, step) {
      if (step) el.style.setProperty('--reveal-delay', (step * STAGGER_MS) + 'ms');
      el.classList.add('is-visible');
    }

    var io = new IntersectionObserver(function (entries) {
      var step = 0;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        show(entry.target, Math.min(step, STAGGER_MAX));
        step++;
        io.unobserve(entry.target);
      });
    }, {
      // 画面の下から1割ほど入ったところで出す。
      // threshold は 0 にしておく。罫のように面積が 0 の要素は
      // 割合で判定すると、いつまでも条件を満たさないため
      rootMargin: '0px 0px -10% 0px',
      threshold: 0
    });

    targets.forEach(function (el) { io.observe(el); });

    // 初期表示で画面内にあるものは、観測を待たずに出す（取りこぼし防止）
    window.setTimeout(function () {
      var step = 0;
      targets.forEach(function (el) {
        if (el.classList.contains('is-visible')) return;
        if (el.getBoundingClientRect().top < window.innerHeight * 0.95) {
          show(el, Math.min(step, STAGGER_MAX));
          step++;
        }
      });
    }, 60);
  }

  /* ---------------------------------------------------------------------
     3. 固定CTAの表示制御
        既定は表示。ファーストビュー（[data-cta-hide] を付けた要素、通常はヒーローと
        セクション内CTA）が画面に入っている間だけ .is-hidden を付けて引っ込める。
  --------------------------------------------------------------------- */
  function initFixedCta() {
    var bar = document.querySelector('.fixed-cta');
    if (!bar) return;

    var zones = Array.prototype.slice.call(document.querySelectorAll('[data-cta-hide]'));
    if (!zones.length || !('IntersectionObserver' in window)) return;

    // 「今、画面に入っている要素」を配列で管理する（増減カウントだと初期化時にずれる）
    var visible = [];

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var i = visible.indexOf(entry.target);
        if (entry.isIntersecting) {
          if (i === -1) visible.push(entry.target);
        } else if (i !== -1) {
          visible.splice(i, 1);
        }
      });
      bar.classList.toggle('is-hidden', visible.length > 0);
    }, { threshold: 0 });

    zones.forEach(function (el) { io.observe(el); });
  }

  function init() {
    initNav();
    initReveal();
    initFixedCta();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
