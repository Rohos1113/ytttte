import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeErrorMessage, errorMessageFromUnknown } from "./error-message.ts";

test("humanizeErrorMessage maps balance errors", () => {
  const raw = 'KieHttpError: 400 Bad Request: {"code": 4001, "msg": "account balance is insufficient"}';
  const res = humanizeErrorMessage(raw);
  assert.match(res, /балансе/);
  assert.doesNotMatch(res, /KieHttpError/);
  assert.doesNotMatch(res, /4001/);
});

test("humanizeErrorMessage maps server 502 error", () => {
  const raw = "HTTP 502 Bad Gateway: upstream server unavailable";
  const res = humanizeErrorMessage(raw);
  assert.match(res, /перегружен|недоступен/);
  assert.doesNotMatch(res, /502/);
});

test("humanizeErrorMessage maps moderation error", () => {
  const raw = '{"error": {"message": "prompt violates content moderation safety policy"}}';
  const res = humanizeErrorMessage(raw);
  assert.match(res, /безопасности|цензура/);
});

test("humanizeErrorMessage cleans exception prefixes", () => {
  const raw = "ActionCallError: 400 Bad Request: Не хватает входных данных";
  const res = humanizeErrorMessage(raw);
  assert.equal(res, "Не хватает входных данных");
});

test("errorMessageFromUnknown returns humanized string", () => {
  const err = new Error("Rate limit reached: 429 Too Many Requests");
  const res = errorMessageFromUnknown(err);
  assert.match(res, /лимит запросов/);
});
