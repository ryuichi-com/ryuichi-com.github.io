// 折り返しの点検。全ページを実際に描画して、1行ずつの文字数を測る。
//
// 「回復期リハビリテーシ／ョン。」のような語中の分断や、
// 「す。」「を、」だけの行が出ていないかを機械的に見つけるためのもの。
// サイトの動作には不要。修正したあとの確認だけに使う。
//
//   npm install playwright && npx playwright install chromium
//   cd physio-ryu-tokyo && python3 -m http.server 8765
//   node tools/check-line-breaks.mjs
//
// 引数（どちらも省略可）
//   第1: これ未満の文字数の行を報告する（既定 5）
//   第2: 確認する画面幅をカンマ区切りで（既定 360,390,430,768,1366）
//
//   node tools/check-line-breaks.mjs 6 375,390,1366

import { chromium } from 'playwright';

const BASE  = process.env.BASE || 'http://localhost:8765';
const MIN   = Number(process.argv[2] || 5);
const WIDTHS = (process.argv[3] || '360,390,430,768,1366').split(',').map(Number);
const PAGES = ['/', '/about/', '/after-treatment/', '/first-visit/', '/access/', '/legal/', '/privacy/'];

// ブロック要素ごとに、子孫のテキストを1文字ずつ測って「実際に見えている行」に組み直す。
// 行の判定は上端ではなく左端の巻き戻りで見る。
// 同じ行に大きさの違う文字が混じると（価格の「1回」など）上端がずれるため。
const collect = (min) => {
  const BLOCKS = 'p,li,dd,dt,h1,h2,h3,h4,summary,figcaption,blockquote,td,th';
  const found = [];
  document.querySelectorAll(BLOCKS).forEach((el) => {
    if (el.closest('.ph__label')) return;        // 写真の撮影指示は本文ではない
    if (el.closest('.flow__step')) return;       // 「見る／評価」は2段組みなので折り返しではない
    if (el.querySelector(BLOCKS)) return;        // 入れ子の親は数えない
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const lines = [];
    let prevLeft = null, prevTop = null, buf = '', node;

    while ((node = walker.nextNode())) {
      if (!node.data.trim()) continue;
      for (let i = 0; i < node.data.length; i++) {
        const ch = node.data[i];
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect) { if (ch.trim()) buf += ch; continue; }
        if (prevLeft !== null && rect.left < prevLeft - 1 && rect.top > prevTop - 2) {
          if (buf.trim()) lines.push(buf.trim());
          buf = '';
        }
        prevLeft = rect.left;
        prevTop = rect.top;
        buf += ch;
      }
    }
    if (buf.trim()) lines.push(buf.trim());
    if (lines.length < 2) return;                // 折り返していない

    lines.forEach((line, i) => {
      if (line.length < min) {
        found.push({
          line, at: i + 1, of: lines.length,
          where: el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ').join('.') : ''),
          whole: lines.join('／'),
        });
      }
    });
  });
  return found;
};

const browser = await chromium.launch();
let count = 0;

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();

  for (const path of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    // スクロール演出で隠れている要素も、出た状態にしてから測る
    await page.evaluate(() => document.querySelectorAll('.reveal-ready').forEach((e) => e.classList.add('is-visible')));

    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth - d.clientWidth;
    });
    if (overflow > 1) {
      count++;
      console.log(`\n!!! ${width}px ${path} 横スクロールが出ています（${overflow}px）`);
    }

    const found = await page.evaluate(collect, MIN);
    if (found.length) {
      console.log(`\n### ${width}px ${path}`);
      for (const f of found) {
        count++;
        console.log(`  [${f.line.length}文字] 「${f.line}」 ${f.at}/${f.of}行目  <${f.where}>`);
        console.log(`      ${f.whole}`);
      }
    }
  }
  await ctx.close();
}

await browser.close();
console.log(count === 0
  ? `\n${MIN}文字未満の行はありません（${WIDTHS.join(' / ')}px）`
  : `\n合わせて ${count} 件`);
