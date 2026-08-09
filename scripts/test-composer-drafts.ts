import assert from "node:assert/strict";
import {
  composerDraftForTab,
  pruneComposerDrafts,
  updateComposerDraftForTab,
} from "../src/lib/composer-drafts";

let drafts = updateComposerDraftForTab({}, "tab-a", "deploy from project A");
drafts = updateComposerDraftForTab(drafts, "tab-b", "inspect project B");
assert.equal(composerDraftForTab(drafts, "tab-a"), "deploy from project A");
assert.equal(composerDraftForTab(drafts, "tab-b"), "inspect project B");
assert.equal(composerDraftForTab(drafts, "tab-c"), "");

drafts = updateComposerDraftForTab(drafts, "tab-a", "");
assert.equal(composerDraftForTab(drafts, "tab-a"), "");
assert.equal(composerDraftForTab(drafts, "tab-b"), "inspect project B");

drafts = updateComposerDraftForTab(drafts, "tab-c", "temporary");
const pruned = pruneComposerDrafts(drafts, new Set(["tab-b"]));
assert.deepEqual(pruned, { "tab-b": "inspect project B" });

console.log("PASS composer drafts remain tab-scoped and prune with closed tabs");
