const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTray } = require("../src/tray.cjs");
for (const platform of ["win32", "linux", "darwin"]) {
  test(platform + " tray uses the correct platform icon", () => {
    let loaded; let templates = 0;
    const image = { resize: () => image, setTemplateImage: () => templates++ };
    const electron = { nativeImage: { createFromPath: p => { loaded = p; return image; } }, Tray: class { setToolTip() {} setContextMenu() {} on() {} }, Menu: { buildFromTemplate: t => t } };
    createTray({ electron, platform });
    assert.ok(loaded.endsWith(platform === "darwin" ? "tray-template.png" : "icon.png"));
    assert.equal(templates, platform === "darwin" ? 1 : 0);
  });
}
