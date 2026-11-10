import assert from "node:assert/strict";
import { test } from "node:test";
import { createWhisperToken, hashWhisperToken, isValidWhisperToken } from "../dist/security.js";

test("whisper tokens are unguessable-format and hashes do not store the token", () => {
  const token = createWhisperToken();
  assert.equal(isValidWhisperToken(token), true);
  assert.equal(token.length, 43);
  assert.equal(hashWhisperToken(token).length, 64);
  assert.notEqual(hashWhisperToken(token), token);
  assert.notEqual(createWhisperToken(), token);
});

test("whisper token parser rejects malformed and short values", () => {
  assert.equal(isValidWhisperToken("short"), false);
  assert.equal(isValidWhisperToken("x".repeat(44)), false);
  assert.equal(isValidWhisperToken("!".repeat(43)), false);
});
