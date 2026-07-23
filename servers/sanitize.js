/**
 * sanitize.js — Defensive scrubber for attacker-controlled email content
 * before it lands in the LLM context.
 *
 * Threat model: any string sourced from an email sender is untrusted. Hostile
 * senders can hide instructions via:
 *  - <script>/<style> content the trivial-regex stripper leaves behind
 *  - HTML entities that decode to live syntax after stripping
 *  - CSS-hidden elements (display:none, color:white, font-size:0, etc.)
 *  - Zero-width / bidi / word-joiner characters
 *  - Unicode Tags block (U+E0000–U+E007F) used for invisible steganography
 *  - Variation selectors abused on non-emoji bases
 *  - Confusables / homoglyphs (folded by NFKC)
 *
 * Strategy: parse, strip, decode, normalize, length-cap, then wrap in clear
 * untrusted-data delimiters so the model sees the boundary.
 */

import sanitizeHtmlLib from "sanitize-html";
import he from "he";

const INVISIBLE_RX =
  /[​-‏⁠-⁯﻿]/g;
const TAGS_BLOCK_RX = /[\u{E0000}-\u{E007F}]/gu;
const VARIATION_SELECTORS_RX = /[︀-️]/g;

const HIDDEN_STYLE_RX =
  /(?:^|;|\s)(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\b|font-size\s*:\s*0(?:px|pt|em|rem)?\b|color\s*:\s*(?:white|#fff(?:fff)?|rgba?\(\s*255\s*,\s*255\s*,\s*255)|left\s*:\s*-\d{3,}px|text-indent\s*:\s*-\d{3,}px)/i;

const HTML_NONTEXT_TAGS = [
  "script",
  "style",
  "head",
  "title",
  "meta",
  "link",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
];

function stripHtml(html) {
  // Two-pass: pass 1 keeps the tag tree so exclusiveFilter can drop the
  // entire subtree for elements with hidden styles. Pass 2 strips remaining
  // tags but preserves visible text.
  const passOne = sanitizeHtmlLib(html, {
    allowedTags: false, // allow all tags
    allowedAttributes: false,
    nonTextTags: HTML_NONTEXT_TAGS, // strips content inside, including script/style
    allowVulnerableTags: true, // we don't render the output, sanitize-html is parser-only
    exclusiveFilter: (frame) => {
      const style = frame.attribs?.style || "";
      return HIDDEN_STYLE_RX.test(style);
    },
  });
  return sanitizeHtmlLib(passOne, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: HTML_NONTEXT_TAGS,
  });
}

function stripInvisibles(s) {
  return s
    .replace(INVISIBLE_RX, "")
    .replace(TAGS_BLOCK_RX, "")
    .replace(VARIATION_SELECTORS_RX, "");
}

/**
 * Sanitize a plaintext field (subject, from, snippet, or already-stripped body).
 * Decodes entities, strips invisibles, NFKC-normalizes, collapses whitespace,
 * caps length.
 */
export function sanitizeText(text, { maxLen = 5000 } = {}) {
  if (!text) return "";
  let s = String(text);
  s = he.decode(s);
  s = stripInvisibles(s);
  s = s.normalize("NFKC");
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*\n\s*/g, "\n\n").trim();
  if (s.length > maxLen) s = s.substring(0, maxLen) + "\n[...truncated]";
  return s;
}

/**
 * Sanitize an HTML email body. Decode entities FIRST so smuggled
 * &lt;script&gt; payloads parse as real tags and get stripped, then strip
 * tags (dropping <script>/<style> content and hidden-styled subtrees),
 * then run text-level scrubbing.
 */
export function sanitizeHtml(html, opts = {}) {
  if (!html) return "";
  const decoded = he.decode(String(html));
  const stripped = stripHtml(decoded);
  return sanitizeText(stripped, opts);
}

/**
 * Wrap sanitized untrusted content in unambiguous delimiters so the model
 * sees a clear data-vs-instruction boundary.
 */
export function wrapUntrusted(text, kind = "EMAIL_CONTENT") {
  return `<<<${kind}_BEGIN>>>\n${text}\n<<<${kind}_END>>>`;
}
