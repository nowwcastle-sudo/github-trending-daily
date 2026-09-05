import assert from "node:assert/strict";
import test from "node:test";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

async function loadFilterPresets() {
  await import("../filter-presets.js");
  return globalThis.FilterPresets;
}

test("a preset persists across a browser reload", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  const saved = FilterPresets.save(storage, { name: "Rust CLI", query: "?lang=Rust&tag=cli" });

  assert.deepEqual(saved, [{ name: "Rust CLI", query: "?lang=Rust&tag=cli" }]);
  assert.deepEqual(FilterPresets.read(storage), [{ name: "Rust CLI", query: "?lang=Rust&tag=cli" }]);
});

test("saving the same name replaces that preset instead of duplicating it", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  FilterPresets.save(storage, { name: "Weekly", query: "?period=weekly" });

  const saved = FilterPresets.save(storage, { name: "Weekly", query: "?period=weekly&sort=gain" });

  assert.deepEqual(saved, [{ name: "Weekly", query: "?period=weekly&sort=gain" }]);
});

test("a preset can be deleted without touching the others", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  FilterPresets.save(storage, { name: "One", query: "?period=daily" });
  FilterPresets.save(storage, { name: "Two", query: "?period=weekly" });

  assert.deepEqual(FilterPresets.remove(storage, "One"), [{ name: "Two", query: "?period=weekly" }]);
});

test("the default view serializes to an empty query and is still a valid preset", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  assert.equal(FilterPresets.isValidQuery(""), true);
  assert.deepEqual(FilterPresets.save(storage, { name: "Everything", query: "" }), [{ name: "Everything", query: "" }]);
});

test("names are trimmed to 40 characters and blank names are refused", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  assert.equal(FilterPresets.normalizeName(`  ${"n".repeat(60)}  `).length, FilterPresets.NAME_LIMIT);
  assert.throws(() => FilterPresets.save(storage, { name: "   ", query: "" }), /preset name is required/);
  assert.throws(() => FilterPresets.save(storage, { name: "Bad", query: "lang=Rust" }), /invalid preset query/);
});

test("a pasted name keeps its words but not its newlines or tabs", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();

  assert.equal(FilterPresets.normalizeName("Rust\n\tCLI  weekly"), "Rust CLI weekly");
  // The stored name is what the list renders and what the delete lookup matches on, so it has to be
  // collapsed before it is written, not only when it is displayed.
  assert.deepEqual(FilterPresets.save(storage, { name: " Rust\tCLI\r\nweekly ", query: "?lang=Rust" }),
    [{ name: "Rust CLI weekly", query: "?lang=Rust" }]);
  assert.deepEqual(FilterPresets.remove(storage, "Rust\nCLI weekly"), []);
});

test("the twenty-first preset is refused rather than silently dropping an older one", async () => {
  const FilterPresets = await loadFilterPresets();
  const storage = memoryStorage();
  for (let index = 0; index < FilterPresets.PRESET_LIMIT; index += 1) {
    FilterPresets.save(storage, { name: `Preset ${index}`, query: `?q=${index}` });
  }

  assert.throws(() => FilterPresets.save(storage, { name: "One too many", query: "?q=x" }), /presets cannot exceed 20/);
  assert.equal(FilterPresets.read(storage).length, FilterPresets.PRESET_LIMIT);
});

test("corrupt or unreadable storage reads as an empty list", async () => {
  const FilterPresets = await loadFilterPresets();

  assert.deepEqual(FilterPresets.read(memoryStorage({ "gi.presets": "{not json" })), []);
  assert.deepEqual(FilterPresets.read(memoryStorage({ "gi.presets": '[{"name":"","query":"?q=1"},{"name":"Ok","query":7}]' })), []);
  assert.deepEqual(FilterPresets.read({ getItem() { throw new Error("blocked"); } }), []);
});
