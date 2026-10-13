import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLessons } from '../src/memory/ProjectMemory';
import { classifyCommand } from '../src/permissions/commandRisk';
import { parseReview } from '../src/supervisor/Supervisor';
import { stripAnsi } from '../src/tools/TerminalTools';
import { htmlToText } from '../src/tools/WebTools';

/** Inputs crafted to make backtracking regexes quadratic: each must be handled in well under a second. */
function fast(label: string, run: () => unknown): void {
  const start = performance.now();
  run();
  const ms = performance.now() - start;
  assert.ok(ms < 1500, `${label} took ${Math.round(ms)} ms`);
}

describe('Text processing stays fast on hostile input', () => {
  it('web pages with thousands of unclosed tags and comments', () => {
    fast('unclosed comments', () => htmlToText('<!--'.repeat(200_000)));
    fast('unclosed links', () => htmlToText('<a href="x">'.repeat(100_000)));
    fast('unclosed scripts', () => htmlToText('<p>text</p><script>'.repeat(50_000)));
    fast('unclosed titles', () => htmlToText('<title>a'.repeat(100_000)));
    fast('lone angle brackets', () => htmlToText('<'.repeat(500_000)));
    fast('unclosed headings and code', () => htmlToText('<h2><code><strong><pre>'.repeat(60_000)));
  });

  it('still turns ordinary HTML into the same text', () => {
    const { title, text } = htmlToText(
      '<html><head><title>T &amp; U</title><script>x()</script></head><body><!-- c --><nav>menu</nav><h1>Head</h1><p>See <a href="/docs">the docs</a> and <a href="javascript:alert(1)">this</a>, <a href="data:text/html,x">that</a>.</p><pre>let a = 1;</pre><b>bold</b></body></html>',
      'https://example.com/',
    );
    assert.equal(title, 'T & U');
    assert.match(text, /^# Head$/m);
    assert.match(text, /See \[the docs\]\(https:\/\/example\.com\/docs\) and this, that\./);
    assert.match(text, /```\nlet a = 1;\n```/);
    assert.match(text, /\*\*bold\*\*/);
    assert.doesNotMatch(text, /menu|x\(\)|<!--/);
  });

  it('keeps pages with optional end tags, similar tag names and Turkish text', () => {
    // </head> is optional in HTML: the page must not vanish.
    assert.match(htmlToText('<html><head><meta charset=utf-8><title>Docs</title><body><h1>Guide</h1><p>Hello world.</p>').text, /# Guide\n\nHello world\./);
    assert.match(htmlToText('<body><nav><a href="/a">A</a><h1>Guide</h1><p>Body.</p>').text, /# Guide/);
    // "</a" is not "</abbr>", "</b" is not "</body>".
    assert.equal(htmlToText('<p><a href="/x"><abbr>API</abbr> reference</a></p>', 'https://e.com/').text, '[API reference](https://e.com/x)');
    assert.match(htmlToText('<p><b>Note:</p><h2>Install</h2><p>Para one.</p></body>').text, /^## Install$/m);
    // "İ" lowercases to two characters; nothing may shift after it.
    const tr = htmlToText('<head><title>İzmir İstanbul</title></head><p>İçerik <b>kalın</b> ve <a href="/x">bağlantı</a>.</p>', 'https://e.com/');
    assert.equal(tr.title, 'İzmir İstanbul');
    assert.equal(tr.text, 'İçerik **kalın** ve [bağlantı](https://e.com/x).');
    fast('similar closing tags', () => htmlToText('<a href="x"></abbr>'.repeat(100_000)));
    fast('unclosed nav, form and head', () => htmlToText('<nav><form><head>x'.repeat(100_000)));
    fast('Turkish text between tags', () => htmlToText('<p>İ<b>İ</b></p>'.repeat(100_000)));
  });

  it('command output, supervisor replies, lessons and commands', () => {
    fast('unterminated escape sequences', () => stripAnsi('\u001b]'.repeat(300_000)));
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m \u001b]0;title\u0007done'), 'red done');
    fast('unclosed verdicts', () => parseReview(`<verdict>intervene</verdict>${'<verdict>'.repeat(100_000)}`));
    fast('lesson lines full of spaces', () => parseLessons(`* ${' '.repeat(200_000)}x`));
    fast('long command lines', () => classifyCommand(`node ${'a '.repeat(100_000)}-e "console.log(1)"`));
    fast('open( without a closing parenthesis', () => classifyCommand(`python -c "${'open('.repeat(50_000)}"`));
  });
});
