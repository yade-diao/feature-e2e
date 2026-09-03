/**
 * The feature reader, and the environment origin a feature names.
 *
 * `baseUrlFromFeature` is what lets `record` run without a BASE_URL env var: the
 * login step's Url column already names the entry page, and a forgotten env var
 * used to point the whole run at an unrelated public site. These pin down that it
 * reads the first URL's origin, drops the path, and returns null (not a throw,
 * not a placeholder) when the feature names none.
 *
 * Run with: node --test src/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseUrlFromFeature, allSteps } from '../feature.mjs';

/** Write a feature file to a scratch dir and return its path plus a cleanup. */
function featureFile(text) {
  const dir = mkdtempSync(join(tmpdir(), 'fe2e-feat-'));
  const path = join(dir, 'x.feature');
  writeFileSync(path, text);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('baseUrlFromFeature: takes the origin of the login table Url, dropping the path', () => {
  const f = featureFile(
    'Feature: F\n' +
    '  Scenario: Login\n' +
    '    Given I try to login with user "kyle"\n' +
    '      | Url                                | User | Password |\n' +
    '      | https://env.example.com/app/start/ | kyle | secret   |\n');
  assert.equal(baseUrlFromFeature(f.path), 'https://env.example.com',
    'BASE_URL is the origin — the path belongs in the spec goto(), not the config');
  f.cleanup();
});

test('baseUrlFromFeature: takes the FIRST url when several appear', () => {
  const f = featureFile(
    'Feature: F\n' +
    '  Scenario: S\n' +
    '    Given the entry page https://first.example.com/\n' +
    '    And a link to https://second.example.com/elsewhere\n');
  assert.equal(baseUrlFromFeature(f.path), 'https://first.example.com',
    'the entry page is the first URL a feature names');
  f.cleanup();
});

test('baseUrlFromFeature: a table cell URL is not swallowed by the pipe delimiter', () => {
  // The regex must stop at the `|` and trailing whitespace, not eat the column
  // separator into the URL and then fail to parse.
  const f = featureFile(
    'Feature: F\n' +
    '  Scenario: S\n' +
    '    Given login\n' +
    '      | Url                    | User |\n' +
    '      |https://tight.example.com/|kyle|\n');
  assert.equal(baseUrlFromFeature(f.path), 'https://tight.example.com');
  f.cleanup();
});

test('baseUrlFromFeature: a feature that names no URL returns null, not a throw', () => {
  const f = featureFile('Feature: F\n  Scenario: S\n    Given a page\n');
  assert.equal(baseUrlFromFeature(f.path), null,
    'null lets the caller fall back to erroring; a placeholder would hide a missing env');
  f.cleanup();
});

test('baseUrlFromFeature: http (not just https) is accepted for a local server', () => {
  const f = featureFile('Feature: F\n  Scenario: S\n    Given http://127.0.0.1:8123/app\n');
  assert.equal(baseUrlFromFeature(f.path), 'http://127.0.0.1:8123');
  f.cleanup();
});

test('allSteps: flattens every scenario step, background included', () => {
  const f = featureFile(
    'Feature: F\n' +
    '  Background:\n' +
    '    Given I am logged in\n' +
    '  Scenario: S\n' +
    '    When I click Save\n' +
    '    Then I see a toast\n');
  assert.deepEqual(allSteps(f.path).map(s => s.text),
    ['I am logged in', 'I click Save', 'I see a toast']);
  f.cleanup();
});
