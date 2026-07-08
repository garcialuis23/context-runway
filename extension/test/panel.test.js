'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPanelHtml, getNonce } = require('../src/panel');

test('getNonce', async (t) => {
  await t.test('is 32 characters long', () => {
    assert.equal(getNonce().length, 32);
  });

  await t.test('only uses alphanumeric characters', () => {
    assert.match(getNonce(), /^[A-Za-z0-9]{32}$/);
  });

  await t.test('is different on every call', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => getNonce()));
    // Astronomically unlikely to collide 20 times in a row if this is
    // actually random; a fixed/constant nonce would fail this immediately.
    assert.equal(nonces.size, 20);
  });
});

test('renderPanelHtml', async (t) => {
  await t.test('embeds the given nonce in both the CSP and the tags it authorizes', () => {
    const nonce = 'TESTNONCE1234567890TESTNONCE1234';
    const html = renderPanelHtml(nonce);

    assert.match(html, new RegExp(`style-src 'nonce-${nonce}'`));
    assert.match(html, new RegExp(`script-src 'nonce-${nonce}'`));
    assert.match(html, new RegExp(`<style nonce="${nonce}">`));
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  });

  await t.test('does not leak one nonce into a page rendered for another', () => {
    const htmlA = renderPanelHtml('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const htmlB = renderPanelHtml('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    assert.ok(!htmlA.includes('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'));
    assert.ok(!htmlB.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  });

  await t.test('produces a well-formed HTML document with the expected title', () => {
    const html = renderPanelHtml(getNonce());
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>Context Runway<\/title>/);
    assert.match(html, /<\/html>$/);
    // Every opening tag we care about has a matching close, i.e. the
    // template literal isn't missing/duplicating a closing tag.
    for (const tag of ['html', 'head', 'body', 'script', 'style']) {
      const opens = (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
      const closes = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(opens, closes, `mismatched <${tag}> tags`);
    }
  });

  await t.test('CSP has no unsafe-inline or wildcard sources', () => {
    const html = renderPanelHtml(getNonce());
    const cspMatch = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
    assert.ok(cspMatch, 'expected a CSP meta tag');
    assert.ok(!cspMatch[1].includes('unsafe-inline'));
    assert.ok(!cspMatch[1].includes('*'));
  });
});
