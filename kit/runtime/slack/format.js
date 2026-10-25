'use strict';

// The one Slack formatter and splitter (Story 9.2). Every reply, ephemeral or
// in a modal view, goes through splitText, so no Slack section is ever over
// its limit and a long answer arrives whole instead of cut off.
//
// toMrkdwn(markdown) turns ordinary markdown (headings, bold, italics, links,
// lists, quotes, code) into Slack mrkdwn and escapes &, < and > on the way, so
// nothing in the input can mention, link or format beyond what it asked for.
// Only http(s) and mailto links become links. It is for raw markdown (a
// module's text, later the AI's answer); text that is already mrkdwn, such as
// kit/runtime/messages output, must not go through it (it would escape twice).
//
// splitText(text) cuts mrkdwn into sections under SECTION_LIMIT characters,
// on a line break where it can, then a space, else a hard cut that never
// splits an escape (&amp;), an emoji or a <link|text>. A code block cut across
// sections is closed at the end of one and reopened at the start of the next.
//
// Thread history is never turned into AI messages in V1: a thread can hold
// result rows, and rows never reach the AI (NFR9). Nothing here reads a thread.

// Slack allows 3000 characters in a section; 2900 leaves headroom.
const SECTION_LIMIT = 2900;
// Slack allows 50 blocks in one message (a modal view allows 100).
const MAX_MESSAGE_BLOCKS = 50;

const FENCE = '```';
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Placeholders use private-use characters, stripped from the input first.
const HOLD = '';
const BOLD = '';
const stripPrivate = (s) => s.replace(/[-]/g, '');

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>|"]+$/i;

// Bold, italics and strikethrough on text that is already escaped.
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`)
    .replace(/(^|[^*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])/g, '$1_$2_')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~')
    .replace(new RegExp(BOLD, 'g'), '*');
}

// One line's inline markdown: code spans kept (escaped only), links made
// Slack links when safe, the rest escaped then given Slack emphasis.
function inline(line) {
  const held = [];
  const hold = (s) => { held.push(s); return `${HOLD}${held.length - 1}${HOLD}`; };
  let s = line.replace(/`([^`\n]+)`/g, (_, code) => hold(`\`${escapeText(code)}\``));
  s = s.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const text = emphasis(escapeText(label.trim())) || escapeText(url);
    if (!SAFE_URL.test(url)) return hold(`${text} (${escapeText(url)})`);
    return hold(`<${url.replace(/&/g, '&amp;')}|${text}>`);
  });
  s = emphasis(escapeText(s));
  return s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i) => held[Number(i)]);
}

// Markdown to Slack mrkdwn, line by line. Fenced code keeps its text (escaped)
// and loses its language tag; an unclosed fence is closed at the end.
function toMrkdwn(markdown) {
  const lines = stripPrivate(String(markdown == null ? '' : markdown)).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null; // the opening marker while inside a code block
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.trim().slice(marker[1].length)) {
        out.push(FENCE);
        fence = null;
      } else {
        out.push(escapeText(line));
      }
      continue;
    }
    if (marker) {
      fence = marker[1];
      out.push(FENCE);
      continue;
    }
    let m;
    if ((m = line.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/))) {
      const text = inline(m[1].replace(/\*\*|__/g, ''));
      out.push(text ? `*${text}*` : '');
    } else if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('───');
    } else if ((m = line.match(/^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
      const indent = '    '.repeat(Math.floor(m[1].replace(/\t/g, '    ').length / 2));
      const box = m[2] === undefined ? '' : (m[2] === ' ' ? '☐ ' : '☑ ');
      out.push(`${indent}• ${box}${inline(m[3])}`);
    } else if ((m = line.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/))) {
      const indent = '    '.repeat(Math.floor(m[1].replace(/\t/g, '    ').length / 2));
      out.push(`${indent}${m[2]}. ${inline(m[3])}`);
    } else if ((m = line.match(/^ {0,3}>\s?(.*)$/))) {
      out.push(`> ${inline(m[1])}`);
    } else {
      out.push(inline(line));
    }
  }
  if (fence) out.push(FENCE);
  return out.join('\n');
}

const fencesIn = (s) => (s.match(/```/g) || []).length;

// Where to cut rest so the piece fits in room characters.
function cutPoint(rest, room) {
  let cut = rest.lastIndexOf('\n', room);
  let drop = 1;
  if (cut <= 0) cut = rest.lastIndexOf(' ', room);
  if (cut > 0) {
    // Never inside a <link|text>: cut before it instead.
    const open = rest.lastIndexOf('<', cut);
    if (open > 0 && open > rest.lastIndexOf('>', cut)) { cut = open; drop = 0; }
    return { cut, drop };
  }
  cut = room;
  const amp = rest.lastIndexOf('&', cut);
  if (amp > 0 && cut - amp < 6 && !rest.slice(amp, cut).includes(';')) cut = amp;
  const open = rest.lastIndexOf('<', cut);
  if (open > 0 && open > rest.lastIndexOf('>', cut - 1)) cut = open;
  // Never through a run of backticks (a fence would stop being one).
  while (cut > 1 && rest[cut] === '`' && rest[cut - 1] === '`') cut -= 1;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { cut: cut > 0 ? cut : room, drop: 0 };
}

// Splits mrkdwn into sections of at most max characters (see the top).
function splitText(text, max = SECTION_LIMIT) {
  const parts = [];
  let rest = String(text == null ? '' : text);
  let inCode = false;
  for (;;) {
    const prefix = inCode ? `${FENCE}\n` : '';
    if (prefix.length + rest.length <= max) {
      if (rest.length || prefix || !parts.length) parts.push(prefix + rest);
      return parts;
    }
    // Room for the reopened fence and a possible closing "\n```".
    const room = max - prefix.length - (FENCE.length + 1);
    const { cut, drop } = cutPoint(rest, room);
    const piece = rest.slice(0, cut);
    const open = (fencesIn(piece) % 2 === 1) !== inCode;
    parts.push(prefix + piece + (open ? `\n${FENCE}` : ''));
    inCode = open;
    rest = rest.slice(cut + drop);
  }
}

// mrkdwn text as section blocks, one per piece.
const textBlocks = (text) => splitText(text).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t || ' ' } }));

// Raw markdown straight to section blocks.
const formatBlocks = (markdown) => textBlocks(toMrkdwn(markdown));

// A reply as the messages to send it as (ephemeral replies). Text that fits
// one section stays a plain text message; longer text becomes section blocks,
// at most 50 per message, with the first piece as the notification text.
// A message that brings its own blocks is sent as it is.
function messageParts(message) {
  const m = typeof message === 'string' ? { text: message } : (message || { text: '' });
  if (Array.isArray(m.blocks) && m.blocks.length) return [m];
  const text = String(m.text == null ? '' : m.text);
  if (text.length <= SECTION_LIMIT) return [m];
  const blocks = textBlocks(text);
  const out = [];
  for (let i = 0; i < blocks.length; i += MAX_MESSAGE_BLOCKS) {
    const chunk = blocks.slice(i, i + MAX_MESSAGE_BLOCKS);
    out.push({ ...m, text: chunk[0].text.text, blocks: chunk });
  }
  return out;
}

module.exports = {
  toMrkdwn, splitText, textBlocks, formatBlocks, messageParts, SECTION_LIMIT, MAX_MESSAGE_BLOCKS,
};
