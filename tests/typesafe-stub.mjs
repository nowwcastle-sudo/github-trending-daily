// Pipeline tests must not reach TypeSafe: they assert zero fetches, and an
// unreachable service would hold every repository and change what they observe.
// Importing this installs a deterministic stub that answers the way the service
// does — one noul per question id — so classification succeeds offline.
//
// `stubbedTags` lets a test pin the tags it needs; anything unlisted answers 0.

import { CLASSIFICATION_QUESTION_IDS, setTypeSafeClient } from "../scripts/typesafe-client.mjs";

export function stubTypeSafe(tags = []) {
  const held = new Set(tags);
  setTypeSafeClient({
    async systemOne() {
      return {
        answers: Object.fromEntries(CLASSIFICATION_QUESTION_IDS.map(id => [id, { type: "noul", noul: held.has(id) ? 0.99 : 0.01 }])),
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  });
}

export function stubTypeSafeUnavailable(message = "stubbed outage") {
  setTypeSafeClient({
    async systemOne() {
      throw new Error(message);
    },
  });
}

stubTypeSafe();
