// Compatibility facade for recognition status. Controls live in the native reader.
globalThis.MAS_panel = {
  async mount() { return null; },
  status(text, kind = 'info') { globalThis.MAS_reader?.status(text, kind); },
};
