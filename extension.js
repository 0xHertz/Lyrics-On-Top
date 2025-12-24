import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class LyricsExtension extends Extension {
  enable() {
    const cssFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
    this._styleProvider = St.ThemeContext.get_for_stage(global.stage)
      .get_theme()
      .load_stylesheet(cssFile);
    this._label = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "panel-status-menu-box",
    });
    // 插入到左侧状态区

    Main.panel._leftBox.insert_child_at_index(this._label, 2);
    // === 新增：创建浮动胶囊 ===
    this._createFloatingLyrics();
    // === 新增：监听 Top Bar 可见性 ===

    this._panelSignals = [];

    const panelBox = Main.layoutManager.panelBox;

    this._panelSignals.push(
      panelBox.connect("notify::visible", () => this._updateVisibility()),
      panelBox.connect("notify::height", () => this._updateVisibility()),
      panelBox.connect("notify::opacity", () => this._updateVisibility()),
    );

    const overview = Main.overview;
    this._overviewSignals = [];
    this._overviewSignals = [
      overview.connect("showing", () => this._updateVisibility()),
      overview.connect("hiding", () => this._updateVisibility()),
      overview.connect("shown", () => this._updateVisibility()),
      overview.connect("hidden", () => this._updateVisibility()),
    ];

    // Shell 启动完成后再做首次判断

    this._startupTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      // 500ms 是实践中比较稳的值
      () => {
        this._updateVisibility();
        this._startupTimeoutId = null;
        return GLib.SOURCE_REMOVE;
      },
    );
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._updateVisibility();
      return GLib.SOURCE_REMOVE;
    });

    this._startLyrics();
  }

  disable() {
    if (this._panelSignals) {
      const panelBox = Main.layoutManager.panelBox;
      this._panelSignals.forEach((id) => panelBox.disconnect(id));
      this._panelSignals = null;
    }
    if (this._overviewSignals) {
      this._overviewSignals.forEach((id) => Main.overview.disconnect(id));
      this._overviewSignals = null;
    }
    if (this._startupTimeoutId) {
      GLib.source_remove(this._startupTimeoutId);
      this._startupTimeoutId = null;
    }
    if (this._floatingBox) {
      this._floatingBox.destroy();
      this._floatingBox = null;
      this._floatingLabel = null;
    }

    if (this._process) {
      this._process.force_exit();
      this._process = null;
    }

    if (this._label) {
      this._label.destroy();
      this._label = null;
    }
    if (this._styleProvider) {
      const cssFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
      this._styleProvider.unload_stylesheet(cssFile);
      this._styleProvider = null;
    }
  }

  _startLyrics() {
    try {
      this._process = new Gio.Subprocess({
        argv: ["sptlrx", "pipe"],
        flags: Gio.SubprocessFlags.STDOUT_PIPE,
      });
      this._process.init(null);

      const stdout = this._process.get_stdout_pipe();
      this._stream = new Gio.DataInputStream({
        base_stream: stdout,
      });

      this._readLine();
    } catch (e) {
      this._label.set_text("lyrics error");
    }
  }
  _isTopBarActuallyVisible() {
    if (Main.overview._shown || Main.overview.animationInProgress) {
      return true;
    }
    const panelBox = Main.layoutManager.panelBox;
    return panelBox.visible && panelBox.height > 0 && panelBox.opacity > 0;
  }

  _updateVisibility() {
    const topBarVisible = this._isTopBarActuallyVisible();
    if (topBarVisible) {
      this._label.show();
      this._floatingBox.hide();
    } else {
      this._label.hide();
      this._floatingBox.show();
    }
  }
  _createFloatingLyrics() {
    this._floatingLabel = new St.Label({
      text: "",
      style_class: "lyrics-floating-label",
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._floatingBox = new St.BoxLayout({
      style_class: "lyrics-floating-box",
      reactive: false,
      y_align: Clutter.ActorAlign.START,
    });

    this._floatingBox.add_child(this._floatingLabel); // === 关键：对齐约束（水平居中） ===

    this._floatingBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.X_AXIS,
        factor: 0.5, // 屏幕中点
      }),
    ); // === 顶部对齐 ===

    this._floatingBox.add_constraint(
      new Clutter.AlignConstraint({
        source: global.stage,
        align_axis: Clutter.AlignAxis.Y_AXIS,
        factor: 0.0, // 顶部
      }),
    );

    Main.layoutManager.addChrome(this._floatingBox, {
      affectsStruts: false,
      trackFullscreen: true,
    });

    this._floatingBox.set_y(40); // 顶部留白
    this._floatingBox.hide();
  }

  _readLine() {
    this._stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
      try {
        const [line] = stream.read_line_finish_utf8(res);
        if (line !== null) {
          this._label.set_text(line);
          this._floatingLabel.set_text(line);
          this._readLine();
        }
      } catch (e) {
        // subprocess ended
      }
    });
  }
}
