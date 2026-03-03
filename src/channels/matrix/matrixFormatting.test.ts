import test from "node:test";
import assert from "node:assert/strict";

import { formatMarkdownResponse } from "./matrixFormatting.js";

test("returns undefined formattedBody for blank markdown", () => {
  const result = formatMarkdownResponse("   \n\n  ");

  assert.equal(result.body, "   \n\n  ");
  assert.equal(result.formattedBody, undefined);
});

test("renders inline markdown with escaping", () => {
  const result = formatMarkdownResponse("Use **bold** and *italics* with `code` and <tag>.");

  assert.equal(
    result.formattedBody,
    "<p>Use <strong>bold</strong> and <em>italics</em> with <code>code</code> and &lt;tag&gt;.</p>"
  );
});

test("renders unordered and ordered lists", () => {
  const result = formatMarkdownResponse("- first\n- second\n\n1. one\n2. two");

  assert.equal(result.formattedBody, "<ul><li>first</li><li>second</li></ul><ol><li>one</li><li>two</li></ol>");
});

test("renders fenced code blocks with language hints", () => {
  const result = formatMarkdownResponse("```ts\nconst x = 1 < 2;\n```\n");

  assert.equal(result.formattedBody, "<pre><code>const x = 1 &lt; 2;\n</code></pre>");
});

test("renders links from markdown syntax", () => {
  const result = formatMarkdownResponse("See [docs](https://example.com/docs).\nNext line");

  assert.equal(
    result.formattedBody,
    '<p>See <a href="https://example.com/docs">docs</a>.<br/>Next line</p>'
  );
});

test("renders markdown tables", () => {
  const result = formatMarkdownResponse(
    "| Name | Score |\n| --- | --- |\n| Alice | 10 |\n| Bob | 8 |"
  );

  assert.equal(
    result.formattedBody,
    "<table><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>Alice</td><td>10</td></tr><tr><td>Bob</td><td>8</td></tr></tbody></table>"
  );
});
