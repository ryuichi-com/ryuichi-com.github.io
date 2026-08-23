/* ============================================================================
   Physio Ryu Tokyo — 共通スクリプト（全ページ共通で読み込む）
   ---------------------------------------------------------------------------
   ビルド不要のバニラJS。読み込みは </body> 直前で <script src="js/site.js" defer>。
   やっていることは3つだけ:
     1) グローバルナビの開閉（スマホ）
     2) 軽いフェードイン（IntersectionObserver / .reveal に付ける）
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
     2. フェードイン
        .reveal を付けた要素だけが対象。JS が .reveal-ready を足してから
        観測するので、JS が動かない環境では最初から表示されたままになる。
  --------------------------------------------------------------------- */
  function initReveal() {
    var targets = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!targets.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) return;

    targets.forEach(function (el) { el.classList.add('reveal-ready'); });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    targets.forEach(function (el) { io.observe(el); });

    // 初期表示で画面内にある要素は即座に出す（観測の取りこぼし防止）
    window.setTimeout(function () {
      targets.forEach(function (el) {
        var rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.95) el.classList.add('is-visible');
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
