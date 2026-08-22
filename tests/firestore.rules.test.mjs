import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  setLogLevel,
} from "firebase/firestore";

let env;
const ruleTest = process.env.FIRESTORE_EMULATOR_HOST ? test : test.skip;
setLogLevel("silent");

before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) return;
  env = await initializeTestEnvironment({
    projectId: "github-trending-nowwcastle-test",
    firestore: {
      rules: await readFile(process.env.FIRESTORE_RULES_FILE || "firestore.rules", "utf8"),
    },
  });
});

beforeEach(async () => env?.clearFirestore());
after(async () => env?.cleanup());

const userDoc = (context, uid) => doc(context.firestore(), "users", uid);
const valid = favorites => ({ favorites, updatedAt: serverTimestamp() });

ruleTest("owner may create, get, update, and delete the document", async () => {
  const owner = env.authenticatedContext("alice");
  await assertSucceeds(setDoc(userDoc(owner, "alice"), valid(["a/one"])));
  await assertSucceeds(getDoc(userDoc(owner, "alice")));
  await assertSucceeds(setDoc(userDoc(owner, "alice"), valid(["b/two"])));
  await assertSucceeds(deleteDoc(userDoc(owner, "alice")));
});

ruleTest("collection queries are denied even to an owner", async () => {
  const owner = env.authenticatedContext("alice");
  await assertSucceeds(setDoc(userDoc(owner, "alice"), valid(["a/one"])));
  await assertFails(getDocs(collection(owner.firestore(), "users")));
});

ruleTest("unauthenticated users cannot read or write a user document", async () => {
  const owner = env.authenticatedContext("alice");
  const guest = env.unauthenticatedContext();
  await assertSucceeds(setDoc(userDoc(owner, "alice"), valid(["a/one"])));
  await assertFails(getDoc(userDoc(guest, "alice")));
  await assertFails(setDoc(userDoc(guest, "charlie"), valid(["c/three"])));
  await assertFails(setDoc(userDoc(guest, "alice"), valid(["b/two"])));
  await assertFails(deleteDoc(userDoc(guest, "alice")));
});

ruleTest("a different UID cannot get, create, update, or delete", async () => {
  const alice = env.authenticatedContext("alice");
  const bob = env.authenticatedContext("bob");
  await assertSucceeds(setDoc(userDoc(alice, "alice"), valid(["a/one"])));
  await assertFails(getDoc(userDoc(bob, "alice")));
  await assertFails(setDoc(userDoc(bob, "charlie"), valid(["c/three"])));
  await assertFails(setDoc(userDoc(bob, "alice"), valid(["b/two"])));
  await assertFails(deleteDoc(userDoc(bob, "alice")));
});

ruleTest("missing and extra fields are denied", async () => {
  const owner = env.authenticatedContext("alice");
  await assertFails(setDoc(userDoc(owner, "alice"), { favorites: [] }));
  await assertFails(setDoc(userDoc(owner, "alice"), { updatedAt: serverTimestamp() }));
  await assertFails(setDoc(userDoc(owner, "alice"), {
    ...valid([]),
    email: "x@example.com",
  }));
});

ruleTest("favorites must be a list", async () => {
  const owner = env.authenticatedContext("alice");
  await assertFails(setDoc(userDoc(owner, "alice"), {
    favorites: "a/one",
    updatedAt: serverTimestamp(),
  }));
});

ruleTest("client timestamps are denied", async () => {
  const owner = env.authenticatedContext("alice");
  await assertFails(setDoc(userDoc(owner, "alice"), {
    favorites: [],
    updatedAt: new Date(0),
  }));
});

ruleTest("500 unique favorites are allowed but 501 are denied", async () => {
  const owner = env.authenticatedContext("alice");
  const fiveHundred = Array.from({ length: 500 }, (_, index) => `o/r${index}`);
  assert.equal(fiveHundred.length, 500);
  await assertSucceeds(setDoc(userDoc(owner, "alice"), valid(fiveHundred)));
  await assertFails(setDoc(userDoc(owner, "alice"), valid([...fiveHundred, "o/overflow"])));
});

ruleTest("duplicate favorites are denied", async () => {
  const owner = env.authenticatedContext("alice");
  await assertFails(setDoc(userDoc(owner, "alice"), valid(["a/one", "a/one"])));
});
